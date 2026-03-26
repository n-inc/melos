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
        workflow: {
          outputs: {
            research: { _keys: ['sources'], _size: 27 },
          },
        },
      },
    }, '/repo/.melos/final-report.json');

    expect(text).toContain('Summary: Implemented and verified the login flow.');
    expect(text).toContain('Changes:');
    expect(text).toContain('Final State: The login flow now succeeds.');
    expect(text).toContain('User Confirmation Needed:');
    expect(text).toContain('Workflow Outputs:');
    expect(text).toContain('- research: keys=[sources] size=27B');
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

  it('truncates workflow outputs in generated report evidence and prompts', async () => {
    const cwd = createGitRepo('melos-exec-report-workflow-');
    mkdirSync(join(cwd, '.melos'));
    writeFileSync(join(cwd, 'tracked.txt'), 'base\n', 'utf-8');
    execSync('git add tracked.txt', { cwd, stdio: 'ignore' });
    execSync('git commit -m "test: seed tracked file"', { cwd, stdio: 'ignore' });
    const largePayload = 'x'.repeat(12_000);
    const workflowOutput = {
      summary: 'report',
      raw: largePayload,
      sources: ['https://example.com'],
    };
    const summarizedOutput = {
      _keys: ['summary', 'raw', 'sources'],
      _size: Buffer.byteLength(JSON.stringify(workflowOutput), 'utf8'),
    };

    const executeSpy = jest.spyOn(ClaudeEngine.prototype, 'execute').mockImplementation(async (prompt, options) => {
      expect(prompt).toContain('"workflow"');
      expect(prompt).toContain('"outputs"');
      expect(prompt).toContain('"research"');
      expect(prompt).toContain('"summary"');
      expect(prompt).toContain('"raw"');
      expect(prompt).toContain('"_keys"');
      expect(prompt).toContain('"_size"');
      expect(prompt).not.toContain(largePayload);
      expect(options?.effort).toBe('medium');
      return {
        success: true,
        output: JSON.stringify({
          summary: 'Report summary.',
          changes: ['Included workflow output summaries.'],
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
        run: { engine: 'auto' },
        workflow: {
          start: 'research',
          phases: {
            research: {
              task: 'Summarize the staged change',
              next: 'stop',
            },
          },
        },
      }),
      cwd,
      melosDir: join(cwd, '.melos'),
      iterations: 1,
      success: true,
      decision: 'stop',
      summary: 'completed',
      output: 'done',
      workflow: {
        outputs: {
          research: workflowOutput,
        },
        phaseCounts: { research: 1 },
        history: [{ phase: 'research', summary: 'completed', decision: 'stop' }],
      },
    });

    expect(report.degraded).toBe(false);
    expect(report.report.evidence?.workflow).toEqual({
      outputs: {
        research: summarizedOutput,
      },
      phaseCounts: { research: 1 },
      history: [{ phase: 'research', summary: 'completed', decision: 'stop' }],
    });
    executeSpy.mockRestore();
  });
});
