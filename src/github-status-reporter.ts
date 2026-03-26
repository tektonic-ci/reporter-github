import { Task, TaskStepSpec } from '../core/task';
import { Param } from '../core/param';
import { StatusReporter } from '../core/status-reporter';

/** Options for constructing a {@link GitHubStatusReporter}. */
export interface GitHubStatusReporterOptions {
  /** Container image with curl. Defaults to `"cgr.dev/chainguard/curl:latest-dev"`. */
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
 * Implements {@link StatusReporter} using `curl` calls to
 * `https://api.github.com/repos/{owner}/{repo}/statuses/{sha}`.
 */
export class GitHubStatusReporter implements StatusReporter {
  private readonly image: string;
  private readonly tokenSecretName: string;
  private readonly repoParam: Param;
  private readonly revParam: Param;

  readonly requiredParams: Param[];

  constructor(opts: GitHubStatusReporterOptions = {}) {
    this.image = opts.image ?? 'cgr.dev/chainguard/curl:latest-dev';
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
        command: ['sh', '-c'],
        args: [
          `curl -fsS -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -d "{\\"state\\":\\"pending\\",\\"context\\":\\"${context}\\",\\"description\\":\\"Running\\"}" \
  "https://api.github.com/repos/$(params.${this.repoParam.name})/statuses/$(params.${this.revParam.name})"`,
        ],
      })),
    });
  }

  finalStep(context: string): TaskStepSpec {
    const tokenEnv = this.tokenEnv();
    return {
      name: 'report-status',
      image: this.image,
      env: [tokenEnv],
      command: ['sh', '-c'],
      args: [
        `EXIT_CODE=$(cat /tekton/home/.exit-code)
if [ "$EXIT_CODE" -eq 0 ]; then STATE=success DESC=Passed; else STATE=failure DESC=Failed; fi
curl -fsS -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -d "{\\"state\\":\\"$STATE\\",\\"context\\":\\"${context}\\",\\"description\\":\\"$DESC\\"}" \
  "https://api.github.com/repos/$(params.${this.repoParam.name})/statuses/$(params.${this.revParam.name})"`,
      ],
    };
  }

  private tokenEnv() {
    return {
      name: 'GITHUB_TOKEN',
      valueFrom: { secretKeyRef: { name: this.tokenSecretName, key: 'token' } },
    };
  }
}
