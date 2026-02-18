import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * タスク実行エンジン
 */
export type TaskEngine = 'claude' | 'codex';

/**
 * レビュータスクの種類
 */
export type ReviewType = 'product' | 'code';

/**
 * 有効なレビュータスク種類
 */
export const VALID_REVIEW_TYPES: ReviewType[] = ['product', 'code'];

/**
 * チェック項目のタイプ
 */
export type CheckType =
  | 'auto:jest'      // Jest で自動検証
  | 'auto:rspec'     // RSpec で自動検証
  | 'auto:lint'      // lint で自動検証
  | 'auto:typecheck' // 型チェックで自動検証
  | 'browser'        // ブラウザで確認（証拠必須）
  | 'manual';        // 手動確認

/**
 * 有効なチェックタイプのリスト
 */
export const VALID_CHECK_TYPES: CheckType[] = [
  'auto:jest',
  'auto:rspec',
  'auto:lint',
  'auto:typecheck',
  'browser',
  'manual',
];

const CHECK_TYPE_ALIASES: Record<string, CheckType> = {
  jest: 'auto:jest',
  rspec: 'auto:rspec',
  lint: 'auto:lint',
  eslint: 'auto:lint',
  'auto:eslint': 'auto:lint',
  typecheck: 'auto:typecheck',
  tsc: 'auto:typecheck',
  'auto:tsc': 'auto:typecheck',
  ui: 'browser',
  human: 'manual',
};

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
  /** lint パスしたか */
  lintPassed: boolean;
  /** typecheck パスしたか */
  typecheckPassed: boolean;
}

/**
 * TASK.json の個別タスク
 */
export interface TaskEntry {
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
  /** レビュータスク種別（未指定は実装タスク） */
  reviewType?: ReviewType;
  /** レビュー世代（reviewType 指定時は必須） */
  reviewGeneration?: number;
}

/**
 * TASK.json 全体の型
 */
export type TaskList = TaskEntry[];

/**
 * TASK.json が存在するか確認
 */
export function taskFileExists(path: string): boolean {
  return existsSync(path);
}

/**
 * TASK.json を読み込んでパースする
 * @throws {Error} ファイルが存在しない場合、またはパースに失敗した場合
 */
export async function loadTasks(path: string): Promise<TaskList> {
  if (!taskFileExists(path)) {
    throw new Error(`TASK.json not found: ${path}`);
  }

  const content = await readFile(path, 'utf-8');
  const parsed: unknown = JSON.parse(content);

  if (!Array.isArray(parsed)) {
    throw new Error('TASK.json must be an array');
  }

  // 各タスクを検証
  for (const task of parsed) {
    validateTask(task);
  }

  return parsed as TaskList;
}

/**
 * TASK.json を保存する
 */
export async function saveTasks(path: string, plan: TaskList): Promise<void> {
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
): Promise<TaskList> {
  const plan = await loadTasks(path);
  const task = plan.find((t) => t.id === taskId);

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  task.passes = passes;
  await saveTasks(path, plan);
  return plan;
}

/**
 * 未完了タスクを取得する（passes: false）
 * 元の順序を維持（先頭から順に実行）
 */
export function getPendingTasks(plan: TaskList): TaskEntry[] {
  return plan.filter((task) => !task.passes);
}

/**
 * 次に実行すべきタスクを取得する
 */
export function getNextTask(plan: TaskList): TaskEntry | undefined {
  const pending = getPendingTasks(plan);
  return pending[0];
}

/**
 * すべてのタスクが完了しているか確認
 */
export function isAllTasksCompleted(plan: TaskList): boolean {
  return plan.every((task) => task.passes);
}

/**
 * 新しいタスクを追加する
 */
export async function addTasks(path: string, tasks: TaskEntry[]): Promise<TaskList> {
  const plan = await loadTasks(path);
  plan.push(...tasks);
  await saveTasks(path, plan);
  return plan;
}

/**
 * タスクオブジェクトを検証する
 */
function validateTask(task: unknown): asserts task is TaskEntry {
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
      // チェックタイプは厳密一致で落とさず、既知値へ正規化（未知値は manual にフォールバック）
      check.type = normalizeCheckType(check.type);
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

  if (t.model !== undefined) {
    const normalizedModel = normalizeTaskEngine(t.model);
    if (normalizedModel) {
      t.model = normalizedModel;
    } else {
      delete t.model;
    }
  }

  if (t.reviewType !== undefined) {
    const normalizedReviewType = normalizeReviewType(t.reviewType);
    if (normalizedReviewType) {
      t.reviewType = normalizedReviewType;
    } else {
      delete t.reviewType;
    }
  }

  if (t.reviewGeneration !== undefined) {
    const normalizedGeneration = normalizeReviewGeneration(t.reviewGeneration);
    if (normalizedGeneration) {
      t.reviewGeneration = normalizedGeneration;
    } else {
      delete t.reviewGeneration;
    }
  }

  if (t.reviewType !== undefined && t.reviewGeneration === undefined) {
    const inferredGeneration = inferReviewGenerationFromTaskId(t.id);
    if (inferredGeneration) {
      t.reviewGeneration = inferredGeneration;
    } else {
      // reviewGeneration が補完不能なら、通常タスクとして扱って実行継続
      delete t.reviewType;
    }
  }

  if (t.reviewGeneration !== undefined && t.reviewType === undefined) {
    delete t.reviewGeneration;
  }
}

/**
 * レビュータスクかどうか
 */
export function isReviewTask(task: TaskEntry): boolean {
  return task.reviewType !== undefined;
}

/**
 * 実装タスク（reviewType 未指定）を取得
 */
