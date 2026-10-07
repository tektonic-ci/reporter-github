# @tektonic-ci/reporter-github

GitHub Commit Status reporter for [tektonic](https://github.com/tektonic-ci/core).

Reports each task's outcome to the
[GitHub Commit Status API](https://docs.github.com/en/rest/commits/statuses), so a
PipelineRun shows up as per-task checks on the commit: every context is set to `pending`
before the DAG starts, each task reports its own result as it finishes, and a `finally`
task reconciles anything left pending because its task was skipped, OOMKilled, evicted or
timed out.

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
exited 1`), so the check says where it broke before you open any logs.

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

A task's own status links its TaskRun. Pending statuses and the ones the `finally` reconciler
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

## Exports

| Export | What it is |
|---|---|
| `GitHubStatusReporter` | The `StatusReporter` implementation |
| `GitHubStatusReporterOptions` | Constructor options |
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
