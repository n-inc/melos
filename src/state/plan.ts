import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * タスク実行エンジン
 */
export type TaskEngine = 'claude' | 'codex';

/**
 * チェック項目のタイプ
 */
export type CheckType =
  | 'auto:jest'      // Jest で自動検証
  | 'auto:rspec'     // RSpec で自動検証
  | 'auto:typecheck' // 型チェックで自動検証
  | 'browser'        // ブラウザで確認（証拠必須）
  | 'manual';        // 手動確認

/**
 * 有効なチェックタイプのリスト
 */
export const VALID_CHECK_TYPES: CheckType[] = [
  'auto:jest',
  'auto:rspec',
  'auto:typecheck',
  'browser',
  'manual',
];

/**
 * 検証項目
 */
export interface CheckItem {
  /** 検証項目の説明 */
  text: string;
  /** チェックタイプ */
  type: CheckType;
  /** 完了フラグ */
  passed: boolean;
  /** スクリーンショット証拠のR2 URL（browser タイプ用） */
  screenshot?: string;
  /** 動画証拠のR2 URL（browser タイプ用） */
  video?: string;
}

/**
 * Worker の検証結果（チェック同期に必要な最小項目）
 */
export interface VerificationSummary {
  /** テスト実行したか */
  testsRun: boolean;
  /** テスト失敗数 */
  testsFailed: number;
  /** Jest チェックの結果（判定できる場合） */
  jestPassed?: boolean;
  /** RSpec チェックの結果（判定できる場合） */
  rspecPassed?: boolean;
  /** typecheck パスしたか */
  typecheckPassed: boolean;
}

/**
 * PLAN.json の個別タスク
 */
export interface PlanTask {
  /** タスクID（例: "1", "review-1"） */
  id: string;
  /** タスクの説明 */
  description: string;
  /** 検証項目 */
  checks?: CheckItem[];
  /** タスク完了フラグ */
  passes: boolean;
  /** タスク実行エンジン（省略時はデフォルトエンジンを使用） */
  model?: TaskEngine;
}

/**
 * PLAN.json 全体の型
 */
export type Plan = PlanTask[];

/**
 * PLAN.json が存在するか確認
 */
export function planExists(path: string): boolean {
  return existsSync(path);
}

/**
 * PLAN.json を読み込んでパースする
 * @throws {Error} ファイルが存在しない場合、またはパースに失敗した場合
 */
export async function loadPlan(path: string): Promise<Plan> {
  if (!planExists(path)) {
    throw new Error(`PLAN.json not found: ${path}`);
  }

  const content = await readFile(path, 'utf-8');
  const parsed: unknown = JSON.parse(content);

  if (!Array.isArray(parsed)) {
    throw new Error('PLAN.json must be an array');
  }

  // 各タスクを検証
  for (const task of parsed) {
    validateTask(task);
  }

  return parsed as Plan;
}

/**
 * PLAN.json を保存する
 */
export async function savePlan(path: string, plan: Plan): Promise<void> {
  const content = JSON.stringify(plan, null, 2) + '\n';
  await writeFile(path, content, 'utf-8');
}

/**
 * タスクの `passes` を更新する
 */
