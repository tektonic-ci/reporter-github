# @pfenerty/tektonic-reporter-github

GitHub Commit Status reporter for [tektonic](https://github.com/tektonic-ci/core).

Reports each task's outcome to the
[GitHub Commit Status API](https://docs.github.com/en/rest/commits/statuses), so a
PipelineRun shows up as per-task checks on the commit: every context is set to `pending`
before the DAG starts, each task reports its own result as it finishes, and a `finally`
task reconciles anything left pending because its task was skipped, OOMKilled, evicted or
timed out.

## Install

```bash
npm install @pfenerty/tektonic-reporter-github
```

`@pfenerty/tektonic` is a **peer** dependency, deliberately: a reporter is matched to its
tasks by object identity, and two copies of the core package are two incompatible sets of
classes. Your project pins the version; this package follows it.

## Use

```ts
import { Task } from '@pfenerty/tektonic';
import { GitHubStatusReporter } from '@pfenerty/tektonic-reporter-github';

// Under PAC, reuse the git-auth token from the pod env rather than injecting a
// github-token secret into every step.
const statusReporter = new GitHubStatusReporter({ skipTokenInjection: true });

new Task({ name: 'test', statusReporter, steps: [/* … */] });
```

The task's `statusContext` (defaulting to its name) becomes the GitHub check name. The
reporter needs `repo-full-name` and `revision` params, which it merges into every task that
uses it; `TektonicProject` binds both from PAC.

The status steps POST with nushell's `http post`, so they need an image providing `nushell`.
They resolve through the project's `injectedStepImage` and synthesis fails naming the
capability if it does not declare one — pass `image` to override per reporter.

## Exports

| Export | What it is |
|---|---|
| `GitHubStatusReporter` | The `StatusReporter` implementation |
| `GitHubStatusReporterOptions` | Constructor options |
| `statusParam(taskName)` | The `$(tasks.<name>.status)` param its reconciler task binds |

## Why it is a separate package

Because nothing else proves the `StatusReporter` seam works. This package imports only
`@pfenerty/tektonic`'s published surface — a build-time check enforces it — so anything a
third-party reporter would need and cannot reach fails here first. See
[docs/status-reporters.md](../../docs/status-reporters.md) to write your own.

## License

[Apache-2.0](../../LICENSE)
