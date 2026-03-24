import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  command,
  file,
  gitDiffStat,
  handoffHistory,
  optionalFile,
  previousHandoff,
  previousObservation,
  state,
} from '../providers.js';
import type { ContextSection } from '../recipe.js';
import type { RunnerState } from '../recipe.js';

function createContext(cwd: string, overrides: Partial<RunnerState> = {}) {
  const stateValue: RunnerState = {
    iteration: 2,
    startedAt: new Date().toISOString(),
    lastObservation: null,
    bestMetrics: { score: 0.8 },
    checkpointRef: 'refs/melos/exec/test',
    cwd,
    recipePath: join(cwd, 'recipe.ts'),
    attempts: 1,
    ...overrides,
  };

  return {
    cwd,
    melosDir: join(cwd, '.melos'),
    recipePath: stateValue.recipePath,
    state: stateValue,
    previousObservation: stateValue.lastObservation,
  };
}

function asSection(value: ContextSection | ContextSection[] | null | undefined): ContextSection | null {
  if (!value || Array.isArray(value)) {
    return null;
  }
  return value;
}

describe('exec providers', () => {
  it('renders file and optionalFile content', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-provider-file-'));
    writeFileSync(join(cwd, 'notes.txt'), 'hello provider\n', 'utf-8');

    const requiredSection = await file('notes.txt')(createContext(cwd));
    const optionalSection = await optionalFile('notes.txt')(createContext(cwd));
    const missingSection = await optionalFile('missing.txt')(createContext(cwd));

    expect(asSection(requiredSection)?.content).toContain('hello provider');
    expect(asSection(optionalSection)?.content).toContain('hello provider');
    expect(missingSection).toBeNull();
  });

  it('renders git diff stat and command output', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-provider-git-'));
    execSync('git init', { cwd, stdio: 'ignore' });
    execSync('git config user.email "melos-test@example.com"', { cwd, stdio: 'ignore' });
    execSync('git config user.name "Melos Test"', { cwd, stdio: 'ignore' });
    writeFileSync(join(cwd, 'tracked.txt'), 'before\n', 'utf-8');
    execSync('git add tracked.txt', { cwd, stdio: 'ignore' });
    execSync('git commit -m "test: seed"', { cwd, stdio: 'ignore' });
    writeFileSync(join(cwd, 'tracked.txt'), 'after\n', 'utf-8');

    const diffSection = await gitDiffStat()(createContext(cwd));
    const commandSection = await command('printf "provider command\\n"')(createContext(cwd));

    expect(asSection(diffSection)?.content).toContain('tracked.txt');
    expect(asSection(commandSection)?.content).toContain('provider command');
  });

  it('renders state and previousObservation blocks', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-provider-state-'));
    mkdirSync(join(cwd, '.melos'), { recursive: true });
    const ctx = createContext(cwd, {
      lastObservation: {
        ok: false,
        status: 'fail',
        summary: 'last run failed',
        metrics: { score: 0.4 },
      },
    });

    const stateSection = await state()(ctx);
    const observationSection = await previousObservation()(ctx);

    expect(asSection(stateSection)?.content).toContain('"attempts": 1');
    expect(asSection(observationSection)?.content).toContain('last run failed');
  });

  it('renders previousHandoff and handoffHistory blocks', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-provider-handoff-'));
    const handoffDir = join(cwd, '.melos', 'handoff');
    mkdirSync(handoffDir, { recursive: true });
    writeFileSync(join(handoffDir, 'iteration-1.json'), JSON.stringify({
      iteration: 1,
      timestamp: '2026-03-24T00:00:00.000Z',
      promptSummary: 'fix auth',
      assistantText: 'updated auth flow',
      observation: { ok: false, status: 'fail', summary: 'still failing', metrics: {} },
      decision: { kind: 'continue', summary: 'try again' },
      attempts: [],
      failures: [],
      insights: ['auth is two-step'],
      nextSteps: ['check refresh token'],
      blockers: [],
      modifiedFiles: ['src/auth.ts'],
      commands: ['pnpm test auth'],
      trace: [],
    }), 'utf-8');
    writeFileSync(join(handoffDir, 'iteration-2.json'), JSON.stringify({
      iteration: 2,
      timestamp: '2026-03-24T00:01:00.000Z',
      promptSummary: 'fix auth again',
      assistantText: 'added null check',
      observation: { ok: true, status: 'pass', summary: 'fixed', metrics: {} },
      decision: { kind: 'stop', summary: 'done' },
      attempts: [],
      failures: [],
      insights: ['null refresh token was the issue'],
      nextSteps: [],
      blockers: [],
      modifiedFiles: ['src/auth.ts'],
      commands: ['pnpm test auth'],
      trace: [],
    }), 'utf-8');

    const latestSection = await previousHandoff()(createContext(cwd));
    const historySection = await handoffHistory({ count: 2 })(createContext(cwd));

    expect(asSection(latestSection)?.content).toContain('"iteration": 2');
    expect(asSection(historySection)?.content).toContain('"iteration": 1');
    expect(asSection(historySection)?.content).toContain('"iteration": 2');
  });
});