export async function updateTaskStatus(
  path: string,
  taskId: string,
  passes: boolean
): Promise<Plan> {
  const plan = await loadPlan(path);
  const task = plan.find((t) => t.id === taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  task.passes = passes;
  await savePlan(path, plan);
  return plan;
}

/**
 * 未完了タスクを取得する（passes: false）
 * 元の順序を維持（先頭から順に実行）
 */
export function getPendingTasks(plan: Plan): PlanTask[] {
  return plan.filter((task) => !task.passes);
}

/**
 * 次に実行すべきタスクを取得する
 */
export function getNextTask(plan: Plan): PlanTask | undefined {
  const pending = getPendingTasks(plan);
  return pending[0];
}

/**
 * すべてのタスクが完了しているか確認
 */
export function isAllTasksCompleted(plan: Plan): boolean {
  return plan.every((task) => task.passes);
}

/**
 * 新しいタスクを追加する
 */
export async function addTasks(path: string, tasks: PlanTask[]): Promise<Plan> {
  const plan = await loadPlan(path);
  plan.push(...tasks);
  await savePlan(path, plan);
  return plan;
}

/**
 * タスクオブジェクトを検証する
 */
function validateTask(task: unknown): asserts task is PlanTask {
  if (typeof task !== 'object' || task === null) {
    throw new Error('Task must be an object');
  }

  const t = task as Record<string, unknown>;

  if (typeof t.id !== 'string') {
    throw new Error('Task.id must be a string');
  }

  if (typeof t.description !== 'string') {
    throw new Error('Task.description must be a string');
  }

  // checks の検証
  if (t.checks !== undefined) {
    if (!Array.isArray(t.checks)) {
      throw new Error('Task.checks must be an array if present');
    }
    for (let i = 0; i < t.checks.length; i++) {
      const check = t.checks[i] as Record<string, unknown>;
      if (typeof check !== 'object' || check === null) {
        throw new Error(`Task.checks[${i}] must be an object`);
      }
      if (typeof check.text !== 'string') {
        throw new Error(`Task.checks[${i}].text must be a string`);
      }
      if (typeof check.type !== 'string' || !VALID_CHECK_TYPES.includes(check.type as CheckType)) {
        throw new Error(`Task.checks[${i}].type must be one of: ${VALID_CHECK_TYPES.join(', ')}`);
      }
      if (typeof check.passed !== 'boolean') {
        throw new Error(`Task.checks[${i}].passed must be a boolean`);
      }
      // 証拠フィールドの検証（オプショナル）
      if (check.screenshot !== undefined && typeof check.screenshot !== 'string') {
        throw new Error(`Task.checks[${i}].screenshot must be a string if present`);
      }
      if (check.video !== undefined && typeof check.video !== 'string') {
        throw new Error(`Task.checks[${i}].video must be a string if present`);
      }
    }
  }

  if (typeof t.passes !== 'boolean') {
    throw new Error('Task.passes must be a boolean');
  }

  if (
    t.model !== undefined &&
    (typeof t.model !== 'string' || !['claude', 'codex'].includes(t.model))
  ) {
    throw new Error('Task.model must be "claude" or "codex" if present');
  }
}

/**
 * 特定のチェック項目の状態を更新する
 */
export async function updateCheckStatus(
  path: string,
  taskId: string,
  checkIndex: number,
  passed: boolean
): Promise<Plan> {
  const plan = await loadPlan(path);
  const task = plan.find((t) => t.id === taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (!task.checks) {
    throw new Error(`Task ${taskId} has no checks`);
  }

  if (checkIndex < 0 || checkIndex >= task.checks.length) {
    throw new Error(`Check index ${checkIndex} out of range for task ${taskId}`);
  }

  task.checks[checkIndex].passed = passed;
  await savePlan(path, plan);
  return plan;
}

/**
 * タスクのすべてのチェック項目が完了しているか確認
 */
export function isAllChecksPassed(task: PlanTask): boolean {
  if (!task.checks || task.checks.length === 0) {
    return true;
  }
  return task.checks.every((check) => check.passed);
}

/**
 * browser タイプのチェックが有効な証拠を持っているか判定
 */
export function hasValidEvidence(check: CheckItem): boolean {
  if (check.type !== 'browser') {
    return true; // browser 以外は証拠不要
  }
  return !!(check.screenshot || check.video);
}

/**
 * チェック項目を証拠付きで更新
 */
export async function updateCheckWithEvidence(
  path: string,
  taskId: string,
  checkIndex: number,
  evidence: { screenshot?: string; video?: string }
): Promise<Plan> {
  const plan = await loadPlan(path);
  const task = plan.find((t) => t.id === taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (!task.checks) {
    throw new Error(`Task ${taskId} has no checks`);
  }

  if (checkIndex < 0 || checkIndex >= task.checks.length) {
    throw new Error(`Check index ${checkIndex} out of range for task ${taskId}`);
  }

  const check = task.checks[checkIndex];
  if (evidence.screenshot) {
    check.screenshot = evidence.screenshot;
  }
  if (evidence.video) {
    check.video = evidence.video;
  }
  check.passed = true;

  await savePlan(path, plan);
  return plan;
}

/**
 * Worker の検証結果から auto:* チェックを同期する
 */
export async function syncAutoChecksFromVerification(
  path: string,
  taskId: string,
  verification: VerificationSummary
): Promise<Plan> {
  const plan = await loadPlan(path);
  const task = plan.find((t) => t.id === taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (!task.checks || task.checks.length === 0) {
    return plan;
  }

  for (const check of task.checks) {
    const inferred = inferCheckPassedFromVerification(check, verification);
    if (inferred !== null) {
      check.passed = inferred;
    }
  }

  await savePlan(path, plan);
  return plan;
}

/**
 * check.type と検証結果から passed を推定する
 */
function inferCheckPassedFromVerification(
  check: CheckItem,
  verification: VerificationSummary
): boolean | null {
  switch (check.type) {
    case 'auto:jest':
      if (verification.jestPassed !== undefined) {
        return verification.jestPassed;
      }
      // 片方のみ明示されている場合は未実行扱いにする
      if (verification.rspecPassed !== undefined) {
        return false;
      }
      return verification.testsRun && verification.testsFailed === 0;
    case 'auto:rspec':
      if (verification.rspecPassed !== undefined) {
        return verification.rspecPassed;
      }
      // 片方のみ明示されている場合は未実行扱いにする
      if (verification.jestPassed !== undefined) {
        return false;
      }
      return verification.testsRun && verification.testsFailed === 0;
    case 'auto:typecheck':
      return verification.typecheckPassed;
    default:
      return null;
  }
}

/**
 * PLAN修正の記録
 */
export interface PlanModification {
  timestamp: string;
  type: 'add' | 'update' | 'delete';
  taskId: string;
  reason: string;
  previousState?: PlanTask;
}

/**
 * PLAN.json を修正し、修正履歴を記録
 */
export async function modifyPlan(
  path: string,
  modification: {
    type: 'add' | 'update' | 'delete';
    taskId: string;
    reason: string;
    task?: PlanTask;
  }
): Promise<{ plan: Plan; modification: PlanModification }> {
  const plan = await loadPlan(path);
  const timestamp = new Date().toISOString();

  const record: PlanModification = {
    timestamp,
    type: modification.type,
    taskId: modification.taskId,
    reason: modification.reason,
  };

  switch (modification.type) {
    case 'add':
      if (!modification.task) {
        throw new Error('追加するタスクが指定されていません');
      }
      plan.push(modification.task);
      break;

    case 'update': {
      const index = plan.findIndex((t) => t.id === modification.taskId);
      if (index === -1) {
        throw new Error(`タスクが見つかりません: ${modification.taskId}`);
      }
      record.previousState = { ...plan[index] };
      if (modification.task) {
        plan[index] = modification.task;
      }
      break;
    }

    case 'delete': {
      const index = plan.findIndex((t) => t.id === modification.taskId);
      if (index === -1) {
        throw new Error(`タスクが見つかりません: ${modification.taskId}`);
      }
      record.previousState = { ...plan[index] };
      plan.splice(index, 1);
      break;
    }
  }

  await savePlan(path, plan);

  return { plan, modification: record };
}
