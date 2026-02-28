export type CheckType =
  | 'command'
  | 'auto:lint'
  | 'auto:typecheck'
  | 'auto:test'
  | 'e2e'
  | 'manual';

export interface ValidationCheck {
  id: string;
  description: string;
  type: CheckType;
  command?: string;
  expectedOutcome?: string;
  passed: boolean;
  failureCount: number;
  lastFailure?: string;
}

export interface ValidationContract {
  staticChecks: ValidationCheck[];
  testSuites: ValidationCheck[];
  e2eChecks?: ValidationCheck[];
  manualSteps?: ValidationCheck[];
}

export interface ValidationCheckFailure {
  summary: string;
  affectedFiles: string[];
  errorMessages: string[];
  rootCause?: string;
}

export interface ValidationCheckResult {
  checkId: string;
  passed: boolean;
  exitCode?: number;
  durationMs?: number;
  output?: string;
  failure?: ValidationCheckFailure;
}

export interface ValidationReport {
  milestoneId: string;
  timestamp: string;
  passed: boolean;
  results: ValidationCheckResult[];
  attempt: number;
}

export interface ValidationFailureSummary {
  checkId: string;
  description: string;
  lastFailure: string;
  failureCount: number;
}

export function createEmptyValidationContract(): ValidationContract {
  return {
    staticChecks: [],
    testSuites: [],
  };
}

export function getAllValidationChecks(contract: ValidationContract): ValidationCheck[] {
  return [
    ...contract.staticChecks,
    ...contract.testSuites,
    ...(contract.e2eChecks ?? []),
    ...(contract.manualSteps ?? []),
  ];
}

export function cloneValidationContract(contract: ValidationContract): ValidationContract {
  return {
    staticChecks: contract.staticChecks.map((check) => ({ ...check })),
    testSuites: contract.testSuites.map((check) => ({ ...check })),
    e2eChecks: contract.e2eChecks?.map((check) => ({ ...check })),
    manualSteps: contract.manualSteps?.map((check) => ({ ...check })),
  };
}

export function normalizeValidationCheck(input: Partial<ValidationCheck>, index: number): ValidationCheck {
  return {
    id: input.id?.trim() || `check-${index + 1}`,
    description: input.description?.trim() || 'Unnamed validation check',
    type: input.type ?? 'command',
    command: input.command?.trim() || undefined,
    expectedOutcome: input.expectedOutcome?.trim() || undefined,
    passed: Boolean(input.passed),
    failureCount: typeof input.failureCount === 'number' && input.failureCount > 0
      ? Math.floor(input.failureCount)
      : 0,
    lastFailure: input.lastFailure?.trim() || undefined,
  };
}

export function normalizeValidationContract(contract: Partial<ValidationContract> | null | undefined): ValidationContract {
  if (!contract) {
    return createEmptyValidationContract();
  }

  const normalizeList = (checks: ValidationCheck[] | undefined): ValidationCheck[] =>
    (checks ?? []).map((check, index) => normalizeValidationCheck(check, index));

  return {
    staticChecks: normalizeList(contract.staticChecks),
    testSuites: normalizeList(contract.testSuites),
    e2eChecks: normalizeList(contract.e2eChecks),
    manualSteps: normalizeList(contract.manualSteps),
  };
}

export function mergeValidationResults(
  contract: ValidationContract,
  report: ValidationReport
): ValidationContract {
  const byId = new Map(report.results.map((result) => [result.checkId, result]));

  const mergeList = (checks: ValidationCheck[]): ValidationCheck[] =>
    checks.map((check) => {
      const result = byId.get(check.id);
      if (!result) {
        return check;
      }
      if (result.passed) {
        return {
          ...check,
          passed: true,
        };
      }
      return {
        ...check,
        passed: false,
        failureCount: check.failureCount + 1,
        lastFailure: result.failure?.summary ?? result.output ?? `check ${check.id} failed`,
      };
    });

  return {
    staticChecks: mergeList(contract.staticChecks),
    testSuites: mergeList(contract.testSuites),
    e2eChecks: contract.e2eChecks ? mergeList(contract.e2eChecks) : undefined,
    manualSteps: contract.manualSteps ? mergeList(contract.manualSteps) : undefined,
  };
}

export function collectValidationFailures(contract: ValidationContract): ValidationFailureSummary[] {
  const failures: ValidationFailureSummary[] = [];
  for (const check of getAllValidationChecks(contract)) {
    if (check.failureCount > 0 && check.lastFailure) {
      failures.push({
        checkId: check.id,
        description: check.description,
        lastFailure: check.lastFailure,
        failureCount: check.failureCount,
      });
    }
  }
  return failures;
}

export function hasValidationLoop(contract: ValidationContract, threshold: number = 3): boolean {
  return getAllValidationChecks(contract).some((check) => check.failureCount >= threshold);
}
