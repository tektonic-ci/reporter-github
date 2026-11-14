import { describe, it, expect } from 'vitest';
import { Pipeline, Task, type InjectedStepImage } from '@tektonic-ci/core';
import { assertStatusReporterConformance, synthPipeline, synthTasks } from '@tektonic-ci/core/testing';
import {
  CHECK_RUN_ID_PARAM,
  CHECK_RUN_ID_PATH,
  DEFAULT_ANNOTATION_PATTERN,
  GitHubChecksReporter,
  MAX_CHECK_OUTPUT_BYTES,
  checkRunResultName,
} from './github-checks-reporter';
import { GitHubStatusReporter, PIPELINE_RUN_PARAM, tektonDashboardUrl } from './github-status-reporter';

// A plain string names a project image that provides everything an injected step needs.
const injectedStepImage: InjectedStepImage = 'ghcr.io/example/ci-base:test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

const pipelineWith = (reporter: GitHubChecksReporter) =>
  new Pipeline({
    name: 'ci',
    tasks: [
      new Task({
        name: 'go-test',
        statusReporter: reporter,
        statusContext: 'ci/go-test',
        steps: [{ name: 'vet', image: 'go', script: 'go vet' }, { name: 'test', image: 'go', script: 'go test' }],
      }),
      new Task({ name: 'lint', statusReporter: reporter, statusContext: 'ci/lint', steps: [{ name: 'lint', image: 'go', script: 'lint' }] }),
    ],
  });

const synth = (reporter = new GitHubChecksReporter()) => {
  const p = pipelineWith(reporter);
  return { view: synthPipeline(p, { injectedStepImage }), tasks: synthTasks(p, { injectedStepImage }) };
};

const stepScript = (task: { manifest: AnyObj }, step: string): string =>
  task.manifest.spec.steps.find((s: AnyObj) => s.name === step).script;

