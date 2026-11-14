import { createHash } from 'node:crypto';
import {
  EXIT_CODE_PATH,
  Param,
  Result,
  Script,
  Task,
  injectedImageRef,
  languageFor,
  stepExitCodePath,
  stepOutputPath,
} from '@tektonic-ci/core';
import type { StatusReconcilerEntry, StatusReporter, StepOutputCapture, TaskStepSpec } from '@tektonic-ci/core';
import { PIPELINE_RUN_PARAM, STARTED_AT_PATH, statusParam } from './github-status-reporter';
import type { GitHubStatusReporterOptions, StatusDetailsUrl } from './github-status-reporter';
import { FORMAT_DURATION_DEF, detailsUrlExpr, failIfAny, nuString } from './nushell';

/**
 * The param that carries a context's check-run ID from the pending task into the task that
 * reports it. Core declares it on every reporting task and binds it to the pending task's
 * result (see {@link GitHubChecksReporter.pendingTaskResults}).
 */
export const CHECK_RUN_ID_PARAM = 'check-run-id';

/**
 * Where {@link GitHubChecksReporter.startStep} leaves the check-run ID for the final step. The
 * start step creates the run itself when the pending task could not, so the final step reads
 * this before the param.
 */
export const CHECK_RUN_ID_PATH = '/tekton/home/.check-run-id';

/**
 * The most step output a check run's summary carries. GitHub caps `output.summary` at 65535
 * characters; this leaves room for the step table and headings.
 */
export const MAX_CHECK_OUTPUT_BYTES = 60_000;

/**
 * Matches `path:line: message` and `path:line:col: message`, the shape Go, ESLint (unix
 * formatter), tsc (`--pretty false`), shellcheck (gcc format) and most compilers print. The path
 * must have an extension, which keeps timestamps and URLs from matching. Named groups:
 * `path`, `line`, `message` (required) and `col` (optional).
 */
export const DEFAULT_ANNOTATION_PATTERN =
  '^(?<path>[\\w./@+-]+\\.[A-Za-z0-9]+):(?<line>\\d+)(?::(?<col>\\d+))?:\\s*(?<message>\\S.*)$';

/** GitHub accepts at most 50 annotations per check-run update. */
const MAX_ANNOTATIONS = 50;

/** Options for constructing a {@link GitHubChecksReporter}. */
export interface GitHubChecksReporterOptions
  extends Omit<GitHubStatusReporterOptions, 'tokenSecretName' | 'skipTokenInjection' | 'detailsUrl'> {
  /**
   * Name of a Kubernetes Secret holding the GitHub token under `"token"`. Defaults to
   * `"github-token"`.
   *
   * The Checks API accepts only a **GitHub App installation token**: a personal access token
   * gets 403. Under Pipelines as Code, use PAC's per-run App token instead: set
   * `skipTokenInjection` and pass it through `podTemplateEnv`, as the README shows.
   */
  tokenSecretName?: string;
  /** Skip per-step `GITHUB_TOKEN` injection; the token is provided at the PipelineRun level. */
  skipTokenInjection?: boolean;
  /** The check run's Details link. See {@link tektonDashboardUrl}. */
  detailsUrl?: StatusDetailsUrl;
  /**
   * Post the tail of the first failing step's output in the check run's summary. On by
   * default, at most {@link MAX_CHECK_OUTPUT_BYTES} (also the cap on `maxBytes`).
   *
   * **The output is posted as printed, secrets included.** Anyone who can see the repository's
   * checks can read it; for a public repository that means anyone. Set `false` for a task that
   * may print credentials.
   */
  output?: StepOutputCapture | false;
  /**
   * Regular expression (Rust syntax, as nushell's `parse --regex` takes it) that turns lines of
   * the failing step's output into check-run annotations. Needs named groups `path`, `line` and
   * `message`. Defaults to {@link DEFAULT_ANNOTATION_PATTERN}; `false` turns annotations off.
   * Has no effect when `output` is `false`, since there is no output to read.
   */
  annotationPattern?: string | false;
}

