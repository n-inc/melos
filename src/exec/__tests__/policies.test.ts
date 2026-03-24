import { askDecision, continueUntilPass, plateauMetric, rollbackDecision } from '../policies.js';

function createContext() {
  return {
    cwd: process.cwd(),
    melosDir: `${process.cwd()}/.melos`,
    recipePath: `${process.cwd()}/recipe.ts`,
    state: {
      iteration: 2,
      startedAt: new Date().toISOString(),
      lastObservation: null,
      bestMetrics: { score: 0.8 },
      checkpointRef: 'refs/melos/exec/test',
      cwd: process.cwd(),
      recipePath: `${process.cwd()}/recipe.ts`,
      attempts: 1,
    },
    previousObservation: null,
    assistantText: '',
    engineResult: {
      success: true,
      output: '',
      exitCode: 0,
    },
    recipe: {
      prompt: 'test',
      context: [],
      run: { engine: 'codex' as const },
      evaluate: async () => ({ ok: true, summary: 'ok' }),
      policy: async () => ({ kind: 'stop' as const }),
      limits: { patience: 2 },
    },
  };
}

describe('exec policies', () => {
  it('stops when continueUntilPass sees a passing observation', async () => {
    const policy = continueUntilPass();
    const decision = await policy({
      ...createContext(),
      observation: { ok: true, status: 'pass', summary: 'done', metrics: {} },
    });
    expect(decision.kind).toBe('stop');
  });

  it('returns rollback on metric regression', async () => {
    const policy = plateauMetric('score', { rollbackOnRegression: true, patience: 3 });
    const decision = await policy({
      ...createContext(),
      observation: { ok: false, status: 'fail', summary: 'regressed', metrics: { score: 0.6 } },
    });
    expect(decision.kind).toBe('rollback');
  });

  it('returns ask and rollback helpers', () => {
    expect(askDecision('Need input').kind).toBe('ask');
    expect(rollbackDecision({ reason: 'bad change' }).kind).toBe('rollback');
  });
});
