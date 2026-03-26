import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearConfiguredRunArtifacts, clearStaleRunArtifacts, shouldResetRunArtifacts } from '../index.js';
import { createRoute } from '../recipe.js';

describe('exec index', () => {
  it('clears stale workflow and final report artifacts before a new run', () => {
    const melosDir = join(mkdtempSync(join(tmpdir(), 'melos-exec-index-')), '.melos');
    mkdirSync(melosDir, { recursive: true });
    writeFileSync(join(melosDir, 'review-result.json'), '{"blockingCount":0}\n', 'utf-8');
    writeFileSync(join(melosDir, 'final-report.json'), '{"summary":"old"}\n', 'utf-8');
    writeFileSync(join(melosDir, 'events.jsonl'), '{"seq":1}\n', 'utf-8');

    clearStaleRunArtifacts(melosDir);

    expect(existsSync(join(melosDir, 'review-result.json'))).toBe(false);
    expect(existsSync(join(melosDir, 'final-report.json'))).toBe(false);
    expect(existsSync(join(melosDir, 'events.jsonl'))).toBe(true);
  });

  it('clears configured file-produce artifacts and report artifacts before a new run', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-configured-'));
    const reviewPath = join(cwd, 'artifacts', 'review.json');
    const reportPath = join(cwd, 'reports', 'final.json');
    mkdirSync(join(cwd, 'artifacts'), { recursive: true });
    mkdirSync(join(cwd, 'reports'), { recursive: true });
    writeFileSync(reviewPath, '{"blockingCount":0}\n', 'utf-8');
    writeFileSync(reportPath, '{"summary":"old"}\n', 'utf-8');

    clearConfiguredRunArtifacts(cwd, createRoute({
      run: { engine: 'auto' },
      workflow: {
        start: 'review',
        phases: {
          review: {
            task: 'Review the work',
            validate: {
              llm: ['Review says the work is complete'],
            },
            produce: { from: { file: 'artifacts/review.json' } },
            on: {
              pass: 'stop',
              fail: 'stop',
            },
          },
        },
      },
      report: { path: 'reports/final.json' },
    }));

    expect(existsSync(reviewPath)).toBe(false);
    expect(existsSync(reportPath)).toBe(false);
  });

  it('clears file-produce artifacts relative to the phase run cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-configured-phase-cwd-'));
    const phaseDir = join(cwd, 'review-phase');
    const artifactPath = join(phaseDir, 'artifacts', 'review.json');
    mkdirSync(join(phaseDir, 'artifacts'), { recursive: true });
    writeFileSync(artifactPath, '{"blockingCount":0}\n', 'utf-8');

    clearConfiguredRunArtifacts(cwd, createRoute({
      run: { engine: 'auto' },
      workflow: {
        start: 'review',
        phases: {
          review: {
            task: 'Review the work',
            run: { cwd: 'review-phase' },
            validate: {
              llm: ['Review says the work is complete'],
            },
            produce: { from: { file: 'artifacts/review.json' } },
            on: {
              pass: 'stop',
              fail: 'stop',
            },
          },
        },
      },
    }));

    expect(existsSync(artifactPath)).toBe(false);
  });

  it('clears the default final report artifact before a new run when report is omitted', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-default-report-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const reportPath = join(melosDir, 'final-report.json');
    writeFileSync(reportPath, '{"summary":"old"}\n', 'utf-8');

    clearConfiguredRunArtifacts(cwd, createRoute({
      run: { engine: 'auto' },
      workflow: {
        start: 'research',
        phases: {
          research: {
            task: 'Research the topic',
            on: { pass: 'stop' },
          },
        },
      },
    }));

    expect(existsSync(reportPath)).toBe(false);
  });

  it('skips artifact reset when resuming from a later phase', () => {
    expect(shouldResetRunArtifacts({
      route: '/tmp/sample.ts',
      startPhase: 'write',
    })).toBe(false);
  });

  it('resets artifacts for a fresh run without startPhase', () => {
    expect(shouldResetRunArtifacts({
      route: '/tmp/sample.ts',
    })).toBe(true);
  });
});
