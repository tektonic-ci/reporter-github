import {
  EXIT_CODE_PATH,
  Param,
  Script,
  Task,
  injectedImageRef,
  languageFor,
  stepExitCodePath,
} from '@pfenerty/tektonic';
import type { StatusReporter, TaskStepSpec } from '@pfenerty/tektonic';

/**
 * Param carrying a pipeline task's runtime status into the skip-resolver task.
 *
 * The value is bound by the finally PipelineTask to `$(tasks.<taskName>.status)` — the only
 * scope in which Tekton substitutes that variable. Keyed on the task name (already a valid
 * Kubernetes name, unique within a pipeline) rather than the status context, which may
 * contain `/`.
 */
export function statusParam(taskName: string): Param {
  return new Param({
    name: `status-${taskName}`,
    type: 'string',
    pipelineExpression: `$(tasks.${taskName}.status)`,
  });
}

/** Options for constructing a {@link GitHubStatusReporter}. */
export interface GitHubStatusReporterOptions {
  /**
   * Container image providing nushell — the status POSTs use nushell `http post`.
   * Defaults to the project's `injectedStepImage`, which must then declare `nushell`.
   */
  image?: string;
  /** Name of the Kubernetes Secret containing the GitHub token (key: `"token"`). Defaults to `"github-token"`. */
  tokenSecretName?: string;
  /**
   * When true, skip per-step GITHUB_TOKEN injection via secretKeyRef.
   * Use when GITHUB_TOKEN is already provided at the PipelineRun podTemplate level
   * (e.g. via PAC's `{{ git_auth_secret }}` + `TektonicProjectOptions.podTemplateEnv`).
   */
  skipTokenInjection?: boolean;
  /** Pipeline param supplying the GitHub `owner/repo` value. Defaults to `new Param({ name: 'repo-full-name', type: 'string' })`. */
  repoFullNameParam?: Param;
  /** Pipeline param supplying the commit SHA. Defaults to `new Param({ name: 'revision', type: 'string' })`. */
  revisionParam?: Param;
  /**
   * CPU/memory limits for the single step in the auto-generated `set-status-pending` and
   * `reconcile-status` tasks. The step only makes HTTP POSTs to the GitHub Commit Status
   * API, one per context in turn; the default step resources (512Mi limit) are far more
   * than needed and can cause OOM on memory-constrained nodes.
   *
   * Recommended values for a homelab or constrained cluster:
   * `{ requests: { cpu: '25m', memory: '64Mi' }, limits: { cpu: '200m', memory: '128Mi' } }`
   */
  pendingTaskComputeResources?: {
    requests?: { cpu?: string; memory?: string; 'ephemeral-storage'?: string };
    limits?: { cpu?: string; memory?: string; 'ephemeral-storage'?: string };
  };
  /**
   * When true (the default), the final `report-status` step re-exits the captured
   * exit code (`exit $exit_code`) after POSTing to GitHub, so a failed work step
   * fails the TaskRun (and therefore the PipelineRun). Set false to preserve the
   * legacy report-only behavior, where a failed step turns the commit status red
   * but the TaskRun still reports Succeeded.
   */
  failOnError?: boolean;
}

/**
 * Reports task statuses to the GitHub Commit Status API.
 *
 * Implements {@link StatusReporter} using nushell `http post` calls to
 * `https://api.github.com/repos/{owner}/{repo}/statuses/{sha}`.
 */
export class GitHubStatusReporter implements StatusReporter {
  private readonly image: string;
  private readonly tokenSecretName: string;
  private readonly skipTokenInjection: boolean;
  private readonly repoParam: Param;
  private readonly revParam: Param;
  private readonly pendingComputeResources: GitHubStatusReporterOptions['pendingTaskComputeResources'];
  private readonly failOnError: boolean;

  readonly requiredParams: Param[];

  constructor(opts: GitHubStatusReporterOptions = {}) {
    this.image = opts.image ?? injectedImageRef('nushell');
    this.tokenSecretName = opts.tokenSecretName ?? 'github-token';
    this.skipTokenInjection = opts.skipTokenInjection ?? false;
    this.repoParam = opts.repoFullNameParam ?? new Param({ name: 'repo-full-name', type: 'string' });
    this.revParam = opts.revisionParam ?? new Param({ name: 'revision', type: 'string' });
    this.requiredParams = [this.repoParam, this.revParam];
    this.pendingComputeResources = opts.pendingTaskComputeResources;
    this.failOnError = opts.failOnError ?? true;
  }

