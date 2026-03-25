import { renderFinalReportText } from '../report.js';

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
});
