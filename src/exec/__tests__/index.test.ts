import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearConfiguredRunArtifacts, clearStaleRunArtifacts } from '../index.js';
import type { RouteDefinition } from '../recipe.js';

describe('exec index', () => {
  it('clears stale review and final report artifacts before a new run', () => {
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

  it('clears configured review and report artifacts before a new run', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-configured-'));
    const reviewPath = join(cwd, 'artifacts', 'review.json');
    const reportPath = join(cwd, 'reports', 'final.json');
    mkdirSync(join(cwd, 'artifacts'), { recursive: true });
    mkdirSync(join(cwd, 'reports'), { recursive: true });
    writeFileSync(reviewPath, '{"blockingCount":0}\n', 'utf-8');
    writeFileSync(reportPath, '{"summary":"old"}\n', 'utf-8');

    clearConfiguredRunArtifacts(cwd, {
      review: { path: 'artifacts/review.json' },
      report: { path: 'reports/final.json' },
    } as unknown as RouteDefinition);

    expect(existsSync(reviewPath)).toBe(false);
    expect(existsSync(reportPath)).toBe(false);
  });
});
