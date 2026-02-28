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
    validator?: ModelName;
    research?: ModelName;
  };
  git?: {
    enabled?: boolean;
    baseBranch?: string;
    autoPush?: boolean;
    preMergeValidation?: boolean;
    validationCommands?: string[];
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
    if (isNonEmptyString(config.models.validator)) {
      models.validator = config.models.validator;
    }
    if (isNonEmptyString(config.models.research)) {
      models.research = config.models.research;
    }
    if (Object.keys(models).length > 0) {
      validated.models = models;
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

    if (Object.keys(git).length > 0) {
      validated.git = git;
    }
  }

  return validated;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
