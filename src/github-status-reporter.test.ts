import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { GitHubStatusReporter, statusParam } from './github-status-reporter';
import { EXIT_CODE_PATH, Pipeline, Task, Workspace } from '@pfenerty/tektonic';
import { synthPipeline, synthTask } from '@pfenerty/tektonic/testing';

// The reporter POSTs with nushell `http post`, so its steps resolve to a project image that
// must declare `nushell` — tektonic's neutral fallback does not, by design.
const CAPABLE = { injectedStepImage: 'ghcr.io/example/ci-base:test' } as const;

describe('GitHubStatusReporter', () => {
  describe('createPendingTask()', () => {
    it('creates one step per context', () => {
      const reporter = new GitHubStatusReporter();
      const task = reporter.createPendingTask(['ci/test', 'ci/build']);
      expect(task.steps).toHaveLength(2);
      expect(task.steps[0].name).toBe('pending-ci-test');
      expect(task.steps[1].name).toBe('pending-ci-build');
    });

    it('replaces slashes with dashes in step names', () => {
      const reporter = new GitHubStatusReporter();
      const task = reporter.createPendingTask(['ci/lint/go']);
      expect(task.steps[0].name).toBe('pending-ci-lint-go');
    });

    it('omits computeResources on pending steps when pendingTaskComputeResources is not set', () => {
      const reporter = new GitHubStatusReporter();
      const task = reporter.createPendingTask(['ci/test']);
      expect((task.steps[0] as any).computeResources).toBeUndefined();
    });

    it('applies pendingTaskComputeResources to every pending step', () => {
      const resources = {
        requests: { cpu: '25m', memory: '64Mi' },
        limits: { cpu: '200m', memory: '128Mi' },
      };
      const reporter = new GitHubStatusReporter({ pendingTaskComputeResources: resources });
      const task = reporter.createPendingTask(['ci/test', 'ci/build', 'ci/lint']);
      for (const step of task.steps) {
        expect((step as any).computeResources).toEqual(resources);
      }
    });

    it('pending task synthesizes with computeResources in manifest', () => {
      const resources = {
        requests: { cpu: '25m', memory: '64Mi' },
        limits: { cpu: '200m', memory: '128Mi' },
      };
      const reporter = new GitHubStatusReporter({ pendingTaskComputeResources: resources });
      const task = reporter.createPendingTask(['go-test', 'go-build']);
      const app = new App();
      const chart = new Chart(app, 'test');
      task.synth(chart, 'ns', CAPABLE);
      const manifest = chart.toJson()[0] as any;
      for (const step of manifest.spec.steps) {
        expect(step.computeResources).toEqual(resources);
      }
    });
  });

  describe('createStatusReconcilerTask()', () => {
    it('creates one step per entry, named after the context', () => {
      const reporter = new GitHubStatusReporter();
      const task = reporter.createStatusReconcilerTask([
        { taskName: 'test', context: 'ci/test' },
        { taskName: 'build', context: 'ci/build' },
      ]);
      expect(task.steps).toHaveLength(2);
      expect(task.steps[0].name).toBe('resolve-ci-test');
      expect(task.steps[1].name).toBe('resolve-ci-build');
    });

    it('defaults to the name "reconcile-status"', () => {
      const reporter = new GitHubStatusReporter();
      const task = reporter.createStatusReconcilerTask([{ taskName: 'test', context: 'ci/test' }]);
      expect(task.name).toBe('reconcile-status');
    });

    // Kept so external callers pinned to the older StatusReporter method keep working.
    it('createSkipResolverTask() delegates, keeping its legacy default name', () => {
      const reporter = new GitHubStatusReporter();
      const task = reporter.createSkipResolverTask([{ taskName: 'test', context: 'ci/test' }]);
      expect(task.name).toBe('resolve-skipped-status');
      expect(task.steps).toHaveLength(1);
    });

    const scriptFor = (taskName: string, context: string) => {
      const reporter = new GitHubStatusReporter();
      const task = reporter.createStatusReconcilerTask([{ taskName, context }]);
      const app = new App();
      const chart = new Chart(app, 'test');
      task.synth(chart, 'ns', CAPABLE);
      return (chart.toJson()[0] as any).spec.steps[0].script as string;
    };

    it('acts only on the statuses that mean report-status never ran', () => {
      const script = scriptFor('deploy', 'ci/deploy');
      expect(script).toContain('$(params.status-deploy)');
      expect(script).toContain('if $status not-in ["None" "Failed"]');
      expect(script).toContain('exit 0');
    });

    it('reports a skipped task green and a failed or terminated one red', () => {
      const script = scriptFor('deploy', 'ci/deploy');
      expect(script).toContain('let state = if $status == "None" { "success" } else { "failure" }');
      expect(script).toContain('let desc = if $status == "None" { "Skipped" } else { "Failed or terminated" }');
    });

    // Tekton substitutes $(tasks.*) in a PipelineTask's params, not in a referenced Task's
    // step script. Written inline the status stayed literal and no context was ever resolved.
    it('reads the status from a param instead of inlining $(tasks.X.status) in the script', () => {
      const reporter = new GitHubStatusReporter();
      const task = reporter.createStatusReconcilerTask([{ taskName: 'deploy', context: 'ci/deploy' }]);
      const app = new App();
      const chart = new Chart(app, 'test');
      task.synth(chart, 'ns', CAPABLE);
      expect((chart.toJson()[0] as any).spec.steps[0].script).not.toContain('$(tasks.');
    });

    it('declares a status param per entry alongside the required params', () => {
      const reporter = new GitHubStatusReporter();
      const task = reporter.createStatusReconcilerTask([
        { taskName: 'deploy', context: 'ci/deploy' },
        { taskName: 'test', context: 'ci/test' },
      ]);
      expect(task.params.map(p => p.name)).toEqual([
        'repo-full-name',
        'revision',
        'status-deploy',
        'status-test',
      ]);
    });

    it('binds each status param to $(tasks.X.status) in the pipeline task spec', () => {
      const reporter = new GitHubStatusReporter();
      const task = reporter.createStatusReconcilerTask([{ taskName: 'deploy', context: 'ci/deploy' }]);
      const spec = task._toPipelineTaskSpec([]) as any;
      expect(spec.params).toContainEqual({
        name: 'status-deploy',
        value: '$(tasks.deploy.status)',
      });
    });

    // Status params are supplied by the finally task itself, not by the PipelineRun.
    it('keeps status params out of pipeline-level param inference', () => {
      expect(statusParam('deploy').pipelineExpression).toBe('$(tasks.deploy.status)');
    });

    // A context may contain slashes; a task name never does. Keying the param on the task name
    // keeps it a valid Tekton param reference.
    it('names the status param after the task, not the slash-bearing context', () => {
      const reporter = new GitHubStatusReporter();
      const task = reporter.createStatusReconcilerTask([{ taskName: 'lint-go', context: 'ci/lint/go' }]);
      expect(task.params.map(p => p.name)).toContain('status-lint-go');
      expect(task.params.every(p => !p.name.includes('/'))).toBe(true);
    });

    // Tekton skips every remaining step in a pod after a non-zero step, so without this one
    // failed POST swallows all later contexts.
    it('marks every resolve step onError: continue so one failure cannot cascade', () => {
      const reporter = new GitHubStatusReporter();
      const task = reporter.createStatusReconcilerTask([
        { taskName: 'deploy', context: 'ci/deploy' },
        { taskName: 'test', context: 'ci/test' },
      ]);
      const app = new App();
      const chart = new Chart(app, 'test');
      task.synth(chart, 'ns', CAPABLE);
      for (const step of (chart.toJson()[0] as any).spec.steps) {
        expect(step.onError).toBe('continue');
      }
    });

    it('omits GITHUB_TOKEN env when skipTokenInjection is true', () => {
      const reporter = new GitHubStatusReporter({ skipTokenInjection: true });
      const task = reporter.createStatusReconcilerTask([{ taskName: 'deploy', context: 'ci/deploy' }]);
      expect(task.steps[0].env).toHaveLength(0);
    });
  });

  describe('skipTokenInjection', () => {
    it('omits GITHUB_TOKEN from pending step env when true', () => {
      const reporter = new GitHubStatusReporter({ skipTokenInjection: true });
      const task = reporter.createPendingTask(['ci/test']);
      expect(task.steps[0].env).toHaveLength(0);
    });

    it('omits GITHUB_TOKEN from finalStep env when true', () => {
      const reporter = new GitHubStatusReporter({ skipTokenInjection: true });
      const step = reporter.finalStep('ci/test');
      expect((step as any).env).toHaveLength(0);
    });

    it('includes GITHUB_TOKEN secretKeyRef by default', () => {
      const reporter = new GitHubStatusReporter();
      const task = reporter.createPendingTask(['ci/test']);
      expect(task.steps[0].env).toContainEqual({
        name: 'GITHUB_TOKEN',
        valueFrom: { secretKeyRef: { name: 'github-token', key: 'token' } },
      });
    });
  });

  describe('requiredParams', () => {
    it('includes repo-full-name and revision params', () => {
      const reporter = new GitHubStatusReporter();
      const names = reporter.requiredParams.map(p => p.name);
      expect(names).toContain('repo-full-name');
      expect(names).toContain('revision');
    });
  });

  describe('ScriptLanguage routing', () => {
    const renderFinal = () => {
      const reporter = new GitHubStatusReporter();
      const t = new Task({ name: 'build', steps: [{ name: 'run', image: 'alpine' }], statusReporter: reporter, statusContext: 'ci/build' });
      const app = new App();
      const chart = new Chart(app, 'test');
      t.synth(chart, 'ns', CAPABLE);
      return chart.toJson()[0].spec.steps.find((s: any) => s.name === 'report-status').script;
    };

    it('final step uses the plugin-generated nushell preamble (single shebang, generic log)', () => {
      const script = renderFinal();
      expect(script.match(/#!\/usr\/bin\/env nu/g)).toHaveLength(1);
      expect(script).toContain("def log [msg: string] { print $\"[(date now | format date '%H:%M:%S')] ($msg)\" }");
      // label supplied at the call site, not baked into a per-script def
      expect(script).toContain('report-status [ci/build]: POST');
      // http post logic preserved (kept on nushell)
      expect(script).toContain('http post $url $body');
    });
  });

  describe('failOnError', () => {
    const renderFinalWith = (opts?: ConstructorParameters<typeof GitHubStatusReporter>[0]) => {
      const reporter = new GitHubStatusReporter(opts);
      const t = new Task({ name: 'build', steps: [{ name: 'run', image: 'alpine' }], statusReporter: reporter, statusContext: 'ci/build' });
      const app = new App();
      const chart = new Chart(app, 'test');
      t.synth(chart, 'ns', CAPABLE);
      return chart.toJson()[0].spec.steps.find((s: any) => s.name === 'report-status').script;
    };

    it('re-exits the captured exit code by default (failed step fails the TaskRun)', () => {
      const script = renderFinalWith();
      // the exit follows the POST so GitHub still receives the status
      expect(script).toContain('http post $url $body');
      expect(script.trimEnd().endsWith('exit $exit_code')).toBe(true);
    });

    it('omits the re-exit when failOnError is false (legacy report-only behavior)', () => {
      const script = renderFinalWith({ failOnError: false });
      expect(script).toContain('http post $url $body');
      expect(script).not.toContain('exit $exit_code');
    });
  });

  // The contract file is written by the wrapped script, so a body calling the shell's
  // `exit` — untrappable in nushell — leaves it at a stale 0 and the reporter posts
  // success on a real failure. Tekton's own per-step files are written by the
  // entrypoint and survive that, so the reporter consults both and takes the worst.
  describe('per-step exit codes', () => {
    const renderStepsFor = (task: Task) => {
      const app = new App();
      const chart = new Chart(app, 'test');
      task.synth(chart, 'ns', CAPABLE);
      return chart.toJson()[0].spec.steps as { name: string; script?: string; onError?: string }[];
    };
    const renderFinalFor = (task: Task) =>
      renderStepsFor(task).find((s) => s.name === 'report-status')!.script!;

    const taskWith = (opts: Record<string, unknown>) =>
      new Task({
        name: 'build',
        statusReporter: new GitHubStatusReporter(),
        statusContext: 'ci/build',
        ...opts,
      } as unknown as ConstructorParameters<typeof Task>[0]);

    it('reads the per-step exitCode file for every user step', () => {
      const script = renderFinalFor(
        taskWith({ steps: [{ name: 'compile', image: 'alpine' }, { name: 'verify', image: 'alpine' }] }),
      );
      expect(script).toContain('"/tekton/steps/step-compile/exitCode"');
      expect(script).toContain('"/tekton/steps/step-verify/exitCode"');
    });

    it('takes the worst of the contract file and the per-step codes', () => {
      const script = renderFinalFor(taskWith({ steps: [{ name: 'compile', image: 'alpine' }] }));
      expect(script).toContain(`open --raw ${EXIT_CODE_PATH}`);
      expect(script).toContain('[$contract_code ...$step_codes] | math max');
    });

    it('treats a missing per-step file as 0 so a step that never ran cannot fail the task', () => {
      const script = renderFinalFor(taskWith({ steps: [{ name: 'compile', image: 'alpine' }] }));
      expect(script).toContain('try { open --raw $p | str trim | into int } catch { 0 }');
    });

    it('excludes the injected cache steps, so a failed cache save stays non-fatal', () => {
      const cacheWs = new Workspace({ name: 'npm-cache' });
      const steps = renderStepsFor(
        taskWith({
          steps: [{ name: 'compile', image: 'alpine' }],
          caches: [{ name: 'npm', key: ['package-lock.json'], paths: ['node_modules'], workspace: cacheWs }],
        }),
      );
      const script = steps.find((s) => s.name === 'report-status')!.script!;
      // The cache steps really are steps in the rendered task, so excluding them has to be
      // deliberate. Assert that premise rather than trusting a bare not.toContain, which
      // would also pass if the steps were named something else entirely. The save step is
      // the pointed case: it carries onError:continue so a failed cache write is non-fatal,
      // which is exactly the verdict consulting its exit code would silently overturn.
      const cacheSteps = steps.filter((s) => s.name !== 'compile' && s.name !== 'report-status');
      expect(cacheSteps.map((s) => s.name)).toEqual(['restore-npm-cache', 'save-npm-cache']);
      expect(cacheSteps.find((s) => s.name === 'save-npm-cache')!.onError).toBe('continue');

      expect(script).toContain('"/tekton/steps/step-compile/exitCode"');
      for (const s of cacheSteps) {
        expect(script).not.toContain(`step-${s.name}/exitCode`);
      }
    });
  });
});

describe('consuming tektonic from outside the package', () => {
  // This suite exists because the reporter now lives outside @pfenerty/tektonic, and these
  // are the things that stopped being free when it did. Each one is reachable only through
  // the published surface; if an export is withdrawn, this file stops compiling.

  it('resolves its image through the project, and synthesis names the missing capability', () => {
    const reporting = new Task({
      name: 'c',
      statusReporter: new GitHubStatusReporter(),
      statusContext: 'ci/c',
      steps: [{ name: 's', image: 'alpine' }],
    });
    // The status POSTs use nushell `http post`, so injectedImageRef('nushell') is what the
    // reporter asks the project's image for — not a hardcoded image of its own.
    expect(() => synthTask(reporting)).toThrow(/needs an image providing nushell/);
    expect(() =>
      synthTask(reporting, { injectedStepImage: { image: 'ghcr.io/example/ci:1', provides: ['nushell'] } }),
    ).not.toThrow();
  });

  it('an explicit reporter image beats the project image', () => {
    const view = synthTask(
      new Task({
        name: 'c',
        statusReporter: new GitHubStatusReporter({ image: 'ghcr.io/example/reporter:1' }),
        statusContext: 'ci/c',
        steps: [{ name: 's', image: 'alpine' }],
      }),
      { injectedStepImage: 'ghcr.io/example/ci-base:test' },
    );
    expect(view.step('report-status').image).toBe('ghcr.io/example/reporter:1');
  });

  it('reconciles through a param, because $(tasks.*) stays literal inside a step script', () => {
    const reporter = new GitHubStatusReporter();
    const pipeline = new Pipeline({
      name: 'ci',
      tasks: [
        new Task({
          name: 'deploy',
          statusReporter: reporter,
          steps: [{ name: 's', image: 'alpine', onError: 'continue' }],
        }),
      ],
    });
    const reconcile = synthPipeline(pipeline).task('reconcile-status-ci');
    expect(reconcile.params['status-deploy']).toBe('$(tasks.deploy.status)');
    // ...and the expression must not leak into the pipeline's own interface.
    expect(synthPipeline(pipeline).paramNames).not.toContain('status-deploy');
  });
});
