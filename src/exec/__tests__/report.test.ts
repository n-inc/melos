import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import { ClaudeEngine } from '../../engines/claude.js';
import { createRoute } from '../recipe.js';
import { generateFinalReport, renderFinalReportText } from '../report.js';

function createGitRepo(prefix: string): string {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  execSync('git init', { cwd, stdio: 'ignore' });
  execSync('git config user.email "melos-test@example.com"', { cwd, stdio: 'ignore' });
  execSync('git config user.name "Melos Test"', { cwd, stdio: 'ignore' });
  return cwd;
}

describe('exec report', () => {
  it('renders a generated report for text output', () => {
    const text = renderFinalReportText({
      summary: 'Implemented and verified the login flow.',
      changes: ['Added the login flow.'],
      rationale: ['Kept the implementation within the requested scope.'],
      finalState: 'The login flow now succeeds.',
      remainingIssues: [],
      userConfirmationNeeded: ['Confirm whether edge-case validation is needed.'],
      evidence: {
        checks: [{ command: 'pnpm test', exitCode: 0, ok: true }],
        pass: [{ criterion: 'Does the final response explain the change?', verdict: 'yes' }],
      },
    }, '/repo/.melos/final-report.json');

    expect(text).toContain('Summary: Implemented and verified the login flow.');
    expect(text).toContain('Changes:');
    expect(text).toContain('Final State: The login flow now succeeds.');
    expect(text).toContain('User Confirmation Needed:');
    expect(text).toContain('Report Path: /repo/.melos/final-report.json');
  });

  it('renders a fallback warning when the report is degraded', () => {
    const text = renderFinalReportText({
      summary: 'Fallback summary.',
      changes: [],
      rationale: ['Claude report generation failed.'],
      finalState: 'Fallback summary.',
      remainingIssues: ['report generation failed'],
      userConfirmationNeeded: [],
    }, '/repo/.melos/final-report.json', { degraded: true });

    expect(text).toContain('Warning: report was generated from fallback data.');
  });

  it('includes staged-only files in the report artifact list', async () => {
    const cwd = createGitRepo('melos-exec-report-staged-');
    mkdirSync(join(cwd, '.melos'));
    writeFileSync(join(cwd, 'tracked.txt'), 'base\n', 'utf-8');
    execSync('git add tracked.txt', { cwd, stdio: 'ignore' });
    execSync('git commit -m "test: seed tracked file"', { cwd, stdio: 'ignore' });

    writeFileSync(join(cwd, 'staged-only.txt'), 'content\n', 'utf-8');
    execSync('git add staged-only.txt', { cwd, stdio: 'ignore' });

    const executeSpy = jest.spyOn(ClaudeEngine.prototype, 'execute').mockImplementation(async (prompt) => {
      expect(prompt).toContain('"changedFiles"');
      expect(prompt).toContain('staged-only.txt');
      return {
        success: true,
        output: JSON.stringify({
          summary: 'Report summary.',
          changes: ['Included staged file.'],
          rationale: ['Needed for final inspection.'],
          finalState: 'Report generated.',
          remainingIssues: [],
          userConfirmationNeeded: [],
        }),
        exitCode: 0,
      };
    });

    const report = await generateFinalReport({
      recipe: createRoute({
        task: 'Summarize the staged change',
        run: { engine: 'auto' },
      }),
      cwd,
      melosDir: join(cwd, '.melos'),
      iterations: 1,
      success: true,
      decision: 'stop',
      summary: 'completed',
      output: 'done',
    });

    expect(report.degraded).toBe(false);
    executeSpy.mockRestore();
  });
});