  // Everything createPendingTask and createStatusReconcilerTask read, and nothing else:
  // failOnError only shapes finalStep, so a strict and a report-only reporter share one
  // pending and one reconciler task. A new option that feeds either task belongs here.
  pendingGroupKey(): string {
    return JSON.stringify({
      image: this.image,
      tokenSecretName: this.tokenSecretName,
      skipTokenInjection: this.skipTokenInjection,
      repoParam: [this.repoParam.name, this.repoParam.type],
      revParam: [this.revParam.name, this.revParam.type],
      pendingComputeResources: this.pendingComputeResources ?? null,
    });
  }

  createPendingTask(contexts: string[], name = 'set-status-pending'): Task {
    const env = this.skipTokenInjection ? [] : [this.tokenEnv()];
    return new Task({
      name,
      params: this.requiredParams,
      // One step for every context: a container per context bought nothing but pod overhead,
      // since the POSTs ran one after another either way.
      steps: [{
        name: 'pending',
        image: this.image,
        env,
        script: this.pendingScript(contexts),
        // The script already tries every context before failing; this keeps a failed POST
        // from failing the TaskRun and, through runAfter, every task waiting on it.
        onError: 'continue' as const,
        ...(this.pendingComputeResources && { computeResources: this.pendingComputeResources }),
      }],
    });
  }

  /**
   * @deprecated Use {@link createStatusReconcilerTask}. Retained so callers pinned to the
   * older {@link StatusReporter} method keep working; behaviour is identical.
   */
  createSkipResolverTask(
    entries: { taskName: string; context: string }[],
    name = 'resolve-skipped-status',
  ): Task {
    return this.createStatusReconcilerTask(entries, name);
  }

  createStatusReconcilerTask(
    entries: { taskName: string; context: string }[],
    name = 'reconcile-status',
  ): Task {
    const env = this.skipTokenInjection ? [] : [this.tokenEnv()];
    // One param per entry carrying that task's runtime status. `pipelineExpression` makes the
    // finally PipelineTask supply `$(tasks.<taskName>.status)` as the value — see
    // skipResolverScript for why the status cannot be referenced from the script directly.
    // Keyed on taskName, not context: task names are already valid Kubernetes names and are
    // unique within a pipeline, whereas a context may contain `/`.
    const statusParams = entries.map(({ taskName }) => statusParam(taskName));
    return new Task({
      name,
      params: [...this.requiredParams, ...statusParams],
      steps: [{
        name: 'reconcile',
        image: this.image,
        env,
        script: this.reconcileScript(entries.map(({ context }, i) => ({ status: statusParams[i], context }))),
        // See createPendingTask: the script reconciles every entry before it fails.
        onError: 'continue' as const,
        ...(this.pendingComputeResources && { computeResources: this.pendingComputeResources }),
      }],
    });
  }

  finalStep(context: string, userStepNames: string[] = []): TaskStepSpec {
    const env = this.skipTokenInjection ? [] : [this.tokenEnv()];
    return {
      name: 'report-status',
      image: this.image,
      env,
      script: this.finalScript(context, userStepNames),
    };
  }

  // Both scripts are authored through the Nushell {@link ScriptLanguage} plugin
  // so the shebang and `log` preamble are generated at synth time rather than
  // hand-written here; the step label is supplied at each call site. The GitHub
  // Commit Status API calls use nushell `http post`, so the reporter's image
  // must provide nushell (see GitHubStatusReporterOptions.image).
  private pendingScript(contexts: string[]): Script {
    return new Script(languageFor('nushell'), `${this.postStatusDef()}

let contexts = [${contexts.map(nuString).join(' ')}]

let failed = $contexts | each { |context|
  let body = { state: "pending", context: $context, description: "Running" }
  if (post-status $"status-pending [($context)]" $body) { null } else { $context }
} | compact

${failIfAny('status-pending')}`);
  }

  // Runs in the pipeline's `finally` block, after the whole DAG has settled, and acts on the
  // two statuses that mean the task's own `report-status` step never ran:
  //   None   — skipped by `when` (directly, or because an ancestor was skipped/failed).
  //   Failed — failed, including infrastructure kills (OOMKill, eviction, image-pull failure,
  //            TaskRun timeout) that terminate the pod before any step of the task runs. For a
  //            task that did run and reported its own failure this re-POSTs the same red state,
  //            which is idempotent for the context; without it an OOMKilled task leaves its
  //            context pending forever with no signal.
  // A task that succeeded already reported itself via `finalStep`, so the step no-ops.
  //
  // The status arrives as a param, NOT as `$(tasks.<taskName>.status)` written inline here.
  // Tekton substitutes `$(tasks.*)` in a PipelineTask's params and `when`, but not inside a
  // referenced Task's step script — written inline it stays a literal string, never equals
  // "None", and every step short-circuits without ever POSTing. `statusParam` carries the
  // real expression to the finally PipelineTask via `Param.pipelineExpression`.
  private reconcileScript(entries: { status: Param; context: string }[]): Script {
    const rows = entries.map(({ status, context }) => `  { status: ${nuString(String(status))}, context: ${nuString(context)} }`);
    return new Script(languageFor('nushell'), `${this.postStatusDef()}

let entries = [
${rows.join('\n')}
]

let failed = $entries | each { |entry|
  let label = $"reconcile-status [($entry.context)]"
  if $entry.status not-in ["None" "Failed"] {
    log $"($label): task status is ($entry.status), nothing to resolve"
    null
  } else {
    let state = if $entry.status == "None" { "success" } else { "failure" }
    let desc = if $entry.status == "None" { "Skipped" } else { "Failed or terminated" }
    log $"($label): task status is ($entry.status)"
    let body = { state: $state, context: $entry.context, description: $desc }
    if (post-status $label $body) { null } else { $entry.context }
  }
} | compact

${failIfAny('reconcile-status')}`);
  }