/**
 * The pending-task result holding a context's check-run ID. Derived from the context alone, so
 * the pending task, the reporting task and the reconciler agree on it without coordination; a
 * hash, because a context may hold characters a Tekton result name cannot (`/`).
 */
export function checkRunResultName(context: string): string {
  return `check-run-${createHash('sha256').update(context).digest('hex').slice(0, 12)}`;
}

/**
 * Reports task results as GitHub check runs: one per context, created `queued` by the pending
 * task, moved to `in_progress` when the task's pod starts, and completed by the task's final
 * step with a Markdown summary of its steps, the failing step's output tail and annotations
 * parsed from it. A `finally` reconciler concludes runs for tasks that were skipped (`skipped`)
 * or killed before they could report (`failure`).
 *
 * Every call degrades rather than fails the pipeline. If the pending task cannot create a run,
 * the start step creates it; if neither did, the final step does. Ships alongside
 * {@link GitHubStatusReporter}, not as a replacement.
 */
export class GitHubChecksReporter implements StatusReporter {
  private readonly image: string;
  private readonly tokenSecretName: string;
  private readonly skipTokenInjection: boolean;
  private readonly repoParam: Param;
  private readonly revParam: Param;
  private readonly pendingComputeResources: GitHubChecksReporterOptions['pendingTaskComputeResources'];
  private readonly failOnError: boolean;
  private readonly detailsUrl?: StatusDetailsUrl;
  private readonly annotationPattern: string | false;

  readonly requiredParams: Param[];
  readonly captureStepOutput?: StepOutputCapture;

