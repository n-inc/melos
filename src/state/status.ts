import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { PromiseType } from '../utils/promise.js';

/**
 * 実行ステータス
 */
export type RunStatus = 'idle' | 'running' | 'completed' | 'error' | 'paused';

/**
 * 現在のタスク情報
 */
export interface CurrentTask {
  /** タスクID */
  id: string;
  /** タスク説明 */
  description: string;
}

/**
 * Git 状態
 */
export interface GitState {
  /** 現在のブランチ名 */
  branch: string;
  /** リモートにプッシュ済みか */
  isPushed: boolean;
  /** PR情報（存在する場合） */
  pullRequest: { number: number; url: string } | null;
  /** 最後のコミットハッシュ */
  lastCommitHash: string;
  /** 取得時刻（ISO 8601） */
  fetchedAt: string;
}

/**
 * イテレーション結果の種類
 */
export type IterationOutcome =
  | 'TASK_DONE'
  | 'TASK_RETRY'
  | 'TASK_SKIP'
  | 'REVIEW_PASS'
  | 'REVIEW_FINDINGS'
  | 'CI_PASS'
  | 'CI_FAIL'
  | 'ERROR';

/**
 * 直前イテレーションのサマリー
 */
export interface LastIterationSummary {
  outcome: IterationOutcome;
  taskId: string | null;
  durationSeconds: number;
  filesChanged: number;
  keyActions: string[];
  error: string | null;
}

/**
 * エスカレーションリスクレベル
 */
export type RiskLevel = 'low' | 'medium' | 'high';

/**
 * エスカレーションリスク情報
 */
export interface EscalationRisk {
  sameTaskAttempts: number;
  riskLevel: RiskLevel;
  reason: string | null;
}

/**
 * CIステータス
 */
export type CIStatus = 'passing' | 'failing' | 'pending' | 'unknown';

/**
 * 状態シグナル
 */
export interface StateSignals {
  ciStatus: CIStatus;
  reviewPending: boolean;
  blockedBy: string | null;
}

/**
 * 履歴エントリ
 */
export interface HistoryEntry {
  iteration: number;
  outcome: string;
  taskId: string | null;
}

/**
 * 直近履歴（最大5件）
 */
export type RecentHistory = HistoryEntry[];

/**
 * Melos 実行状態
 */
export interface MelosStatus {
  /** 現在のイテレーション番号 */
  iteration: number;
  /** 最大イテレーション数 */
  maxIterations: number;
  /** 現在のタスク */
  currentTask: CurrentTask | null;
  /** 完了タスク数 */
  completedTasks: number;
  /** 総タスク数 */
  totalTasks: number;
  /** ループ開始時刻（ISO 8601） */
  startedAt: string;
  /** エンジン実行開始時刻（ISO 8601） */
  engineStartedAt: string | null;
  /** 使用エンジン */
  engine: 'claude' | 'codex';
  /** 実行ステータス */
  status: RunStatus;
  /** Git状態 */
  gitState: GitState;
  /** 最後の更新時刻（ISO 8601） */
  updatedAt: string;
  /** 直前イテレーションのサマリー */
  lastIterationSummary?: LastIterationSummary;
  /** エスカレーションリスク情報 */
  escalationRisk?: EscalationRisk;
  /** 状態シグナル */
  stateSignals?: StateSignals;
  /** 直近履歴 */
  recentHistory?: RecentHistory;
}

/**
 * デフォルトのGitStateを生成
 */
