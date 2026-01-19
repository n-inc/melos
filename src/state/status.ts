import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

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
 * Marathon 実行状態
 */
export interface MarathonStatus {
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
export function createDefaultStatus(): MarathonStatus {
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
export async function loadStatus(path: string): Promise<MarathonStatus> {
  if (!statusExists(path)) {
    return createDefaultStatus();
  }

  try {
    const content = await readFile(path, 'utf-8');
    const data = JSON.parse(content) as Partial<MarathonStatus>;

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
  status: MarathonStatus
): Promise<void> {
  const updated: MarathonStatus = {
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
  updates: Partial<MarathonStatus>
): Promise<MarathonStatus> {
  const current = await loadStatus(path);
  const updated: MarathonStatus = {
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
): Promise<MarathonStatus> {
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
): Promise<MarathonStatus> {
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
): Promise<MarathonStatus> {
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
): Promise<MarathonStatus> {
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
): Promise<MarathonStatus> {
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
