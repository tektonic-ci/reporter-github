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
import { PIPELINE_RUN_PARAM, nuString, statusParam } from './github-status-reporter';
import type { StatusDetailsUrl } from './github-status-reporter';

/**
 * Where {@link GitHubChecksReporter.startStep} records the check run it updated or created, so
 * the final step updates the same run even when the pending task could not create one.
 */
export const CHECK_RUN_ID_PATH = '/tekton/home/.check-run-id';

/** The param through which each reporting task receives its check run's ID from the pending task. */
export const CHECK_RUN_ID_PARAM = 'check-run-id';

/**
 * Bytes of a failed step's output posted with its check run by default. GitHub caps a check
 * run's `output.text` at 65535 characters, so {@link GitHubChecksReporterOptions.logTailBytes}
 * may not exceed {@link MAX_LOG_TAIL_BYTES}.
 */
export const DEFAULT_LOG_TAIL_BYTES = 32 * 1024;

/** The largest {@link GitHubChecksReporterOptions.logTailBytes}, leaving room under GitHub's 65535-character `output.text` for the fence around it. */
export const MAX_LOG_TAIL_BYTES = 60_000;

/**
 * An annotation pattern for compiler-style `file:line: message` and `file:line:col: message`
 * lines, as Go, gcc, tsc (with `--pretty false`), eslint's unix formatter and many linters print.
 */
export const FILE_LINE_ANNOTATION_PATTERN =
  String.raw`^\s*(?P<file>[^\s:]+):(?P<line>\d+):(?:\d+:)?\s*(?P<message>.+)$`;

/** Turns lines of a failed step's output into check run annotations. */
export interface CheckRunAnnotations {
  /**
   * A regular expression (Rust `regex` syntax, as nushell's `parse --regex` takes it) matched
   * against each line of the failed step's captured output. It needs the named groups
   * `file`, `line` and `message`; other groups are ignored. See
   * {@link FILE_LINE_ANNOTATION_PATTERN}. GitHub keeps the first 50 matches.
   */
  pattern: string;
  /**
   * Directory the reported paths are relative to, usually where the repository is checked
   * out (`/workspace/source`). An annotation's path must be relative to the repository root
   * for GitHub to place it on the file, so this prefix is removed. Relative paths are kept.
   */
  pathPrefix?: string;
}

/** Options for constructing a {@link GitHubChecksReporter}. */
export interface GitHubChecksReporterOptions {
  /**
   * Container image providing nushell, which makes the API calls. Defaults to the project's
   * `injectedStepImage`, which must then declare `nushell`.
   */
  image?: string;
  /**
   * Name of the Kubernetes Secret holding the token (key: `"token"`). Defaults to
   * `"github-token"`. The token must be a GitHub App installation token: GitHub does not let
   * a personal access token write check runs.
   */
  tokenSecretName?: string;
  /**
   * When true, GITHUB_TOKEN is not injected into each step, because the PipelineRun's pod
   * template already supplies it — under Pipelines as Code, its `{{ git_auth_secret }}`
   * (a GitHub App installation token) through `TektonicProjectOptions.podTemplateEnv`.
   */
  skipTokenInjection?: boolean;
  /** Pipeline param supplying the GitHub `owner/repo` value. Defaults to `repo-full-name`. */
  repoFullNameParam?: Param;
  /** Pipeline param supplying the commit SHA. Defaults to `revision`. */
  revisionParam?: Param;
  /** GitHub REST API root, for GitHub Enterprise Server. Defaults to `https://api.github.com`. */
  apiUrl?: string;
  /** CPU/memory for the single step of the pending and reconcile tasks. See {@link GitHubStatusReporterOptions}. */
  pendingTaskComputeResources?: {
    requests?: { cpu?: string; memory?: string; 'ephemeral-storage'?: string };
    limits?: { cpu?: string; memory?: string; 'ephemeral-storage'?: string };
  };
  /**
   * When true (the default) the final step exits with the task's exit code after reporting,
   * so a failed step fails the TaskRun. False reports the failure on the check run only.
   */
  failOnError?: boolean;
  /**
   * The check runs' Details links. A task's own updates link its TaskRun; the Queued run and
   * the reconciler's link the PipelineRun. Adds a `pipeline-run-name` param, as for
   * {@link GitHubStatusReporter}.
   */
  detailsUrl?: StatusDetailsUrl;
  /**
   * Bytes of the failed step's output to post with its check run: the tail, at most
   * {@link MAX_LOG_TAIL_BYTES}. Defaults to {@link DEFAULT_LOG_TAIL_BYTES}.
   */
  logTailBytes?: number;
  /** Annotations parsed from the failed step's output. None by default. */
  annotations?: CheckRunAnnotations;
}

