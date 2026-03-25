import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import { AppServerEngine } from '../../engines/app-server.js';
import { ClaudeEngine } from '../../engines/claude.js';
import { Engine, type EngineOptions, type EngineResult } from '../../engines/base.js';
import { gitCheckpoint } from '../checkpoint.js';
import { metricExtractor, shellChecks } from '../evaluators.js';
import { resolveHandoffFingerprint } from '../handoff.js';
import { continueUntilPass, plateauMetric } from '../policies.js';
import { createRoute, createRuntimeRoute } from '../recipe.js';
import { runRoute, eventLog } from '../runner.js';
import { createSimpleRoute } from '../simple.js';

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

    const recipe = createRuntimeRoute({
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

    const summary = await runRoute({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(1);
    expect(readFileSync(join(cwd, 'status.txt'), 'utf-8')).toBe('pass\n');
  });

  it('resolves relative run.cwd from the exec cwd even when the recipe path is temporary', async () => {
    const cwd = createGitRepo('melos-exec-run-cwd-');
    mkdirSync(join(cwd, 'api'));
    writeFileSync(join(cwd, 'api', 'status.txt'), 'fail\n', 'utf-8');
    writeFileSync(join(cwd, 'api', 'check.js'), `
      const { readFileSync } = require('node:fs');
      const content = readFileSync(__dirname + '/status.txt', 'utf-8');
      process.exit(content.includes('pass') ? 0 : 1);
    `, 'utf-8');
    execSync('git add .', { cwd, stdio: 'ignore' });
    execSync('git commit -m "test: seed api fixture"', { cwd, stdio: 'ignore' });

    const engine = new ScriptedEngine([
      async (options) => {
        writeFileSync(join(String(options?.cwd), 'status.txt'), 'pass\n', 'utf-8');
        return { success: true, output: 'updated api', exitCode: 0 };
      },
    ]);

    const recipe = createRuntimeRoute({
      prompt: 'Fix the failing api check',
      context: [],
      run: { engine, cwd: 'api' },
      evaluate: shellChecks(['node check.js']),
      policy: continueUntilPass(),
      limits: { maxIterations: 3 },
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRoute({
      recipe,
      cwd,
      recipePath: '/tmp/melos-generated.ts',
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(readFileSync(join(cwd, 'api', 'status.txt'), 'utf-8')).toBe('pass\n');
  });

  it('compiles declarative check recipes and loops until checks pass', async () => {
    const cwd = createGitRepo('melos-exec-declarative-check-');
    writeFileSync(join(cwd, 'status.txt'), 'fail\n', 'utf-8');
    writeFileSync(join(cwd, 'check.js'), `
      const { readFileSync } = require('node:fs');
      const content = readFileSync(__dirname + '/status.txt', 'utf-8');
      process.exit(content.includes('pass') ? 0 : 1);
    `, 'utf-8');
    execSync('git add .', { cwd, stdio: 'ignore' });
    execSync('git commit -m "test: seed declarative fixture"', { cwd, stdio: 'ignore' });

    const engine = new ScriptedEngine([
      async (options) => {
        writeFileSync(join(String(options?.cwd), 'status.txt'), 'pass\n', 'utf-8');
        return { success: true, output: 'fixed declarative check', exitCode: 0 };
      },
    ]);

    const recipe = createRoute({
      task: 'Fix the failing check',
      context: [],
      run: { engine, cwd },
      check: ['node check.js'],
      limit: 3,
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRoute({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(1);
  });

  it('compiles declarative measure recipes and stops when thresholds are reached', async () => {
    const cwd = createGitRepo('melos-exec-declarative-until-');
    writeFileSync(join(cwd, 'score.json'), JSON.stringify({ score: 0.1 }), 'utf-8');
    execSync('git add score.json', { cwd, stdio: 'ignore' });
    execSync('git commit -m "test: seed declarative metric"', { cwd, stdio: 'ignore' });

    const engine = new ScriptedEngine([
      async (options) => {
        writeFileSync(join(String(options?.cwd), 'score.json'), JSON.stringify({ score: 0.5 }), 'utf-8');
        return { success: true, output: 'score=0.5', exitCode: 0 };
      },
      async (options) => {
        writeFileSync(join(String(options?.cwd), 'score.json'), JSON.stringify({ score: 0.95 }), 'utf-8');
        return { success: true, output: 'score=0.95', exitCode: 0 };
      },
    ]);

    const recipe = createRoute({
      task: 'Improve the score',
      context: [],
      run: { engine, cwd },
      measure: {
        command: `node -e "process.stdout.write(require('fs').readFileSync('score.json', 'utf8'))"`,
      },
      until: { metric: 'score', atLeast: 0.9 },
      limit: 3,
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRoute({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(2);
  });

  it('compiles declarative pass recipes and loops until natural-language criteria pass', async () => {
    const cwd = createGitRepo('melos-exec-declarative-pass-');
    const engine = new ScriptedEngine([
      async () => ({ success: true, output: 'Implemented the change but no final verification yet.', exitCode: 0 }),
      async () => ({ success: true, output: 'Implemented the change and verified the login flow succeeds.', exitCode: 0 }),
    ]);
    const executeSpy = jest.spyOn(AppServerEngine.prototype, 'execute')
      .mockResolvedValueOnce({
        success: true,
        output: JSON.stringify({
          criteria: [
            { criterion: 'Mentions that the login flow succeeds', verdict: 'no', rationale: 'Missing explicit verification.' },
          ],
        }),
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        success: true,
        output: JSON.stringify({
          criteria: [
            { criterion: 'Mentions that the login flow succeeds', verdict: 'yes', rationale: 'Explicit verification is present.' },
          ],
        }),
        exitCode: 0,
      });
    const shutdownSpy = jest.spyOn(AppServerEngine.prototype, 'shutdown').mockResolvedValue();

    const recipe = createRoute({
      task: 'Implement the login flow',
      context: [],
      run: { engine, cwd, model: 'codex-latest' },
      pass: ['Mentions that the login flow succeeds'],
      limit: 3,
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRoute({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(2);
    expect(executeSpy).toHaveBeenCalledTimes(2);

    executeSpy.mockRestore();
    shutdownSpy.mockRestore();
  });

  it('compiles review routes into a built-in review loop contract and stops when blockingCount reaches zero', async () => {
    const cwd = createGitRepo('melos-exec-review-loop-');
    const prompts: string[] = [];
    const engine = new ScriptedEngine([
      async () => {
        writeFileSync(join(cwd, '.melos', 'review-result.json'), JSON.stringify({
          summary: 'found one valid P2',
          blockingCount: 1,
        }), 'utf-8');
        return { success: true, output: 'Found one valid P2 and fixed it.', exitCode: 0 };
      },
      async () => {
        writeFileSync(join(cwd, '.melos', 'review-result.json'), JSON.stringify({
          summary: 'no valid blocking findings remain',
          blockingCount: 0,
        }), 'utf-8');
        return { success: true, output: 'No valid blocking findings remain.', exitCode: 0 };
      },
    ]);
    const executeSpy = jest.spyOn(engine, 'execute').mockImplementation(async (prompt, options) => {
      prompts.push(prompt);
      return await ScriptedEngine.prototype.execute.call(engine, prompt, options);
    });

    const route = createRoute({
      task: 'Review the diff and fix valid P1/P2 findings.',
      context: [],
      run: { engine, cwd },
      review: {},
      limit: 3,
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRoute({
      recipe: route,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(2);
    expect(prompts[0]).toContain('Review Loop Contract');
    expect(prompts[0]).toContain('.melos/review-result.json');
    expect(prompts[0]).toContain('blockingCount');
    expect(prompts[0]).not.toContain('summary: "short summary"');

    executeSpy.mockRestore();
  });

  it('keeps review routes iterative even when limit is omitted', async () => {
    const cwd = createGitRepo('melos-exec-review-default-limit-');
    let executions = 0;
    const engine = new ScriptedEngine([
      async () => {
        executions += 1;
        writeFileSync(join(cwd, '.melos', 'review-result.json'), JSON.stringify({
          summary: 'one blocking finding remains',
          blockingCount: 1,
        }), 'utf-8');
        return { success: true, output: 'Fixed one issue, one remains.', exitCode: 0 };
      },
      async () => {
        executions += 1;
        writeFileSync(join(cwd, '.melos', 'review-result.json'), JSON.stringify({
          summary: 'no blocking findings remain',
          blockingCount: 0,
        }), 'utf-8');
        return { success: true, output: 'No blocking findings remain.', exitCode: 0 };
      },
    ]);

    const route = createRoute({
      task: 'Review the diff and fix valid P1/P2 findings.',
      context: [],
      run: { engine, cwd },
      review: {},
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRoute({
      recipe: route,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(2);
    expect(executions).toBe(2);
  });

  it('generates and saves a final report when report is configured', async () => {
    const cwd = createGitRepo('melos-exec-report-');
    const engine = new ScriptedEngine([
      async () => ({
        success: true,
        output: 'Implemented the login flow and verified the happy path.',
        exitCode: 0,
      }),
    ]);
    const executeSpy = jest.spyOn(ClaudeEngine.prototype, 'execute').mockImplementation(async (prompt, options) => {
      expect(prompt).toContain('Generate the final execution report as strict JSON.');
      expect(prompt).toContain('"changedFiles"');
      expect(prompt).toContain('handoff summary');
      expect(options).toMatchObject({
        cwd,
        model: 'opus',
        effort: 'medium',
        printMode: true,
        skipPermissions: false,
        permissionMode: 'dontAsk',
        suppressTerminalOutput: true,
      });
      expect(typeof options?.appendSystemPrompt).toBe('string');
      expect(options?.appendSystemPrompt).toContain('provided execution evidence');
      expect(typeof options?.jsonSchema).toBe('string');
      return {
        success: true,
        output: JSON.stringify({
          summary: 'Implemented and verified the login flow.',
          changes: ['Added login flow handling.', 'Verified the happy path.'],
          rationale: ['Kept the change focused on the requested scope.'],
          finalState: 'The login flow now succeeds in the happy path.',
          remainingIssues: [],
          userConfirmationNeeded: ['Confirm whether edge-case validation should also be added.'],
        }),
        exitCode: 0,
      };
    });

    const recipe = createRoute({
      task: 'Implement the login flow',
      context: [],
      run: { engine, cwd, model: 'codex-latest' },
      report: { stdout: true },
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRoute({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.reportPath).toBe(join(cwd, '.melos', 'final-report.json'));
    expect(summary.report).toMatchObject({
      summary: 'Implemented and verified the login flow.',
      finalState: 'The login flow now succeeds in the happy path.',
      remainingIssues: [],
      userConfirmationNeeded: ['Confirm whether edge-case validation should also be added.'],
    });
    expect(summary.reportModel).toBe('opus');
    expect(summary.reportDegraded).toBe(false);
    expect(JSON.parse(readFileSync(join(cwd, '.melos', 'final-report.json'), 'utf-8'))).toMatchObject({
      summary: 'Implemented and verified the login flow.',
    });

    executeSpy.mockRestore();
  });

  it('keeps a successful run completed when final report persistence fails', async () => {
    const cwd = createGitRepo('melos-exec-report-write-failure-');
    const engine = new ScriptedEngine([
      async () => ({
        success: true,
        output: 'Implemented the login flow and verified the happy path.',
        exitCode: 0,
      }),
    ]);
    const executeSpy = jest.spyOn(ClaudeEngine.prototype, 'execute').mockResolvedValue({
      success: true,
      output: JSON.stringify({
        summary: 'Implemented and verified the login flow.',
        changes: ['Added login flow handling.', 'Verified the happy path.'],
        rationale: ['Kept the change focused on the requested scope.'],
        finalState: 'The login flow now succeeds in the happy path.',
        remainingIssues: [],
        userConfirmationNeeded: [],
      }),
      exitCode: 0,
    });

    const recipe = createRoute({
      task: 'Implement the login flow',
      context: [],
      run: { engine, cwd, model: 'codex-latest' },
      report: { path: '/dev/null/final-report.json', stdout: true },
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRoute({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.status).toBe('completed');
    expect(summary.report).toBeDefined();
    expect(summary.reportDegraded).toBe(true);
    expect(summary.reportWarning).toMatch(/failed to write final report/i);
    expect(summary.reportPath).toBeUndefined();

    executeSpy.mockRestore();
  });

  it('evaluates check and pass in the same iteration even when checks fail', async () => {
    const cwd = createGitRepo('melos-exec-check-and-pass-');
    writeFileSync(join(cwd, 'status.txt'), 'fail\n', 'utf-8');
    writeFileSync(join(cwd, 'check.js'), `
      const { readFileSync } = require('node:fs');
      const content = readFileSync(__dirname + '/status.txt', 'utf-8');
      process.exit(content.includes('pass') ? 0 : 1);
    `, 'utf-8');
    execSync('git add .', { cwd, stdio: 'ignore' });
    execSync('git commit -m "test: seed combined check/pass fixture"', { cwd, stdio: 'ignore' });

    const engine = new ScriptedEngine([
      async (options) => {
        writeFileSync(join(String(options?.cwd), 'status.txt'), 'fail\n', 'utf-8');
        return { success: true, output: 'Implemented the fix and claim the login flow succeeds.', exitCode: 0 };
      },
      async (options) => {
        writeFileSync(join(String(options?.cwd), 'status.txt'), 'pass\n', 'utf-8');
        return { success: true, output: 'Implemented the fix and verified the login flow succeeds.', exitCode: 0 };
      },
    ]);
    const executeSpy = jest.spyOn(AppServerEngine.prototype, 'execute')
      .mockResolvedValue({
        success: true,
        output: JSON.stringify({
          criteria: [
            { criterion: 'Mentions that the login flow succeeds', verdict: 'yes', rationale: 'The answer explicitly says it succeeds.' },
          ],
        }),
        exitCode: 0,
      });
    const shutdownSpy = jest.spyOn(AppServerEngine.prototype, 'shutdown').mockResolvedValue();

    const recipe = createRoute({
      task: 'Fix the login flow',
      context: [],
      run: { engine, cwd, model: 'codex-latest' },
      check: ['node check.js'],
      pass: ['Mentions that the login flow succeeds'],
      limit: 3,
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRoute({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(2);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(summary.observation?.data).toMatchObject({
      check: expect.anything(),
      pass: expect.objectContaining({
        criteria: [
          expect.objectContaining({ criterion: 'Mentions that the login flow succeeds', verdict: 'yes' }),
        ],
      }),
    });

    executeSpy.mockRestore();
    shutdownSpy.mockRestore();
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

    const recipe = createRuntimeRoute({
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

    const summary = await runRoute({
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

  it('creates a single git commit on stop when configured', async () => {
    const cwd = createGitRepo('melos-exec-commit-stop-');
    writeFileSync(join(cwd, '.gitignore'), '.melos/\n', 'utf-8');
    writeFileSync(join(cwd, 'status.txt'), 'fail\n', 'utf-8');
    writeFileSync(join(cwd, 'check.js'), `
      const { readFileSync } = require('node:fs');
      const content = readFileSync(__dirname + '/status.txt', 'utf-8');
      process.exit(content.includes('pass') ? 0 : 1);
    `, 'utf-8');
    execSync('git add .', { cwd, stdio: 'ignore' });
    execSync('git commit -m "test: seed commit-stop fixture"', { cwd, stdio: 'ignore' });

    const engine = new ScriptedEngine([
      async (options) => {
        writeFileSync(join(String(options?.cwd), 'status.txt'), 'pass\n', 'utf-8');
        return { success: true, output: 'fixed for stop commit', exitCode: 0 };
      },
    ]);

    const recipe = createRoute({
      task: 'Fix the failing check and stop once it passes',
      context: [],
      run: { engine, cwd },
      check: ['node check.js'],
      commit: { when: 'stop' },
      limit: 2,
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRoute({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    const history = execSync('git log --format=%s -2', { cwd, encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/);
    const eventTypes = readFileSync(join(cwd, '.melos', 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).type);
    const nonMelosStatus = execSync("git status --short -- . ':(exclude).melos'", { cwd, encoding: 'utf-8' }).trim();

    expect(summary.success).toBe(true);
    expect(nonMelosStatus).toBe('');
    expect(history[0]).toContain('melos: finalize iteration 1');
    expect(eventTypes).toContain('commit_created');
  });

  it('fails before running when auto-commit is configured on a dirty worktree', async () => {
    const cwd = createGitRepo('melos-exec-commit-dirty-start-');
    writeFileSync(join(cwd, 'status.txt'), 'fail\n', 'utf-8');
    writeFileSync(join(cwd, 'check.js'), `
      const { readFileSync } = require('node:fs');
      const content = readFileSync(__dirname + '/status.txt', 'utf-8');
      process.exit(content.includes('pass') ? 0 : 1);
    `, 'utf-8');
    execSync('git add .', { cwd, stdio: 'ignore' });
    execSync('git commit -m "test: seed dirty-start fixture"', { cwd, stdio: 'ignore' });
    writeFileSync(join(cwd, 'notes.txt'), 'pre-existing user change\n', 'utf-8');

    const engine = new ScriptedEngine([
      async (options) => {
        writeFileSync(join(String(options?.cwd), 'status.txt'), 'pass\n', 'utf-8');
        return { success: true, output: 'fixed for stop commit', exitCode: 0 };
      },
    ]);
    const executeSpy = jest.spyOn(engine, 'execute');

    const recipe = createRoute({
      task: 'Fix the failing check and stop once it passes',
      context: [],
      run: { engine, cwd },
      check: ['node check.js'],
      commit: { when: 'stop' },
      limit: 2,
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRoute({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    const history = execSync('git log --format=%s', { cwd, encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/);

    expect(summary.success).toBe(false);
    expect(summary.iterations).toBe(0);
    expect(summary.summary).toContain('auto-commit requires a clean git worktree');
    expect(summary.reason).toContain('notes.txt');
    expect(executeSpy).not.toHaveBeenCalled();
    expect(readFileSync(join(cwd, 'status.txt'), 'utf-8')).toBe('fail\n');
    expect(history).toHaveLength(1);

    executeSpy.mockRestore();
  });

  it('commits accepted iterations and keeps rollback available for later iterations', async () => {
    const cwd = createGitRepo('melos-exec-commit-accepted-');
    writeFileSync(join(cwd, 'score.json'), JSON.stringify({ score: 0.1 }), 'utf-8');
    execSync('git add score.json', { cwd, stdio: 'ignore' });
    execSync('git commit -m "test: seed accepted-iteration metric"', { cwd, stdio: 'ignore' });

    const scores = [0.5, 0.8, 0.6, 0.8];
    const engine = new ScriptedEngine(scores.map((score) => async (options) => {
      writeFileSync(join(String(options?.cwd), 'score.json'), JSON.stringify({ score }), 'utf-8');
      return { success: true, output: `score=${score}`, exitCode: 0 };
    }));

    const recipe = createRuntimeRoute({
      prompt: 'Improve the metric and keep accepted iterations',
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
      commit: { when: 'accepted-iteration' },
      log: eventLog({ melosDir: join(cwd, '.melos') }),
    });

    const summary = await runRoute({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    const history = execSync('git log --format=%s', { cwd, encoding: 'utf-8' })
      .trim()
      .split(/\r?\n/);
    const eventTypes = readFileSync(join(cwd, '.melos', 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).type);

    expect(summary.success).toBe(false);
    expect(JSON.parse(readFileSync(join(cwd, 'score.json'), 'utf-8')).score).toBeCloseTo(0.8);
    expect(history[0]).toContain('melos: keep iteration 2');
    expect(history[1]).toContain('melos: keep iteration 1');
    expect(history).toHaveLength(3);
    expect(eventTypes.filter((type) => type === 'commit_created')).toHaveLength(2);
    expect(eventTypes).toContain('rollback_applied');
  });

  it('runs simple prompt mode as a one-iteration recipe', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-simple-'));
    const recipe = createSimpleRoute({
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

    const summary = await runRoute({
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

    const recipe = createRuntimeRoute({
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

    const summary = await runRoute({
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

    const recipe = createRuntimeRoute({
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

    const summary = await runRoute({
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

  it('keeps the main codex thread isolated from agent-based ask resolution', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-ask-thread-isolation-'));
    const executeSpy = jest.spyOn(AppServerEngine.prototype, 'execute')
      .mockResolvedValueOnce({ success: true, output: 'initial draft', exitCode: 0 })
      .mockResolvedValueOnce({
        success: true,
        output: JSON.stringify({
          resolved: true,
          answer: 'Use the API token from .env.local.',
          rationale: 'repo context already provides the answer',
        }),
        exitCode: 0,
      })
      .mockResolvedValueOnce({ success: true, output: 'final draft', exitCode: 0 });
    const threadSpy = jest.spyOn(AppServerEngine.prototype, 'getActiveThreadId')
      .mockReturnValueOnce('thr_main')
      .mockReturnValueOnce('thr_resolver')
      .mockReturnValueOnce('thr_main');
    const shutdownSpy = jest.spyOn(AppServerEngine.prototype, 'shutdown').mockResolvedValue();

    const recipe = createRuntimeRoute({
      prompt: 'Ship the fix',
      context: [],
      run: { engine: 'codex', cwd },
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

    const summary = await runRoute({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
      askMode: 'agent-first',
    });

    expect(summary.success).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(3);
    expect(executeSpy.mock.calls[0]?.[1]).not.toHaveProperty('threadId');
    expect(executeSpy.mock.calls[1]?.[1]).not.toHaveProperty('threadId');
    expect(executeSpy.mock.calls[2]?.[1]).toMatchObject({ threadId: 'thr_main' });

    executeSpy.mockRestore();
    threadSpy.mockRestore();
    shutdownSpy.mockRestore();
  });

  it('fails when ask fallback requires a user but stdin is not interactive', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-ask-fail-'));
    const engine = new ScriptedEngine([
      async () => ({ success: true, output: 'need answer', exitCode: 0 }),
      async () => ({ success: true, output: '{"resolved":false,"rationale":"not enough context"}', exitCode: 0 }),
    ]);

    const recipe = createRuntimeRoute({
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

    const summary = await runRoute({
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

    const recipe = createRuntimeRoute({
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

    const summary = await runRoute({
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

    const recipe = createRuntimeRoute({
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

    await runRoute({
      recipe,
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    const fingerprint = resolveHandoffFingerprint({ prompt: 'Ship the fix' });
    expect(fingerprint).not.toBeNull();
    expect(existsSync(join(cwd, '.melos', 'handoff', `sha256-${fingerprint}`, 'iteration-1.json'))).toBe(true);
  });

  it('resolves relative recipe paths against the run cwd for handoff fingerprinting', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-handoff-relative-path-'));
    const recipeDir = join(cwd, 'recipes');
    mkdirSync(recipeDir, { recursive: true });
    writeFileSync(join(recipeDir, 'sample.ts'), 'export default {};\n', 'utf-8');

    const recipe = createRuntimeRoute({
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

    await runRoute({
      recipe,
      cwd,
      recipePath: 'recipes/sample.ts',
      melosDir: join(cwd, '.melos'),
    });

    const fingerprint = resolveHandoffFingerprint({ recipePath: join(cwd, 'recipes', 'sample.ts') });
    expect(fingerprint).not.toBeNull();
    expect(existsSync(join(cwd, '.melos', 'handoff', `sha256-${fingerprint}`, 'iteration-1.json'))).toBe(true);
    expect(existsSync(join(cwd, '.melos', 'handoff', 'sha256-unknown', 'iteration-1.json'))).toBe(false);
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

    const recipe = createRuntimeRoute({
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

    const summary = await runRoute({
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

    const recipe = createRuntimeRoute({
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

    const summary = await runRoute({
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