  // POSTs one commit status and reports whether it landed, so a caller looping over contexts
  // can carry on past a failure and fail once at the end.
  private postStatusDef(): string {
    const repo = `$(params.${this.repoParam.name})`;
    const rev = `$(params.${this.revParam.name})`;
    return `def post-status [label: string, body: record]: nothing -> bool {
  let url = $"https://api.github.com/repos/${repo}/statuses/${rev}"
  log $"($label): POST ($url)"
  log $"($label): body: ($body | to json -r)"
  try {
    http post $url $body -t application/json -H [
      Authorization $"token ($env.GITHUB_TOKEN)"
      Accept "application/vnd.github+json"
    ]
    log $"($label): done"
    true
  } catch { |e|
    log $"($label): error: ($e.msg)"
    false
  }
}`;
  }

  private finalScript(context: string, userStepNames: string[]): Script {
    const repo = `$(params.${this.repoParam.name})`;
    const rev = `$(params.${this.revParam.name})`;
    // When failOnError, re-exit the captured code AFTER the POST so a failed work
    // step fails the TaskRun. The report-status step is rendered without
    // onError:continue, so this non-zero exit propagates.
    const failLine = this.failOnError ? '\nexit $exit_code' : '';
    // Two sources, worst wins. The contract file is what the wrapped script writes;
    // Tekton's per-step files are what the *entrypoint* writes, and they are the only
    // ones that survive a body calling the shell's `exit` (untrappable in nushell, so
    // the wrapper never runs and the contract file keeps a stale 0 — the failure mode
    // that had a task reporting green on real drift). Reading both means a Tekton that
    // does not write the per-step files degrades to the old behaviour rather than
    // reporting a blanket success.
    const stepPaths = userStepNames.map((n) => `"${stepExitCodePath(n)}"`).join(' ');
    return new Script(languageFor('nushell'), `let contract_code = (try { open --raw ${EXIT_CODE_PATH} | str trim | into int } catch { 1 })
# A step that never ran has no file; 0 keeps it out of the max.
let step_codes = ([${stepPaths}] | each { |p| try { open --raw $p | str trim | into int } catch { 0 } })
let exit_code = ([$contract_code ...$step_codes] | math max)
let state = if $exit_code == 0 { "success" } else { "failure" }
let desc = if $exit_code == 0 { "Passed" } else { "Failed" }

log $"report-status [${context}]: exit-code=($exit_code) state=($state)"

let url = $"https://api.github.com/repos/${repo}/statuses/${rev}"
let body = { state: $state, context: "${context}", description: $desc }

log $"report-status [${context}]: POST ($url)"
log $"report-status [${context}]: body: ($body | to json -r)"

try {
  http post $url $body -t application/json -H [
    Authorization $"token ($env.GITHUB_TOKEN)"
    Accept "application/vnd.github+json"
  ]
  log "report-status [${context}]: done"
} catch { |e|
  log $"report-status [${context}]: error: ($e.msg)"
}${failLine}`);
  }

  private tokenEnv() {
    return {
      name: 'GITHUB_TOKEN',
      valueFrom: { secretKeyRef: { name: this.tokenSecretName, key: 'token' } },
    };
  }
}

// A nushell double-quoted string literal. JSON's escapes (\" \\ \n \t) are valid there too,
// so a context containing a quote cannot end the literal early.
function nuString(value: string): string {
  return JSON.stringify(value);
}

// Every context has been tried by the time this runs; exit non-zero once if any failed, so the
// failure stays visible in the step's state.
function failIfAny(label: string): string {
  return `if ($failed | is-not-empty) {
  log $"${label}: ($failed | length) failed: ($failed | str join ', ')"
  exit 1
}`;
}
