/**
 * Marathon 設定ファイルローダー
 *
 * .marathon.json ファイルからプロジェクト固有の設定を読み込む
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 設定ファイル名
 */
export const CONFIG_FILE_NAME = '.marathon.json';

/**
 * Marathon 設定ファイルの型
 */
export interface MarathonConfig {
  /** モデル名（Claude: haiku, sonnet, opus / Codex: gpt-5.2-codex など） */
  model?: string;
  /** 推論努力レベル（Codex用） */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** 最大イテレーション数 */
  maxIterations?: number;
  /** エンジン選択 */
  engine?: 'claude' | 'codex';
  /** HITL モード */
  hitl?: boolean;
}

/**
 * 設定ファイルを読み込む
 *
 * @param cwd 作業ディレクトリ（デフォルト: process.cwd()）
 * @returns 設定オブジェクト（ファイルが存在しない場合は空オブジェクト）
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<MarathonConfig> {
  const configPath = join(cwd, CONFIG_FILE_NAME);

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content) as MarathonConfig;
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
export function loadConfigSync(cwd: string = process.cwd()): MarathonConfig {
  const configPath = join(cwd, CONFIG_FILE_NAME);

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const { readFileSync } = require('node:fs');
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as MarathonConfig;
    return validateConfig(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`設定ファイルの読み込みに失敗しました: ${configPath}\n${message}`);
  }
}

/**
 * 設定を検証する
 */
function validateConfig(config: MarathonConfig): MarathonConfig {
  const validated: MarathonConfig = {};

  // model: 文字列であればそのまま
  if (typeof config.model === 'string') {
    validated.model = config.model;
  }

  // reasoningEffort: 有効な値のみ
  if (config.reasoningEffort) {
    const validLevels = ['low', 'medium', 'high', 'xhigh'];
    if (validLevels.includes(config.reasoningEffort)) {
      validated.reasoningEffort = config.reasoningEffort;
    }
  }

  // maxIterations: 1〜1000 の整数
  if (typeof config.maxIterations === 'number') {
    const num = Math.floor(config.maxIterations);
    if (num >= 1 && num <= 1000) {
      validated.maxIterations = num;
    }
  }

  // engine: claude または codex
  if (config.engine === 'claude' || config.engine === 'codex') {
    validated.engine = config.engine;
  }

  // hitl: boolean
  if (typeof config.hitl === 'boolean') {
    validated.hitl = config.hitl;
  }

  return validated;
}