export function getImplementationTasks(plan: TaskList): TaskEntry[] {
  return plan.filter((task) => !isReviewTask(task));
}

/**
 * 現在のレビュー世代（実装タスク数）を取得
 */
export function getCurrentReviewGeneration(plan: TaskList): number {
  return getImplementationTasks(plan).length;
}

/**
 * 必須レビュー（product/code）で不足しているタスクを生成する
 *
 * 生成条件:
 * - 実装タスクが1件以上ある
 * - 実装タスクが全て完了している
 * - 当該 generation に reviewType=product/code の両方が存在しない
 */
export function createMissingReviewTasks(plan: TaskList): TaskEntry[] {
  const implementationTasks = getImplementationTasks(plan);
  if (implementationTasks.length === 0) {
    return [];
  }

  if (implementationTasks.some((task) => !task.passes)) {
    return [];
  }

  const generation = implementationTasks.length;
  const existingTypes = new Set<ReviewType>();
  for (const task of plan) {
    if (task.reviewType && task.reviewGeneration === generation) {
      existingTypes.add(task.reviewType);
    }
  }

  const missingTypes = VALID_REVIEW_TYPES.filter((type) => !existingTypes.has(type));
  if (missingTypes.length === 0) {
    return [];
  }

  const existingIds = new Set(plan.map((task) => task.id));
  return missingTypes.map((type) =>
    createReviewTask(existingIds, generation, type)
  );
}

function createReviewTask(
  existingIds: Set<string>,
  generation: number,
  type: ReviewType
): TaskEntry {
  const baseId = `review-${type}-g${generation}`;
  let id = baseId;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${baseId}-${suffix}`;
    suffix++;
  }
  existingIds.add(id);

  const description =
    type === 'product'
      ? `[Product Review] PRD.md との整合性を確認し、要件未達・仕様乖離を洗い出す (generation ${generation})`
      : `[Code Review] 変更差分中心で P1/P2 相当の品質問題を確認する (generation ${generation})`;

  return {
    id,
    description,
    passes: false,
    reviewType: type,
    reviewGeneration: generation,
  };
}

/**
 * 特定のチェック項目の状態を更新する
 */
export async function updateCheckStatus(
  path: string,
  taskId: string,
  checkIndex: number,
  passed: boolean
): Promise<TaskList> {
  const plan = await loadTasks(path);
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
  await saveTasks(path, plan);
  return plan;
}

/**
 * タスクのすべてのチェック項目が完了しているか確認
 */
export function isAllChecksPassed(task: TaskEntry): boolean {
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
): Promise<TaskList> {
  const plan = await loadTasks(path);
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

  await saveTasks(path, plan);
  return plan;
}

/**
 * Worker の検証結果から auto:* チェックを同期する
 */
export async function syncAutoChecksFromVerification(
  path: string,
  taskId: string,
  verification: VerificationSummary
): Promise<TaskList> {
  const plan = await loadTasks(path);
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

  await saveTasks(path, plan);
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
    case 'auto:lint':
      return verification.lintPassed;
    case 'auto:typecheck':
      return verification.typecheckPassed;
    default:
      return null;
  }
}

function normalizeCheckType(type: unknown): CheckType {
  if (typeof type !== 'string') {
    return 'manual';
  }

  const normalized = type.trim().toLowerCase();
  if (VALID_CHECK_TYPES.includes(normalized as CheckType)) {
    return normalized as CheckType;
  }

  return CHECK_TYPE_ALIASES[normalized] ?? 'manual';
}

function normalizeTaskEngine(model: unknown): TaskEngine | undefined {
  if (typeof model !== 'string') {
    return undefined;
  }

  const normalized = model.trim().toLowerCase();
  if (normalized === 'claude' || normalized === 'codex') {
    return normalized;
  }

  if (normalized === 'openai' || normalized === 'gpt') {
    return 'codex';
  }

  return undefined;
}

function normalizeReviewType(reviewType: unknown): ReviewType | undefined {
  if (typeof reviewType !== 'string') {
    return undefined;
  }

  const normalized = reviewType.trim().toLowerCase();
  if (VALID_REVIEW_TYPES.includes(normalized as ReviewType)) {
    return normalized as ReviewType;
  }

  if (normalized === 'prd' || normalized === 'product-review') {
    return 'product';
  }
  if (normalized === 'code-review') {
    return 'code';
  }

  return undefined;
}

function normalizeReviewGeneration(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 1) {
      return value;
    }
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (parsed >= 1) {
        return parsed;
      }
    }
  }

  return undefined;
}

function inferReviewGenerationFromTaskId(taskId: unknown): number | undefined {
  if (typeof taskId !== 'string') {
    return undefined;
  }

  const match = taskId.match(/-g(\d+)(?:$|-)/i);
  if (!match) {
    return undefined;
  }

  return Number.parseInt(match[1], 10);
}

/**
 * TASK修正の記録
 */
export interface TaskModification {
  timestamp: string;
  type: 'add' | 'update' | 'delete';
  taskId: string;
  reason: string;
  previousState?: TaskEntry;
}

/**
 * TASK.json を修正し、修正履歴を記録
 */
export async function modifyTasks(
  path: string,
  modification: {
    type: 'add' | 'update' | 'delete';
    taskId: string;
    reason: string;
    task?: TaskEntry;
  }
): Promise<{ tasks: TaskList; modification: TaskModification }> {
  const plan = await loadTasks(path);
  const timestamp = new Date().toISOString();

  const record: TaskModification = {
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

  await saveTasks(path, plan);

  return { tasks: plan, modification: record };
}
