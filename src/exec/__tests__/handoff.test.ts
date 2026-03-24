import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type IterationHandoff,
  readHandoffHistory,
  readLatestHandoff,
  resolveHandoffFingerprint,
  SAFE_PROMPT_CEILING,
  selectHandoffHistorySection,
  writeIterationHandoff,
} from '../handoff.js';

function createHandoff(overrides: Partial<IterationHandoff> = {}): IterationHandoff {
  return {
    iteration: 1,
    timestamp: '2026-03-24T00:00:00.000Z',
    promptSummary: 'fix auth',
    assistantText: 'updated auth flow',
    observation: { ok: true, status: 'pass', summary: 'done', metrics: {} },
    decision: { kind: 'stop', summary: 'done' },
    attempts: [],
    failures: [],
    insights: [],
    nextSteps: [],
    blockers: [],
    modifiedFiles: ['src/auth.ts'],
    commands: ['pnpm test auth'],
    trace: [],
    resolvedQuestions: [],
    ...overrides,
  };
}

describe('exec handoff', () => {
  it('writes and reads handoff history inside the recipe namespace', () => {
    const melosDir = join(mkdtempSync(join(tmpdir(), 'melos-exec-handoff-ns-')), '.melos');
    const fingerprint = resolveHandoffFingerprint({ prompt: 'Ship the fix' });

    expect(fingerprint).not.toBeNull();
    writeIterationHandoff(melosDir, fingerprint!, createHandoff({ iteration: 1 }));
    writeIterationHandoff(melosDir, fingerprint!, createHandoff({ iteration: 2, promptSummary: 'second pass' }));

    const history = readHandoffHistory(melosDir, fingerprint!);
    const latest = readLatestHandoff(melosDir, fingerprint!);

    expect(history).toHaveLength(2);
    expect(history[0]?.iteration).toBe(1);
    expect(history[1]?.iteration).toBe(2);
    expect(latest?.iteration).toBe(2);
  });

  it('ignores legacy flat handoff files', () => {
    const root = mkdtempSync(join(tmpdir(), 'melos-exec-handoff-flat-ignore-'));
    const melosDir = join(root, '.melos');
    const fingerprint = resolveHandoffFingerprint({ prompt: 'Ship the fix' });
    mkdirSync(join(melosDir, 'handoff'), { recursive: true });
    writeFileSync(join(melosDir, 'handoff', 'iteration-1.json'), JSON.stringify(createHandoff()), 'utf-8');

    expect(readHandoffHistory(melosDir, fingerprint!)).toEqual([]);
    expect(readLatestHandoff(melosDir, fingerprint!)).toBeNull();
  });

  it('uses full history when it fits the prompt budget', () => {
    const melosDir = join(mkdtempSync(join(tmpdir(), 'melos-exec-handoff-full-')), '.melos');
    const fingerprint = 'full-history';
    writeIterationHandoff(melosDir, fingerprint, createHandoff({ iteration: 1 }));

    const decision = selectHandoffHistorySection({
      melosDir,
      fingerprint,
      prompt: 'Iterate with history',
      sections: [],
    });

    expect(decision.mode).toBe('full');
    expect(decision.section?.content).toContain('"assistantText": "updated auth flow"');
  });

  it('falls back to compact summaries when full history exceeds the prompt budget', () => {
    const melosDir = join(mkdtempSync(join(tmpdir(), 'melos-exec-handoff-compact-')), '.melos');
    const fingerprint = 'compact-history';
    writeIterationHandoff(melosDir, fingerprint, createHandoff({
      iteration: 1,
      assistantText: 'x'.repeat(700_000),
      trace: [{ kind: 'agent_message', timestamp: '2026-03-24T00:00:00.000Z', text: 'y'.repeat(100_000) }],
    }));
    writeIterationHandoff(melosDir, fingerprint, createHandoff({
      iteration: 2,
      assistantText: 'z'.repeat(700_000),
      trace: [{ kind: 'agent_message', timestamp: '2026-03-24T00:01:00.000Z', text: 'w'.repeat(100_000) }],
    }));

    const decision = selectHandoffHistorySection({
      melosDir,
      fingerprint,
      prompt: 'Iterate with history',
      sections: [],
      ceiling: SAFE_PROMPT_CEILING,
    });

    expect(decision.mode).toBe('compact');
    expect(decision.section?.content).toContain('"iteration": 1');
    expect(decision.section?.content).not.toContain('"assistantText"');
    expect(decision.section?.content).not.toContain('"trace"');
  });

  it('trims oldest compact summaries when compact history still exceeds the prompt budget', () => {
    const melosDir = join(mkdtempSync(join(tmpdir(), 'melos-exec-handoff-trimmed-')), '.melos');
    const fingerprint = 'trimmed-history';
    writeIterationHandoff(melosDir, fingerprint, createHandoff({
      iteration: 1,
      observation: { ok: false, status: 'fail', summary: 'a'.repeat(400_000), metrics: {} },
    }));
    writeIterationHandoff(melosDir, fingerprint, createHandoff({
      iteration: 2,
      observation: { ok: false, status: 'fail', summary: 'b'.repeat(400_000), metrics: {} },
    }));
    writeIterationHandoff(melosDir, fingerprint, createHandoff({
      iteration: 3,
      observation: { ok: false, status: 'fail', summary: 'c'.repeat(400_000), metrics: {} },
    }));

    const decision = selectHandoffHistorySection({
      melosDir,
      fingerprint,
      prompt: 'Iterate with history',
      sections: [],
      ceiling: SAFE_PROMPT_CEILING,
    });

    expect(decision.mode).toBe('trimmed');
    expect(decision.omittedEntries).toBeGreaterThan(0);
    expect(decision.section?.content).not.toContain('"iteration": 1');
    expect(decision.section?.content).toContain('"iteration": 3');
  });

  it('omits handoff history when even one compact entry exceeds the prompt budget', () => {
    const melosDir = join(mkdtempSync(join(tmpdir(), 'melos-exec-handoff-omitted-')), '.melos');
    const fingerprint = 'omitted-history';
    writeIterationHandoff(melosDir, fingerprint, createHandoff({
      iteration: 1,
      observation: { ok: false, status: 'fail', summary: 'a'.repeat(950_000), metrics: {} },
    }));

    const decision = selectHandoffHistorySection({
      melosDir,
      fingerprint,
      prompt: 'Iterate with history',
      sections: [],
      ceiling: SAFE_PROMPT_CEILING,
    });

    expect(decision.mode).toBe('omitted');
    expect(decision.section).toBeNull();
    expect(decision.includedEntries).toBe(0);
  });
});
