import {
  collectValidationFailures,
  hasValidationLoop,
  mergeValidationResults,
  normalizeValidationContract,
} from '../validation.js';

describe('state/validation', () => {
  it('normalizes validation contract', () => {
    const contract = normalizeValidationContract({
      staticChecks: [
        {
          id: 'typecheck',
          description: 'Typecheck',
          type: 'auto:typecheck',
          command: 'npm run typecheck',
          passed: false,
          failureCount: 0,
        },
      ],
      qaChecks: [
        {
          id: 'browser',
          description: 'Browser QA',
          type: 'browser',
          requiredRunner: 'playwright-interactive',
          requiredArtifacts: ['screenshot', 'video'],
          passed: false,
          failureCount: 0,
        },
      ],
      testSuites: [],
    });

    expect(contract.staticChecks[0]?.id).toBe('typecheck');
    expect(contract.staticChecks[0]?.failureCount).toBe(0);
    expect(contract.qaChecks?.[0]?.requiredRunner).toBe('playwright-interactive');
    expect(contract.qaChecks?.[0]?.requiredArtifacts).toEqual(['screenshot', 'video']);
  });

  it('increments failure count on failed checks and clears pass status on success', () => {
    const base = normalizeValidationContract({
      staticChecks: [
        {
          id: 'typecheck',
          description: 'Typecheck',
          type: 'auto:typecheck',
          command: 'npm run typecheck',
          passed: false,
          failureCount: 0,
        },
      ],
      testSuites: [
        {
          id: 'test',
          description: 'Tests',
          type: 'auto:test',
          command: 'npm test',
          passed: false,
          failureCount: 0,
        },
      ],
    });

    const failedOnce = mergeValidationResults(base, {
      milestoneId: 'm1',
      timestamp: new Date().toISOString(),
      passed: false,
      attempt: 1,
      results: [
        {
          checkId: 'typecheck',
          passed: true,
        },
        {
          checkId: 'test',
          passed: false,
          failure: {
            summary: 'tests failed',
            affectedFiles: [],
            errorMessages: ['fail'],
          },
        },
      ],
    });

    expect(failedOnce.staticChecks[0]?.passed).toBe(true);
    expect(failedOnce.testSuites[0]?.failureCount).toBe(1);

    const failedTwice = mergeValidationResults(failedOnce, {
      milestoneId: 'm1',
      timestamp: new Date().toISOString(),
      passed: false,
      attempt: 2,
      results: [
        {
          checkId: 'test',
          passed: false,
          failure: {
            summary: 'still failing',
            affectedFiles: [],
            errorMessages: ['fail'],
          },
        },
      ],
    });

    expect(failedTwice.testSuites[0]?.failureCount).toBe(2);

    const failures = collectValidationFailures(failedTwice);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.checkId).toBe('test');
    expect(hasValidationLoop(failedTwice, 2)).toBe(true);
  });
});
