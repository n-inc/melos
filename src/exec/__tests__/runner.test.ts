import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import { AppServerEngine } from '../../engines/app-server.js';
import { Engine, type EngineOptions, type EngineResult } from '../../engines/base.js';
import { gitCheckpoint } from '../checkpoint.js';
import { metricExtractor, shellChecks } from '../evaluators.js';
import { resolveHandoffFingerprint } from '../handoff.js';
import { continueUntilPass, plateauMetric } from '../policies.js';
import { createRecipe } from '../recipe.js';
import { runRecipe, eventLog } from '../runner.js';
import { createSimpleRecipe } from '../simple.js';

class ScriptedEngine extends Engine {
  readonly name = 'scripted';

  private index = 0;

  constructor(private readonly steps: Array<(options: EngineOptions | undefined) => Promise<EngineResult> | EngineResult>) {
    super();
  }

  async execute(prompt: string, options?: EngineOptions): Promise<EngineResult> {
    const step = this.steps[this.index] ?? this.steps[this.steps.length - 1];
    this.index += 1;
    return step(options);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function createGitRepo(prefix: string): string {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  execSync('git init', { cwd, stdio: 'ignore' });
  execSync('git config user.email "melos-test@example.com"', { cwd, stdio: 'ignore' });
  execSync('git config user.name "Melos Test"', { cwd, stdio: 'ignore' });
  return cwd;
}

describe('exec runner', () => {
  it('loops until shell checks pass in a fixture repo', async () => {
    const cwd = createGitRepo('melos-exec-ralph-');
    writeFileSync(join(cwd, 'status.txt'), 'fail\n', 'utf-8');
    writeFileSync(join(cwd, 'check.js'), `
      const { readFileSync } = require('node:fs');
      const content = readFileSync(__dirname + '/status.txt', 'utf-8');
      process.exit(content.includes('pass') ? 0 : 1);
    `, 'utf-8');
    writeFileSync(join(cwd, 'build.js'), `
      const { readFileSync } = require('node:fs');
      const content = readFileSync(__dirname + '/status.txt', 'utf-8');
      process.exit(content.includes('pass') ? 0 : 1);
    `, 'utf-8');
    execSync('git add .', { cwd, stdio: 'ignore' });
    execSync('git commit -m "test: seed fixture"', { cwd, stdio: 'ignore' });

    const engine = new ScriptedEngine([
      async (options) => {
        writeFileSync(join(String(options?.cwd), 'status.txt'), 'pass\n', 'utf-8');
        return { success: true, output: 'updated', exitCode: 0 };
      },
    ]);

    const recipe = createRecipe({
      prompt: 'Fix the failing checks',
      context: [],
      run: { engine, cwd },
      evaluate: shellChecks([
        'node check.js',
        'node build.js',
      ]),
      policy: continueUntilPass(),
      limits: { maxIterations: 3 },
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRecipe({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(1);
    expect(readFileSync(join(cwd, 'status.txt'), 'utf-8')).toBe('pass\n');
  });

  it('keeps improvements, rolls back regressions, and stops on patience', async () => {
    const cwd = createGitRepo('melos-exec-autoresearch-');
    writeFileSync(join(cwd, 'score.json'), JSON.stringify({ score: 0.1 }), 'utf-8');
    execSync('git add score.json', { cwd, stdio: 'ignore' });
    execSync('git commit -m "test: seed metric"', { cwd, stdio: 'ignore' });

    const scores = [0.5, 0.8, 0.6, 0.8];
    const engine = new ScriptedEngine(scores.map((score) => async (options) => {
      writeFileSync(join(String(options?.cwd), 'score.json'), JSON.stringify({ score }), 'utf-8');
      return { success: true, output: `score=${score}`, exitCode: 0 };
    }));
    const streamed: string[] = [];
    const log = eventLog({
      melosDir: join(cwd, '.melos'),
      onEvent: (event) => {
        streamed.push(event.type);
      },
    });

    const recipe = createRecipe({
      prompt: 'Improve the metric',
      context: [],
      run: { engine, cwd },
      evaluate: metricExtractor({
        command: `node -e "process.stdout.write(require('fs').readFileSync('score.json', 'utf8'))"`,
        extract: ({ parsedJson }) => ({
          ok: false,
          metrics: {
            score: Number((parsedJson as { score?: number } | undefined)?.score ?? Number.NaN),
          },
        }),
      }),
      policy: plateauMetric('score', { patience: 2, rollbackOnRegression: true }),
      limits: { maxIterations: 4, patience: 2 },
      checkpoint: gitCheckpoint(),
      log,
    });

    const summary = await runRecipe({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    const fileEvents = readFileSync(join(cwd, '.melos', 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).type);

    expect(summary.success).toBe(false);
    expect(summary.iterations).toBe(4);
    expect(streamed).toEqual(fileEvents);
    expect(fileEvents).toContain('rollback_applied');
    expect(JSON.parse(readFileSync(join(cwd, 'score.json'), 'utf-8')).score).toBeCloseTo(0.8);
  });

  it('runs simple prompt mode as a one-iteration recipe', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-simple-'));
    const recipe = createSimpleRecipe({
      prompt: 'Say hello',
      cwd,
    });
    recipe.run.engine = new ScriptedEngine([
      async () => ({
        success: true,
        output: 'hello from simple mode',
        exitCode: 0,
      }),
    ]);
    recipe.log = eventLog({ melosDir: join(cwd, '.melos') });

    const summary = await runRecipe({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(1);
    expect(summary.output).toContain('hello from simple mode');
  });

  it('reuses codex thread ids across iterations', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-thread-'));
    const executeSpy = jest.spyOn(AppServerEngine.prototype, 'execute')
      .mockResolvedValue({ success: true, output: 'iteration output', exitCode: 0 });
    const threadSpy = jest.spyOn(AppServerEngine.prototype, 'getActiveThreadId')
      .mockReturnValue('thr_exec_shared');

    const recipe = createRecipe({
      prompt: 'Keep iterating until pass',
      context: [],
      run: { engine: 'codex', cwd },
      evaluate: ({ state }) => ({
        ok: state.iteration >= 2,
        status: state.iteration >= 2 ? 'pass' : 'fail',
        summary: `iteration-${state.iteration}`,
      }),
      policy: continueUntilPass(),
      limits: { maxIterations: 3 },
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRecipe({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(executeSpy.mock.calls[0]?.[1]).not.toHaveProperty('threadId');
    expect(executeSpy.mock.calls[1]?.[1]).toMatchObject({ threadId: 'thr_exec_shared' });

    executeSpy.mockRestore();
    threadSpy.mockRestore();
  });

  it('resolves ask decisions with the agent and injects resolved questions into the next prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-ask-agent-'));
    const prompts: string[] = [];
    const engine = new ScriptedEngine([
      async (_options) => ({ success: true, output: 'initial draft', exitCode: 0 }),
      async (_options) => ({
        success: true,
        output: JSON.stringify({
          resolved: true,
          answer: 'Use the API token from .env.local.',
          rationale: 'The repo already documents .env.local as the source of truth.',
        }),
        exitCode: 0,
      }),
      async (_options) => ({ success: true, output: 'final draft', exitCode: 0 }),
    ]);
    const executeSpy = jest.spyOn(engine, 'execute').mockImplementation(async (prompt, options) => {
      prompts.push(prompt);
      return await ScriptedEngine.prototype.execute.call(engine, prompt, options);
    });

    const recipe = createRecipe({
      prompt: 'Ship the fix',
      context: [],
      run: { engine, cwd },
      evaluate: ({ state }) => {
        if (state.iteration === 1) {
          return {
            ok: false,
            status: 'fail',
            summary: 'Need to know where the API token comes from',
            question: 'Where should the API token come from?',
          };
        }
        return {
          ok: true,
          status: 'pass',
          summary: 'Resolved after follow-up',
        };
      },
      policy: continueUntilPass(),
      limits: { maxIterations: 3 },
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRecipe({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
      askMode: 'agent-first',
    });

    expect(summary.success).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(3);
    expect(prompts[1]).toContain('Where should the API token come from?');
    expect(prompts[2]).toContain('resolved questions');
    expect(prompts[2]).toContain('Use the API token from .env.local.');
  });

  it('fails when ask fallback requires a user but stdin is not interactive', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-ask-fail-'));
    const engine = new ScriptedEngine([
      async () => ({ success: true, output: 'need answer', exitCode: 0 }),
      async () => ({ success: true, output: '{"resolved":false,"rationale":"not enough context"}', exitCode: 0 }),
    ]);

    const recipe = createRecipe({
      prompt: 'Ship the fix',
      context: [],
      run: { engine, cwd },
      evaluate: () => ({
        ok: false,
        status: 'fail',
        summary: 'Question required',
        question: 'Which API should be used?',
      }),
      policy: continueUntilPass(),
      limits: { maxIterations: 2 },
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRecipe({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
      askMode: 'agent-first',
    });

    expect(summary.success).toBe(false);
    expect(summary.status).toBe('failed');
    expect(summary.summary).toContain('Could not resolve question');
  });

  it('uses the user answer immediately when askMode is always-user', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-ask-user-'));
    const prompts: string[] = [];
    const engine = new ScriptedEngine([
      async () => ({ success: true, output: 'need answer', exitCode: 0 }),
      async () => ({ success: true, output: 'final answer', exitCode: 0 }),
    ]);
    const executeSpy = jest.spyOn(engine, 'execute').mockImplementation(async (prompt, options) => {
      prompts.push(prompt);
      return await ScriptedEngine.prototype.execute.call(engine, prompt, options);
    });

    const recipe = createRecipe({
      prompt: 'Ship the fix',
      context: [],
      run: { engine, cwd },
      evaluate: ({ state }) => state.iteration === 1
        ? {
          ok: false,
          status: 'fail',
          summary: 'Need an API choice',
          question: 'Which API should be used?',
        }
        : {
          ok: true,
          status: 'pass',
          summary: 'Completed',
        },
      policy: continueUntilPass(),
      limits: { maxIterations: 3 },
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRecipe({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
      askMode: 'always-user',
      askUser: async ({ question }) => question === 'Which API should be used?'
        ? 'Use the internal GraphQL API.'
        : null,
    });

    expect(summary.success).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain('resolved questions');
    expect(prompts[1]).toContain('Use the internal GraphQL API.');
  });

  it('keeps handoff artifacts by default', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-handoff-keep-default-'));

    const recipe = createRecipe({
      prompt: 'Ship the fix',
      context: [],
      run: {
        engine: new ScriptedEngine([
          async () => ({ success: true, output: 'done', exitCode: 0 }),
        ]),
        cwd,
      },
      evaluate: () => ({
        ok: true,
        status: 'pass',
        summary: 'Completed',
      }),
      policy: continueUntilPass(),
      limits: { maxIterations: 1 },
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    await runRecipe({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    const fingerprint = resolveHandoffFingerprint({ prompt: 'Ship the fix' });
    expect(fingerprint).not.toBeNull();
    expect(existsSync(join(cwd, '.melos', 'handoff', `sha256-${fingerprint}`, 'iteration-1.json'))).toBe(true);
  });

  it('injects handoff history automatically from the second iteration onward', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-handoff-context-'));
    const prompts: string[] = [];
    const engine = new ScriptedEngine([
      async () => ({ success: true, output: 'first attempt', exitCode: 0 }),
      async () => ({ success: true, output: 'second attempt', exitCode: 0 }),
    ]);
    const executeSpy = jest.spyOn(engine, 'execute').mockImplementation(async (prompt, options) => {
      prompts.push(prompt);
      return await ScriptedEngine.prototype.execute.call(engine, prompt, options);
    });

    const recipe = createRecipe({
      prompt: 'Iterate with history',
      context: [],
      run: { engine, cwd },
      evaluate: ({ state }) => ({
        ok: state.iteration >= 2,
        status: state.iteration >= 2 ? 'pass' : 'fail',
        summary: `iteration-${state.iteration}`,
      }),
      policy: continueUntilPass(),
      limits: { maxIterations: 3 },
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });
    const currentFingerprint = resolveHandoffFingerprint({ prompt: 'Iterate with history' });
    const otherFingerprint = resolveHandoffFingerprint({ prompt: 'Other recipe' });
    mkdirSync(join(cwd, '.melos', 'handoff', `sha256-${otherFingerprint}`), { recursive: true });
    writeFileSync(join(cwd, '.melos', 'handoff', `sha256-${otherFingerprint}`, 'iteration-1.json'), JSON.stringify({
      iteration: 1,
      timestamp: '2026-03-24T00:00:00.000Z',
      promptSummary: 'other namespace history',
      assistantText: 'should never appear',
      observation: { ok: true, status: 'pass', summary: 'other', metrics: {} },
      decision: { kind: 'stop', summary: 'other' },
      attempts: [],
      failures: [],
      insights: [],
      nextSteps: [],
      blockers: [],
      modifiedFiles: [],
      commands: [],
      trace: [],
      resolvedQuestions: [],
    }), 'utf-8');

    const summary = await runRecipe({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(currentFingerprint).not.toBeNull();
    expect(prompts[0]).not.toContain('## handoff history');
    expect(prompts[1]).toContain('## handoff history');
    expect(prompts[1]).toContain('"iteration": 1');
    expect(prompts[1]).not.toContain('other namespace history');
  });

  it('omits handoff history and emits a warning when the prompt budget is exceeded', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-handoff-omit-warning-'));
    const prompts: string[] = [];
    const engine = new ScriptedEngine([
      async () => ({ success: true, output: 'first attempt', exitCode: 0 }),
      async () => ({ success: true, output: 'second attempt', exitCode: 0 }),
    ]);
    const executeSpy = jest.spyOn(engine, 'execute').mockImplementation(async (prompt, options) => {
      prompts.push(prompt);
      return await ScriptedEngine.prototype.execute.call(engine, prompt, options);
    });

    const recipe = createRecipe({
      prompt: 'Iterate with history',
      context: [],
      run: { engine, cwd },
      evaluate: ({ state }) => ({
        ok: state.iteration >= 2,
        status: state.iteration >= 2 ? 'pass' : 'fail',
        summary: state.iteration === 1 ? 'x'.repeat(950_000) : 'done',
      }),
      policy: continueUntilPass(),
      limits: { maxIterations: 2 },
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRecipe({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    const events = readFileSync(join(cwd, '.melos', 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; payload?: Record<string, unknown> });

    expect(summary.success).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(prompts[1]).not.toContain('## handoff history');
    expect(events.some((event) => event.type === 'warning_emitted'
      && event.payload?.warning === 'handoff history omitted due to prompt budget')).toBe(true);
    expect(events.some((event) => {
      const handoffHistory = event.payload?.handoffHistory;
      return event.type === 'context_built'
        && isRecord(handoffHistory)
        && handoffHistory.mode === 'omitted';
    })).toBe(true);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