describe('GitHubChecksReporter', () => {
  describe('check-run ID plumbing', () => {
    it('names results from the context alone, as valid Tekton result names', () => {
      expect(checkRunResultName('ci/go-test')).toBe(checkRunResultName('ci/go-test'));
      expect(checkRunResultName('ci/go-test')).not.toBe(checkRunResultName('ci/lint'));
      expect(checkRunResultName('ci/go test "x"')).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
    });

    it('declares one pending-task result per context', () => {
      const { tasks } = synth();
      const results = (tasks['set-status-pending-ci'].manifest as AnyObj).spec.results.map((r: AnyObj) => r.name);
      expect(results).toEqual([checkRunResultName('ci/go-test'), checkRunResultName('ci/lint')]);
    });

    it('binds each reporting task to its own context\'s result', () => {
      const { view } = synth();
      expect(view.params('go-test')[CHECK_RUN_ID_PARAM]).toBe(
        `$(tasks.set-status-pending-ci.results.${checkRunResultName('ci/go-test')})`,
      );
      expect(view.params('lint')[CHECK_RUN_ID_PARAM]).toBe(
        `$(tasks.set-status-pending-ci.results.${checkRunResultName('ci/lint')})`,
      );
    });

    it('binds the reconciler to every task\'s status and check-run ID', () => {
      const { view } = synth();
      const params = view.params('reconcile-status-ci');
      expect(params['status-go-test']).toBe('$(tasks.go-test.status)');
      expect(params['check-run-go-test']).toBe(
        `$(tasks.set-status-pending-ci.results.${checkRunResultName('ci/go-test')})`,
      );
      expect(params['check-run-lint']).toBe(
        `$(tasks.set-status-pending-ci.results.${checkRunResultName('ci/lint')})`,
      );
    });

    it('writes every result before calling GitHub, so an outage cannot fail the pipeline', () => {
      const script = stepScript(synth().tasks['set-status-pending-ci'], 'pending');
      expect(script.indexOf('"none" | save -f $run.result')).toBeGreaterThan(-1);
      expect(script.indexOf('"none" | save -f $run.result')).toBeLessThan(script.indexOf('gh POST'));
    });

    it('creates the run from the start step when the pending task could not', () => {
      const script = stepScript(synth().tasks['go-test'], 'report-running');
      expect(script).toContain(`param-id "$(params.${CHECK_RUN_ID_PARAM})"`);
      expect(script).toContain('gh POST "/check-runs"');
      expect(script).toContain(`save -f ${CHECK_RUN_ID_PATH}`);
    });

    it('has the final step prefer the start step\'s ID over the param', () => {
      const script = stepScript(synth().tasks['go-test'], 'report-status');
      expect(script).toContain(`open --raw ${CHECK_RUN_ID_PATH}`);
    });
  });

  describe('final step', () => {
    it('re-exits the step exit code unless failOnError is false', () => {
      expect(stepScript(synth().tasks['go-test'], 'report-status')).toMatch(/\nexit \$exit_code$/);
      expect(stepScript(synth(new GitHubChecksReporter({ failOnError: false })).tasks['go-test'], 'report-status'))
        .not.toContain('exit $exit_code');
    });

    it('reads every user step\'s exit code and captured output', () => {
      const script = stepScript(synth().tasks['go-test'], 'report-status');
      expect(script).toContain('/tekton/steps/step-vet/exitCode');
      expect(script).toContain('/tekton/home/.step-output-test');
    });

    it('turns on core\'s step-output capture, and leaves it off with output: false', () => {
      expect(new GitHubChecksReporter().captureStepOutput).toEqual({ maxBytes: MAX_CHECK_OUTPUT_BYTES });
      expect(new GitHubChecksReporter({ output: { maxBytes: 4096 } }).captureStepOutput).toEqual({ maxBytes: 4096 });
      const off = new GitHubChecksReporter({ output: false });
      expect(off.captureStepOutput).toBeUndefined();
      const script = stepScript(synth(off).tasks['go-test'], 'report-status');
      expect(script).not.toContain('### Output of');
      expect(script).toContain('let annotations = []');
    });

    it('rejects an output size GitHub would truncate', () => {
      expect(() => new GitHubChecksReporter({ output: { maxBytes: MAX_CHECK_OUTPUT_BYTES + 1 } })).toThrow(/at most/);
      expect(() => new GitHubChecksReporter({ output: { maxBytes: 0 } })).toThrow(/positive integer/);
    });

    it('parses annotations with the default pattern, a custom one, or none', () => {
      const def = stepScript(synth().tasks['go-test'], 'report-status');
      expect(def).toContain(`parse --regex ${JSON.stringify(DEFAULT_ANNOTATION_PATTERN)}`);
      const custom = stepScript(synth(new GitHubChecksReporter({ annotationPattern: '^(?<path>.+)@(?<line>\\d+) (?<message>.+)$' })).tasks['go-test'], 'report-status');
      expect(custom).toContain('(?<path>.+)@(?<line>');
      const none = stepScript(synth(new GitHubChecksReporter({ annotationPattern: false })).tasks['go-test'], 'report-status');
      expect(none).toContain('let annotations = []');
    });
  });

  describe('default annotation pattern', () => {
    // Exercised with JS's regex engine: the pattern sticks to syntax Rust's regex shares.
    const re = new RegExp(DEFAULT_ANNOTATION_PATTERN);
    it.each([
      ['./internal/api/router.go:42:7: undefined: foo', './internal/api/router.go', '42', 'undefined: foo'],
      ['src/index.ts:3: error TS2304: Cannot find name', 'src/index.ts', '3', 'error TS2304: Cannot find name'],
      ['@scope/pkg/a.js:10:1: x', '@scope/pkg/a.js', '10', 'x'],
    ])('matches %s', (line, path, ln, message) => {
      const m = re.exec(line);
      expect(m?.groups).toMatchObject({ path, line: ln, message });
    });
    it.each(['at 12:30:45 server started', 'https://example.com:443/x: y', '--- FAIL: TestX (0.00s)'])('ignores %s', (line) => {
      expect(re.exec(line)).toBeNull();
    });
  });

  describe('reconciler', () => {
    it('leaves a run its task already completed, and concludes skipped and killed tasks', () => {
      const script = stepScript(synth().tasks['reconcile-status-ci'], 'reconcile');
      expect(script).toContain('(gh GET $"/check-runs/($id)" | get status) == "completed"');
      expect(script).toContain('"skipped"');
      expect(script).toContain('"Failed or terminated"');
    });
  });

  describe('details link', () => {
    it('links queued and reconciled runs to the PipelineRun, running and final ones to the TaskRun', () => {
      const { tasks, view } = synth(new GitHubChecksReporter({ detailsUrl: tektonDashboardUrl('https://dash.example/') }));
      expect(stepScript(tasks['set-status-pending-ci'], 'pending')).toContain(`pipelineruns/$(params.${PIPELINE_RUN_PARAM})`);
      expect(stepScript(tasks['reconcile-status-ci'], 'reconcile')).toContain(`pipelineruns/$(params.${PIPELINE_RUN_PARAM})`);
      expect(stepScript(tasks['go-test'], 'report-running')).toContain('taskruns/$(context.taskRun.name)');
      expect(stepScript(tasks['go-test'], 'report-status')).toContain('taskruns/$(context.taskRun.name)');
      expect(view.params('go-test')[PIPELINE_RUN_PARAM]).toBe('$(context.pipelineRun.name)');
    });

    it('omits details_url when no detailsUrl is set', () => {
      expect(stepScript(synth().tasks['go-test'], 'report-status')).not.toContain('details_url');
    });
  });

  describe('token', () => {
    it('injects GITHUB_TOKEN from the secret, or nothing with skipTokenInjection', () => {
      const env = (r: GitHubChecksReporter) => (r.finalStep('ci/x').env as AnyObj[]) ?? [];
      expect(env(new GitHubChecksReporter({ tokenSecretName: 'app-token' }))[0].valueFrom.secretKeyRef).toEqual({ name: 'app-token', key: 'token' });
      expect(env(new GitHubChecksReporter({ skipTokenInjection: true }))).toEqual([]);
    });

    it('reads PAC\'s per-run token on the reporter steps alone with tokenSecretKey', () => {
      const r = new GitHubChecksReporter({ tokenSecretName: '{{ git_auth_secret }}', tokenSecretKey: 'git-provider-token' });
      const ref = { name: '{{ git_auth_secret }}', key: 'git-provider-token' };
      expect((r.finalStep('ci/x').env as AnyObj[])[0].valueFrom.secretKeyRef).toEqual(ref);
      expect((r.startStep('ci/x').env as AnyObj[])[0].valueFrom.secretKeyRef).toEqual(ref);
      expect((r.createPendingTask(['ci/x']).steps[0].env as AnyObj[])[0].valueFrom.secretKeyRef).toEqual(ref);
      expect(r.pendingGroupKey()).not.toBe(new GitHubChecksReporter({ tokenSecretName: '{{ git_auth_secret }}' }).pendingGroupKey());
    });
  });

  describe('grouping', () => {
    it('shares a pending task between reporters that differ only in final-step options', () => {
      expect(new GitHubChecksReporter({ failOnError: false, output: false }).pendingGroupKey())
        .toBe(new GitHubChecksReporter().pendingGroupKey());
      expect(new GitHubChecksReporter({ tokenSecretName: 'other' }).pendingGroupKey())
        .not.toBe(new GitHubChecksReporter().pendingGroupKey());
    });

    it('keeps a separate pending task from a GitHubStatusReporter in the same pipeline', () => {
      const p = new Pipeline({
        name: 'ci',
        tasks: [
          new Task({ name: 'a', statusReporter: new GitHubChecksReporter(), steps: [{ name: 's', image: 'go', script: 'x' }] }),
          new Task({ name: 'b', statusReporter: new GitHubStatusReporter(), steps: [{ name: 's', image: 'go', script: 'x' }] }),
        ],
      });
      const pending = synthPipeline(p, { injectedStepImage }).taskNames.filter((n) => n.startsWith('set-status-pending'));
      expect(pending).toHaveLength(2);
    });
  });

  describe('conformance', () => {
    it('holds for a strict reporter', () => {
      assertStatusReporterConformance(() => new GitHubChecksReporter(), { injectedStepImage });
    });
    it('holds for a report-only reporter without output', () => {
      assertStatusReporterConformance(() => new GitHubChecksReporter({ failOnError: false, output: false }), { injectedStepImage });
    });
  });
});
