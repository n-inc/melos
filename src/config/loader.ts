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
 * フェーズ別エンジン設定（詳細版）
 */
export interface PhaseEngineConfig {
  /** エンジン選択 */
  engine?: 'claude' | 'codex';
  /** 推論努力レベル（Codex用） */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** モデル名 */
  model?: string;
  /** Claude effort レベル（Opus 4.6+） */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Claude thinking budget（旧モデル向け、1024〜31999） */
  thinkingBudget?: number;
}

/**
 * フェーズ設定（入力時：文字列でエンジン名のみ、またはオブジェクトで詳細設定）
 * 注: validateConfig で正規化後は常に PhaseEngineConfig になる
 */
export type PhaseConfigInput = 'claude' | 'codex' | PhaseEngineConfig;

/**
 * Melos 設定ファイルの型（正規化後）
 */
export interface MelosConfig {
  /** モデル名（Claude: haiku, sonnet, opus / Codex: gpt-5.3-codex など） */
  model?: string;
  /** 推論努力レベル（Codex用） */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** 最大イテレーション数 */
  maxIterations?: number;
  /** デフォルトエンジン（全フェーズの初期値） */
  defaultEngine?: 'claude' | 'codex';
  /** Claude effort レベル（Opus 4.6+） */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Claude thinking budget（旧モデル向け、1024〜31999） */
  thinkingBudget?: number;
  /** フェーズ別エンジン設定（正規化済み） */
  phases?: {
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
 * 旧形式の設定キーをチェックしてエラーをスロー
 */
function checkDeprecatedKeys(config: Record<string, unknown>): void {
  if ('engine' in config) {
    throw new Error(
      '設定ファイルエラー: 「engine」は廃止されました。「defaultEngine」を使用してください。\n' +
      '例: { "defaultEngine": "claude" }'
    );
  }
  if ('engines' in config) {
    throw new Error(
      '設定ファイルエラー: 「engines」は廃止されました。「phases」を使用してください。\n' +
      '例: { "phases": { "research": "codex" } }'
    );
  }
}

/**
 * フェーズ設定を正規化（文字列 → オブジェクト形式に変換）
 */
function normalizePhaseConfig(config: PhaseConfigInput): PhaseEngineConfig {
  if (typeof config === 'string') {
    return { engine: config };
  }
  return config;
}

/**
 * 設定を検証する
 */
function validateConfig(config: MelosConfig): MelosConfig {
  // 旧形式のキーをチェック
  checkDeprecatedKeys(config as unknown as Record<string, unknown>);

  const validated: MelosConfig = {};

  // model: 文字列であればそのまま
  if (typeof config.model === 'string') {
    validated.model = config.model;
  }

  // reasoningEffort: 有効な値のみ
  if (config.reasoningEffort) {
    const validLevels = ['minimal', 'low', 'medium', 'high', 'xhigh'];
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

  // defaultEngine: claude または codex
  if (config.defaultEngine === 'claude' || config.defaultEngine === 'codex') {
    validated.defaultEngine = config.defaultEngine;
  }

  // effort: 有効な値のみ
  if (config.effort) {
    const validEfforts = ['low', 'medium', 'high', 'max'];
    if (validEfforts.includes(config.effort)) {
      validated.effort = config.effort;
    }
  }

  // thinkingBudget: 1024〜31999 の整数（旧モデル向け）
  if (typeof config.thinkingBudget === 'number') {
    const num = Math.floor(config.thinkingBudget);
    if (num >= 1024 && num <= 31999) {
      validated.thinkingBudget = num;
    }
  }

  // phases フィールドの検証
  if (config.phases && typeof config.phases === 'object') {
    validated.phases = {};
    const phaseNames: PhaseType[] = ['research', 'task', 'verification', 'review'];

    for (const phase of phaseNames) {
      const phaseConfig = config.phases[phase];
      if (phaseConfig !== undefined) {
        // 文字列またはオブジェクトを正規化
        const normalized = normalizePhaseConfig(phaseConfig);
        const validatedPhase: PhaseEngineConfig = {};

        if (normalized.engine === 'claude' || normalized.engine === 'codex') {
          validatedPhase.engine = normalized.engine;
        }

        if (normalized.reasoningEffort) {
          const validLevels = ['low', 'medium', 'high'];
          if (validLevels.includes(normalized.reasoningEffort)) {
            validatedPhase.reasoningEffort = normalized.reasoningEffort as 'low' | 'medium' | 'high';
          }
        }

        if (typeof normalized.model === 'string') {
          validatedPhase.model = normalized.model;
        }

        // effort: 有効な値のみ（Claude用）
        if (normalized.effort) {
          const validEfforts = ['low', 'medium', 'high', 'max'];
          if (validEfforts.includes(normalized.effort)) {
            validatedPhase.effort = normalized.effort as 'low' | 'medium' | 'high' | 'max';
          }
        }

        // thinkingBudget: 1024〜31999 の整数（旧モデル向け）
        if (typeof normalized.thinkingBudget === 'number') {
          const budget = Math.floor(normalized.thinkingBudget);
          if (budget >= 1024 && budget <= 31999) {
            validatedPhase.thinkingBudget = budget;
          }
        }

        if (Object.keys(validatedPhase).length > 0) {
          validated.phases[phase] = validatedPhase;
        }
      }
    }
  }

  return validated;
}
