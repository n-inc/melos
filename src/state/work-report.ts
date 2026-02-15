import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Worker の実行結果ステータス
 */
export type WorkReportStatus =
  | 'SUCCESS'  // 成功（全ての成功基準を満たした）
  | 'PARTIAL'  // 部分成功（一部の成功基準のみ満たした）
  | 'FAILED'   // 失敗（エラーが発生）
  | 'BLOCKED'; // ブロック（外部依存等で進行不可）

/**
 * 変更されたファイル情報
 */
export interface FileChange {
  /** ファイルパス */
  path: string;
  /** 追加行数 */
  additions: number;
  /** 削除行数 */
  deletions: number;
}

/**
 * 検証結果
 */
export interface VerificationResult {
  /** テスト実行したか */
  testsRun: boolean;
  /** テスト成功数 */
  testsPassed: number;
  /** テスト失敗数 */
  testsFailed: number;
  /** lint パスしたか */
  lintPassed: boolean;
  /** typecheck パスしたか */
  typecheckPassed: boolean;
}

/**
 * 成功基準の結果
 */
export interface CriterionResult {
  /** 基準の説明 */
  criterion: string;
  /** 達成したか */
  passed: boolean;
  /** 備考（失敗理由等） */
  note?: string;
}

/**
 * 発見された追加タスク
 */
export interface DiscoveredTask {
  /** タスクの説明 */
  description: string;
  /** 優先度 */
  priority: 'high' | 'medium' | 'low';
  /** 関連タスクID */
  relatedTaskId?: string;
}

/**
 * Worker → Manager への報告
 */
export interface WorkReport {
  /** イテレーション番号 */
  iteration: number;
  /** タスクID */
  taskId: string;
  /** 実行結果ステータス */
  status: WorkReportStatus;
  /** 実行内容のサマリー */
  summary: string;
  /** 変更されたファイル */
  filesChanged: FileChange[];
  /** 検証結果 */
  verification: VerificationResult;
  /** 成功基準の達成状況 */
  successCriteriaResults: CriterionResult[];
  /** 発生した問題 */
  issues: string[];
  /** 発見された追加タスク */
  discoveredTasks: DiscoveredTask[];
  /** 学習した内容 */
  learnings: string[];
  /** ヘルプが必要か（BLOCKED時に使用） */
  requestsHelp: boolean;
  /** ヘルプが必要な理由 */
  helpReason?: string;
  /** Worker 実行ログのファイルパス */
  logFilePath?: string;
  /** 作成時刻（ISO 8601） */
  createdAt: string;
}

/**
 * WorkReport ファイルのパスを取得
 */
export function getWorkReportPath(melosDir: string): string {
  return join(melosDir, 'WORK_REPORT.json');
}

/**
 * WorkReport が存在するか確認
 */
export function workReportExists(melosDir: string): boolean {
  return existsSync(getWorkReportPath(melosDir));
}

/**
 * WorkReport を読み込む
 * @param melosDir .melos ディレクトリのパス
 * @returns WorkReport または存在しない場合は null
 */
export async function loadWorkReport(melosDir: string): Promise<WorkReport | null> {
  const path = getWorkReportPath(melosDir);
  if (!existsSync(path)) {
    return null;
  }

  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as WorkReport;
}

/**
 * WorkReport を保存する
 * @param melosDir .melos ディレクトリのパス
 * @param report 保存する WorkReport
 */
export async function saveWorkReport(
  melosDir: string,
  report: WorkReport
): Promise<void> {
  if (!existsSync(melosDir)) {
    mkdirSync(melosDir, { recursive: true });
  }

  const path = getWorkReportPath(melosDir);
  const content = JSON.stringify(report, null, 2) + '\n';
  await writeFile(path, content, 'utf-8');
}

/**
 * WorkReport を作成する
 */
export function createWorkReport(params: {
  iteration: number;
  taskId: string;
  status: WorkReportStatus;
  summary: string;
  filesChanged?: FileChange[];
  verification?: Partial<VerificationResult>;
  successCriteriaResults?: CriterionResult[];
  issues?: string[];
  discoveredTasks?: DiscoveredTask[];
  learnings?: string[];
  requestsHelp?: boolean;
  helpReason?: string;
  logFilePath?: string;
}): WorkReport {
  return {
    iteration: params.iteration,
    taskId: params.taskId,
    status: params.status,
    summary: params.summary,
    filesChanged: params.filesChanged ?? [],
    verification: {
      testsRun: params.verification?.testsRun ?? false,
      testsPassed: params.verification?.testsPassed ?? 0,
      testsFailed: params.verification?.testsFailed ?? 0,
      lintPassed: params.verification?.lintPassed ?? false,
      typecheckPassed: params.verification?.typecheckPassed ?? false,
    },
    successCriteriaResults: params.successCriteriaResults ?? [],
    issues: params.issues ?? [],
    discoveredTasks: params.discoveredTasks ?? [],
    learnings: params.learnings ?? [],
    requestsHelp: params.requestsHelp ?? false,
    helpReason: params.helpReason,
    logFilePath: params.logFilePath,
    createdAt: new Date().toISOString(),
  };
}

/**
 * WorkReport を削除する（クリーンアップ用）
 */
export async function clearWorkReport(melosDir: string): Promise<void> {
  const path = getWorkReportPath(melosDir);
  if (existsSync(path)) {
    await unlink(path);
  }
}

/**
 * 全ての成功基準が達成されたか確認
 */
export function isAllCriteriaPassed(report: WorkReport): boolean {
  if (report.successCriteriaResults.length === 0) {
    return report.status === 'SUCCESS';
  }
  return report.successCriteriaResults.every((c) => c.passed);
}

/**
 * 検証が全てパスしたか確認
 */
export function isVerificationPassed(report: WorkReport): boolean {
  const v = report.verification;
  return (
    (!v.testsRun || v.testsFailed === 0) &&
    v.lintPassed &&
    v.typecheckPassed
  );
}
