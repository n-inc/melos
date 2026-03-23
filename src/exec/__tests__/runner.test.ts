import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Engine, type EngineOptions, type EngineResult } from '../../engines/base.js';
import { gitCheckpoint } from '../checkpoint.js';
import { metricExtractor, shellChecks } from '../evaluators.js';
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
});
