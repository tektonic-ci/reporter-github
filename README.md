# @tektonic-ci/reporter-github

GitHub reporters for [tektonic](https://github.com/tektonic-ci/core): `GitHubStatusReporter`
posts commit statuses, and `GitHubChecksReporter` posts check runs that carry the failed
step's output ([below](#check-runs)).

Reports each task's outcome to the
[GitHub Commit Status API](https://docs.github.com/en/rest/commits/statuses), so a
PipelineRun shows up as per-task checks on the commit. Every context reads `Queued` before
the DAG starts, then `Running` once its task's pod starts, then the task's result. A `finally`
task reconciles anything left pending because its task was skipped, OOMKilled, evicted or
timed out.

`Running` needs a core with the `StatusReporter.startStep` hook (2.4.0 or later).
Under older cores a context goes straight from `Queued` to its result.

## Install

```bash
npm install @tektonic-ci/reporter-github
```

`@tektonic-ci/core` is a **peer** dependency, deliberately: a reporter is matched to its
tasks by object identity, and two copies of the core package are two incompatible sets of
classes. Your project pins the version; this package follows it.

## Use

```ts
import { Task } from '@tektonic-ci/core';
import { GitHubStatusReporter } from '@tektonic-ci/reporter-github';

// Under PAC, reuse the git-auth token from the pod env rather than injecting a
// github-token secret into every step.
const statusReporter = new GitHubStatusReporter({ skipTokenInjection: true });

new Task({ name: 'test', statusReporter, steps: [/* … */] });
```

The task's `statusContext` (defaulting to its name) becomes the GitHub check name. The
reporter needs `repo-full-name` and `revision` params, which it merges into every task that
uses it; `TektonicProject` binds both from PAC.

A failed task's status names the step that failed and its exit code (`Failed: step test
exited 1`), so the check says where it broke before you open any logs. With `Running`
reported, the result also says how long the task took: `Passed in 3m12s`, `Failed: step test
exited 1 (2m05s)`.

### Details links

By default the statuses carry no Details link. Pass `detailsUrl` to give each one a
`target_url` into your console. For a [Tekton Dashboard](https://github.com/tektoncd/dashboard):

```ts
import { GitHubStatusReporter, tektonDashboardUrl } from '@tektonic-ci/reporter-github';

const statusReporter = new GitHubStatusReporter({
  skipTokenInjection: true,
  detailsUrl: tektonDashboardUrl('https://tekton.example.com'),
});
```

A task's own statuses (`Running` and its result) link its TaskRun. `Queued` statuses and the ones the `finally` reconciler
posts (skipped or killed tasks, which may have no TaskRun) link the PipelineRun. For another
console, pass the templates yourself, using `{namespace}`, `{pipelineRun}` and `{taskRun}`:

```ts
detailsUrl: {
  pipelineRun: 'https://console.example.com/runs/{namespace}/{pipelineRun}',
  taskRun: 'https://console.example.com/runs/{namespace}/{pipelineRun}/{taskRun}', // optional
}
```

Setting it adds a `pipeline-run-name` param to each reporting task, bound from
`$(context.pipelineRun.name)` in the pipeline, so nothing new has to be passed in.

These links cover the per-task statuses only. The `Pipelines as Code CI / …` check runs take
their links from Pipelines as Code's own `pipelines-as-code` ConfigMap (`tekton-dashboard-url`
or the `custom-console-*` keys), which is cluster configuration.

### Image

The status steps POST with nushell's `http post`, so they need an image providing `nushell`.
They resolve through the project's `injectedStepImage` and synthesis fails naming the
capability if it does not declare one — pass `image` to override per reporter.

## Check runs

`GitHubChecksReporter` reports each task as a check run through the
[Checks API](https://docs.github.com/en/rest/checks/runs) instead of a commit status, so a
failure can be read on GitHub without opening a console:

- the pending task creates a `queued` run per context and hands each task its run's ID;
- the task's start step moves it to `in_progress`;
- the final step completes it with a table of the task's steps and their exit codes, the
  tail of the failed step's output, and optionally annotations parsed from that output;
- the `finally` reconciler concludes the runs of skipped tasks as `skipped` and of tasks
  killed before they could report (OOMKill, eviction, timeout) as `failure`. A run the task
  already completed is left alone.

```ts
import { FILE_LINE_ANNOTATION_PATTERN, GitHubChecksReporter, tektonDashboardUrl } from '@tektonic-ci/reporter-github';

const statusReporter = new GitHubChecksReporter({
  skipTokenInjection: true, // PAC's {{ git_auth_secret }} through podTemplateEnv
  detailsUrl: tektonDashboardUrl('https://tekton.example.com'),
  annotations: { pattern: FILE_LINE_ANNOTATION_PATTERN, pathPrefix: '/workspace/source' },
});
```

It needs `@tektonic-ci/core` 2.5.0 or later and throws on construction under an older core.

**Token.** GitHub only lets a GitHub App write check runs: a personal access token gets a
403. Under Pipelines as Code, use its installation token (`{{ git_auth_secret }}`, through
`TektonicProjectOptions.podTemplateEnv`) with `skipTokenInjection: true`. Runs created with
that token belong to the PAC App's check suite.

**The output is posted as printed.** Core captures each step's output for the final step
(`captureStepOutput`), and the failed step's tail goes into the check run, which anyone who
can see the repository's checks can read — on a public repository, anyone. A step must not
print secrets. `logTailBytes` sets how much is posted (default 32 KiB, at most 60 000, under
GitHub's 65 535-character limit).

**Annotations.** `annotations.pattern` is matched against each line of the failed step's
output with nushell's `parse --regex` (Rust regex syntax) and needs the named groups `file`,
`line` and `message`. `FILE_LINE_ANNOTATION_PATTERN` matches `file:line: message` and
`file:line:col: message`. Paths must be relative to the repository root for GitHub to place
them, so `pathPrefix` (the checkout directory) is stripped. GitHub keeps the first 50.

**Limits.** The pending task passes each run's ID as a Tekton result, and all of a pod's
results share its 4 KiB termination message: about 50 contexts per pipeline.
`apiUrl` points it at GitHub Enterprise Server.

## Exports

| Export | What it is |
|---|---|
| `GitHubStatusReporter` | The commit status reporter |
| `GitHubStatusReporterOptions` | Its constructor options |
| `GitHubChecksReporter` | The check run reporter |
| `GitHubChecksReporterOptions`, `CheckRunAnnotations` | Its constructor options |
| `FILE_LINE_ANNOTATION_PATTERN` | An annotation pattern for `file:line[:col]: message` |
| `checkRunResultName(context)` | The pending-task result carrying a context's check run ID |
| `CHECK_RUN_ID_PARAM`, `CHECK_RUN_ID_PATH` | Where a reporting task receives and keeps its run's ID |
| `DEFAULT_LOG_TAIL_BYTES`, `MAX_LOG_TAIL_BYTES` | `logTailBytes` default and ceiling |
| `statusParam(taskName)` | The `$(tasks.<name>.status)` param its reconciler task binds |
| `tektonDashboardUrl(baseUrl)` | `detailsUrl` templates for a Tekton Dashboard |
| `StatusDetailsUrl` | The `detailsUrl` option's type |
| `PIPELINE_RUN_PARAM` | Name of the param `detailsUrl` adds (`pipeline-run-name`) |

## Why it is a separate package

Because nothing else proves the `StatusReporter` seam works. This repo builds and tests
against `@tektonic-ci/core` as published on npm, exactly as a third-party reporter would, so
anything such a reporter would need and cannot reach fails here first. See
[docs/status-reporters.md](https://github.com/tektonic-ci/core/blob/main/docs/status-reporters.md) to write your own.

## License

[Apache-2.0](LICENSE)