  constructor(opts: GitHubChecksReporterOptions = {}) {
    this.image = opts.image ?? injectedImageRef('nushell');
    this.tokenSecretName = opts.tokenSecretName ?? 'github-token';
    this.skipTokenInjection = opts.skipTokenInjection ?? false;
    this.repoParam = opts.repoFullNameParam ?? new Param({ name: 'repo-full-name', type: 'string' });
    this.revParam = opts.revisionParam ?? new Param({ name: 'revision', type: 'string' });
    this.detailsUrl = opts.detailsUrl;
    this.requiredParams = [this.repoParam, this.revParam];
    if (this.detailsUrl) {
      this.requiredParams.push(new Param({
        name: PIPELINE_RUN_PARAM,
        type: 'string',
        pipelineExpression: '$(context.pipelineRun.name)',
      }));
    }
    this.pendingComputeResources = opts.pendingTaskComputeResources;
    this.failOnError = opts.failOnError ?? true;
    if (opts.output !== false) {
      const maxBytes = opts.output?.maxBytes ?? MAX_CHECK_OUTPUT_BYTES;
      if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_CHECK_OUTPUT_BYTES) {
        throw new Error(
          `GitHubChecksReporter: output.maxBytes must be a positive integer of at most ` +
            `${MAX_CHECK_OUTPUT_BYTES} (GitHub caps a check run's summary at 65535 characters), got ${maxBytes}`,
        );
      }
      this.captureStepOutput = { maxBytes };
    }
    this.annotationPattern = this.captureStepOutput ? opts.annotationPattern ?? DEFAULT_ANNOTATION_PATTERN : false;
  }

  // Everything createPendingTask and createStatusReconcilerTask read, and nothing else.
  pendingGroupKey(): string {
    return JSON.stringify({
      image: this.image,
      tokenSecretName: this.tokenSecretName,
      skipTokenInjection: this.skipTokenInjection,
      repoParam: [this.repoParam.name, this.repoParam.type],
      revParam: [this.revParam.name, this.revParam.type],
      pendingComputeResources: this.pendingComputeResources ?? null,
      detailsUrl: this.detailsUrl?.pipelineRun ?? null,
    });
  }

  pendingTaskResults(context: string): Record<string, string> {
    return { [CHECK_RUN_ID_PARAM]: checkRunResultName(context) };
  }

  createPendingTask(contexts: string[], name = 'set-status-pending'): Task {
    return new Task({
      name,
      params: this.requiredParams,
      results: contexts.map((c) => new Result({ name: checkRunResultName(c) })),
      steps: [{
        name: 'pending',
        image: this.image,
        env: this.env(),
        script: this.pendingScript(contexts),
        // The script tries every context and writes every result before failing; this keeps a
        // GitHub outage from failing the pipeline through runAfter.
        onError: 'continue' as const,
        ...(this.pendingComputeResources && { computeResources: this.pendingComputeResources }),
      }],
    });
  }

  createStatusReconcilerTask(entries: StatusReconcilerEntry[], name = 'reconcile-status'): Task {
    const statusParams = entries.map(({ taskName }) => statusParam(taskName));
    // The reconciler is not a reporting task, so core does not bind pending results for it:
    // each entry's check-run ID comes from the pending task core names in the entry.
    const idParams = entries.map(({ taskName, context, pendingTaskName }) =>
      pendingTaskName
        ? new Param({
          name: `check-run-${taskName}`,
          type: 'string',
          pipelineExpression: `$(tasks.${pendingTaskName}.results.${checkRunResultName(context)})`,
        })
        : undefined,
    );
    return new Task({
      name,
      params: [...this.requiredParams, ...statusParams, ...idParams.filter((p): p is Param => p !== undefined)],
      steps: [{
        name: 'reconcile',
        image: this.image,
        env: this.env(),
        script: this.reconcileScript(entries.map(({ context }, i) => ({
          status: String(statusParams[i]),
          context,
          id: idParams[i] ? String(idParams[i]) : '',
        }))),
        onError: 'continue' as const,
        ...(this.pendingComputeResources && { computeResources: this.pendingComputeResources }),
      }],
    });
  }

  // Core prepends this and forces onError: continue, so a failed call never fails the task.
  startStep(context: string): TaskStepSpec {
    return { name: 'report-running', image: this.image, env: this.env(), script: this.startScript(context) };
  }

  finalStep(context: string, userStepNames: string[] = []): TaskStepSpec {
    return { name: 'report-status', image: this.image, env: this.env(), script: this.finalScript(context, userStepNames) };
  }

  private env() {
    return this.skipTokenInjection
      ? []
      : [{ name: 'GITHUB_TOKEN', valueFrom: { secretKeyRef: { name: this.tokenSecretName, key: 'token' } } }];
  }

  private pendingScript(contexts: string[]): Script {
    const runs = contexts.map((c) => `  { context: ${nuString(c)}, result: "$(results.${checkRunResultName(c)}.path)" }`);
    const body = this.withDetailsUrl(
      `{ name: $run.context, head_sha: "${this.rev()}", status: "queued" }`,
      'pipelineRun',
    );
    return this.script(`let runs = [
${runs.join('\n')}
]

# Write every result before calling GitHub: a reporting task whose param names a result the
# pending task never wrote fails, and a GitHub outage must not take the pipeline with it.
for run in $runs { "none" | save -f $run.result }

let failed = $runs | each { |run|
  let label = $"check-pending [($run.context)]"
  try {
    let id = (gh POST "/check-runs" ${body} | get id | into string)
    $id | save -f $run.result
    log $"($label): created check run ($id)"
    null
  } catch { |e|
    log $"($label): error: ($e.msg)"
    $run.context
  }
} | compact

${failIfAny('check-pending')}`);
  }

  // Records the start time before calling GitHub, so the final summary has a duration even if
  // the call fails.
  private startScript(context: string): Script {
    const label = nuString(`check-running [${context}]`);
    const body = this.withDetailsUrl(`{ status: "in_progress", started_at: (now-iso) }`, 'taskRun');
    return this.script(`try { date now | format date '%s' | save -f ${STARTED_AT_PATH} } catch { |e| log $"check-running: cannot record start time: ($e.msg)" }

let id = (param-id "$(params.${CHECK_RUN_ID_PARAM})")
let body = ${body}
let id = if $id != null {
  try { gh PATCH $"/check-runs/($id)" $body | ignore; log $"(${label}): check run ($id) in progress" } catch { |e| log $"(${label}): error: ($e.msg)" }
  $id
} else {
  # The pending task could not create the run; create it here instead.
  try {
    let id = (gh POST "/check-runs" ($body | merge { name: ${nuString(context)}, head_sha: "${this.rev()}" }) | get id | into string)
    log $"(${label}): created check run ($id)"
    $id
  } catch { |e| log $"(${label}): error: ($e.msg)"; null }
}
if $id != null { $id | save -f ${CHECK_RUN_ID_PATH} }`);
  }

  private finalScript(context: string, userStepNames: string[]): Script {
    const label = nuString(`report-status [${context}]`);
    const capture = this.captureStepOutput !== undefined;
    const steps = userStepNames
      .map((n) => `{ name: ${nuString(n)}, path: "${stepExitCodePath(n)}", out: "${stepOutputPath(n)}" }`)
      .join(' ');
    const annotations = this.annotationPattern === false
      ? 'let annotations = []'
      : `let annotations = if ($tail | is-empty) { [] } else {
  $tail | lines | parse --regex ${nuString(this.annotationPattern)} | first ${MAX_ANNOTATIONS} | each { |m|
    let line = ($m.line | into int)
    { path: ($m.path | str replace -r '^\\./' ''), start_line: $line, end_line: $line, annotation_level: "failure", message: ($m.message | str trim) }
  }
}`;
    const body = this.withDetailsUrl(
      '{ status: "completed", conclusion: $conclusion, completed_at: (now-iso), output: $output }',
      'taskRun',
    );
    // As in GitHubStatusReporter: the worst of the contract file and Tekton's per-step exit
    // codes, since a body that calls `exit` never updates the contract file.
    return this.script(`${FORMAT_DURATION_DEF}

let contract_code = (try { open --raw ${EXIT_CODE_PATH} | str trim | into int } catch { 1 })
let step_codes = ([${steps}] | each { |s|
  let ran = ($s.path | path exists)
  { name: $s.name, ran: $ran, out: $s.out, code: (if $ran { try { open --raw $s.path | str trim | into int } catch { 0 } } else { 0 }) }
})
let exit_code = ([$contract_code ...($step_codes | each { |s| $s.code })] | math max)
let conclusion = if $exit_code == 0 { "success" } else { "failure" }
let failed_steps = ($step_codes | where code != 0)
let result = if $exit_code == 0 {
  "Passed"
} else if ($failed_steps | is-empty) {
  $"Failed: exit ($exit_code)"
} else {
  let first = ($failed_steps | first)
  $"Failed: step ($first.name) exited ($first.code)"
}
let duration = (try { format-duration ((date now | format date '%s' | into int) - (open --raw ${STARTED_AT_PATH} | str trim | into int)) } catch { null })
let title = if $duration == null { $result } else { $"($result) in ($duration)" }

let rows = ($step_codes | each { |s|
  let st = if not $s.ran { "did not run" } else if $s.code == 0 { "passed" } else { $"exited ($s.code)" }
  $"| ($s.name) | ($st) |"
})
mut summary = (["| Step | Result |" "| --- | --- |" ...$rows] | str join "\\n")
${capture
    ? `let tail = if ($failed_steps | is-empty) { "" } else {
  try { open --raw ($failed_steps | first | get out) | into string | ansi strip | str trim -r } catch { "" }
}
if ($tail | is-not-empty) {
  $summary = ([$summary "" $"### Output of ($failed_steps | first | get name)" "" "~~~~text" $tail "~~~~"] | str join "\\n")
}`
    : 'let tail = ""'}
${annotations}

let output = ({ title: $title, summary: $summary } | merge (if ($annotations | is-empty) { {} } else { { annotations: $annotations } }))
let body = ${body}
let id = (try { open --raw ${CHECK_RUN_ID_PATH} | str trim } catch { param-id "$(params.${CHECK_RUN_ID_PARAM})" })
log $"(${label}): exit-code=($exit_code) conclusion=($conclusion)"
try {
  if $id != null {
    gh PATCH $"/check-runs/($id)" $body | ignore
  } else {
    gh POST "/check-runs" ($body | merge { name: ${nuString(context)}, head_sha: "${this.rev()}" }) | ignore
  }
  log $"(${label}): done"
} catch { |e|
  log $"(${label}): error: ($e.msg)"
}${this.failOnError ? '\nexit $exit_code' : ''}`);
  }

  // Concludes the runs whose task never reported itself: skipped (status None) or killed before
  // its final step (Failed). A Failed task that did report has a completed run carrying its real
  // summary, which a generic one here would overwrite, so those are left alone.
  private reconcileScript(entries: { status: string; context: string; id: string }[]): Script {
    const rows = entries.map(({ status, context, id }) =>
      `  { status: ${nuString(status)}, context: ${nuString(context)}, id: ${nuString(id)} }`);
    const body = this.withDetailsUrl(
      '{ status: "completed", conclusion: $conclusion, completed_at: (now-iso), output: $output }',
      'pipelineRun',
    );
    return this.script(`let entries = [
${rows.join('\n')}
]

let failed = $entries | each { |entry|
  let label = $"reconcile-status [($entry.context)]"
  if $entry.status not-in ["None" "Failed"] {
    log $"($label): task status is ($entry.status), nothing to resolve"
    null
  } else {
    let id = (param-id $entry.id)
    let done = if $id == null { false } else {
      try { (gh GET $"/check-runs/($id)" | get status) == "completed" } catch { false }
    }
    if $done {
      log $"($label): check run ($id) already completed"
      null
    } else {
      let skipped = $entry.status == "None"
      let conclusion = if $skipped { "skipped" } else { "failure" }
      let output = if $skipped {
        { title: "Skipped", summary: "Tekton skipped this task: a when expression was false, or a task it depends on failed or was skipped." }
      } else {
        { title: "Failed or terminated", summary: "The task failed before it could report its own result. Its pod was killed (OOMKill, eviction), the TaskRun timed out, or the pod never started (image pull). See the PipelineRun for details." }
      }
      let body = ${body}
      log $"($label): task status is ($entry.status)"
      try {
        if $id != null {
          gh PATCH $"/check-runs/($id)" $body | ignore
        } else {
          gh POST "/check-runs" ($body | merge { name: $entry.context, head_sha: "${this.rev()}" }) | ignore
        }
        null
      } catch { |e|
        log $"($label): error: ($e.msg)"
        $entry.context
      }
    }
  }
} | compact

${failIfAny('reconcile-status')}`);
  }

  // The GitHub calls, the ISO timestamp the Checks API wants, and the ID parse every script
  // shares. An ID param that is not a number ("none" from a failed pending POST, or the literal
  // `$(params...)` of an unbound param) means there is no run to update.
  private script(body: string): Script {
    return new Script(languageFor('nushell'), `def gh [method: string, path: string, body?: record]: nothing -> any {
  let url = $"https://api.github.com/repos/${this.repo()}($path)"
  let headers = [
    Authorization $"Bearer ($env.GITHUB_TOKEN)"
    Accept "application/vnd.github+json"
    X-GitHub-Api-Version "2022-11-28"
  ]
  match $method {
    "POST" => { http post $url $body -t application/json -H $headers }
    "PATCH" => { http patch $url $body -t application/json -H $headers }
    _ => { http get $url -H $headers }
  }
}

def now-iso []: nothing -> string { date now | date to-timezone UTC | format date '%Y-%m-%dT%H:%M:%SZ' }

def param-id [value: string]: nothing -> any { if ($value | str trim) =~ '^\\d+$' { $value | str trim } else { null } }

${body}`);
  }

  private withDetailsUrl(record: string, kind: 'pipelineRun' | 'taskRun'): string {
    if (!this.detailsUrl) return record;
    return `(${record} | merge { details_url: ${nuString(detailsUrlExpr(this.detailsUrl, kind))} })`;
  }

  private repo(): string {
    return `$(params.${this.repoParam.name})`;
  }

  private rev(): string {
    return `$(params.${this.revParam.name})`;
  }
}
