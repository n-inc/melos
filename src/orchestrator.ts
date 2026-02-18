import { join } from 'node:path';
import { existsSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import { ManagerAgent, type ManagerAgentConfig } from './agents/manager.js';
import { WorkerAgent, type WorkerAgentConfig } from './agents/worker.js';
import type { ManagerInput, WorkerInput, ManagerDecision, WorkerResult } from './agents/types.js';
import {
  loadPlan,
  planExists,
  addTasks,
  createMissingReviewTasks,
  getPendingTasks,
  isReviewTask,
  updateTaskStatus,
  syncAutoChecksFromVerification,
  isAllChecksPassed,
  type Plan,
  type PlanTask,
} from './state/plan.js';
import {
  type WorkOrder,
  saveWorkOrder,
} from './state/work-order.js';
import {
  type DiscoveredTask,
  type WorkReport,
  saveWorkReport,
  loadWorkReport,
} from './state/work-report.js';
import {
  type Escalation,
  saveEscalation,
  loadEscalation,
  clearEscalation,
} from './state/escalation.js';
import {
  createSpinner,
  formatElapsed,
  type Spinner,
} from './ui/display.js';

/**
 * オーケストレーターの設定
 */
export interface OrchestratorConfig {
  /** 作業ディレクトリ */
  cwd: string;
  /** 最大イテレーション数 */
  maxIterations: number;
  /** PRD ファイルパス */
  prdFile: string;
  /** プランファイルパス */
  planFile: string;
  /** 進捗ファイルパス */
  progressFile: string;
  /** .melos/ ディレクトリパス */
  melosDir: string;
  /** Manager モデル名 */
  managerModel?: string;
  /** Manager effort レベル */
  managerEffort?: 'low' | 'medium' | 'high' | 'max';
  /** Worker モデル名 */
  workerModel?: string;
  /** Worker 推論努力レベル */
  workerReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** ドライラン（計画のみ、Worker実行しない） */
  dryRun?: boolean;
}

/**
 * ループ実行結果
 */
export interface LoopResult {
  /** 成功フラグ */
  success: boolean;
  /** 完了したイテレーション数 */
  completedIterations: number;
  /** 終了理由 */
  reason: 'complete' | 'max_iterations' | 'error' | 'escalation';
  /** エラーメッセージ（エラー時） */
  error?: string;
  /** HANDOFF 内容（完了時） */
  handoffContent?: string;
}

/**
 * オーケストレーター状態
 */
interface OrchestratorState {
  iteration: number;
  plan: Plan | null;
  prd: string | null;
  progress: string | null;
  lastWorkOrder: WorkOrder | null;
  lastWorkReport: WorkReport | null;
  pendingEscalation: Escalation | null;
}

/**
 * カラー出力用の ANSI コード
 */
const Colors = {
  RED: '\x1b[0;31m',
  GREEN: '\x1b[0;32m',
  YELLOW: '\x1b[1;33m',
  BLUE: '\x1b[0;34m',
  CYAN: '\x1b[0;36m',
  MAGENTA: '\x1b[0;35m',
  DIM: '\x1b[2m',
  NC: '\x1b[0m',
} as const;

/**
 * カラー付きログ出力
 */
function log(color: keyof typeof Colors, message: string): void {
  process.stderr.write(`${Colors[color]}${message}${Colors.NC}\n`);
}

/**
 * シンプルなイテレーションヘッダー
 */
function printIterationHeader(
  iteration: number,
  maxIterations: number,
  agent: 'manager' | 'worker',
  elapsed: string,
  model: string,
  effort: string
): void {
  const agentName = agent === 'manager' ? 'Manager' : 'Worker';
  const color = agent === 'manager' ? 'CYAN' : 'MAGENTA';

  log('BLUE', '');
  log('BLUE', `────────────────────────────────────────`);
  log(color, `Iteration ${iteration}/${maxIterations} │ ${agentName} │ ${elapsed}`);
  log('DIM', `model: ${model} | effort: ${effort}`);
  log('BLUE', `────────────────────────────────────────`);
}

/**
 * オーケストレーター
 *
 * Manager + Worker アーキテクチャでタスクを実行する。
 * - Manager (Claude/Codex): 判断、タスク分解、レビュー
 * - Worker (Codex): タスク実装、テスト、コミット
 */
export class Orchestrator {
  private config: OrchestratorConfig;
  private manager: ManagerAgent;
  private worker: WorkerAgent;
  private state: OrchestratorState;
  private aborted: boolean = false;
  private loopStartTime: Date = new Date();
  private currentSpinner: Spinner | null = null;
  private static readonly DEFAULT_WORKER_MODEL = 'gpt-5.3-codex';
  private static readonly DEFAULT_MANAGER_EFFORT = 'high';
  private static readonly DEFAULT_WORKER_EFFORT = 'medium';

  constructor(config: OrchestratorConfig) {
    this.config = config;

    // Manager Agent 初期化
    const managerConfig: ManagerAgentConfig = {
      cwd: config.cwd,
      promptsDir: join(config.cwd, 'prompts'),
      model: config.managerModel,
      effort: config.managerEffort,
    };
    this.manager = new ManagerAgent(managerConfig);

    // Worker Agent 初期化
    const workerConfig: WorkerAgentConfig = {
      cwd: config.cwd,
      promptsDir: join(config.cwd, 'prompts'),
      model: config.workerModel,
      reasoningEffort: config.workerReasoningEffort,
    };
    this.worker = new WorkerAgent(workerConfig);

    // 状態初期化
    this.state = {
      iteration: 1,
      plan: null,
      prd: null,
      progress: null,
      lastWorkOrder: null,
      lastWorkReport: null,
      pendingEscalation: null,
    };
  }

  /**
   * オーケストレーターを実行する
   */
  async run(): Promise<LoopResult> {
    this.loopStartTime = new Date();

    // .melos/ ディレクトリを作成
    this.ensureMelosDir();

    // 状態を読み込み
    await this.loadState();

    log('BLUE', '');
    log('BLUE', '========================================');
    log('BLUE', 'Melos - Manager + Worker');
    log('BLUE', '========================================');
    log('BLUE', '');

    // メインループ
    while (this.state.iteration <= this.config.maxIterations && !this.aborted) {
      const result = await this.runIteration();

      if (result.reason !== 'continue') {
        return {
          success: result.reason === 'complete',
          completedIterations: this.state.iteration,
          reason: result.reason as LoopResult['reason'],
          error: result.error,
          handoffContent: result.handoffContent,
        };
      }

      this.state.iteration++;
    }

    // 最大イテレーションに達した
    return {
      success: false,
      completedIterations: this.state.iteration,
      reason: 'max_iterations',
    };
  }

  /**
   * 1イテレーションを実行する
   */
  private async runIteration(): Promise<{
    reason: 'continue' | 'complete' | 'escalation' | 'error';
    error?: string;
    handoffContent?: string;
  }> {
    const elapsed = formatElapsed(this.loopStartTime);
    printIterationHeader(
      this.state.iteration,
      this.config.maxIterations,
      'manager',
      elapsed,
      this.config.managerModel ?? '(default)',
      this.config.managerEffort ?? Orchestrator.DEFAULT_MANAGER_EFFORT
    );

    // 1. Manager に判断を求める
    this.currentSpinner = createSpinner('Manager が判断中...');

    const managerInput: ManagerInput = {
      iteration: this.state.iteration,
      plan: this.state.plan,
      prd: this.state.prd,
      progress: this.state.progress,
      lastWorkReport: this.state.lastWorkReport,
      pendingEscalation: this.state.pendingEscalation,
    };

    let decision: ManagerDecision;
    try {
      decision = await this.manager.run(managerInput);
    } catch (error) {
      this.currentSpinner.fail('Manager 実行エラー');
      return {
        reason: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    this.currentSpinner.succeed('Manager 判断完了');

    // 2. 判断に応じて行動
    switch (decision.type) {
      case 'dispatch_task': {
        let workOrder = decision.workOrder;
        const latestPlan = await this.loadLatestPlanForResolution();
        const resolvedTaskId = resolveTaskIdWithFallback(
          latestPlan,
          workOrder.taskId,
          workOrder.description
        );
        if (resolvedTaskId !== workOrder.taskId) {
          log(
            'YELLOW',
            `taskId を補正: "${workOrder.taskId}" -> "${resolvedTaskId}"`
          );
          workOrder = {
            ...workOrder,
            taskId: resolvedTaskId,
          };
        }

        if (this.config.dryRun) {
          log('YELLOW', '[DRY-RUN] Worker 実行をスキップ');
          log('CYAN', `タスク: ${workOrder.taskId}`);
          log('CYAN', `説明: ${workOrder.description}`);
          return { reason: 'continue' };
        }

        // Worker にタスクを実行させる
        const workerResult = await this.runWorker(workOrder);

        // 結果を保存
        this.state.lastWorkOrder = workOrder;
        this.state.lastWorkReport = workerResult.report;
        await saveWorkOrder(this.config.melosDir, workOrder);
        await saveWorkReport(this.config.melosDir, workerResult.report);

        // 成功した場合、プランを更新
        if (planExists(this.config.planFile)) {
          this.state.plan = await this.updatePlanAfterWorker(
            workOrder.taskId,
            workOrder.description,
            workerResult
          );
        }

        return { reason: 'continue' };
      }

      case 'escalate': {
        const escalation = decision.escalation;
        await saveEscalation(this.config.melosDir, escalation);
        this.state.pendingEscalation = escalation;

        log('YELLOW', '');
        log('YELLOW', '========================================');
        log('YELLOW', 'エスカレーション');
        log('YELLOW', '========================================');
        log('YELLOW', `タイプ: ${escalation.type}`);
        log('YELLOW', `質問: ${escalation.question}`);
        if (escalation.options) {
          log('YELLOW', 'オプション:');
          for (const opt of escalation.options) {
            log('YELLOW', `  - ${opt.label}: ${opt.description}`);
          }
        }
        if (escalation.recommendation) {
          log('CYAN', `推奨: ${escalation.recommendation}`);
        }
        log('YELLOW', '');

        return { reason: 'escalation' };
      }

      case 'complete': {
        const completionGuard = shouldBlockCompletion(this.state.plan);
        if (completionGuard.blocked) {
          const reviewCount = completionGuard.pendingReviewTaskIds.length;
          log(
            'YELLOW',
            `未完了タスクが ${completionGuard.pendingTaskIds.length} 件あるため完了を保留します`
          );
          if (reviewCount > 0) {
            log(
              'YELLOW',
              `レビュー未完了タスク: ${completionGuard.pendingReviewTaskIds.join(', ')}`
            );
          }
          return { reason: 'continue' };
        }

        // HANDOFF.md を保存
        const handoffPath = join(this.config.cwd, 'HANDOFF.md');
        await writeFile(handoffPath, decision.handoffContent, 'utf-8');

        log('GREEN', '');
        log('GREEN', '========================================');
        log('GREEN', '全タスク完了');
        log('GREEN', '========================================');
        log('GREEN', `HANDOFF.md を生成しました: ${handoffPath}`);
        log('GREEN', '');

        return {
          reason: 'complete',
          handoffContent: decision.handoffContent,
        };
      }

      case 'error': {
        log('RED', 'Manager の判断を解釈できず終了します');
        log('RED', `理由: ${decision.message}`);
        return {
          reason: 'error',
          error: decision.message,
        };
      }

      case 'review_complete': {
        // レビュー完了の場合は次のイテレーションへ
        if (!decision.approved && decision.feedback) {
          log('YELLOW', `レビューフィードバック: ${decision.feedback}`);
        }
        return { reason: 'continue' };
      }
    }
  }

  /**
   * Worker を実行する
   */
  private async runWorker(workOrder: WorkOrder): Promise<WorkerResult> {
    const elapsed = formatElapsed(this.loopStartTime);
    printIterationHeader(
      this.state.iteration,
      this.config.maxIterations,
      'worker',
      elapsed,
      this.config.workerModel ?? Orchestrator.DEFAULT_WORKER_MODEL,
      this.config.workerReasoningEffort ?? Orchestrator.DEFAULT_WORKER_EFFORT
    );

    this.currentSpinner = createSpinner(
      `Worker がタスク ${workOrder.taskId} を実行中...`
    );

    const workerInput: WorkerInput = {
      workOrder,
      codebasePatterns: this.state.progress,
      prd: this.state.prd,
    };

    let result: WorkerResult;
    try {
      result = await this.worker.run(workerInput);
    } catch (error) {
      this.currentSpinner.fail('Worker 実行エラー');
      return {
        type: 'failed',
        report: {
          iteration: workOrder.iteration,
          taskId: workOrder.taskId,
          status: 'FAILED',
          summary: error instanceof Error ? error.message : String(error),
          filesChanged: [],
          verification: {
            testsRun: false,
            testsPassed: 0,
            testsFailed: 0,
            lintPassed: false,
            typecheckPassed: false,
          },
          successCriteriaResults: [],
          issues: [error instanceof Error ? error.message : String(error)],
          discoveredTasks: [],
          learnings: [],
          requestsHelp: true,
          createdAt: new Date().toISOString(),
        },
      };
    }

    // 結果に応じてスピナーを更新
    switch (result.type) {
      case 'success':
        this.currentSpinner.succeed(
          `タスク ${workOrder.taskId} 完了: ${result.report.summary}`
        );
        break;
      case 'partial':
        // warn がないので succeed を使用
        this.currentSpinner.succeed(
          `タスク ${workOrder.taskId} 部分完了: ${result.report.summary}`
        );
        log('YELLOW', '⚠ 一部の成功基準が満たされていません');
        break;
      case 'blocked':
        this.currentSpinner.fail(
          `タスク ${workOrder.taskId} ブロック: ${result.report.summary}`
        );
        break;
      case 'failed':
        this.currentSpinner.fail(
          `タスク ${workOrder.taskId} 失敗: ${result.report.summary}`
        );
        break;
    }

    // 学習内容を PROGRESS.md に追記
    if (result.report.learnings && result.report.learnings.length > 0) {
      await this.appendLearnings(workOrder.taskId, result.report.learnings);
    }

    return result;
  }

  /**
   * 状態を読み込む
   */
  private async loadState(): Promise<void> {
    // PLAN.json
    if (planExists(this.config.planFile)) {
      this.state.plan = await loadPlan(this.config.planFile);
    }

    // PRD.md
    if (existsSync(this.config.prdFile)) {
      this.state.prd = await readFile(this.config.prdFile, 'utf-8');
    }

    // PROGRESS.md
    if (existsSync(this.config.progressFile)) {
      this.state.progress = await readFile(this.config.progressFile, 'utf-8');
    }

    // 前回の WORK_REPORT
    this.state.lastWorkReport = await loadWorkReport(this.config.melosDir);

    // 保留中のエスカレーション
    this.state.pendingEscalation = await loadEscalation(this.config.melosDir);

    await this.ensureRequiredReviewTasks();
  }

  /**
   * .melos/ ディレクトリを作成する
   */
  private ensureMelosDir(): void {
    if (!existsSync(this.config.melosDir)) {
      mkdirSync(this.config.melosDir, { recursive: true });
    }

    // .gitignore に追加
    const gitignorePath = join(this.config.cwd, '.gitignore');
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      if (!content.includes('.melos/')) {
        appendFileSync(gitignorePath, '\n.melos/\n');
      }
    }
  }

  /**
   * 学習内容を PROGRESS.md に追記する
   */
  private async appendLearnings(
    taskId: string,
    learnings: string[]
  ): Promise<void> {
    const now = new Date().toISOString().split('T')[0];
    const learningLines = formatLearningsForProgress(taskId, learnings, now).split('\n');
    const existing = existsSync(this.config.progressFile)
      ? await readFile(this.config.progressFile, 'utf-8')
      : '# Progress Log\n';

    const updated = upsertLearningsSection(existing, learningLines);
    await writeFile(this.config.progressFile, updated, 'utf-8');

    // 状態を更新
    this.state.progress = updated;
  }

  /**
   * Worker 実行後に PLAN.json のチェックと完了状態を同期する
   */
  private async updatePlanAfterWorker(
    taskId: string,
    taskDescription: string,
    workerResult: WorkerResult
  ): Promise<Plan> {
    const latestPlan = await this.loadLatestPlanForResolution();
    const resolvedTaskId = resolveTaskIdWithFallback(
      latestPlan,
      taskId,
      taskDescription,
      [workerResult.report.taskId]
    );
    if (!latestPlan || !latestPlan.some((task) => task.id === resolvedTaskId)) {
      log(
        'YELLOW',
        `⚠ Task id を PLAN.json に解決できないため更新をスキップ: "${taskId}" -> "${resolvedTaskId}"`
      );
      return latestPlan ?? [];
    }

    let plan = await syncAutoChecksFromVerification(
      this.config.planFile,
      resolvedTaskId,
      workerResult.report.verification
    );

    const task = plan.find((t) => t.id === resolvedTaskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const shouldPass = workerResult.type === 'success' && isAllChecksPassed(task);
    plan = await updateTaskStatus(this.config.planFile, resolvedTaskId, shouldPass);

    const followupTasks = buildFollowupPlanTasks(
      plan,
      workerResult.report.taskId,
      workerResult.report.discoveredTasks
    );
    if (followupTasks.length > 0) {
      plan = await addTasks(this.config.planFile, followupTasks);
      log('CYAN', `フォローアップタスクを PLAN.json に ${followupTasks.length} 件追加`);
    }

    const reviewTasks = getReviewTasksToAdd(plan, !!this.state.prd);
    if (reviewTasks.length > 0) {
      plan = await addTasks(this.config.planFile, reviewTasks);
      log('CYAN', `レビュータスクを PLAN.json に ${reviewTasks.length} 件追加`);
    }

    return plan;
  }

  private async loadLatestPlanForResolution(): Promise<Plan | null> {
    if (!planExists(this.config.planFile)) {
      return this.state.plan;
    }

    const latestPlan = await loadPlan(this.config.planFile);
    this.state.plan = latestPlan;
    return latestPlan;
  }

  private async ensureRequiredReviewTasks(): Promise<void> {
    if (!this.state.plan || !planExists(this.config.planFile)) {
      return;
    }

    const reviewTasks = getReviewTasksToAdd(this.state.plan, !!this.state.prd);
    if (reviewTasks.length === 0) {
      return;
    }

    this.state.plan = await addTasks(this.config.planFile, reviewTasks);
    log('CYAN', `レビュータスクを PLAN.json に ${reviewTasks.length} 件追加`);
  }

  /**
   * エスカレーションに回答する
   */
  async answerEscalation(answer: string): Promise<void> {
    if (!this.state.pendingEscalation) {
      throw new Error('保留中のエスカレーションがありません');
    }

    this.state.pendingEscalation.status = 'answered';
    this.state.pendingEscalation.answer = answer;
    await saveEscalation(this.config.melosDir, this.state.pendingEscalation);
  }

  /**
   * エスカレーションをクリアする
   */
  async clearPendingEscalation(): Promise<void> {
    await clearEscalation(this.config.melosDir);
    this.state.pendingEscalation = null;
  }

  /**
   * 実行を中止する
   */
  abort(): void {
    this.aborted = true;
    this.manager.abort();
    this.worker.abort();
    if (this.currentSpinner) {
      this.currentSpinner.fail('中止されました');
    }
  }
}

/**
 * 完了判定をブロックすべきか判定する
 */
export function shouldBlockCompletion(plan: Plan | null): {
  blocked: boolean;
  pendingTaskIds: string[];
  pendingReviewTaskIds: string[];
} {
  if (!plan) {
    return {
      blocked: false,
      pendingTaskIds: [],
      pendingReviewTaskIds: [],
    };
  }

  const pendingTasks = getPendingTasks(plan);
  if (pendingTasks.length === 0) {
    return {
      blocked: false,
      pendingTaskIds: [],
      pendingReviewTaskIds: [],
    };
  }

  const pendingReviewTaskIds = pendingTasks
    .filter((task) => isReviewTask(task))
    .map((task) => task.id);

  return {
    blocked: true,
    pendingTaskIds: pendingTasks.map((task) => task.id),
    pendingReviewTaskIds,
  };
}

/**
 * Manager が返した taskId を PLAN 上の実IDに解決する
 *
 * 例:
 * - "10" <-> "task-10"
 */
export function resolveTaskIdForPlan(plan: Plan | null, taskId: string): string {
  if (!plan || plan.length === 0) {
    return taskId;
  }

  const requested = taskId.trim();
  if (requested.length === 0) {
    return taskId;
  }

  // まず完全一致を優先
  if (plan.some((task) => task.id === requested)) {
    return requested;
  }

  const directAliases = new Set<string>([requested]);
  const numeric = requested.match(/^\d+$/);
  if (numeric) {
    directAliases.add(`task-${requested}`);
  }
  const prefixed = requested.match(/^task-(\d+)$/);
  if (prefixed) {
    directAliases.add(prefixed[1]);
  }

  const directMatches = plan.filter((task) => directAliases.has(task.id));
  if (directMatches.length === 1) {
    return directMatches[0].id;
  }

  // "10" と "task-10" を同じキーとして扱ったときに一意なら採用
  const canonicalRequested = toCanonicalTaskKey(requested);
  if (!canonicalRequested) {
    return requested;
  }
  const canonicalMatches = plan.filter(
    (task) => toCanonicalTaskKey(task.id) === canonicalRequested
  );
  if (canonicalMatches.length === 1) {
    return canonicalMatches[0].id;
  }

  return requested;
}

export function resolveTaskIdWithFallback(
  plan: Plan | null,
  taskId: string,
  taskDescription?: string,
  fallbackTaskIds: string[] = []
): string {
  if (!plan || plan.length === 0) {
    return taskId;
  }

  const seenCandidates = new Set<string>();
  const candidates = [taskId, ...fallbackTaskIds]
    .map((candidate) => candidate.trim())
    .filter((candidate) => {
      if (candidate.length === 0 || seenCandidates.has(candidate)) {
        return false;
      }
      seenCandidates.add(candidate);
      return true;
    });

  for (const candidate of candidates) {
    const resolved = resolveTaskIdForPlan(plan, candidate);
    if (plan.some((task) => task.id === resolved)) {
      return resolved;
    }
  }

  if (taskDescription) {
    const byDescription = resolveTaskIdByDescription(plan, taskDescription);
    if (byDescription) {
      return byDescription;
    }
  }

  return taskId;
}

export function resolveTaskIdByDescription(
  plan: Plan | null,
  description: string
): string | null {
  if (!plan || plan.length === 0) {
    return null;
  }

  const normalizedDescription = normalizeDescription(description);
  if (normalizedDescription.length === 0) {
    return null;
  }

  const matches = plan.filter(
    (task) => normalizeDescription(task.description) === normalizedDescription
  );
  if (matches.length === 1) {
    return matches[0].id;
  }

  const pendingMatches = matches.filter((task) => !task.passes);
  if (pendingMatches.length === 1) {
    return pendingMatches[0].id;
  }

  return null;
}

function toCanonicalTaskKey(taskId: string): string | null {
  const numericOnly = taskId.match(/^\d+$/);
  if (numericOnly) {
    return normalizeNumericKey(numericOnly[0]);
  }

  const prefixed = taskId.match(/^task-(\d+)$/);
  if (prefixed) {
    return normalizeNumericKey(prefixed[1]);
  }

  return null;
}

function normalizeNumericKey(value: string): string {
  const normalized = value.replace(/^0+(?=\d)/, '');
  return normalized.length > 0 ? normalized : '0';
}

function normalizeDescription(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * PRD が存在する場合に限り、不足しているレビュータスクを返す
 */
export function getReviewTasksToAdd(plan: Plan | null, hasPrd: boolean): PlanTask[] {
  if (!hasPrd || !plan) {
    return [];
  }
  return createMissingReviewTasks(plan);
}

/**
 * PROGRESS.md に追記する学習項目を整形
 */
export function formatLearningsForProgress(
  taskId: string,
  learnings: string[],
  date: string = new Date().toISOString().split('T')[0]
): string {
  return learnings.map((l) => `- ${date} Task ${taskId}: ${l}`).join('\n');
}

/**
 * PROGRESS.md の Learnings セクションへ追記し、旧フォーマットも集約する
 */
export function upsertLearningsSection(
  progressContent: string,
  learningLines: string[]
): string {
  const normalized = progressContent.replace(/\r\n/g, '\n');
  const nonEmptyLearningLines = learningLines.filter((line) => line.trim().length > 0);

  const { withoutLegacy, legacyLines } = extractLegacyLearnings(normalized);
  const lines = withoutLegacy.split('\n');

  const learningsHeaderIndex = lines.findIndex((line) => line.startsWith('## Learnings'));
  let beforeSection = lines;
  let existingLearningLines: string[] = [];
  let afterSection: string[] = [];

  if (learningsHeaderIndex >= 0) {
    let sectionEndIndex = lines.length;
    for (let i = learningsHeaderIndex + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) {
        sectionEndIndex = i;
        break;
      }
    }
    beforeSection = lines.slice(0, learningsHeaderIndex);
    existingLearningLines = lines
      .slice(learningsHeaderIndex + 1, sectionEndIndex)
      .filter((line) => line.startsWith('- '));
    afterSection = lines.slice(sectionEndIndex);
  }

  const mergedLearningLines = dedupeLines([
    ...existingLearningLines,
    ...legacyLines,
    ...nonEmptyLearningLines,
  ]);

  const beforeText = trimTrailingBlankLines(beforeSection).join('\n').trimEnd();
  const baseText = beforeText.length > 0 ? beforeText : '# Progress Log';
  const learningsText = `## Learnings\n\n${mergedLearningLines.join('\n')}`;
  const afterText = trimLeadingBlankLines(afterSection).join('\n').trim();

  let result = `${baseText}\n\n${learningsText}`;
  if (afterText.length > 0) {
    result += `\n\n${afterText}`;
  }

  return `${result.trimEnd()}\n`;
}

function extractLegacyLearnings(content: string): {
  withoutLegacy: string;
  legacyLines: string[];
} {
  const lines = content.split('\n');
  const kept: string[] = [];
  const legacyLines: string[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const match = line.match(/^### Learnings \((\d{4}-\d{2}-\d{2})\)$/);
    if (!match) {
      kept.push(line);
      index++;
      continue;
    }

    const date = match[1];
    index++;

    while (index < lines.length && lines[index].trim() === '') {
      index++;
    }

    while (index < lines.length && lines[index].startsWith('- ')) {
      const raw = lines[index].slice(2).trim();
      const normalized = normalizeLegacyLearningText(raw);
      legacyLines.push(`- ${date} ${normalized}`);
      index++;
    }

    while (index < lines.length && lines[index].trim() === '') {
      index++;
    }
  }

  return {
    withoutLegacy: kept.join('\n'),
    legacyLines,
  };
}

function normalizeLegacyLearningText(text: string): string {
  const bracketTask = text.match(/^\[(.+?)\]\s*(.*)$/);
  if (bracketTask) {
    return `Task ${bracketTask[1]}: ${bracketTask[2]}`.trim();
  }
  return text;
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    if (!line || seen.has(line)) {
      continue;
    }
    seen.add(line);
    result.push(line);
  }
  return result;
}

function trimTrailingBlankLines(lines: string[]): string[] {
  const result = [...lines];
  while (result.length > 0 && result[result.length - 1].trim() === '') {
    result.pop();
  }
  return result;
}

function trimLeadingBlankLines(lines: string[]): string[] {
  const result = [...lines];
  while (result.length > 0 && result[0].trim() === '') {
    result.shift();
  }
  return result;
}

/**
 * WorkReport の discoveredTasks から PLAN 追加用タスクを生成する
 *
 * ルール:
 * - priority=high は個別タスクとして追加
 * - priority=medium/low は relatedTaskId 単位で集約（未指定は 1 つに集約）
 */
export function buildFollowupPlanTasks(
  plan: Plan,
  sourceTaskId: string,
  discoveredTasks: DiscoveredTask[]
): PlanTask[] {
  if (!discoveredTasks || discoveredTasks.length === 0) {
    return [];
  }

  const existingIds = new Set(plan.map((task) => task.id));
  const drafts: Array<{ description: string }> = [];

  const groupedMinor = new Map<string, DiscoveredTask[]>();

  for (const task of discoveredTasks) {
    if (!task.description || task.description.trim().length === 0) {
      continue;
    }

    if (task.priority === 'high') {
      drafts.push({
        description: `[Follow-up] ${task.description.trim()}`,
      });
      continue;
    }

    const bucketKey = task.relatedTaskId?.trim() || '__minor_misc__';
    const bucket = groupedMinor.get(bucketKey) ?? [];
    bucket.push(task);
    groupedMinor.set(bucketKey, bucket);
  }

  for (const bucket of groupedMinor.values()) {
    if (bucket.length === 1) {
      drafts.push({
        description: `[Follow-up] ${bucket[0].description.trim()}`,
      });
      continue;
    }

    const preview = bucket
      .slice(0, 2)
      .map((task) => task.description.trim())
      .join(' / ');
    const tail = bucket.length > 2 ? ` ほか${bucket.length - 2}件` : '';
    drafts.push({
      description: `[Follow-up] 軽微な不整合 ${bucket.length} 件をまとめて対応: ${preview}${tail}`,
    });
  }

  return drafts.map((draft) => ({
    id: createNextFollowupTaskId(existingIds, sourceTaskId),
    description: draft.description,
    passes: false,
  }));
}

function createNextFollowupTaskId(existingIds: Set<string>, sourceTaskId: string): string {
  let sequence = 1;
  while (true) {
    const candidate = `${sourceTaskId}-followup-${sequence}`;
    if (!existingIds.has(candidate)) {
      existingIds.add(candidate);
      return candidate;
    }
    sequence++;
  }
}
