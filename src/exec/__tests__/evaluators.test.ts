import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import { AppServerEngine } from '../../engines/app-server.js';
import { commandJson, llmEvaluate, metricExtractor, runShellCommand, shellChecks } from '../evaluators.js';
import { file } from '../providers.js';
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
    writeFileSync(join(cwd, 'REQUIREMENTS.md'), 'must mention benchmark evidence\n', 'utf-8');
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
      context: [file('REQUIREMENTS.md')],
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