/**
 * The pending-task result carrying a context's check run ID. Hashed rather than slugged: a
 * context may hold any character, and every result shares the pod's 4 KiB termination
 * message, so the name is kept short.
 */
export function checkRunResultName(context: string): string {
  return `check-run-${createHash('sha256').update(context).digest('hex').slice(0, 10)}`;
}

/**
 * Reports each task as a GitHub check run, through the
 * [Checks API](https://docs.github.com/en/rest/checks/runs).
 *
 * The pending task creates one `queued` run per context and hands each task its run's ID.
 * The start step moves the run to `in_progress`; the final step completes it with a Markdown
 * table of the steps, the tail of the failed step's output and, optionally, annotations. A
 * `finally` task concludes the runs of tasks that were skipped (`skipped`) or killed before
 * reporting (`failure`), and leaves completed runs alone.
 *
 * The failed step's output is posted as it was printed. Anyone who can see the repository's
 * checks can read it — on a public repository, anyone — so a step must not print secrets.
 *
 * Needs `@tektonic-ci/core` 2.5.0 or later (pending-task results and step-output capture).
 */
export class GitHubChecksReporter implements StatusReporter {
  private readonly image: string;
  private readonly tokenSecretName: string;
  private readonly skipTokenInjection: boolean;
  private readonly repoParam: Param;
  private readonly revParam: Param;
  private readonly apiUrl: string;
  private readonly pendingComputeResources: GitHubChecksReporterOptions['pendingTaskComputeResources'];
  private readonly failOnError: boolean;
  private readonly detailsUrl?: StatusDetailsUrl;
  private readonly annotations?: CheckRunAnnotations;

  readonly requiredParams: Param[];
  readonly captureStepOutput: StepOutputCapture;

