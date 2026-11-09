import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Pipeline, Task, sh, stepExitCodePath, stepOutputPath, EXIT_CODE_PATH, type InjectedStepImage } from '@tektonic-ci/core';
import { assertStatusReporterConformance, synthPipeline, synthTask, synthTasks } from '@tektonic-ci/core/testing';
import {
  CHECK_RUN_ID_PATH,
  FILE_LINE_ANNOTATION_PATTERN,
  GitHubChecksReporter,
  checkRunResultName,
  type GitHubChecksReporterOptions,
} from './github-checks-reporter';
import { tektonDashboardUrl } from './github-status-reporter';

const injectedStepImage: InjectedStepImage = { image: 'ghcr.io/example/ci-base:test', provides: ['sh', 'git', 'nushell'] };

const pipelineFor = (reporter: GitHubChecksReporter) => {
  const build = new Task({
    name: 'build',
    statusReporter: reporter,
    statusContext: 'ci/build',
    steps: [{ name: 'compile', image: 'alpine', script: sh`echo hi` }, { name: 'test', image: 'alpine', script: sh`echo hi` }],
  });
  const deploy = new Task({
    name: 'deploy',
    statusReporter: reporter,
    statusContext: 'ci/deploy',
    needs: [build],
    steps: [{ name: 'push', image: 'alpine', script: sh`echo hi` }],
  });
  return new Pipeline({ name: 'ci', tasks: [build, deploy] });
};

type Step = { name: string; script: string; onError?: string; env?: unknown[] };
const stepsOf = (view: { manifest: Record<string, unknown> }) => (view.manifest.spec as { steps: Step[] }).steps;
const stepScript = (view: { manifest: Record<string, unknown> }, name: string) => stepsOf(view).find((s) => s.name === name)!.script;

