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
 * フェーズタイプ
 */
export type PhaseType = 'research' | 'task' | 'verification' | 'review';

/**
 * フェーズ別エンジン設定
 */
export interface PhaseEngineConfig {
  /** エンジン選択 */
  engine?: 'claude' | 'codex';
  /** 推論努力レベル（Codex用） */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** モデル名 */
  model?: string;
  /** Claude thinking budget（1024〜31999） */
  thinkingBudget?: number;
}

/**
 * Melos 設定ファイルの型
 */
export interface MelosConfig {
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
  /** Claude thinking budget（1024〜31999） */
  thinkingBudget?: number;
  /** フェーズ別エンジン設定 */
  engines?: {
    research?: PhaseEngineConfig;
    task?: PhaseEngineConfig;
    verification?: PhaseEngineConfig;
    review?: PhaseEngineConfig;
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

  // thinkingBudget: 1024〜31999 の整数
  if (typeof config.thinkingBudget === 'number') {
    const num = Math.floor(config.thinkingBudget);
    if (num >= 1024 && num <= 31999) {
      validated.thinkingBudget = num;
    }
  }

  // engines フィールドの検証
  if (config.engines && typeof config.engines === 'object') {
    validated.engines = {};
    const phases: PhaseType[] = ['research', 'task', 'verification', 'review'];

    for (const phase of phases) {
      const phaseConfig = config.engines[phase];
      if (phaseConfig && typeof phaseConfig === 'object') {
        const validatedPhase: PhaseEngineConfig = {};

        if (phaseConfig.engine === 'claude' || phaseConfig.engine === 'codex') {
          validatedPhase.engine = phaseConfig.engine;
        }

        if (phaseConfig.reasoningEffort) {
          const validLevels = ['low', 'medium', 'high'];
          if (validLevels.includes(phaseConfig.reasoningEffort)) {
            validatedPhase.reasoningEffort = phaseConfig.reasoningEffort as 'low' | 'medium' | 'high';
          }
        }

        if (typeof phaseConfig.model === 'string') {
          validatedPhase.model = phaseConfig.model;
        }

        // thinkingBudget: 1024〜31999 の整数（Claude用）
        if (typeof phaseConfig.thinkingBudget === 'number') {
          const budget = Math.floor(phaseConfig.thinkingBudget);
          if (budget >= 1024 && budget <= 31999) {
            validatedPhase.thinkingBudget = budget;
          }
        }

        if (Object.keys(validatedPhase).length > 0) {
          validated.engines[phase] = validatedPhase;
        }
      }
    }
  }

  return validated;
}