  constructor(opts: GitHubChecksReporterOptions = {}) {
    if (typeof stepOutputPath !== 'function') {
      throw new Error('GitHubChecksReporter needs @tektonic-ci/core 2.5.0 or later');
    }
    const logTailBytes = opts.logTailBytes ?? DEFAULT_LOG_TAIL_BYTES;
    if (!Number.isInteger(logTailBytes) || logTailBytes < 1 || logTailBytes > MAX_LOG_TAIL_BYTES) {
      throw new Error(`GitHubChecksReporter: logTailBytes must be an integer from 1 to ${MAX_LOG_TAIL_BYTES}, got ${logTailBytes}`);
    }
    if (opts.annotations) validateAnnotations(opts.annotations);

    this.image = opts.image ?? injectedImageRef('nushell');
    this.tokenSecretName = opts.tokenSecretName ?? 'github-token';
    this.skipTokenInjection = opts.skipTokenInjection ?? false;
    this.repoParam = opts.repoFullNameParam ?? new Param({ name: 'repo-full-name', type: 'string' });
    this.revParam = opts.revisionParam ?? new Param({ name: 'revision', type: 'string' });
    this.apiUrl = (opts.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.pendingComputeResources = opts.pendingTaskComputeResources;
    this.failOnError = opts.failOnError ?? true;
    this.detailsUrl = opts.detailsUrl;
    this.annotations = opts.annotations;
    this.captureStepOutput = { maxBytes: logTailBytes };
    this.requiredParams = [this.repoParam, this.revParam];
    if (this.detailsUrl) {
      this.requiredParams.push(new Param({
        name: PIPELINE_RUN_PARAM,
        type: 'string',
        pipelineExpression: '$(context.pipelineRun.name)',
      }));
    }
  }

  // Everything the pending and reconcile tasks read. failOnError, logTailBytes, annotations
  // and the taskRun link shape only the start and final steps.
  pendingGroupKey(): string {
    return JSON.stringify({
      image: this.image,
      tokenSecretName: this.tokenSecretName,
      skipTokenInjection: this.skipTokenInjection,
      repoParam: [this.repoParam.name, this.repoParam.type],
      revParam: [this.revParam.name, this.revParam.type],
      apiUrl: this.apiUrl,
      pendingComputeResources: this.pendingComputeResources ?? null,
      detailsUrl: this.detailsUrl?.pipelineRun ?? null,
    });
  }

  pendingTaskResults(context: string): Record<string, string> {
    return { [CHECK_RUN_ID_PARAM]: checkRunResultName(context) };
  }

  createPendingTask(contexts: string[], name = 'set-status-pending'): Task {
    const results = [...new Set(contexts.map(checkRunResultName))].map((r) => new Result({
      name: r,
      description: 'ID of the check run created for a context; empty if creating it failed',
    }));
    const runs = contexts.map((c) => `  { context: ${nuString(c)}, result: "$(results.${checkRunResultName(c)}.path)" }`);
    const queued = this.withDetailsUrl(
      '{ status: "queued", output: { title: "Queued", summary: "Waiting for the tasks it runs after, or for a node." } }',
      'pipelineRun',
    );
    return new Task({
      name,
      params: this.requiredParams,
      results,
      steps: [{
        name: 'pending',
        image: this.image,
        env: this.env(),
        script: new Script(languageFor('nushell'), `${this.apiDefs()}

let runs = [
${runs.join('\n')}
]

let failed = $runs | each { |run|
  let label = $"check-queued [($run.context)]"
  let id = try { create-run $run.context ${queued} } catch { |e| log $"($label): error: ($e.msg)"; "" }
  # Written even when empty: Tekton fails a task whose param references an unwritten result.
  $id | save -f $run.result
  if $id == "" { $run.context } else { log $"($label): check run ($id)"; null }
} | compact

${failIfAny('check-queued')}`),
        // Every context is tried and every result written before the script fails; this
        // keeps one failed POST from failing every task that runs after this one.
        onError: 'continue' as const,
        ...(this.pendingComputeResources && { computeResources: this.pendingComputeResources }),
      }],
    });
  }

  createStatusReconcilerTask(entries: StatusReconcilerEntry[], name = 'reconcile-status'): Task {
    const statusParams = entries.map(({ taskName }) => statusParam(taskName));
    // The pending task's results reach a finally task the same way as a task's status: as a
    // param the PipelineTask binds, since $(tasks.*) stays literal inside a step script.
    const idParams = entries.map(({ taskName, context, pendingTaskName }) => pendingTaskName
      ? new Param({
        name: `check-run-${taskName}`,
        type: 'string',
        pipelineExpression: `$(tasks.${pendingTaskName}.results.${checkRunResultName(context)})`,
      })
      : undefined);
    const rows = entries.map(({ context }, i) =>
      `  { status: "$(params.${statusParams[i].name})", context: ${nuString(context)}, id: ${idParams[i] ? `"$(params.${idParams[i]!.name})"` : '""'} }`);
    const conclude = this.withDetailsUrl(
      '{ status: "completed", conclusion: $conclusion, completed_at: (now-iso), output: { title: $title, summary: $summary } }',
      'pipelineRun',
    );
    return new Task({
      name,
      params: [...this.requiredParams, ...statusParams, ...idParams.filter((p): p is Param => p !== undefined)],
      steps: [{
        name: 'reconcile',
        image: this.image,
        env: this.env(),
        script: new Script(languageFor('nushell'), `${this.apiDefs()}

let entries = [
${rows.join('\n')}
]

let failed = $entries | each { |entry|
  let label = $"check-reconcile [($entry.context)]"
  if $entry.status not-in ["None" "Failed"] {
    log $"($label): task status is ($entry.status), nothing to resolve"
    null
  } else {
    let current = if $entry.id == "" { null } else {
      try { gh-api GET $"/check-runs/($entry.id)" } catch { |e| log $"($label): cannot read check run: ($e.msg)"; null }
    }
    let concluded = if $current == null { false } else { $current.status == "completed" }
    if $concluded {
      log $"($label): task status is ($entry.status), check run already concluded ($current.conclusion)"
      null
    } else {
      log $"($label): task status is ($entry.status)"
      let skipped = $entry.status == "None"
      let conclusion = if $skipped { "skipped" } else { "failure" }
      let title = if $skipped { "Skipped" } else { "Failed or terminated" }
      let summary = if $skipped {
        "The task did not run: a \`when\` expression skipped it, or a task it runs after failed or was skipped."
      } else {
        "The task stopped before it could report a result. It may have been OOMKilled, evicted, timed out or cancelled, or its pod may never have started. See the TaskRun."
      }
      try { put-run $entry.context $entry.id ${conclude} | ignore; log $"($label): done"; null } catch { |e| log $"($label): error: ($e.msg)"; $entry.context }
    }
  }
} | compact

${failIfAny('check-reconcile')}`),
        onError: 'continue' as const,
        ...(this.pendingComputeResources && { computeResources: this.pendingComputeResources }),
      }],
    });
  }

  // Core renders this with onError: continue, so a failed call never fails the task.
  startStep(context: string): TaskStepSpec {
    const body = this.withDetailsUrl('{ status: "in_progress", started_at: (now-iso) }', 'taskRun');
    return {
      name: 'report-running',
      image: this.image,
      env: this.env(),
      script: new Script(languageFor('nushell'), `${this.apiDefs()}

let label = ${nuString(`check-running [${context}]`)}
try {
  let id = put-run ${nuString(context)} "$(params.${CHECK_RUN_ID_PARAM})" ${body}
  # The final step updates this run, which this step may just have created.
  $id | save -f ${CHECK_RUN_ID_PATH}
  log $"($label): check run ($id) in progress"
} catch { |e| log $"($label): error: ($e.msg)" }`),
    };
  }

  finalStep(context: string, userStepNames: string[] = []): TaskStepSpec {
    return {
      name: 'report-status',
      image: this.image,
      env: this.env(),
      script: this.finalScript(context, userStepNames),
    };
  }

  private finalScript(context: string, userStepNames: string[]): Script {
    const steps = userStepNames
      .map((n) => `  { name: ${nuString(n)}, code_path: "${stepExitCodePath(n)}", out_path: "${stepOutputPath(n)}" }`)
      .join('\n');
    const body = this.withDetailsUrl(
      '{ status: "completed", conclusion: $conclusion, completed_at: (now-iso), output: $output }',
      'taskRun',
    );
    return new Script(languageFor('nushell'), `${this.apiDefs()}

let label = ${nuString(`check-result [${context}]`)}
let steps = [
${steps}
]

# As GitHubStatusReporter: the wrapper's contract file and Tekton's per-step exit codes, worst
# wins. A step with no exit code did not finish (or never ran) and counts as 0 here.
let contract_code = (try { open --raw ${EXIT_CODE_PATH} | str trim | into int } catch { 1 })
let step_codes = ($steps | each { |s| $s | merge { code: (try { open --raw $s.code_path | str trim | into int } catch { null }) } })
let exit_code = ([$contract_code ...($step_codes | each { |s| $s.code | default 0 })] | math max)
let failed_steps = ($step_codes | where { |s| $s.code != null and $s.code != 0 })
let conclusion = if $exit_code == 0 { "success" } else { "failure" }
let title = if $exit_code == 0 {
  "Passed"
} else if ($failed_steps | is-empty) {
  $"Failed: exit ($exit_code)"
} else {
  let first = ($failed_steps | first)
  $"Failed: step ($first.name) exited ($first.code)"
}

let rows = ($step_codes | each { |s|
  let result = if $s.code == null { "did not finish" } else if $s.code == 0 { "passed" } else { $"exited ($s.code)" }
  $"| \`($s.name)\` | ($result) |"
})
let table = (["| Step | Result |" "| --- | --- |" ...$rows] | str join "\\n")

# The output of the step that failed: the first with a non-zero exit code, else (only the
# contract file failed) the last step.
let tail_step = if $exit_code == 0 or ($steps | is-empty) { null } else if ($failed_steps | is-empty) { $steps | last } else { $failed_steps | first }
let tail = if $tail_step == null { "" } else {
  try { open --raw $tail_step.out_path | into binary | decode utf-8 | ansi strip | str trim --right } catch { "" }
}

let summary = if $tail == "" { $table } else { $"($table)\\n\\nThe end of \`($tail_step.name)\`'s output is below." }
mut output = { title: $title, summary: $summary }
if $tail != "" {
  $output = ($output | merge { text: $"\`\`\`\`text\\n($tail)\\n\`\`\`\`" })
}
${this.annotationsBlock()}

let param_id = "$(params.${CHECK_RUN_ID_PARAM})"
let id = (try { open --raw ${CHECK_RUN_ID_PATH} | str trim } catch { $param_id })
log $"($label): exit-code=($exit_code) conclusion=($conclusion)"
try {
  let id = put-run ${nuString(context)} $id ${body}
  log $"($label): check run ($id) completed"
} catch { |e| log $"($label): error: ($e.msg)" }${this.failOnError ? '\nexit $exit_code' : ''}`);
  }

  private annotationsBlock(): string {
    if (!this.annotations) return '';
    const prefix = this.annotations.pathPrefix;
    const relative = prefix === undefined
      ? '$file'
      : `(try { $file | path relative-to ${nuString(prefix)} } catch { $file })`;
    return `if $tail != "" {
  let annotations = ($tail | lines | parse --regex r#'${this.annotations.pattern}'# | first 50 | each { |m|
    try {
      let line = ($m.line | into int)
      let file = ($m.file | str trim | str replace -r '^\\./' '')
      { path: ${relative}, start_line: $line, end_line: $line, annotation_level: "failure", message: ($m.message | str trim) }
    } catch { null }
  } | compact)
  if ($annotations | is-not-empty) {
    $output = ($output | merge { annotations: $annotations })
  }
}`;
  }

  // gh-api makes one call and raises on failure; create-run and put-run return the run's ID.
  private apiDefs(): string {
    const base = `${this.apiUrl}/repos/$(params.${this.repoParam.name})`;
    const sha = `$(params.${this.revParam.name})`;
    return `def gh-api [method: string, path: string, body?: record]: nothing -> any {
  let url = $"(${nuString(base)})($path)"
  let headers = [
    Authorization $"token ($env.GITHUB_TOKEN)"
    Accept "application/vnd.github+json"
    X-GitHub-Api-Version "2022-11-28"
  ]
  if $method == "GET" {
    http get $url -H $headers
  } else if $method == "POST" {
    http post $url $body -t application/json -H $headers
  } else {
    http patch $url $body -t application/json -H $headers
  }
}

def create-run [name: string, body: record]: nothing -> string {
  gh-api POST "/check-runs" ({ name: $name, head_sha: ${nuString(sha)} } | merge $body) | get id | into string
}

# Updates run $id, or creates the run when there is no ID to update.
def put-run [name: string, id: string, body: record]: nothing -> string {
  if $id == "" {
    create-run $name $body
  } else {
    gh-api PATCH $"/check-runs/($id)" $body | ignore
    $id
  }
}

def now-iso []: nothing -> string {
  date now | date to-timezone UTC | format date '%Y-%m-%dT%H:%M:%SZ'
}`;
  }

  private withDetailsUrl(record: string, kind: 'pipelineRun' | 'taskRun'): string {
    if (!this.detailsUrl) return record;
    const template = kind === 'taskRun' ? this.detailsUrl.taskRun ?? this.detailsUrl.pipelineRun : this.detailsUrl.pipelineRun;
    const url = template
      .split('{namespace}').join('$(context.taskRun.namespace)')
      .split('{pipelineRun}').join(`$(params.${PIPELINE_RUN_PARAM})`)
      .split('{taskRun}').join('$(context.taskRun.name)');
    return `(${record} | merge { details_url: ${nuString(url)} })`;
  }

  private env() {
    return this.skipTokenInjection
      ? []
      : [{ name: 'GITHUB_TOKEN', valueFrom: { secretKeyRef: { name: this.tokenSecretName, key: 'token' } } }];
  }
}

function validateAnnotations({ pattern }: CheckRunAnnotations): void {
  for (const group of ['file', 'line', 'message']) {
    if (!new RegExp(`\\(\\?P?<${group}>`).test(pattern)) {
      throw new Error(`GitHubChecksReporter: annotations.pattern needs a named group '${group}', as in (?P<${group}>...)`);
    }
  }
  // Embedded in a nushell raw string, r#'...'#, and in a Tekton script, where $( starts a substitution.
  if (pattern.includes("'#") || pattern.includes('$(')) {
    throw new Error(`GitHubChecksReporter: annotations.pattern may not contain "'#" or "$("`);
  }
}

function failIfAny(label: string): string {
  return `if ($failed | is-not-empty) {
  log $"${label}: ($failed | length) failed: ($failed | str join ', ')"
  exit 1
}`;
}
