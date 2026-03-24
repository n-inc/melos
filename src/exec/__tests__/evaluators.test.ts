import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commandJson, metricExtractor, runShellCommand, shellChecks } from '../evaluators.js';
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
});
