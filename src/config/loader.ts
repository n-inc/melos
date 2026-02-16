/**
 * Melos 設定ファイルローダー
 *
 * .melos.json ファイルからプロジェクト固有の設定を読み込む
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 設定ファイル名
 */
export const CONFIG_FILE_NAME = '.melos.json';

/**
 * Melos 設定ファイルの型
 */
export interface MelosConfig {
  /** デフォルトモデル名（Manager/Worker 両方のデフォルト） */
  model?: string;
  /** 最大イテレーション数 */
  maxIterations?: number;
  /** Manager 固有設定 */
  manager?: {
    /** Manager モデル名（model より優先） */
    model?: string;
    /** Claude effort レベル */
    effort?: 'low' | 'medium' | 'high' | 'max';
  };
  /** Worker 固有設定 */
  worker?: {
    /** Worker モデル名（model より優先） */
    model?: string;
    /** Codex 推論努力レベル */
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  };
}

/**
 * 設定ファイルを読み込む
 *
 * @param cwd 作業ディレクトリ（デフォルト: process.cwd()）
 * @returns 設定オブジェクト（ファイルが存在しない場合は空オブジェクト）
 */
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

/**
 * 設定ファイルを同期的に読み込む
 *
 * @param cwd 作業ディレクトリ（デフォルト: process.cwd()）
 * @returns 設定オブジェクト（ファイルが存在しない場合は空オブジェクト）
 */
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

/**
 * 設定を検証する
 */
function validateConfig(config: MelosConfig): MelosConfig {
  const validated: MelosConfig = {};

  // model: 文字列であればそのまま
  if (typeof config.model === 'string') {
    validated.model = config.model;
  }

  // maxIterations: 1〜1000 の整数
  if (typeof config.maxIterations === 'number') {
    const num = Math.floor(config.maxIterations);
    if (num >= 1 && num <= 1000) {
      validated.maxIterations = num;
    }
  }

  // manager セクション
  if (config.manager && typeof config.manager === 'object') {
    const manager: NonNullable<MelosConfig['manager']> = {};

    if (typeof config.manager.model === 'string') {
      manager.model = config.manager.model;
    }

    if (config.manager.effort) {
      const validEfforts = ['low', 'medium', 'high', 'max'];
      if (validEfforts.includes(config.manager.effort)) {
        manager.effort = config.manager.effort;
      }
    }

    if (Object.keys(manager).length > 0) {
      validated.manager = manager;
    }
  }

  // worker セクション
  if (config.worker && typeof config.worker === 'object') {
    const worker: NonNullable<MelosConfig['worker']> = {};

    if (typeof config.worker.model === 'string') {
      worker.model = config.worker.model;
    }

    if (config.worker.reasoningEffort) {
      const validLevels = ['minimal', 'low', 'medium', 'high', 'xhigh'];
      if (validLevels.includes(config.worker.reasoningEffort)) {
        worker.reasoningEffort = config.worker.reasoningEffort;
      }
    }

    if (Object.keys(worker).length > 0) {
      validated.worker = worker;
    }
  }

  return validated;
}