describe('GitHubChecksReporter', () => {
  describe('wiring', () => {
    it('hands each reporting task its check run ID from the pending task', () => {
      const pipeline = pipelineFor(new GitHubChecksReporter());
      const view = synthPipeline(pipeline);
      expect(view.task('build').params['check-run-id']).toBe(`$(tasks.set-status-pending-ci.results.${checkRunResultName('ci/build')})`);
      expect(view.task('deploy').params['check-run-id']).toBe(`$(tasks.set-status-pending-ci.results.${checkRunResultName('ci/deploy')})`);
    });

    it('declares one result per context on the pending task', () => {
      const tasks = synthTasks(pipelineFor(new GitHubChecksReporter()), { injectedStepImage });
      const results = (tasks['set-status-pending-ci'].manifest.spec as { results: { name: string }[] }).results.map((r) => r.name);
      expect(results).toEqual([checkRunResultName('ci/build'), checkRunResultName('ci/deploy')]);
    });

    it('binds each reconciled task\'s check run ID in the finally task', () => {
      const view = synthPipeline(pipelineFor(new GitHubChecksReporter()));
      const reconcile = view.task('reconcile-status-ci');
      expect(reconcile.params['check-run-build']).toBe(`$(tasks.set-status-pending-ci.results.${checkRunResultName('ci/build')})`);
      expect(reconcile.params['status-deploy']).toBe('$(tasks.deploy.status)');
    });

    it('asks core to capture step output, bounded by logTailBytes', () => {
      expect(new GitHubChecksReporter().captureStepOutput).toEqual({ maxBytes: 32 * 1024 });
      expect(new GitHubChecksReporter({ logTailBytes: 1000 }).captureStepOutput).toEqual({ maxBytes: 1000 });
      const tasks = synthTasks(pipelineFor(new GitHubChecksReporter()), { injectedStepImage });
      expect(stepScript(tasks.build, 'compile')).toContain(stepOutputPath('compile'));
    });

    it('result names are short, valid and stable for any context', () => {
      expect(checkRunResultName('ci/build')).toMatch(/^check-run-[0-9a-f]{10}$/);
      expect(checkRunResultName('say "hi" / ü')).toMatch(/^check-run-[0-9a-f]{10}$/);
      expect(checkRunResultName('ci/build')).toBe(checkRunResultName('ci/build'));
      expect(checkRunResultName('ci/build')).not.toBe(checkRunResultName('ci/test'));
    });

    it('ignores options that only shape the start and final steps when grouping', () => {
      const key = new GitHubChecksReporter().pendingGroupKey();
      expect(new GitHubChecksReporter({ failOnError: false, logTailBytes: 10, annotations: { pattern: FILE_LINE_ANNOTATION_PATTERN } }).pendingGroupKey()).toBe(key);
      expect(new GitHubChecksReporter({ apiUrl: 'https://ghe.example/api/v3' }).pendingGroupKey()).not.toBe(key);
    });

    it('omits GITHUB_TOKEN from every step with skipTokenInjection', () => {
      const tasks = synthTasks(pipelineFor(new GitHubChecksReporter({ skipTokenInjection: true })), { injectedStepImage });
      for (const name of ['set-status-pending-ci', 'reconcile-status-ci']) expect(stepsOf(tasks[name])[0].env ?? []).toHaveLength(0);
      for (const step of ['report-running', 'report-status']) expect(stepsOf(tasks.build).find((s) => s.name === step)!.env ?? []).toHaveLength(0);
    });

    it('never fails a task from the pending, start or reconcile step', () => {
      const tasks = synthTasks(pipelineFor(new GitHubChecksReporter()), { injectedStepImage });
      expect(stepsOf(tasks['set-status-pending-ci'])[0].onError).toBe('continue');
      expect(stepsOf(tasks['reconcile-status-ci'])[0].onError).toBe('continue');
      expect(stepsOf(tasks.build).find((s) => s.name === 'report-running')!.onError).toBe('continue');
    });

    it('re-exits the task\'s exit code only with failOnError', () => {
      const final = (opts: GitHubChecksReporterOptions) => stepScript(synthTask(new Task({ name: 't', steps: [new GitHubChecksReporter(opts).finalStep('c', ['a'])] }), { injectedStepImage }), 'report-status');
      expect(final({})).toContain('exit $exit_code');
      expect(final({ failOnError: false })).not.toContain('exit $exit_code');
    });
  });

  describe('options', () => {
    it.each([0, -1, 1.5, 60_001])('rejects logTailBytes %s', (logTailBytes) => {
      expect(() => new GitHubChecksReporter({ logTailBytes })).toThrow(/logTailBytes/);
    });

    it('rejects an annotation pattern missing a named group', () => {
      expect(() => new GitHubChecksReporter({ annotations: { pattern: '(?P<file>.+):(?P<line>\\d+)' } })).toThrow(/'message'/);
    });

    it('rejects an annotation pattern that would break out of its string or the script', () => {
      expect(() => new GitHubChecksReporter({ annotations: { pattern: "(?P<file>.)(?P<line>.)(?P<message>'#)" } })).toThrow(/may not contain/);
      expect(() => new GitHubChecksReporter({ annotations: { pattern: '(?P<file>.)(?P<line>.)(?P<message>$(x))' } })).toThrow(/may not contain/);
    });
  });

  describe('StatusReporter conformance', () => {
    it.each<[string, GitHubChecksReporterOptions]>([
      ['defaults', {}],
      ['report-only', { failOnError: false }],
      ['details links and annotations', { detailsUrl: tektonDashboardUrl('https://tekton.example'), annotations: { pattern: FILE_LINE_ANNOTATION_PATTERN } }],
    ])('holds with %s', (_, opts) => {
      assertStatusReporterConformance(() => new GitHubChecksReporter(opts), { injectedStepImage });
    });
  });
});

// ─── The scripts, run ────────────────────────────────────────────────────────
// Each step's nushell runs against an in-memory stand-in for the Checks API, with Tekton's
// substitutions and paths replaced the way a TaskRun would.

const hasNu = spawnSync('nu', ['--version']).status === 0;

// nushell's http commands ignore NO_PROXY, so a proxy in the environment would swallow the
// calls to the local fake.
const childEnv = Object.fromEntries([
  ...Object.entries(process.env).filter(([k]) => !/^(https?|all)_proxy$/i.test(k)),
  ['GITHUB_TOKEN', 'ghs_test'],
]);

