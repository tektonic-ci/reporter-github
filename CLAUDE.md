# @tektonic-ci/reporter-github

GitHub Commit Status reporter for [tektonic](https://github.com/tektonic-ci/core). A
`StatusReporter` built only against `@tektonic-ci/core`'s published surface, from npm, the
way a third-party provider would be.

## Dev environment

Tooling comes from [Flox](https://flox.dev). Outside an activated shell, prefix commands
with `flox activate --`.

| Action | Command |
|---|---|
| Install | `npm install` |
| Test (typecheck + vitest) | `npm test` |
| Build | `npm run build` |
| Re-generate `.tekton/` | `npm run synth` |
| Check `.tekton/` is current | `npm run check` |

## Compatibility with core

- `@tektonic-ci/core` is a **peer** dependency (`^2`) plus a dev dependency for building
  and testing. Widening the peer range to a new core major is a release of its own
  ([ADR 0002](https://github.com/tektonic-ci/core/blob/main/docs/adr/0002-npm-scope-and-versioning.md)).
- Import only what core exports from its package root and `@tektonic-ci/core/testing`.
  If something a reporter needs isn't exported, that is a core change, not a workaround here.

## CI and releases

- CI is tektonic: `.tekton/` is synthesized from `self-ci.ts` and run by Pipelines as Code
  on the homelab cluster. The Repository CR, ServiceAccount and cache claim
  (`reporter-github-cache`) live in homelab. Don't add GitHub Actions for CI.
- `.github/workflows/publish.yml` is the one exemption, because npm trusted publishing only
  accepts hosted OIDC issuers. Pushing a `vX.Y.Z` tag that matches `package.json` stages the
  release with provenance; approve it with `npm stage approve <stage-id> --auth-type=web`
  (npm 11.19+, which the flox environment has).
- Agent sessions can't write under `.github/workflows/`: hand such changes to a human as a
  patch.
- Record changes under `## Unreleased` in `CHANGELOG.md`.

## Issue tracking

Beads (`bd`), configured in `.beads/`. Use `bd update <id> --append-notes`, not `--notes`
(which replaces). Commit before `bd close`, with the issue ID in the message.
