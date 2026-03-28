import { Task, TaskStepSpec } from '../core/task';
import { Param } from '../core/param';
import { StatusReporter } from '../core/status-reporter';
import { DEFAULT_BASE_IMAGE } from '../constants';

/** Options for constructing a {@link GitHubStatusReporter}. */
export interface GitHubStatusReporterOptions {
  /** Container image with nushell and curl. Defaults to `DEFAULT_BASE_IMAGE`. */
  image?: string;
  /** Name of the Kubernetes Secret containing the GitHub token (key: `"token"`). Defaults to `"github-token"`. */
  tokenSecretName?: string;
  /** Pipeline param supplying the GitHub `owner/repo` value. Defaults to `new Param({ name: 'repo-full-name', type: 'string' })`. */
  repoFullNameParam?: Param;
  /** Pipeline param supplying the commit SHA. Defaults to `new Param({ name: 'revision', type: 'string' })`. */
  revisionParam?: Param;
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
  private readonly repoParam: Param;
  private readonly revParam: Param;

  readonly requiredParams: Param[];

  constructor(opts: GitHubStatusReporterOptions = {}) {
    this.image = opts.image ?? DEFAULT_BASE_IMAGE;
    this.tokenSecretName = opts.tokenSecretName ?? 'github-token';
    this.repoParam = opts.repoFullNameParam ?? new Param({ name: 'repo-full-name', type: 'string' });
    this.revParam = opts.revisionParam ?? new Param({ name: 'revision', type: 'string' });
    this.requiredParams = [this.repoParam, this.revParam];
  }

  createPendingTask(contexts: string[]): Task {
    const tokenEnv = this.tokenEnv();
    return new Task({
      name: 'set-status-pending',
      params: this.requiredParams,
      steps: contexts.map(context => ({
        name: `pending-${context.replace(/\//g, '-')}`,
        image: this.image,
        env: [tokenEnv],
        script: this.pendingScript(context),
      })),
    });
  }

  finalStep(context: string): TaskStepSpec {
    const tokenEnv = this.tokenEnv();
    return {
      name: 'report-status',
      image: this.image,
      env: [tokenEnv],
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

let exit_code = (try { open --raw /tekton/home/.exit-code | str trim | into int } catch { 1 })
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
