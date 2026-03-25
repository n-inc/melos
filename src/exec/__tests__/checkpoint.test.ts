import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitCheckpoint } from '../checkpoint.js';

function createGitRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-checkpoint-'));
  execSync('git init', { cwd, stdio: 'ignore' });
  execSync('git config user.email "melos-test@example.com"', { cwd, stdio: 'ignore' });
  execSync('git config user.name "Melos Test"', { cwd, stdio: 'ignore' });
  writeFileSync(join(cwd, 'tracked.txt'), 'initial\n', 'utf-8');
  execSync('git add tracked.txt', { cwd, stdio: 'ignore' });
  execSync('git commit -m "test: seed"', { cwd, stdio: 'ignore' });
  return cwd;
}

describe('gitCheckpoint', () => {
  it('creates a checkpoint and rolls back to it', async () => {
    const cwd = createGitRepo();
    const checkpoint = gitCheckpoint();
    const ctx = {
      cwd,
      melosDir: join(cwd, '.melos'),
      recipePath: join(cwd, 'recipe.ts'),
      state: {
        iteration: 0,
        phaseExecution: 0,
        startedAt: new Date().toISOString(),
        lastObservation: null,
        bestMetrics: {},
        cwd,
        recipePath: join(cwd, 'recipe.ts'),
        attempts: 0,
        phaseCounts: {},
        outputs: {},
        history: [],
        phaseStates: {},
      },
      previousObservation: null,
    };

    const ref = await checkpoint.create(ctx);
    writeFileSync(join(cwd, 'tracked.txt'), 'changed\n', 'utf-8');
    await checkpoint.rollback(ctx, ref ?? '');

    expect(readFileSync(join(cwd, 'tracked.txt'), 'utf-8')).toBe('initial\n');
  });

  it('keep is a no-op', async () => {
    const cwd = createGitRepo();
    const checkpoint = gitCheckpoint();
    const ctx = {
      cwd,
      melosDir: join(cwd, '.melos'),
      recipePath: join(cwd, 'recipe.ts'),
      state: {
        iteration: 0,
        phaseExecution: 0,
        startedAt: new Date().toISOString(),
        lastObservation: null,
        bestMetrics: {},
        cwd,
        recipePath: join(cwd, 'recipe.ts'),
        attempts: 0,
        phaseCounts: {},
        outputs: {},
        history: [],
        phaseStates: {},
      },
      previousObservation: null,
    };
    const ref = await checkpoint.create(ctx);
    await expect(checkpoint.keep?.(ctx, ref ?? '')).resolves.toBeUndefined();
  });
});
