export type CheckType =
  | 'command'
  | 'auto:lint'
  | 'auto:typecheck'
  | 'auto:test'
  | 'browser'
  | 'e2e'
  | 'manual';

export type ValidationExpectedOutcome = 'exit_code_zero' | 'no_match';

export type ValidationRunner = 'playwright-interactive' | 'browser-test';

export type ValidationArtifact = 'screenshot' | 'video';
export type ValidationEvidenceMode = 'single' | 'before_after';

export interface ValidationCheck {
  id: string;
  description: string;
  type: CheckType;
  command?: string;
  expectedOutcome?: ValidationExpectedOutcome;
  waivedReason?: string;
  requiredRunner?: ValidationRunner;
  requiredArtifacts?: ValidationArtifact[];
  artifactNames?: string[];
  preconditions?: string[];
  deterministicInputs?: string[];
  evidenceMode?: ValidationEvidenceMode;
  reproduceBefore?: boolean;
  passed: boolean;
  failureCount: number;
  lastFailure?: string;
}

export interface ValidationContract {
  staticChecks: ValidationCheck[];
  testSuites: ValidationCheck[];
  qaChecks?: ValidationCheck[];
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
  warning?: string;
  runner?: string;
  screenshotPath?: string;
  videoPath?: string;
  screenshotUrl?: string;
  videoUrl?: string;
  beforeScreenshotPath?: string;
  afterScreenshotPath?: string;
  beforeVideoPath?: string;
  afterVideoPath?: string;
  beforeScreenshotUrl?: string;
  afterScreenshotUrl?: string;
  beforeVideoUrl?: string;
  afterVideoUrl?: string;
  beforeReproduced?: boolean;
  beforeObserved?: string;
  afterObserved?: string;
  failure?: ValidationCheckFailure;
}

export type ValidationEvidenceMap = Record<string, Record<string, ValidationCheckResult>>;

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
    ...(contract.qaChecks ?? []),
  ];
}

export function cloneValidationContract(contract: ValidationContract): ValidationContract {
  return {
    staticChecks: contract.staticChecks.map((check) => ({ ...check })),
    testSuites: contract.testSuites.map((check) => ({ ...check })),
    qaChecks: contract.qaChecks?.map((check) => ({ ...check })),
  };
}

export function inferValidationExpectedOutcome(
  description: string | null | undefined,
  command: string | null | undefined
): ValidationExpectedOutcome | undefined {
  const normalizedCommand = command?.trim() ?? '';
  if (!/^rg(?:\s|$)/.test(normalizedCommand)) {
    return undefined;
  }

  const normalizedDescription = description?.trim().toLowerCase() ?? '';
  if (normalizedDescription.length === 0) {
    return undefined;
  }

  const absencePatterns = [
    /残っていない/,
    /残存.*ない/,
    /存在しない/,
    /ゼロ/,
    /\bno\b.*\bremain/,
    /\bno\b.*\breference/,
    /\bdoes not exist\b/,
    /\bshould not\b/,
    /\babsence\b/,
    /\bremoved?\b/,
    /\bwithout\b/,
  ];
  return absencePatterns.some((pattern) => pattern.test(normalizedDescription))
    ? 'no_match'
    : undefined;
}

export function normalizeValidationExpectedOutcome(
  value: unknown,
  fallback?: {
    description?: string | null | undefined;
    command?: string | null | undefined;
  }
): ValidationExpectedOutcome | undefined {
  if (value === 'exit_code_zero' || value === 'no_match') {
    return value;
  }
  return inferValidationExpectedOutcome(fallback?.description, fallback?.command);
}

export function normalizeValidationCheck(input: Partial<ValidationCheck>, index: number): ValidationCheck {
  const requiredArtifacts = Array.isArray(input.requiredArtifacts)
    ? input.requiredArtifacts.filter((artifact): artifact is ValidationArtifact => artifact === 'screenshot' || artifact === 'video')
    : [];
  const artifactNames = Array.isArray(input.artifactNames)
    ? input.artifactNames
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
      .map((name) => name.trim())
    : [];
  const preconditions = Array.isArray(input.preconditions)
    ? input.preconditions
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
  const deterministicInputs = Array.isArray(input.deterministicInputs)
    ? input.deterministicInputs
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
    : [];
  const waivedReason = typeof input.waivedReason === 'string' && input.waivedReason.trim().length > 0
    ? input.waivedReason.trim()
    : undefined;
  const expectedOutcome = normalizeValidationExpectedOutcome(input.expectedOutcome, {
    description: input.description,
    command: input.command,
  }) ?? 'exit_code_zero';
  const evidenceMode = input.evidenceMode === 'before_after' ? 'before_after' : 'single';

  return {
    id: input.id?.trim() || `check-${index + 1}`,
    description: input.description?.trim() || 'Unnamed validation check',
    type: input.type ?? 'command',
    command: input.command?.trim() || undefined,
    expectedOutcome,
    waivedReason,
    requiredRunner: input.requiredRunner === 'playwright-interactive' || input.requiredRunner === 'browser-test'
      ? input.requiredRunner
      : undefined,
    requiredArtifacts: requiredArtifacts.length > 0 ? requiredArtifacts : undefined,
    artifactNames: artifactNames.length > 0 ? artifactNames : undefined,
    preconditions: preconditions.length > 0 ? preconditions : undefined,
    deterministicInputs: deterministicInputs.length > 0 ? deterministicInputs : undefined,
    evidenceMode,
    reproduceBefore: evidenceMode === 'before_after' ? input.reproduceBefore === true : undefined,
    passed: waivedReason ? true : Boolean(input.passed),
    failureCount: waivedReason ? 0 : (typeof input.failureCount === 'number' && input.failureCount > 0
      ? Math.floor(input.failureCount)
      : 0),
    lastFailure: waivedReason ? undefined : (input.lastFailure?.trim() || undefined),
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
    qaChecks: normalizeList(contract.qaChecks),
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
          failureCount: 0,
          lastFailure: undefined,
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
    qaChecks: contract.qaChecks ? mergeList(contract.qaChecks) : undefined,
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
