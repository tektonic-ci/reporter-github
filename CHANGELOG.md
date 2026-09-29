# Changelog

Notable changes to `@tektonic-ci/reporter-github`. Until 2.1.0 this package lived in
[tektonic-ci/core](https://github.com/tektonic-ci/core) and versioned together with core;
the entries below are the ones from core's changelog that concern it. From here on it
versions on its own, and releases only when it changes
([ADR 0002](https://github.com/tektonic-ci/core/blob/main/docs/adr/0002-npm-scope-and-versioning.md)).

## Unreleased

### Tests: core's conformance kit, and a CI job against core's next release

The test suite runs `assertStatusReporterConformance` from `@tektonic-ci/core/testing` on a
strict and a report-only reporter. Self-CI adds an advisory `test-core-next` task that runs
the same tests with `@tektonic-ci/core@next` installed over the locked core. Its commit status
goes red on a break, but it doesn't fail the run. The dev dependency on core moves to
`^2.2.0`, the first release with the kit. The peer range stays `^2`.

## 2.1.1

### Moved: the package has a repo of its own

The source now lives in `tektonic-ci/reporter-github`, with its history carried over, and
it builds, tests and publishes against `@tektonic-ci/core` from npm. Nothing about the
package's API or output changes.

## 2.1.0

### Renamed: published as `@tektonic-ci/reporter-github`

Was `@pfenerty/tektonic-reporter-github`, which gets no further releases. The peer
dependency is now `@tektonic-ci/core` `^2`. Change the dependency name in `package.json` and
the import:

```ts
import { GitHubStatusReporter } from '@tektonic-ci/reporter-github';
```

### Fixed: reporters differing only in `failOnError` no longer duplicate the pending and reconcile tasks

A pipeline used to build one `set-status-pending-*` and one `reconcile-status-*` task per
reporter *instance*, so a project with a strict and a report-only `GitHubStatusReporter` got
a second pair suffixed `-2` — two extra pods on every run, even though `failOnError` only
changes each task's own final step. `GitHubStatusReporter` now implements core's optional
`pendingGroupKey()` with a key covering everything but `failOnError`, so those reporters
share one pending and one reconcile task. Needs `@tektonic-ci/core` 2.1.0 or later for the
grouping; re-synthesize after upgrading.

### Changed: pending and reconcile tasks run one step

`set-status-pending-*` and `reconcile-status-*` used to carry one step, and so one
container, per context. Each is now a single step, `pending` or `reconcile`, that loops over
the contexts. It still POSTs every one before failing and exits 1 once at the end if any
failed, so one failed POST can't leave the rest unset. `pendingTaskComputeResources` now
sizes that one step. Anything matching the old per-context step names (`pending-<context>`,
`resolve-<context>`) has to move to the new ones.

## 2.0.1

First release as a package of its own, as `@pfenerty/tektonic-reporter-github`.
`GitHubStatusReporter` and `statusParam` were previously exported from
`@pfenerty/tektonic`:

| Was | Is |
|---|---|
| `import { GitHubStatusReporter, statusParam } from '@pfenerty/tektonic'` | `import { GitHubStatusReporter, statusParam } from '@pfenerty/tektonic-reporter-github'` |

The synthesized YAML is byte-identical. The package takes core as a peer dependency so a
project only ever has one copy of it: reporters are matched to their tasks by object
identity.
