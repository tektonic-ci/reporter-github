import { Task, TaskStepSpec } from '../core/task';
import { Param } from '../core/param';
import { StatusReporter } from '../core/status-reporter';
import { DEFAULT_BASE_IMAGE } from '../constants';
import { EXIT_CODE_PATH } from '../script';

/** Options for constructing a {@link GitHubStatusReporter}. */
export interface GitHubStatusReporterOptions {
  /** Container image with nushell and curl. Defaults to `DEFAULT_BASE_IMAGE`. */
  image?: string;
  /** Name of the Kubernetes Secret containing the GitHub token (key: `"token"`). Defaults to `"github-token"`. */
  tokenSecretName?: string;
  /**
   * When true, skip per-step GITHUB_TOKEN injection via secretKeyRef.
   * Use when GITHUB_TOKEN is already provided at the PipelineRun podTemplate level
   * (e.g. via PAC's `{{ git_auth_secret }}` + `PACProjectOptions.podTemplateEnv`).
   */
  skipTokenInjection?: boolean;
  /** Pipeline param supplying the GitHub `owner/repo` value. Defaults to `new Param({ name: 'repo-full-name', type: 'string' })`. */
  repoFullNameParam?: Param;
  /** Pipeline param supplying the commit SHA. Defaults to `new Param({ name: 'revision', type: 'string' })`. */
  revisionParam?: Param;
  /**
   * CPU/memory limits for each step in the auto-generated `set-status-pending` task.
   * Each step makes a single HTTP POST to the GitHub Commit Status API; the default
   * step resources (512Mi limit) are far more than needed and can cause OOM on
   * memory-constrained nodes when many tasks report status (one step per task).
   *
   * Recommended values for a homelab or constrained cluster:
   * `{ requests: { cpu: '25m', memory: '64Mi' }, limits: { cpu: '200m', memory: '128Mi' } }`
   */
  pendingTaskComputeResources?: {
    requests?: { cpu?: string; memory?: string; 'ephemeral-storage'?: string };
    limits?: { cpu?: string; memory?: string; 'ephemeral-storage'?: string };
  };
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

  readonly requiredParams: Param[];

  constructor(opts: GitHubStatusReporterOptions = {}) {
    this.image = opts.image ?? DEFAULT_BASE_IMAGE;
    this.tokenSecretName = opts.tokenSecretName ?? 'github-token';
    this.skipTokenInjection = opts.skipTokenInjection ?? false;
    this.repoParam = opts.repoFullNameParam ?? new Param({ name: 'repo-full-name', type: 'string' });
    this.revParam = opts.revisionParam ?? new Param({ name: 'revision', type: 'string' });
    this.requiredParams = [this.repoParam, this.revParam];
    this.pendingComputeResources = opts.pendingTaskComputeResources;
  }

  createPendingTask(contexts: string[]): Task {
    const env = this.skipTokenInjection ? [] : [this.tokenEnv()];
    return new Task({
      name: 'set-status-pending',
      params: this.requiredParams,
      steps: contexts.map(context => ({
        name: `pending-${context.replace(/\//g, '-')}`,
        image: this.image,
        env,
        script: this.pendingScript(context),
        ...(this.pendingComputeResources && { computeResources: this.pendingComputeResources }),
      })),
    });
  }

  finalStep(context: string): TaskStepSpec {
    const env = this.skipTokenInjection ? [] : [this.tokenEnv()];
    return {
      name: 'report-status',
      image: this.image,
      env,
      script: this.finalScript(context),
    };
  }

  private pendingScript(context: string): string {
    const repo = `$(params.${this.repoParam.name})`;
    const rev = `$(params.${this.revParam.name})`;
    return `#!/usr/bin/env nu
def log [msg: string] {
  print $"[(date now | format date '%H:%M:%S')] status-pending [${context}]: ($msg)"
}

let url = $"https://api.github.com/repos/${repo}/statuses/${rev}"
let body = { state: "pending", context: "${context}", description: "Running" }

log $"POST ($url)"
log $"body: ($body | to json -r)"

try {
  http post $url $body -t application/json -H [
    Authorization $"token ($env.GITHUB_TOKEN)"
    Accept "application/vnd.github+json"
  ]
  log "done"
} catch { |e|
  log $"error: ($e.msg)"
  exit 1
}`;
  }

  private finalScript(context: string): string {
    const repo = `$(params.${this.repoParam.name})`;
    const rev = `$(params.${this.revParam.name})`;
    return `#!/usr/bin/env nu
def log [msg: string] {
  print $"[(date now | format date '%H:%M:%S')] report-status [${context}]: ($msg)"
}

let exit_code = (try { open --raw ${EXIT_CODE_PATH} | str trim | into int } catch { 1 })
let state = if $exit_code == 0 { "success" } else { "failure" }
let desc = if $exit_code == 0 { "Passed" } else { "Failed" }

log $"exit-code=($exit_code) state=($state)"

let url = $"https://api.github.com/repos/${repo}/statuses/${rev}"
let body = { state: $state, context: "${context}", description: $desc }

log $"POST ($url)"
log $"body: ($body | to json -r)"

try {
  http post $url $body -t application/json -H [
    Authorization $"token ($env.GITHUB_TOKEN)"
    Accept "application/vnd.github+json"
  ]
  log "done"
} catch { |e|
  log $"error: ($e.msg)"
}`;
  }

  private tokenEnv() {
    return {
      name: 'GITHUB_TOKEN',
      valueFrom: { secretKeyRef: { name: this.tokenSecretName, key: 'token' } },
    };
  }
}
