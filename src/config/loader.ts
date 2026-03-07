import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CONFIG_FILE_NAME = '.melos.json';

export type ModelName = string;

export interface MelosConfig {
  maxIterations?: number;
  models?: {
    planner?: ModelName;
    worker?: ModelName;
  };
  execution?: {
    maxFeatureAttempts?: number;
    retryInitialDelayMs?: number;
    retryMaxDelayMs?: number;
    stallTimeoutMs?: number;
  };
  verification?: {
    requireManualEvidence?: boolean;
    requireE2EEvidence?: boolean;
    failOnWorkerWarnings?: boolean;
  };
  git?: {
    enabled?: boolean;
    baseBranch?: string;
    autoPush?: boolean;
    preMergeValidation?: boolean;
    validationCommands?: string[];
    pullRequest?: {
      enabled?: boolean;
    };
  };
}

export async function loadConfig(cwd: string = process.cwd()): Promise<MelosConfig> {
  const configPath = join(cwd, CONFIG_FILE_NAME);

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content) as MelosConfig;
    return validateConfig(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`設定ファイルの読み込みに失敗しました: ${configPath}\n${message}`);
  }
}

export function loadConfigSync(cwd: string = process.cwd()): MelosConfig {
  const configPath = join(cwd, CONFIG_FILE_NAME);

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as MelosConfig;
    return validateConfig(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`設定ファイルの読み込みに失敗しました: ${configPath}\n${message}`);
  }
}

function validateConfig(config: MelosConfig): MelosConfig {
  const validated: MelosConfig = {};

  if (typeof config.maxIterations === 'number') {
    const maxIterations = Math.floor(config.maxIterations);
    if (maxIterations >= 1 && maxIterations <= 10000) {
      validated.maxIterations = maxIterations;
    }
  }

  if (config.models && typeof config.models === 'object') {
    const models: NonNullable<MelosConfig['models']> = {};
    if (isNonEmptyString(config.models.planner)) {
      models.planner = config.models.planner;
    }
    if (isNonEmptyString(config.models.worker)) {
      models.worker = config.models.worker;
    }
    if (Object.keys(models).length > 0) {
      validated.models = models;
    }
  }

  if (config.execution && typeof config.execution === 'object') {
    const execution: NonNullable<MelosConfig['execution']> = {};

    if (typeof config.execution.maxFeatureAttempts === 'number') {
      const maxFeatureAttempts = Math.floor(config.execution.maxFeatureAttempts);
      if (maxFeatureAttempts >= 1 && maxFeatureAttempts <= 100) {
        execution.maxFeatureAttempts = maxFeatureAttempts;
      }
    }
    if (typeof config.execution.retryInitialDelayMs === 'number') {
      const retryInitialDelayMs = Math.floor(config.execution.retryInitialDelayMs);
      if (retryInitialDelayMs >= 0 && retryInitialDelayMs <= 3_600_000) {
        execution.retryInitialDelayMs = retryInitialDelayMs;
      }
    }
    if (typeof config.execution.retryMaxDelayMs === 'number') {
      const retryMaxDelayMs = Math.floor(config.execution.retryMaxDelayMs);
      if (retryMaxDelayMs >= 0 && retryMaxDelayMs <= 3_600_000) {
        execution.retryMaxDelayMs = retryMaxDelayMs;
      }
    }
    if (typeof config.execution.stallTimeoutMs === 'number') {
      const stallTimeoutMs = Math.floor(config.execution.stallTimeoutMs);
      if (stallTimeoutMs >= 1_000 && stallTimeoutMs <= 86_400_000) {
        execution.stallTimeoutMs = stallTimeoutMs;
      }
    }

    if (Object.keys(execution).length > 0) {
      validated.execution = execution;
    }
  }

  if (config.verification && typeof config.verification === 'object') {
    const verification: NonNullable<MelosConfig['verification']> = {};

    if (typeof config.verification.requireManualEvidence === 'boolean') {
      verification.requireManualEvidence = config.verification.requireManualEvidence;
    }
    if (typeof config.verification.requireE2EEvidence === 'boolean') {
      verification.requireE2EEvidence = config.verification.requireE2EEvidence;
    }
    if (typeof config.verification.failOnWorkerWarnings === 'boolean') {
      verification.failOnWorkerWarnings = config.verification.failOnWorkerWarnings;
    }

    if (Object.keys(verification).length > 0) {
      validated.verification = verification;
    }
  }

  if (config.git && typeof config.git === 'object') {
    const git: NonNullable<MelosConfig['git']> = {};

    if (typeof config.git.enabled === 'boolean') {
      git.enabled = config.git.enabled;
    }
    if (isNonEmptyString(config.git.baseBranch)) {
      git.baseBranch = config.git.baseBranch;
    }
    if (typeof config.git.autoPush === 'boolean') {
      git.autoPush = config.git.autoPush;
    }
    if (typeof config.git.preMergeValidation === 'boolean') {
      git.preMergeValidation = config.git.preMergeValidation;
    }
    if (Array.isArray(config.git.validationCommands)) {
      git.validationCommands = config.git.validationCommands.filter(isNonEmptyString);
    }
    if (config.git.pullRequest && typeof config.git.pullRequest === 'object') {
      const pullRequest: NonNullable<NonNullable<MelosConfig['git']>['pullRequest']> = {};
      if (typeof config.git.pullRequest.enabled === 'boolean') {
        pullRequest.enabled = config.git.pullRequest.enabled;
      }
      if (Object.keys(pullRequest).length > 0) {
        git.pullRequest = pullRequest;
      }
    }

    if (Object.keys(git).length > 0) {
      validated.git = git;
    }
  }

  return validated;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
