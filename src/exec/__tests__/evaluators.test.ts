import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import { AppServerEngine } from '../../engines/app-server.js';
import { commandJson, llmEvaluate, metricExtractor, runShellCommand, shellChecks } from '../evaluators.js';
import { normalizeObservation } from '../recipe.js';

function createContext(cwd: string) {
  return {
    cwd,
    melosDir: join(cwd, '.melos'),
    recipePath: join(cwd, 'recipe.ts'),
    state: {
      iteration: 1,
      startedAt: new Date().toISOString(),
      lastObservation: null,
      bestMetrics: {},
      cwd,
      recipePath: join(cwd, 'recipe.ts'),
      attempts: 0,
    },
    previousObservation: null,
    assistantText: '',
    engineResult: {
      success: true,
      output: '',
      exitCode: 0,
    },
  };
}

describe('exec evaluators', () => {
  it('normalizes shell exit code failures', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-evaluator-shell-'));
    const evaluate = shellChecks(['exit 1']);
    const observation = normalizeObservation(await evaluate(createContext(cwd)));
    expect(observation.ok).toBe(false);
    expect(observation.status).toBe('fail');
  });

  it('runs shell checks from an overridden cwd when configured', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-evaluator-shell-cwd-'));
    const apiDir = join(cwd, 'api');
    writeFileSync(join(cwd, 'root.txt'), 'root\n', 'utf-8');
    mkdirSync(apiDir, { recursive: true });
    writeFileSync(join(apiDir, 'ok.txt'), 'api\n', 'utf-8');

    const evaluate = shellChecks([{ command: 'test -f ok.txt', cwd: 'api' }]);
    const observation = normalizeObservation(await evaluate(createContext(cwd)));

    expect(observation.ok).toBe(true);
  });

  it('parses JSON command output', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-evaluator-json-'));
    const evaluate = commandJson({
      command: `node -e "process.stdout.write(JSON.stringify({ score: 0.91 }))"`,
    });
    const observation = normalizeObservation(await evaluate(createContext(cwd)));
    expect(observation.ok).toBe(true);
    expect(observation.metrics.score).toBeCloseTo(0.91);
  });

  it('extracts metrics from command output', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-evaluator-metric-'));
    writeFileSync(join(cwd, 'metrics.json'), JSON.stringify({ score: 0.72 }), 'utf-8');
    const evaluate = metricExtractor({
      command: `node -e "process.stdout.write(require('fs').readFileSync('metrics.json', 'utf8'))"`,
    });
    const observation = normalizeObservation(await evaluate(createContext(cwd)));
    expect(observation.metrics.score).toBeCloseTo(0.72);
  });

  it('normalizes timeout failures', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-evaluator-timeout-'));
    const result = await runShellCommand('sleep 1', { cwd, timeoutMs: 10 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  });

  it('falls back to an available shell when SHELL is not present on the system', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-evaluator-shell-fallback-'));
    const originalShell = process.env.SHELL;
    process.env.SHELL = '/definitely-missing-shell';

    try {
      const result = await runShellCommand('printf "fallback works\\n"', { cwd });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('fallback works');
    } finally {
      if (originalShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = originalShell;
      }
    }
  });

  it('evaluates criteria with an LLM and returns pass only when all answers are yes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-evaluator-llm-pass-'));
    const executeSpy = jest.spyOn(AppServerEngine.prototype, 'execute').mockResolvedValue({
      success: true,
      output: JSON.stringify({
        criteria: [
          { criterion: 'Has evidence', verdict: 'yes', rationale: 'Included benchmarks.' },
          { criterion: 'Has conclusion', verdict: 'yes', rationale: 'Clear recommendation.' },
        ],
      }),
      exitCode: 0,
    });
    const shutdownSpy = jest.spyOn(AppServerEngine.prototype, 'shutdown').mockResolvedValue();

    const evaluate = llmEvaluate({
      criteria: ['Has evidence', 'Has conclusion'],
      engine: 'codex',
    });
    const observation = normalizeObservation(await evaluate({
      ...createContext(cwd),
      assistantText: 'Benchmarks show a 2x improvement. Use the optimized path.',
    }));

    expect(observation.ok).toBe(true);
    expect(observation.status).toBe('pass');
    expect(observation.data).toMatchObject({
      engine: 'codex',
      criteria: [
        { criterion: 'Has evidence', verdict: 'yes' },
        { criterion: 'Has conclusion', verdict: 'yes' },
      ],
    });
    expect(shutdownSpy).toHaveBeenCalledTimes(1);

    executeSpy.mockRestore();
    shutdownSpy.mockRestore();
  });

  it('marks llmEvaluate as failed when any criterion is no', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-evaluator-llm-fail-'));
    const executeSpy = jest.spyOn(AppServerEngine.prototype, 'execute').mockResolvedValue({
      success: true,
      output: JSON.stringify({
        criteria: [
          { criterion: 'Has evidence', verdict: 'yes', rationale: 'Included logs.' },
          { criterion: 'Has conclusion', verdict: 'no', rationale: 'No final recommendation.' },
        ],
      }),
      exitCode: 0,
    });

    const evaluate = llmEvaluate({
      criteria: ['Has evidence', 'Has conclusion'],
      engine: 'codex',
    });
    const observation = normalizeObservation(await evaluate({
      ...createContext(cwd),
      assistantText: 'Collected logs but no recommendation yet.',
    }));

    expect(observation.ok).toBe(false);
    expect(observation.status).toBe('fail');

    executeSpy.mockRestore();
  });

  it('normalizes invalid llmEvaluate JSON output as an error', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-evaluator-llm-error-'));
    const executeSpy = jest.spyOn(AppServerEngine.prototype, 'execute').mockResolvedValue({
      success: true,
      output: 'not-json',
      exitCode: 0,
    });

    const evaluate = llmEvaluate({
      criteria: ['Has evidence'],
      engine: 'codex',
    });
    const observation = normalizeObservation(await evaluate({
      ...createContext(cwd),
      assistantText: 'Collected logs.',
    }));

    expect(observation.ok).toBe(false);
    expect(observation.status).toBe('error');

    executeSpy.mockRestore();
  });

  it('includes provider context in the llmEvaluate prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-evaluator-llm-context-'));
    const executeSpy = jest.spyOn(AppServerEngine.prototype, 'execute').mockResolvedValue({
      success: true,
      output: JSON.stringify({
        criteria: [
          { criterion: 'Mentions benchmark evidence', verdict: 'yes', rationale: 'The answer references it.' },
        ],
      }),
      exitCode: 0,
    });

    const evaluate = llmEvaluate({
      criteria: ['Mentions benchmark evidence'],
      context: [() => ({ title: 'requirements', content: 'must mention benchmark evidence' })],
      engine: 'codex',
    });
    await evaluate({
      ...createContext(cwd),
      assistantText: 'Benchmarks improved by 2x.',
    });

    expect(executeSpy.mock.calls[0]?.[0]).toContain('must mention benchmark evidence');
    executeSpy.mockRestore();
  });

  it('rejects llmEvaluate output when returned criteria do not match the requested set', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-evaluator-llm-invalid-criteria-'));
    const executeSpy = jest.spyOn(AppServerEngine.prototype, 'execute').mockResolvedValue({
      success: true,
      output: JSON.stringify({
        criteria: [
          { criterion: 'Has evidence', verdict: 'yes', rationale: 'Included logs.' },
          { criterion: 'Has evidence', verdict: 'yes', rationale: 'Duplicate criterion.' },
        ],
      }),
      exitCode: 0,
    });

    const evaluate = llmEvaluate({
      criteria: ['Has evidence', 'Has conclusion'],
      engine: 'codex',
    });
    const observation = normalizeObservation(await evaluate({
      ...createContext(cwd),
      assistantText: 'Collected logs.',
    }));

    expect(observation.ok).toBe(false);
    expect(observation.status).toBe('error');
    expect(observation.summary).toBe('llm evaluation returned an invalid criteria payload');

    executeSpy.mockRestore();
  });
});
