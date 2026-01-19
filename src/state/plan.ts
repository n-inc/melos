import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * タスク実行エンジン
 */
export type TaskEngine = 'claude' | 'codex';

/**
 * PLAN.json の個別タスク
 */
export interface PlanTask {
  /** タスクID（例: "1", "review-1"） */
  id: string;
  /** タスクの説明 */
  description: string;
  /** 検証ステップ */
  stepsToVerify?: string[];
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

  if (t.stepsToVerify !== undefined) {
    if (!Array.isArray(t.stepsToVerify)) {
      throw new Error('Task.stepsToVerify must be an array if present');
    }
    for (let i = 0; i < t.stepsToVerify.length; i++) {
      if (typeof t.stepsToVerify[i] !== 'string') {
        throw new Error(`Task.stepsToVerify[${i}] must be a string`);
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
