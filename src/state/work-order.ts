import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Manager → Worker への指示
 */
export interface WorkOrder {
  /** イテレーション番号 */
  iteration: number;
  /** タスクID */
  taskId: string;
  /** タスクの説明 */
  description: string;
  /** 具体的な指示リスト */
  instructions: string[];
  /** コンテキスト情報 */
  context: WorkOrderContext;
  /** 成功基準 */
  successCriteria: string[];
  /** 制約事項（オプション） */
  constraints?: WorkOrderConstraints;
  /** 作成時刻（ISO 8601） */
  createdAt: string;
}

/**
 * コンテキスト情報
 */
export interface WorkOrderContext {
  /** 関連ファイルパス */
  relatedFiles: string[];
  /** 従うべきパターン */
  patterns?: string | null;
  /** 注意すべき落とし穴 */
  gotchas?: string | null;
  /** その他のコンテキスト */
  additionalInfo?: string;
}

/**
 * 制約事項
 */
export interface WorkOrderConstraints {
  /** テスト実行必須 */
  mustRunTests?: boolean;
  /** lint パス必須 */
  mustPassLint?: boolean;
  /** typecheck パス必須 */
  mustPassTypecheck?: boolean;
  /** 最大ファイル数 */
  maxFiles?: number;
}

/**
 * WorkOrder ファイルのパスを取得
 */
export function getWorkOrderPath(melosDir: string): string {
  return join(melosDir, 'WORK_ORDER.json');
}

/**
 * WorkOrder が存在するか確認
 */
export function workOrderExists(melosDir: string): boolean {
  return existsSync(getWorkOrderPath(melosDir));
}

/**
 * WorkOrder を読み込む
 * @param melosDir .melos ディレクトリのパス
 * @returns WorkOrder または存在しない場合は null
 */
export async function loadWorkOrder(melosDir: string): Promise<WorkOrder | null> {
  const path = getWorkOrderPath(melosDir);
  if (!existsSync(path)) {
    return null;
  }

  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as WorkOrder;
}

/**
 * WorkOrder を保存する
 * @param melosDir .melos ディレクトリのパス
 * @param workOrder 保存する WorkOrder
 */
export async function saveWorkOrder(
  melosDir: string,
  workOrder: WorkOrder
): Promise<void> {
  if (!existsSync(melosDir)) {
    mkdirSync(melosDir, { recursive: true });
  }

  const path = getWorkOrderPath(melosDir);
  const content = JSON.stringify(workOrder, null, 2) + '\n';
  await writeFile(path, content, 'utf-8');
}

/**
 * 新しい WorkOrder を作成する
 */
export function createWorkOrder(params: {
  iteration: number;
  taskId: string;
  description: string;
  instructions: string[];
  successCriteria: string[];
  context?: Partial<WorkOrderContext>;
  constraints?: WorkOrderConstraints;
}): WorkOrder {
  return {
    iteration: params.iteration,
    taskId: params.taskId,
    description: params.description,
    instructions: params.instructions,
    context: {
      relatedFiles: params.context?.relatedFiles ?? [],
      patterns: params.context?.patterns ?? null,
      gotchas: params.context?.gotchas ?? null,
      additionalInfo: params.context?.additionalInfo,
    },
    successCriteria: params.successCriteria,
    constraints: params.constraints,
    createdAt: new Date().toISOString(),
  };
}

/**
 * WorkOrder を削除する（クリーンアップ用）
 */
export async function clearWorkOrder(melosDir: string): Promise<void> {
  const path = getWorkOrderPath(melosDir);
  if (existsSync(path)) {
    await unlink(path);
  }
}
