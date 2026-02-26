import { readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 実行中ランタイム情報
 */
export interface MelosRuntime {
  /** melos プロセス PID */
  pid: number;
  /** 実行開始時刻（ISO 8601） */
  startedAt: string;
  /** 実行時のカレントディレクトリ */
  cwd: string;
}

/**
 * RUN.json のパス
 */
export function getRuntimePath(melosDir: string): string {
  return join(melosDir, 'RUN.json');
}

/**
 * ランタイム情報が存在するか
 */
export function runtimeExists(melosDir: string): boolean {
  return existsSync(getRuntimePath(melosDir));
}

/**
 * ランタイム情報を読み込む
 */
export async function loadRuntime(melosDir: string): Promise<MelosRuntime | null> {
  const path = getRuntimePath(melosDir);
  if (!existsSync(path)) {
    return null;
  }
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as MelosRuntime;
}

/**
 * ランタイム情報を保存する
 */
export async function saveRuntime(melosDir: string, runtime: MelosRuntime): Promise<void> {
  if (!existsSync(melosDir)) {
    mkdirSync(melosDir, { recursive: true });
  }
  const path = getRuntimePath(melosDir);
  await writeFile(path, JSON.stringify(runtime, null, 2) + '\n', 'utf-8');
}

/**
 * ランタイム情報を削除する
 */
export async function clearRuntime(melosDir: string): Promise<void> {
  const path = getRuntimePath(melosDir);
  if (!existsSync(path)) {
    return;
  }
  await unlink(path);
}

/**
 * PID が生存しているか確認する
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

/**
 * 対象 PID に SIGTERM を送信する
 */
export function terminateProcess(pid: number): void {
  process.kill(pid, 'SIGTERM');
}
