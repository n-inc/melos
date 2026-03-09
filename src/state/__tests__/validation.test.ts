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
    expect(contract.qaChecks?.[0]?.evidenceMode).toBe('single');
  });

  it('normalizes before_after browser evidence requirements', () => {
    const contract = normalizeValidationContract({
      qaChecks: [
        {
          id: 'browser-before-after',
          description: 'Browser QA with before/after evidence',
          type: 'browser',
          requiredRunner: 'playwright-interactive',
          requiredArtifacts: ['screenshot'],
          evidenceMode: 'before_after',
          reproduceBefore: true,
          passed: false,
          failureCount: 0,
        },
      ],
      staticChecks: [],
      testSuites: [],
    });

    expect(contract.qaChecks?.[0]).toMatchObject({
      evidenceMode: 'before_after',
      reproduceBefore: true,
    });
  });

  it('infers no_match expectedOutcome for rg-based absence checks and applies waivers as passed', () => {
    const contract = normalizeValidationContract({
      staticChecks: [
        {
          id: 'absence',
          description: 'フロントエンド実装コードに legacy 参照が残っていないことを確認する',
          type: 'command',
          command: 'rg -n "legacy" src',
          passed: false,
          failureCount: 2,
          waivedReason: 'outside mission scope',
        },
      ],
      testSuites: [],
    });

    expect(contract.staticChecks[0]?.expectedOutcome).toBe('no_match');
    expect(contract.staticChecks[0]?.waivedReason).toBe('outside mission scope');
    expect(contract.staticChecks[0]?.passed).toBe(true);
    expect(contract.staticChecks[0]?.failureCount).toBe(0);
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
    expect(failedOnce.staticChecks[0]?.failureCount).toBe(0);
    expect(failedOnce.staticChecks[0]?.lastFailure).toBeUndefined();
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