export function createDefaultGitState(): GitState {
  return {
    branch: '',
    isPushed: false,
    pullRequest: null,
    lastCommitHash: '',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * デフォルトのステータスを生成
 */
export function createDefaultStatus(): MelosStatus {
  const now = new Date().toISOString();
  return {
    iteration: 0,
    maxIterations: 30,
    currentTask: null,
    completedTasks: 0,
    totalTasks: 0,
    startedAt: now,
    engineStartedAt: null,
    engine: 'claude',
    status: 'idle',
    gitState: createDefaultGitState(),
    updatedAt: now,
  };
}

/**
 * ステータスファイルが存在するか確認
 */
export function statusExists(path: string): boolean {
  return existsSync(path);
}

/**
 * ステータスファイルを読み込む
 */
export async function loadStatus(path: string): Promise<MelosStatus> {
  if (!statusExists(path)) {
    return createDefaultStatus();
  }

  try {
    const content = await readFile(path, 'utf-8');
    const data = JSON.parse(content) as Partial<MelosStatus>;

    // デフォルト値とマージ
    return {
      ...createDefaultStatus(),
      ...data,
    };
  } catch {
    return createDefaultStatus();
  }
}

/**
 * ステータスファイルを保存
 */
export async function saveStatus(
  path: string,
  status: MelosStatus
): Promise<void> {
  const updated: MelosStatus = {
    ...status,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(updated, null, 2), 'utf-8');
}

/**
 * ステータスを部分更新
 */
export async function updateStatus(
  path: string,
  updates: Partial<MelosStatus>
): Promise<MelosStatus> {
  const current = await loadStatus(path);
  const updated: MelosStatus = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  await saveStatus(path, updated);
  return updated;
}

/**
 * エンジン実行開始を記録
 */
export async function markEngineStarted(
  path: string,
  engine: 'claude' | 'codex'
): Promise<MelosStatus> {
  return updateStatus(path, {
    engineStartedAt: new Date().toISOString(),
    engine,
    status: 'running',
  });
}

/**
 * エンジン実行完了を記録
 */
export async function markEngineCompleted(
  path: string,
  success: boolean
): Promise<MelosStatus> {
  return updateStatus(path, {
    engineStartedAt: null,
    status: success ? 'completed' : 'error',
  });
}

/**
 * イテレーション開始を記録
 */
export async function markIterationStarted(
  path: string,
  iteration: number,
  maxIterations: number,
  currentTask: CurrentTask | null
): Promise<MelosStatus> {
  return updateStatus(path, {
    iteration,
    maxIterations,
    currentTask,
    status: 'running',
  });
}

/**
 * Git状態を更新
 */
export async function updateGitState(
  path: string,
  gitState: GitState
): Promise<MelosStatus> {
  return updateStatus(path, {
    gitState,
  });
}

/**
 * タスク進捗を更新
 */
export async function updateTaskProgress(
  path: string,
  completedTasks: number,
  totalTasks: number
): Promise<MelosStatus> {
  return updateStatus(path, {
    completedTasks,
    totalTasks,
  });
}

/**
 * ステータスファイルを削除（クリーンアップ用）
 */
export async function clearStatus(path: string): Promise<void> {
  if (statusExists(path)) {
    const { unlink } = await import('node:fs/promises');
    await unlink(path);
  }
}

/**
 * 変更されたファイル数を取得
 */
export function getFilesChangedCount(cwd: string): number {
  const result = spawnSync('git', ['diff', '--name-only'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    return 0;
  }

  return result.stdout.trim().split('\n').filter(Boolean).length;
}

/**
 * エスカレーションリスクを計算
 */
export function calculateEscalationRisk(
  recentHistory: RecentHistory,
  currentTaskId: string | null
): EscalationRisk {
  if (!currentTaskId) {
    return { sameTaskAttempts: 0, riskLevel: 'low', reason: null };
  }

  let sameTaskAttempts = 0;
  for (const entry of [...recentHistory].reverse()) {
    if (entry.taskId === currentTaskId) {
      sameTaskAttempts++;
    } else {
      break;
    }
  }

  let riskLevel: RiskLevel = 'low';
  let reason: string | null = null;

  if (sameTaskAttempts >= 3) {
    riskLevel = 'high';
    reason = `同一タスクで${sameTaskAttempts}回連続失敗。エスカレーション寸前`;
  } else if (sameTaskAttempts >= 2) {
    riskLevel = 'medium';
    reason = '同一タスクで2回目の試行';
  }

  return { sameTaskAttempts, riskLevel, reason };
}

/**
 * 履歴に新規エントリを追加（最大5件を維持）
 */
export function addToRecentHistory(
  history: RecentHistory,
  entry: HistoryEntry
): RecentHistory {
  const newHistory = [...history, entry];
  return newHistory.slice(-5);
}

/**
 * PromiseType を IterationOutcome に変換
 */
export function mapPromiseToOutcome(
  promiseType: PromiseType | null,
  engineSuccess: boolean
): IterationOutcome {
  if (!engineSuccess) {
    return 'ERROR';
  }

  switch (promiseType) {
    case 'COMPLETE':
    case 'TASK_DONE':
      return 'TASK_DONE';
    case 'ESCALATE':
      return 'ERROR';
    default:
      return 'TASK_RETRY';
  }
}