interface Call { method: string; url: string; body: Record<string, any> | undefined; auth?: string }

class FakeGitHub {
  calls: Call[] = [];
  runs = new Map<string, Record<string, any>>();
  failPosts = false;
  nextId = 1000;
  private server!: Server;
  url = '';

  async start() {
    this.server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = data ? JSON.parse(data) : undefined;
        this.calls.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
        const reply = (status: number, json: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(json));
        };
        const m = req.url!.match(/^\/repos\/acme\/app\/check-runs(?:\/(\d+))?$/);
        if (!m) return reply(404, { message: 'Not Found' });
        if (req.method === 'POST' && !m[1]) {
          if (this.failPosts) return reply(500, { message: 'boom' });
          const id = String(this.nextId++);
          this.runs.set(id, { id: Number(id), ...body });
          return reply(201, this.runs.get(id));
        }
        const run = m[1] && this.runs.get(m[1]);
        if (!run) return reply(404, { message: 'Not Found' });
        if (req.method === 'GET') return reply(200, run);
        if (req.method === 'PATCH') {
          Object.assign(run, body);
          return reply(200, run);
        }
        reply(405, {});
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const addr = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${addr.port}`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  reset() {
    this.calls = [];
    this.runs.clear();
    this.failPosts = false;
    this.nextId = 1000;
  }
}

describe.skipIf(!hasNu)('GitHubChecksReporter scripts, run under nushell', () => {
  const gh = new FakeGitHub();
  let root: string;

  beforeAll(() => gh.start());
  afterAll(() => gh.stop());
  beforeEach(() => {
    gh.reset();
    root = mkdtempSync(join(tmpdir(), 'checks-'));
    return () => rmSync(root, { recursive: true, force: true });
  });

  const reporterOpts = (): GitHubChecksReporterOptions => ({
    apiUrl: gh.url,
    detailsUrl: tektonDashboardUrl('https://tekton.example'),
    annotations: { pattern: FILE_LINE_ANNOTATION_PATTERN, pathPrefix: '/workspace/source' },
  });

  const tasksFor = (opts: GitHubChecksReporterOptions = reporterOpts()) =>
    synthTasks(pipelineFor(new GitHubChecksReporter(opts)), { injectedStepImage });

  // Tekton's substitutions, and /tekton/ moved under the test's directory.
  const run = async (script: string, params: Record<string, string>) => {
    let s = script
      .replace(/\$\(params\.([\w-]+)\)/g, (_, p: string) => {
        if (!(p in params)) throw new Error(`unbound param ${p}`);
        return params[p];
      })
      .replace(/\$\(results\.([\w-]+)\.path\)/g, (_, r: string) => join(root, 'results', r))
      .replace(/\$\(context\.taskRun\.(name|namespace)\)/g, (_, k: string) => (k === 'name' ? 'ci-run-build' : 'ci'))
      .split('/tekton/').join(`${root}/tekton/`);
    expect(s).not.toMatch(/\$\((params|results|context)\./);
    mkdirSync(join(root, 'results'), { recursive: true });
    mkdirSync(join(root, 'tekton', 'home'), { recursive: true });
    const file = join(root, `script-${Math.random().toString(36).slice(2)}.nu`);
    writeFileSync(file, s);
    return new Promise<{ code: number; out: string }>((resolve) => {
      execFile('nu', [file], { env: childEnv }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: stdout + stderr });
      });
    });
  };
  const at = (path: string) => join(root, path.replace(/^\/tekton\//, 'tekton/'));
  const put = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(at(path)), { recursive: true });
    writeFileSync(at(path), content);
  };
  const base = { 'repo-full-name': 'acme/app', revision: 'abc123', 'pipeline-run-name': 'ci-run' };
  const result = (context: string) => readFileSync(join(root, 'results', checkRunResultName(context)), 'utf8');

  it('queues a run per context and writes each ID to its result', async () => {
    const tasks = tasksFor();
    const { code, out } = await run(stepScript(tasks['set-status-pending-ci'], 'pending'), base);
    expect(code, out).toBe(0);
    expect(gh.calls.map((c) => [c.method, c.body?.name, c.body?.status])).toEqual([
      ['POST', 'ci/build', 'queued'],
      ['POST', 'ci/deploy', 'queued'],
    ]);
    expect(gh.calls[0].auth).toBe('token ghs_test');
    expect(gh.calls[0].body).toMatchObject({
      head_sha: 'abc123',
      details_url: 'https://tekton.example/#/namespaces/ci/pipelineruns/ci-run',
    });
    expect([result('ci/build'), result('ci/deploy')]).toEqual(['1000', '1001']);
  });

  it('writes empty results and exits non-zero when it cannot create the runs', async () => {
    gh.failPosts = true;
    const { code } = await run(stepScript(tasksFor()['set-status-pending-ci'], 'pending'), base);
    expect(code).toBe(1);
    expect([result('ci/build'), result('ci/deploy')]).toEqual(['', '']);
  });

  it('takes a passing task from queued to in_progress to success', async () => {
    const tasks = tasksFor();
    await run(stepScript(tasks['set-status-pending-ci'], 'pending'), base);
    const params = { ...base, 'check-run-id': result('ci/build') };

    expect((await run(stepScript(tasks.build, 'report-running'), params)).code).toBe(0);
    expect(gh.runs.get('1000')).toMatchObject({
      status: 'in_progress',
      details_url: 'https://tekton.example/#/namespaces/ci/taskruns/ci-run-build',
    });
    expect(gh.runs.get('1000')!.started_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);

    put(EXIT_CODE_PATH, '0');
    put(stepExitCodePath('compile'), '0');
    put(stepExitCodePath('test'), '0');
    const final = await run(stepScript(tasks.build, 'report-status'), params);
    expect(final.code).toBe(0);
    const runState = gh.runs.get('1000')!;
    expect(runState).toMatchObject({ status: 'completed', conclusion: 'success', output: { title: 'Passed' } });
    expect(runState.output.summary).toBe('| Step | Result |\n| --- | --- |\n| `compile` | passed |\n| `test` | passed |');
    expect(runState.output.text).toBeUndefined();
    expect(gh.calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('posts the failed step\'s output and annotations, then fails the task', async () => {
    const tasks = tasksFor();
    await run(stepScript(tasks['set-status-pending-ci'], 'pending'), base);
    const params = { ...base, 'check-run-id': result('ci/build') };
    await run(stepScript(tasks.build, 'report-running'), params);

    put(EXIT_CODE_PATH, '2');
    put(stepExitCodePath('compile'), '2');
    put(stepOutputPath('compile'), [
      'go build ./...',
      '\u001b[31m/workspace/source/cmd/main.go:12:3: undefined: foo\u001b[0m',
      './internal/x.go:7: missing return',
      'not an annotation: 9',
      '',
    ].join('\n'));
    const final = await run(stepScript(tasks.build, 'report-status'), params);
    expect(final.code).toBe(2);
    const { output, conclusion } = gh.runs.get('1000')!;
    expect(conclusion).toBe('failure');
    expect(output.title).toBe('Failed: step compile exited 2');
    expect(output.summary).toContain('| `compile` | exited 2 |\n| `test` | did not finish |');
    expect(output.summary).toContain('The end of `compile`\'s output is below.');
    expect(output.text).toBe('````text\ngo build ./...\n/workspace/source/cmd/main.go:12:3: undefined: foo\n./internal/x.go:7: missing return\nnot an annotation: 9\n````');
    expect(output.annotations).toEqual([
      { path: 'cmd/main.go', start_line: 12, end_line: 12, annotation_level: 'failure', message: 'undefined: foo' },
      { path: 'internal/x.go', start_line: 7, end_line: 7, annotation_level: 'failure', message: 'missing return' },
    ]);
  });

  it('reports a step\'s output even when its tail starts mid-character', async () => {
    const tasks = tasksFor({ apiUrl: gh.url });
    put(EXIT_CODE_PATH, '1');
    put(stepExitCodePath('compile'), '1');
    put(stepOutputPath('compile'), Buffer.concat([Buffer.from([0xa9]), Buffer.from('caf\u00e9 failed\n')]));
    await run(stepScript(tasks.build, 'report-status'), { ...base, 'check-run-id': '' });
    const created = gh.calls.find((c) => c.method === 'POST')!;
    expect(created.body!.output.text).toContain('café failed');
  });

  it('creates the run from the start step when the pending task could not, and completes that run', async () => {
    const tasks = tasksFor({ apiUrl: gh.url });
    const params = { ...base, 'check-run-id': '' };
    await run(stepScript(tasks.build, 'report-running'), params);
    expect(gh.calls.map((c) => c.method)).toEqual(['POST']);
    expect(readFileSync(at(CHECK_RUN_ID_PATH), 'utf8')).toBe('1000');

    put(EXIT_CODE_PATH, '0');
    await run(stepScript(tasks.build, 'report-status'), params);
    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /repos/acme/app/check-runs',
      'PATCH /repos/acme/app/check-runs/1000',
    ]);
    expect(gh.runs.get('1000')).toMatchObject({ status: 'completed', conclusion: 'success', name: 'ci/build' });
  });

  it('never exits non-zero from the start step', async () => {
    gh.failPosts = true;
    const { code } = await run(stepScript(tasksFor()['build'], 'report-running'), { ...base, 'check-run-id': '' });
    expect(code).toBe(0);
    expect(existsSync(at(CHECK_RUN_ID_PATH))).toBe(false);
  });

  it('concludes skipped and killed tasks and leaves concluded runs alone', async () => {
    const tasks = tasksFor();
    await run(stepScript(tasks['set-status-pending-ci'], 'pending'), base);
    const reconcile = stepScript(tasks['reconcile-status-ci'], 'reconcile');

    // build failed and reported itself; deploy was skipped.
    gh.runs.get('1000')!.status = 'completed';
    gh.runs.get('1000')!.conclusion = 'failure';
    gh.calls = [];
    const r1 = await run(reconcile, {
      ...base,
      'status-build': 'Failed', 'check-run-build': result('ci/build'),
      'status-deploy': 'None', 'check-run-deploy': result('ci/deploy'),
    });
    expect(r1.code).toBe(0);
    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /repos/acme/app/check-runs/1000',
      'GET /repos/acme/app/check-runs/1001',
      'PATCH /repos/acme/app/check-runs/1001',
    ]);
    expect(gh.runs.get('1001')).toMatchObject({ status: 'completed', conclusion: 'skipped', output: { title: 'Skipped' } });
    expect(gh.runs.get('1000')!.conclusion).toBe('failure');

    // build was OOMKilled while running; deploy succeeded.
    gh.runs.get('1000')!.status = 'in_progress';
    gh.calls = [];
    await run(reconcile, {
      ...base,
      'status-build': 'Failed', 'check-run-build': result('ci/build'),
      'status-deploy': 'Succeeded', 'check-run-deploy': result('ci/deploy'),
    });
    expect(gh.calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(gh.runs.get('1000')).toMatchObject({ conclusion: 'failure', output: { title: 'Failed or terminated' } });
  });

  it('creates a concluded run for a context the pending task never created', async () => {
    const reconcile = stepScript(tasksFor()['reconcile-status-ci'], 'reconcile');
    await run(reconcile, { ...base, 'status-build': 'None', 'check-run-build': '', 'status-deploy': 'None', 'check-run-deploy': '' });
    expect(gh.calls.map((c) => [c.method, c.body?.name, c.body?.conclusion])).toEqual([
      ['POST', 'ci/build', 'skipped'],
      ['POST', 'ci/deploy', 'skipped'],
    ]);
  });
});

it('renders a standalone pending task', () => {
  const view = synthTask(new GitHubChecksReporter().createPendingTask(['a', 'b']), { injectedStepImage });
  expect(view.name).toBe('set-status-pending');
});
