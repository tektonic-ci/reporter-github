// Self-CI for @tektonic-ci/reporter-github, synthesized into .tekton/ by `npm run synth`.
//
// Built the way any project consuming tektonic would build its CI: core comes from npm,
// and the reporter reporting on these tasks is this package's own build output, so every
// run exercises the code under test end to end.
import {
    Task,
    GitPipeline,
    TektonicProject,
    TRIGGER_EVENTS,
    DEFAULT_BASE_IMAGE,
    Workspace,
    sh,
} from "@tektonic-ci/core";
import { GitHubStatusReporter, tektonDashboardUrl } from "./dist/index.js";

// ─── Images ──────────────────────────────────────────────────────────────────
const nodeImage = "ghcr.io/pfenerty/apko-cicd/nodejs:24";

// ─── Status reporter ─────────────────────────────────────────────────────────
// Under PAC, reuse the git-auth token via the pod env (see podTemplateEnv below)
// instead of injecting a separate github-token secret per step. Each commit status links
// to its TaskRun (pending and reconciled ones to the PipelineRun) on the tailnet-only
// Tekton Dashboard that homelab runs.
const detailsUrl = tektonDashboardUrl("https://tekton-dashboard.bear-velociraptor.ts.net");
const statusReporter = new GitHubStatusReporter({ skipTokenInjection: true, detailsUrl });

// ─── Cache workspace ────────────────────────────────────────────────────────
// CI runs on the homelab Talos cluster, beside core's. The claim this workspace binds
// (`reporter-github-cache`, on local-path) is created by homelab, along with the PAC
// Repository and the `tekton-triggers` ServiceAccount; tektonic emits only the reference.
const cacheWs = new Workspace({ name: "cache" });

const npmCache = {
    name: "npm",
    key: ["package-lock.json"],
    paths: ["node_modules"],
    workspace: cacheWs,
    compress: true,
    workingDir: "$(workspaces.workspace.path)",
};

// ─── Tasks ───────────────────────────────────────────────────────────────────
const npmTest = new Task({
    name: "test-npm",
    statusReporter,
    caches: [npmCache],
    steps: [
        {
            // The cache is keyed on package-lock.json, so a package.json change whose lock
            // refresh failed would restore the old node_modules and test against it. This
            // dry run fails the build on that drift instead.
            name: "check-lockfile",
            image: nodeImage,
            workingDir: "$(workspaces.workspace.path)",
            script: sh`
                if npm ci --dry-run --ignore-scripts --no-audit --no-fund >/dev/null 2>&1; then
                  echo "check-lockfile: package-lock.json is in sync with package.json"
                  exit 0
                fi
                echo "check-lockfile: package-lock.json does not match package.json" >&2
                echo "check-lockfile: run 'npm install' and commit the updated lock file" >&2
                npm ci --dry-run --ignore-scripts --no-audit --no-fund >&2
            `,
        },
        {
            name: "test",
            image: nodeImage,
            workingDir: "$(workspaces.workspace.path)",
            script: sh`
                set -e
                if [ ! -d node_modules ]; then npm ci; fi
                npm test
            `,
        },
        {
            // .tekton/ is generated from this file. `tektonic check` synthesizes into a temp
            // dir and diffs against what is committed, so drift turns the check red.
            name: "check-manifests",
            image: nodeImage,
            workingDir: "$(workspaces.workspace.path)",
            script: sh`
                set -e
                if [ ! -d node_modules ]; then npm ci; fi
                npm run check
            `,
        },
    ],
});

const npmBuild = new Task({
    name: "build-npm",
    needs: [npmTest],
    statusReporter,
    caches: [npmCache],
    steps: [
        {
            // Packs as well as builds, so a broken `files` list fails here rather than on
            // the registry.
            name: "build",
            image: nodeImage,
            workingDir: "$(workspaces.workspace.path)",
            script: sh`
                set -e
                if [ ! -d node_modules ]; then npm ci; fi
                npm run build
                npm pack --dry-run
            `,
        },
    ],
});

// Runs the tests, conformance kit included, against core's prerelease channel, so a core
// change that breaks this reporter shows up before it reaches `latest`. Advisory: the
// report-only reporter turns this task's commit status red but leaves the run green.
const reportOnlyReporter = new GitHubStatusReporter({ skipTokenInjection: true, failOnError: false, detailsUrl });

const coreNextTest = new Task({
    name: "test-core-next",
    statusReporter: reportOnlyReporter,
    steps: [
        {
            // Works on a copy with its own node_modules: installing core@next into the
            // shared checkout would swap it under test-npm and build-npm running beside it,
            // and would land in the npm cache, which is keyed on the lock file alone.
            name: "test",
            image: nodeImage,
            workingDir: "$(workspaces.workspace.path)",
            script: sh`
                set -e
                dir=$(mktemp -d)
                tar --exclude=node_modules -cf - . | tar -xf - -C "$dir"
                cd "$dir"
                npm ci
                # Core moves "next" only on a prerelease, so after a stable release it trails
                # "latest" and would test an older core than the lock file. Take the newer.
                next=$(npm view @tektonic-ci/core@next version)
                latest=$(npm view @tektonic-ci/core@latest version)
                core=$(node -e '
                    const key = (v) => { const [rel, pre] = v.split("-"); return [...rel.split(".").map(Number), pre === undefined ? 1 : 0]; };
                    const [a, b] = process.argv.slice(1);
                    const [ka, kb] = [key(a), key(b)];
                    const i = ka.findIndex((x, j) => x !== kb[j]);
                    console.log(i === -1 || ka[i] > kb[i] ? a : b);
                ' "$next" "$latest")
                echo "core@next is $next, core@latest is $latest: testing $core"
                npm install --no-save "@tektonic-ci/core@$core"
                npm ls @tektonic-ci/core
                npm test
            `,
        },
    ],
});

// ─── Pipelines ───────────────────────────────────────────────────────────────
const pushPipeline = new GitPipeline({
    name: "npm-push",
    trigger: { rules: [{ on: TRIGGER_EVENTS.PUSH }] },
    tasks: [npmTest, coreNextTest],
});

const prPipeline = new GitPipeline({
    name: "npm-pull-request",
    trigger: { rules: [{ on: TRIGGER_EVENTS.PULL_REQUEST }] },
    tasks: [npmTest, npmBuild, coreNextTest],
});

// ─── Synthesize ──────────────────────────────────────────────────────────────
new TektonicProject({
    name: "reporter-github",
    namespace: "tektonic-ci",
    pipelines: [pushPipeline, prPipeline],
    outdir: ".tekton",
    workspaceStorageSize: "1Gi",
    // The cluster's default class, nfs-client, has no running provisioner.
    workspaceStorageClass: "local-path",
    caches: [{ workspace: cacheWs, storageSize: "2Gi", storageClassName: "local-path" }],
    // The compressed cache and the status reporter need nushell, tar and zstd in the
    // injected steps; the library's own fallback image has only sh and git.
    injectedStepImage: DEFAULT_BASE_IMAGE,
    podTemplateEnv: [
        {
            name: "GITHUB_TOKEN",
            valueFrom: {
                secretKeyRef: { name: "{{ git_auth_secret }}", key: "git-provider-token" },
            },
        },
    ],
});
