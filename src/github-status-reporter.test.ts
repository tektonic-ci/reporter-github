import { describe, it, expect } from 'vitest';
import { App, Chart } from 'cdk8s';
import { GitHubStatusReporter } from './github-status-reporter';
import { Task } from '../core/task';

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
      task.synth(chart, 'ns');
      const manifest = chart.toJson()[0] as any;
      for (const step of manifest.spec.steps) {
        expect(step.computeResources).toEqual(resources);
      }
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
      t.synth(chart, 'ns');
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
});
