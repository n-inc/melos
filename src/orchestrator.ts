import { join } from 'node:path';
import { existsSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import { ManagerAgent, type ManagerAgentConfig } from './agents/manager.js';
import { WorkerAgent, type WorkerAgentConfig } from './agents/worker.js';
import type {
  AskUserPrompt,
  ManagerInput,
  WorkerInput,
  ManagerDecision,
  WorkerResult,
  SteerResult,
} from './agents/types.js';
import {
  loadTasks,
  saveTasks,
  taskFileExists,
  addTasks,
  createInitialReviewTasks,
  createMissingReviewTasks,
  getPendingTasks,
  isReviewTask,
  updateTaskStatus,
  syncAutoChecksFromVerification,
  isAllChecksPassed,
  type TaskList,
  type TaskEntry,
} from './state/task.js';
import {
  type DiscoveredTask,
  type WorkReport,
  saveWorkReport,
  loadWorkReport,
} from './state/work-report.js';
import type { ExecutionMode } from './state/progress.js';
import {
  type Escalation,
  loadEscalation,
  clearEscalation,
} from './state/escalation.js';
import {
  type MelosSession,
  saveSession as saveSessionState,
} from './state/session.js';
import {
  createAppServerEventLogger,
  createSpinner,
  createStreamRenderer,
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
  /** タスクファイルパス */
  taskFile: string;
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
  /** 実行モード */
  executionMode?: ExecutionMode;
  /** ドライラン（計画のみ、Worker実行しない） */
  dryRun?: boolean;
  /** 中断セッションからの再開情報 */
  resumeSession?: MelosSession | null;
  /** 対話入力が可能かどうか */
  interactiveInputEnabled?: boolean;
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
  reason: 'complete' | 'max_iterations' | 'error';
  /** エラーメッセージ（エラー時） */
  error?: string;
  /** HANDOFF 内容（完了時） */
  handoffContent?: string;
}

export type OrchestratorSteerResult =
  | { status: 'accepted' }
  | { status: 'answered'; answer: string }
  | { status: 'queued'; queuedCount: number; target: 'manager-codex' }
  | { status: 'unavailable' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

/**
 * オーケストレーター状態
 */
interface OrchestratorState {
  iteration: number;
  tasks: TaskList | null;
  prd: string | null;
  progress: string | null;
  lastWorkReport: WorkReport | null;
  pendingEscalation: Escalation | null;
  pendingQuestion: AskUserPrompt | null;
  currentTaskId: string | null;
  pendingSteers: string[];
}

const CODEX_MODEL_PATTERN = /codex/i;

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
  private activeAgent: 'manager' | 'worker' | null = null;
  private pendingResumeTaskId: string | null;
  private pendingQuestionAnswerResolver: (() => void) | null = null;
  private static readonly DEFAULT_WORKER_MODEL = 'gpt-5.3-codex';
  private static readonly DEFAULT_MANAGER_EFFORT = 'high';
  private static readonly DEFAULT_WORKER_EFFORT = 'high';

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
      claudeModel: config.managerModel,
      claudeEffort: config.managerEffort,
      resumeThreadId: config.resumeSession?.threadId,
      resumeTaskId: config.resumeSession?.currentTaskId,
    };
    this.worker = new WorkerAgent(workerConfig);
    this.pendingResumeTaskId = config.resumeSession?.currentTaskId ?? null;

    // 状態初期化
    this.state = {
      iteration: config.resumeSession?.iteration ?? 1,
      tasks: null,
      prd: null,
      progress: null,
      lastWorkReport: null,
      pendingEscalation: config.resumeSession?.pendingEscalation ?? null,
      pendingQuestion: config.resumeSession?.pendingQuestion ?? null,
      currentTaskId: config.resumeSession?.currentTaskId ?? null,
      pendingSteers: (config.resumeSession?.pendingSteers ?? [])
        .map((instruction) => instruction.trim())
        .filter((instruction) => instruction.length > 0),
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
    reason: 'continue' | 'complete' | 'error';
    error?: string;
    handoffContent?: string;
  }> {
    if (this.state.pendingQuestion) {
      await this.resolvePendingQuestionFlow(this.state.pendingQuestion);
      return { reason: 'continue' };
    }

    if (this.pendingResumeTaskId) {
      const taskId = this.pendingResumeTaskId;
      this.pendingResumeTaskId = null;
      const latestTasks = await this.loadLatestTaskListForResolution();
      const taskToRun = this.resolveTaskForExecution(taskId, latestTasks);
      log('CYAN', `resume: 中断タスクを再開します (${taskToRun.id})`);

      if (this.config.dryRun) {
        log('YELLOW', '[DRY-RUN] resume では Worker 実行をスキップ');
        return { reason: 'continue' };
      }

      const workerResult = await this.runWorker(taskToRun);
      this.state.lastWorkReport = workerResult.report;
      await saveWorkReport(this.config.melosDir, workerResult.report);

      if (taskFileExists(this.config.taskFile)) {
        this.state.tasks = await this.updateTaskListAfterWorker(
          taskToRun.id,
          taskToRun.description,
          workerResult
        );
      }

      return { reason: 'continue' };
    }

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
    this.currentSpinner = createSpinner(
      buildManagerRunMessage(this.state.lastWorkReport)
    );
    const managerStreamRenderer = createStreamRenderer();
    const managerEventLogger = createAppServerEventLogger('manager');
    let managerSpinnerStoppedForStream = false;
    const stopManagerSpinnerForStream = () => {
      if (managerSpinnerStoppedForStream) {
        return;
      }
      this.currentSpinner?.stop();
      managerSpinnerStoppedForStream = true;
    };

    const managerInput: ManagerInput = {
      iteration: this.state.iteration,
      maxIterations: this.config.maxIterations,
      tasks: this.getTasksForManagerInput(),
      prd: this.state.prd,
      progress: this.state.progress,
      lastWorkReport: this.state.lastWorkReport,
      pendingEscalation: this.state.pendingEscalation,
      deferredSteers: undefined,
      executionMode: this.config.executionMode ?? 'default',
      onAgentMessageDelta: (chunk) => {
        stopManagerSpinnerForStream();
        managerStreamRenderer.writeAgentDelta(chunk);
      },
      onCommandOutputDelta: (chunk) => {
        stopManagerSpinnerForStream();
        managerStreamRenderer.writeCommandDelta(chunk);
      },
      onAppServerEvent: (method, params) => {
        stopManagerSpinnerForStream();
        managerEventLogger.writeEvent(method, params);
      },
    };
    const deferredSteersForManager = this.shouldDeliverDeferredSteersToManager()
      ? [...this.state.pendingSteers]
      : [];
    if (deferredSteersForManager.length > 0) {
      managerInput.deferredSteers = deferredSteersForManager;
      log(
        'CYAN',
        `保留 steer を Manager(Codex) に ${deferredSteersForManager.length} 件引き渡し`
      );
    }

    let decision: ManagerDecision;
    this.activeAgent = 'manager';
    try {
      decision = await this.manager.run(managerInput);
      if (deferredSteersForManager.length > 0) {
        this.state.pendingSteers.splice(0, deferredSteersForManager.length);
      }
      if (this.state.pendingEscalation?.status === 'answered') {
        this.state.pendingEscalation = null;
      }
    } catch (error) {
      managerStreamRenderer.finish();
      this.currentSpinner.fail('Manager 実行エラー');
      return {
        reason: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.activeAgent = null;
    }
    managerStreamRenderer.finish();

    // 2. 判断に応じて行動
    switch (decision.type) {
      case 'dispatch_task': {
        const latestTasks = await this.loadLatestTaskListForResolution();
        const taskToRun = this.resolveTaskForExecution(decision.taskId, latestTasks);

        this.currentSpinner.succeed(
          buildManagerDecisionMessage(
            { type: 'dispatch_task', taskId: taskToRun.id },
            taskToRun.description
          )
        );

        if (this.config.dryRun) {
          log('YELLOW', '[DRY-RUN] Worker 実行をスキップ');
          log('CYAN', `タスク: ${taskToRun.id}`);
          log('CYAN', `説明: ${taskToRun.description}`);
          return { reason: 'continue' };
        }

        // Worker にタスクを実行させる
        const workerResult = await this.runWorker(taskToRun, decision.briefing);

        // 結果を保存
        this.state.lastWorkReport = workerResult.report;
        await saveWorkReport(this.config.melosDir, workerResult.report);

        // 成功した場合、TASK.json を更新
        if (taskFileExists(this.config.taskFile)) {
          this.state.tasks = await this.updateTaskListAfterWorker(
            taskToRun.id,
            taskToRun.description,
            workerResult
          );
        }

        return { reason: 'continue' };
      }

      case 'ask_user': {
        this.currentSpinner.succeed(buildManagerDecisionMessage(decision));
        await this.resolvePendingQuestionFlow(decision.prompt);
        return { reason: 'continue' };
      }

      case 'escalate': {
        this.currentSpinner.succeed(buildManagerDecisionMessage(decision));
        const prompt = this.toAskUserPrompt(decision.escalation);
        await this.resolvePendingQuestionFlow(prompt);
        return { reason: 'continue' };
      }

      case 'complete': {
        this.currentSpinner.succeed(buildManagerDecisionMessage(decision));
        const readyToComplete = await this.ensureReadyForCompletion();
        if (!readyToComplete) {
          return { reason: 'continue' };
        }

        // HANDOFF.md を保存
        const handoffPath = join(this.config.cwd, 'HANDOFF.md');
        await writeFile(handoffPath, decision.handoffContent, 'utf-8');

        log('GREEN', '');
        log('GREEN', '========================================');
        log('GREEN', 'HANDOFF 出力完了');
        log('GREEN', '========================================');
        log('GREEN', `HANDOFF.md を生成しました: ${handoffPath}`);
        log('GREEN', '');

        return {
          reason: 'complete',
          handoffContent: decision.handoffContent,
        };
      }

      case 'error': {
        this.currentSpinner.fail(buildManagerDecisionMessage(decision));
        log('RED', 'Manager の判断を解釈できず終了します');
        log('RED', `理由: ${decision.message}`);
        return {
          reason: 'error',
          error: decision.message,
        };
      }

      case 'review_complete': {
        this.currentSpinner.succeed(buildManagerDecisionMessage(decision));
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
  private async runWorker(task: TaskEntry, briefing?: string): Promise<WorkerResult> {
    const elapsed = formatElapsed(this.loopStartTime);
    printIterationHeader(
      this.state.iteration,
      this.config.maxIterations,
      'worker',
      elapsed,
      this.config.workerModel ?? Orchestrator.DEFAULT_WORKER_MODEL,
      this.config.workerReasoningEffort ?? Orchestrator.DEFAULT_WORKER_EFFORT
    );

    this.currentSpinner = createSpinner(buildWorkerRunMessage(task));
    const streamRenderer = createStreamRenderer();
    const eventLogger = createAppServerEventLogger('worker');
    let spinnerStoppedForStream = false;
    const stopSpinnerForStream = () => {
      if (spinnerStoppedForStream) {
        return;
      }
      this.currentSpinner?.stop();
      spinnerStoppedForStream = true;
    };

    const workerInput: WorkerInput = {
      iteration: this.state.iteration,
      task,
      codebasePatterns: this.state.progress,
      prd: this.state.prd,
      briefing,
      onAgentMessageDelta: (chunk) => {
        stopSpinnerForStream();
        streamRenderer.writeAgentDelta(chunk);
      },
      onCommandOutputDelta: (chunk) => {
        stopSpinnerForStream();
        streamRenderer.writeCommandDelta(chunk);
      },
      onAppServerEvent: (method, params) => {
        stopSpinnerForStream();
        eventLogger.writeEvent(method, params);
      },
    };

    let result: WorkerResult;
    this.state.currentTaskId = task.id;
    this.activeAgent = 'worker';
    try {
      result = await this.worker.run(workerInput);
    } catch (error) {
      streamRenderer.finish();
      const failedResult: WorkerResult = {
        type: 'failed',
        report: {
          iteration: this.state.iteration,
          taskId: task.id,
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
      this.currentSpinner.fail(buildWorkerFinishMessage(task, failedResult));
      this.state.currentTaskId = null;
      this.activeAgent = null;
      return failedResult;
    }
    this.activeAgent = null;
    streamRenderer.finish();

    const finishMessage = buildWorkerFinishMessage(task, result);
    // 結果に応じてスピナーを更新
    switch (result.type) {
      case 'success':
        this.currentSpinner.succeed(finishMessage);
        break;
      case 'partial':
        // warn がないので succeed を使用
        this.currentSpinner.succeed(finishMessage);
        log('YELLOW', '⚠ 一部の成功基準が満たされていません');
        break;
      case 'blocked':
        this.currentSpinner.fail(finishMessage);
        break;
      case 'failed':
        this.currentSpinner.fail(finishMessage);
        break;
    }

    // 学習内容を PROGRESS.md に追記
    if (
      (result.report.learnings?.length ?? 0) > 0 ||
      (result.report.keyDecisions?.length ?? 0) > 0
    ) {
      await this.appendLearnings(task.id, result.report);
    }

    this.state.currentTaskId = null;
    return result;
  }

  /**
   * 中断セッションを保存する
   */
  async saveSession(): Promise<boolean> {
    const currentTaskId = this.state.currentTaskId;
    const pendingSteers = this.state.pendingSteers
      .map((instruction) => instruction.trim())
      .filter((instruction) => instruction.length > 0);
    const pendingQuestion = this.state.pendingQuestion ?? undefined;
    const pendingEscalation = this.state.pendingEscalation ?? undefined;
    if (!currentTaskId && pendingSteers.length === 0 && !pendingQuestion && !pendingEscalation) {
      return false;
    }

    const threadId = currentTaskId
      ? this.worker.getActiveThreadId() ?? this.manager.getActiveThreadId()
      : undefined;

    await saveSessionState(this.config.melosDir, {
      threadId: threadId ?? undefined,
      currentTaskId: currentTaskId ?? undefined,
      iteration: this.state.iteration,
      interruptedAt: new Date().toISOString(),
      model: currentTaskId
        ? this.config.workerModel ?? Orchestrator.DEFAULT_WORKER_MODEL
        : undefined,
      pendingSteers: pendingSteers.length > 0 ? pendingSteers : undefined,
      pendingQuestion,
      pendingEscalation,
    });
    return true;
  }

  /**
   * 状態を読み込む
   */
  private async loadState(): Promise<void> {
    // TASK.json
    if (taskFileExists(this.config.taskFile)) {
      this.state.tasks = await loadTasks(this.config.taskFile);
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

    // 旧形式の保留エスカレーション（互換読み込み）
    const fileEscalation = await loadEscalation(this.config.melosDir);
    if (fileEscalation) {
      this.state.pendingEscalation = fileEscalation;
    }
    if (this.state.pendingEscalation) {
      const legacy = this.state.pendingEscalation;
      if (legacy.status === 'answered' && typeof legacy.answer === 'string' && legacy.answer.trim().length > 0) {
        if (this.shouldDeliverDeferredSteersToManager()) {
          this.state.pendingSteers.push(
            this.formatQuestionAnswerAsSteer(this.toAskUserPrompt(legacy), legacy.answer.trim())
          );
          this.state.pendingEscalation = null;
        } else {
          this.state.pendingEscalation = legacy;
        }
      } else if (!this.state.pendingQuestion) {
        this.state.pendingQuestion = this.toAskUserPrompt(legacy);
        this.state.pendingEscalation = null;
      }
      await clearEscalation(this.config.melosDir);
    }

    if (this.config.executionMode === 'review-only') {
      await this.ensureReviewOnlyTaskPolicy();
      await this.ensureInitialReviewTasks();
    }

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
    report: WorkReport
  ): Promise<void> {
    const allLearnings = [...(report.learnings || [])];

    if (report.keyDecisions?.length) {
      for (const keyDecision of report.keyDecisions) {
        allLearnings.push(
          `Context: ${taskId} | Finding: ${keyDecision.decision} - ${keyDecision.rationale} | Next Action: この判断を関連タスクで踏襲`
        );
      }
    }

    if (allLearnings.length === 0) {
      return;
    }

    const now = new Date().toISOString().split('T')[0];
    const learningLines = formatLearningsForProgress(taskId, allLearnings, now).split('\n');
    const existing = existsSync(this.config.progressFile)
      ? await readFile(this.config.progressFile, 'utf-8')
      : '# Progress Log\n';

    const updated = upsertLearningsSection(existing, learningLines);
    await writeFile(this.config.progressFile, updated, 'utf-8');

    // 状態を更新
    this.state.progress = updated;
  }

  /**
   * Worker 実行後に TASK.json のチェックと完了状態を同期する
   */
  private async updateTaskListAfterWorker(
    taskId: string,
    taskDescription: string,
    workerResult: WorkerResult
  ): Promise<TaskList> {
    const latestPlan = await this.loadLatestTaskListForResolution();
    const resolvedTaskId = resolveTaskIdWithFallback(
      latestPlan,
      taskId,
      taskDescription,
      [workerResult.report.taskId]
    );
    if (!latestPlan || !latestPlan.some((task) => task.id === resolvedTaskId)) {
      log(
        'YELLOW',
        `⚠ Task id を TASK.json に解決できないため更新をスキップ: "${taskId}" -> "${resolvedTaskId}"`
      );
      return latestPlan ?? [];
    }

    let plan = await syncAutoChecksFromVerification(
      this.config.taskFile,
      resolvedTaskId,
      workerResult.report.verification
    );

    const task = plan.find((t) => t.id === resolvedTaskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    const shouldPass = workerResult.type === 'success' && isAllChecksPassed(task);
    plan = await updateTaskStatus(this.config.taskFile, resolvedTaskId, shouldPass);

    const followupTasks = buildFollowupTaskEntries(
      plan,
      workerResult.report.taskId,
      workerResult.report.discoveredTasks
    );
    if (followupTasks.length > 0) {
      plan = await addTasks(this.config.taskFile, followupTasks);
      log('CYAN', `フォローアップタスクを TASK.json に ${followupTasks.length} 件追加`);
    }

    const reviewTasks = getReviewTasksToAdd(
      plan,
      !!this.state.prd,
      { reviewOnly: this.config.executionMode === 'review-only' }
    );
    if (reviewTasks.length > 0) {
      plan = await addTasks(this.config.taskFile, reviewTasks);
      log('CYAN', `レビュータスクを TASK.json に ${reviewTasks.length} 件追加`);
    }

    return plan;
  }

  private async loadLatestTaskListForResolution(): Promise<TaskList | null> {
    if (!taskFileExists(this.config.taskFile)) {
      return this.state.tasks;
    }

    const latestPlan = await loadTasks(this.config.taskFile);
    this.state.tasks = latestPlan;
    return latestPlan;
  }

  private getTasksForManagerInput(): TaskList | null {
    if (!this.state.tasks) {
      return null;
    }
    if (this.config.executionMode !== 'review-only') {
      return this.state.tasks;
    }
    return this.state.tasks.filter((task) => task.reviewType !== 'product');
  }

  private shouldDeliverDeferredSteersToManager(): boolean {
    if (this.state.pendingSteers.length === 0) {
      return false;
    }
    const model = this.config.managerModel;
    if (typeof model !== 'string' || model.trim().length === 0) {
      return true;
    }
    return CODEX_MODEL_PATTERN.test(model);
  }

  private resolveTaskForExecution(
    requestedTaskId: string,
    latestTasks: TaskList | null
  ): TaskEntry {
    const resolvedTaskId = resolveTaskIdWithFallback(latestTasks, requestedTaskId);
    const prioritizedTaskId = this.config.executionMode === 'review-only'
      ? getReviewOnlyPreferredTaskId(latestTasks, resolvedTaskId)
      : resolvedTaskId;

    if (latestTasks) {
      const matchedTask = latestTasks.find((task) => task.id === prioritizedTaskId);
      if (matchedTask) {
        if (resolvedTaskId !== requestedTaskId) {
          log('YELLOW', `taskId を補正: "${requestedTaskId}" -> "${resolvedTaskId}"`);
        }
        if (prioritizedTaskId !== resolvedTaskId) {
          log(
            'YELLOW',
            `review-only 優先順位で taskId を補正: "${resolvedTaskId}" -> "${prioritizedTaskId}"`
          );
        }
        return matchedTask;
      }
    }

    const closestTask = this.findClosestTaskCandidate(requestedTaskId, latestTasks);
    if (closestTask) {
      log(
        'YELLOW',
        `TASK.json に taskId が見つからないため近い候補へ補正: "${requestedTaskId}" -> "${closestTask.id}"`
      );
      return closestTask;
    }

    log('YELLOW', `TASK.json から解決できない taskId のため最小コンテキストで実行: "${requestedTaskId}"`);
    return {
      id: requestedTaskId,
      description: `Task ${requestedTaskId}`,
      passes: false,
    };
  }

  private findClosestTaskCandidate(
    requestedTaskId: string,
    latestTasks: TaskList | null
  ): TaskEntry | null {
    if (!latestTasks || latestTasks.length === 0) {
      return null;
    }

    const normalizedRequested = requestedTaskId.trim().toLowerCase();
    const requestedCanonical = toCanonicalTaskKey(normalizedRequested);
    const pendingTasks = getPendingTasks(latestTasks);
    const pool = pendingTasks.length > 0 ? pendingTasks : latestTasks;

    let best: { task: TaskEntry; score: number } | null = null;
    for (const task of pool) {
      const taskId = task.id.trim().toLowerCase();
      let score = 0;

      if (taskId === normalizedRequested) {
        score += 1000;
      }

      if (taskId.includes(normalizedRequested) || normalizedRequested.includes(taskId)) {
        score += 300;
      }

      const taskCanonical = toCanonicalTaskKey(taskId);
      if (requestedCanonical && taskCanonical && requestedCanonical === taskCanonical) {
        score += 500;
      }

      const description = task.description.trim().toLowerCase();
      if (normalizedRequested.length > 0 && description.includes(normalizedRequested)) {
        score += 120;
      }

      if (!task.passes) {
        score += 50;
      }

      if (!best || score > best.score) {
        best = { task, score };
      }
    }

    return best?.task ?? null;
  }

  private async ensureRequiredReviewTasks(): Promise<void> {
    if (!this.state.tasks || !taskFileExists(this.config.taskFile)) {
      return;
    }

    const reviewTasks = getReviewTasksToAdd(
      this.state.tasks,
      !!this.state.prd,
      { reviewOnly: this.config.executionMode === 'review-only' }
    );
    if (reviewTasks.length === 0) {
      return;
    }

    this.state.tasks = await addTasks(this.config.taskFile, reviewTasks);
    log('CYAN', `レビュータスクを TASK.json に ${reviewTasks.length} 件追加`);
  }

  private async ensureReviewOnlyTaskPolicy(): Promise<void> {
    if (!this.state.tasks || !taskFileExists(this.config.taskFile)) {
      return;
    }

    const { updatedPlan, closedTaskIds } = closePendingProductReviewsForReviewOnly(this.state.tasks);
    if (closedTaskIds.length === 0) {
      return;
    }

    await saveTasks(this.config.taskFile, updatedPlan);
    this.state.tasks = updatedPlan;
    log(
      'CYAN',
      `review-only: Product Review タスクを ${closedTaskIds.length} 件クローズして無効化`
    );
  }

  private async ensureInitialReviewTasks(): Promise<void> {
    const reviewTasks = createInitialReviewTasks(
      this.state.tasks,
      !!this.state.prd,
      { reviewOnly: this.config.executionMode === 'review-only' }
    );
    if (reviewTasks.length === 0) {
      return;
    }

    if (taskFileExists(this.config.taskFile)) {
      this.state.tasks = await addTasks(this.config.taskFile, reviewTasks);
    } else {
      await saveTasks(this.config.taskFile, reviewTasks);
      this.state.tasks = reviewTasks;
    }

    log('CYAN', `レビュータスクを TASK.json に ${reviewTasks.length} 件追加 (review-only)`);
  }

  private async ensureReadyForCompletion(): Promise<boolean> {
    const latestTasks = await this.loadLatestTaskListForResolution();
    const pendingTasks = latestTasks ? getPendingTasks(latestTasks) : [];
    if (pendingTasks.length > 0) {
      log(
        'YELLOW',
        `未完了タスク ${pendingTasks.length} 件が残っているため、完了判定を保留して継続します`
      );
      return false;
    }

    if (this.config.executionMode !== 'review-only') {
      return true;
    }

    if (isCleanCodeReviewReport(this.state.lastWorkReport, latestTasks)) {
      return true;
    }

    const reviewTasks = createInitialReviewTasks(
      latestTasks,
      !!this.state.prd,
      { reviewOnly: true }
    );
    if (reviewTasks.length === 0) {
      log(
        'YELLOW',
        'review-only: 最終 code review が未確認のため継続します（レビュータスク生成なし）'
      );
      return false;
    }

    if (taskFileExists(this.config.taskFile)) {
      this.state.tasks = await addTasks(this.config.taskFile, reviewTasks);
    } else {
      await saveTasks(this.config.taskFile, reviewTasks);
      this.state.tasks = reviewTasks;
    }

    log(
      'CYAN',
      `review-only: 完了前の全体コード再レビューとして ${reviewTasks.length} 件追加`
    );
    return false;
  }

  private async resolvePendingQuestionFlow(prompt: AskUserPrompt): Promise<void> {
    this.state.pendingQuestion = prompt;
    this.printPendingQuestion(prompt);

    if (!this.isInteractiveInputEnabled()) {
      const auto = this.chooseAutomaticQuestionAnswer(prompt);
      this.submitPendingQuestionAnswer(auto.answer, auto.display);
      log('YELLOW', `非対話モードのため自動回答を採用: ${auto.display}`);
      return;
    }

    await this.waitForPendingQuestionAnswer();
  }

  private waitForPendingQuestionAnswer(): Promise<void> {
    if (!this.state.pendingQuestion) {
      return Promise.resolve();
    }
    if (this.pendingQuestionAnswerResolver) {
      return new Promise<void>((resolve) => {
        const previous = this.pendingQuestionAnswerResolver;
        if (!previous) {
          resolve();
          return;
        }
        this.pendingQuestionAnswerResolver = () => {
          previous();
          resolve();
        };
      });
    }
    return new Promise<void>((resolve) => {
      this.pendingQuestionAnswerResolver = () => {
        this.pendingQuestionAnswerResolver = null;
        resolve();
      };
    });
  }

  private submitPendingQuestionAnswer(answer: string, displayAnswer: string): void {
    const pendingQuestion = this.state.pendingQuestion;
    if (!pendingQuestion) {
      return;
    }
    if (this.shouldDeliverDeferredSteersToManager()) {
      this.state.pendingSteers.push(this.formatQuestionAnswerAsSteer(pendingQuestion, answer));
      this.state.pendingEscalation = null;
    } else {
      this.state.pendingEscalation = this.buildAnsweredEscalationFromPrompt(
        pendingQuestion,
        answer
      );
    }
    this.state.pendingQuestion = null;
    const resolver = this.pendingQuestionAnswerResolver;
    this.pendingQuestionAnswerResolver = null;
    if (resolver) {
      resolver();
    }
    log('CYAN', `質問回答を受け付けました: ${displayAnswer}`);
  }

  private resolvePendingQuestionInput(
    input: string,
    prompt: AskUserPrompt
  ): { ok: true; answer: string; display: string } | { ok: false; message: string } {
    const text = input.trim();
    if (text.length === 0) {
      return { ok: false, message: '回答は空にできません' };
    }

    const options = prompt.options ?? [];
    if (options.length === 0) {
      return { ok: true, answer: text, display: text };
    }

    if (/^\d+$/.test(text)) {
      const index = Number(text) - 1;
      if (index < 0 || index >= options.length) {
        return { ok: false, message: `選択肢は 1〜${options.length} で入力してください` };
      }
      const option = options[index];
      return {
        ok: true,
        answer: option.label,
        display: `${option.label}: ${option.description}`,
      };
    }

    const byLabel = options.find((option) => option.label.toLowerCase() === text.toLowerCase());
    if (byLabel) {
      return {
        ok: true,
        answer: byLabel.label,
        display: `${byLabel.label}: ${byLabel.description}`,
      };
    }

    if (prompt.allowFreeText === false) {
      return { ok: false, message: 'この質問は選択肢から回答してください（番号またはラベル）' };
    }

    return { ok: true, answer: text, display: text };
  }

  private printPendingQuestion(prompt: AskUserPrompt): void {
    log('YELLOW', '');
    log('YELLOW', '========================================');
    log('YELLOW', 'ユーザー確認');
    log('YELLOW', '========================================');
    if (prompt.context) {
      log('YELLOW', `コンテキスト: ${prompt.context}`);
    }
    log('YELLOW', `質問: ${prompt.question}`);
    if (prompt.options && prompt.options.length > 0) {
      log('YELLOW', '選択肢:');
      for (let i = 0; i < prompt.options.length; i++) {
        const option = prompt.options[i];
        log('YELLOW', `  ${i + 1}. ${option.label}: ${option.description}`);
      }
    }
    if (prompt.recommendation) {
      log('CYAN', `推奨: ${prompt.recommendation}`);
    }
    if (this.isInteractiveInputEnabled()) {
      if (prompt.options && prompt.options.length > 0) {
        log('CYAN', '回答方法: 番号、ラベル、または自由入力');
      } else {
        log('CYAN', '回答方法: 自由入力');
      }
    }
    log('YELLOW', '');
  }

  private chooseAutomaticQuestionAnswer(prompt: AskUserPrompt): {
    answer: string;
    display: string;
  } {
    const recommendation = prompt.recommendation?.trim();
    const options = prompt.options ?? [];

    if (recommendation && options.length > 0) {
      const matched = options.find(
        (option) => option.label.toLowerCase() === recommendation.toLowerCase()
      );
      if (matched) {
        return {
          answer: matched.label,
          display: `${matched.label}: ${matched.description}`,
        };
      }
    }

    if (options.length > 0) {
      const first = options[0];
      return {
        answer: first.label,
        display: `${first.label}: ${first.description}`,
      };
    }

    if (recommendation && recommendation.length > 0) {
      return { answer: recommendation, display: recommendation };
    }

    const fallback = 'Recommendation がある場合はそれに従い、最善の方針で継続してください。';
    return { answer: fallback, display: fallback };
  }

  private toAskUserPrompt(escalation: Escalation): AskUserPrompt {
    return {
      question: escalation.question,
      context: escalation.context,
      options: escalation.options,
      recommendation: escalation.recommendation,
      allowFreeText: true,
    };
  }

  private buildAnsweredEscalationFromPrompt(prompt: AskUserPrompt, answer: string): Escalation {
    return {
      id: `esc-${Date.now()}`,
      createdAt: new Date().toISOString(),
      type: 'QUESTION',
      context: prompt.context ?? this.state.currentTaskId ?? `iteration-${this.state.iteration}`,
      question: prompt.question,
      options: prompt.options,
      recommendation: prompt.recommendation,
      status: 'answered',
      answer,
      answeredAt: new Date().toISOString(),
    };
  }

  private formatQuestionAnswerAsSteer(prompt: AskUserPrompt, answer: string): string {
    const lines = ['[manager-question-answer]', `question: ${prompt.question}`, `answer: ${answer}`];
    if (prompt.context) {
      lines.push(`context: ${prompt.context}`);
    }
    if (prompt.recommendation) {
      lines.push(`recommendation: ${prompt.recommendation}`);
    }
    return lines.join('\n');
  }

  private isInteractiveInputEnabled(): boolean {
    if (typeof this.config.interactiveInputEnabled === 'boolean') {
      return this.config.interactiveInputEnabled;
    }
    return process.stdin.isTTY;
  }

  /**
   * 実行中ターンへ追加指示を送る
   */
  async steer(instruction: string): Promise<OrchestratorSteerResult> {
    const text = instruction.trim();
    if (text.length === 0) {
      return { status: 'unavailable' };
    }

    if (!this.activeAgent && this.state.pendingQuestion) {
      const resolved = this.resolvePendingQuestionInput(text, this.state.pendingQuestion);
      if (!resolved.ok) {
        return { status: 'error', message: resolved.message };
      }
      this.submitPendingQuestionAnswer(resolved.answer, resolved.display);
      return { status: 'answered', answer: resolved.display };
    }

    let result: SteerResult;
    try {
      if (this.activeAgent === 'worker') {
        result = await this.worker.steer(text);
      } else if (this.activeAgent === 'manager') {
        result = await this.manager.steer(text);
      } else {
        return { status: 'unavailable' };
      }
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (result === 'accepted') {
      return { status: 'accepted' };
    }
    if (result === 'unsupported') {
      this.state.pendingSteers.push(text);
      return {
        status: 'queued',
        queuedCount: this.state.pendingSteers.length,
        target: 'manager-codex',
      };
    }
    return { status: 'unavailable' };
  }

  /**
   * エスカレーションに回答する
   */
  async answerEscalation(answer: string): Promise<void> {
    if (!this.state.pendingQuestion) {
      throw new Error('保留中のエスカレーションがありません');
    }
    this.submitPendingQuestionAnswer(answer.trim(), answer.trim());
  }

  /**
   * エスカレーションをクリアする
   */
  async clearPendingEscalation(): Promise<void> {
    await clearEscalation(this.config.melosDir);
    this.state.pendingEscalation = null;
    this.state.pendingQuestion = null;
  }

  /**
   * 実行を中止する
   */
  abort(): void {
    this.aborted = true;
    this.manager.abort();
    this.worker.abort();
    const resolver = this.pendingQuestionAnswerResolver;
    this.pendingQuestionAnswerResolver = null;
    if (resolver) {
      resolver();
    }
    if (this.currentSpinner) {
      this.currentSpinner.fail('中止されました');
    }
  }
}

const DEFAULT_TASK_LABEL_WIDTH = 40;
const DEFAULT_SUMMARY_WIDTH = 72;

function normalizeOneLine(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function getCharDisplayWidth(char: string): number {
  const code = char.charCodeAt(0);
  if (
    (code >= 0x3000 && code <= 0x9fff) ||
    (code >= 0xff00 && code <= 0xffef)
  ) {
    return 2;
  }
  return 1;
}

function getDisplayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += getCharDisplayWidth(char);
  }
  return width;
}

function truncateMessage(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (getDisplayWidth(value) <= maxWidth) {
    return value;
  }
  if (maxWidth <= 3) {
    return '.'.repeat(maxWidth);
  }
  const ellipsis = '...';
  const maxBodyWidth = maxWidth - getDisplayWidth(ellipsis);
  let width = 0;
  let result = '';
  for (const char of value) {
    const charWidth = getCharDisplayWidth(char);
    if (width + charWidth > maxBodyWidth) {
      break;
    }
    width += charWidth;
    result += char;
  }
  return `${result}${ellipsis}`;
}

export function formatTaskLabel(
  taskId: string,
  description: string,
  maxWidth: number = DEFAULT_TASK_LABEL_WIDTH
): string {
  const cleanedTaskId = normalizeOneLine(taskId);
  const cleanedDescription = normalizeOneLine(description);
  const label = cleanedDescription.length > 0
    ? `[${cleanedTaskId}] ${cleanedDescription}`
    : `[${cleanedTaskId}]`;
  return truncateMessage(label, maxWidth);
}

export function buildManagerRunMessage(lastWorkReport: WorkReport | null): string {
  if (!lastWorkReport) {
    return 'Manager 実行中: 初回判断で次アクションを決定中...';
  }

  const taskId = normalizeOneLine(lastWorkReport.taskId) || '(unknown)';
  const status = normalizeOneLine(lastWorkReport.status) || 'UNKNOWN';
  return `Manager 実行中: 前回 [${taskId}] (${status}) を評価して次アクションを決定中...`;
}

export function buildManagerDecisionMessage(
  decision: ManagerDecision,
  taskDescription: string = ''
): string {
  switch (decision.type) {
    case 'dispatch_task':
      return `Manager 決定: ${formatTaskLabel(decision.taskId, taskDescription)} を Worker に指示`;
    case 'escalate':
      return `Manager 決定: エスカレーション (${decision.escalation.type})`;
    case 'complete':
      return 'Manager 決定: 完了判定';
    case 'error':
      return 'Manager 決定: エラー';
    case 'review_complete':
      return 'Manager 決定: レビュー継続';
    case 'ask_user':
      return 'Manager 決定: ユーザー確認が必要';
  }
}

export function buildWorkerRunMessage(task: Pick<TaskEntry, 'id' | 'description'>): string {
  return `Worker 実行中: ${formatTaskLabel(task.id, task.description)}`;
}

export function buildWorkerFinishMessage(
  task: Pick<TaskEntry, 'id' | 'description'>,
  result: WorkerResult,
  summaryWidth: number = DEFAULT_SUMMARY_WIDTH
): string {
  const status = result.report.status;
  const rawSummary = normalizeOneLine(result.report.summary);
  const summary = rawSummary.length > 0
    ? truncateMessage(rawSummary, summaryWidth)
    : 'summary unavailable';
  return `Worker 完了: ${formatTaskLabel(task.id, task.description)} ${status} - ${summary}`;
}

/**
 * 完了判定をブロックすべきか判定する
 */
export function shouldBlockCompletion(plan: TaskList | null): {
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

export function isCleanCodeReviewReport(
  report: WorkReport | null,
  plan: TaskList | null
): boolean {
  if (!report || !plan) {
    return false;
  }
  if (report.status !== 'SUCCESS') {
    return false;
  }
  if ((report.discoveredTasks?.length ?? 0) > 0) {
    return false;
  }

  const task = plan.find((entry) => entry.id === report.taskId);
  if (!task || task.reviewType !== 'code') {
    return false;
  }

  return task.passes === true;
}

/**
 * Manager が返した taskId を TASK 上の実IDに解決する
 *
 * 例:
 * - "10" <-> "task-10"
 */
export function resolveTaskIdForTaskList(plan: TaskList | null, taskId: string): string {
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
  plan: TaskList | null,
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
    const resolved = resolveTaskIdForTaskList(plan, candidate);
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
  plan: TaskList | null,
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

/**
 * review-only モードでのレビュー実行優先順位を適用する
 *
 * ルール:
 * - product review が指定された場合は code review を最優先で選ぶ
 * - code review が存在しない場合は product 以外の未完了タスクへ退避する
 * - それも無ければ product 以外の既存タスクへ退避する
 * - 最後まで候補がない場合のみ requestedTaskId を返す
 */
export function getReviewOnlyPreferredTaskId(
  plan: TaskList | null,
  requestedTaskId: string
): string {
  if (!plan || plan.length === 0) {
    return requestedTaskId;
  }

  const requestedTask = plan.find((task) => task.id === requestedTaskId);
  if (!requestedTask || requestedTask.reviewType !== 'product') {
    return requestedTaskId;
  }

  if (requestedTask.reviewGeneration !== undefined) {
    const pendingSameGenerationCodeReview = plan.find(
      (task) =>
        !task.passes &&
        task.reviewType === 'code' &&
        task.reviewGeneration === requestedTask.reviewGeneration
    );
    if (pendingSameGenerationCodeReview) {
      return pendingSameGenerationCodeReview.id;
    }
  }

  const pendingCodeReview = plan.find(
    (task) => !task.passes && task.reviewType === 'code'
  );
  if (pendingCodeReview) {
    return pendingCodeReview.id;
  }

  const pendingNonProductTask = plan.find(
    (task) => !task.passes && task.reviewType !== 'product'
  );
  if (pendingNonProductTask) {
    return pendingNonProductTask.id;
  }

  const anyCodeReview = plan.find((task) => task.reviewType === 'code');
  if (anyCodeReview) {
    return anyCodeReview.id;
  }

  const anyNonProductTask = plan.find((task) => task.reviewType !== 'product');
  return anyNonProductTask?.id ?? requestedTaskId;
}

export function closePendingProductReviewsForReviewOnly(plan: TaskList): {
  updatedPlan: TaskList;
  closedTaskIds: string[];
} {
  const closedTaskIds: string[] = [];
  const updatedPlan = plan.map((task) => {
    if (task.reviewType === 'product' && !task.passes) {
      closedTaskIds.push(task.id);
      return { ...task, passes: true };
    }
    return task;
  });

  return {
    updatedPlan: closedTaskIds.length > 0 ? updatedPlan : plan,
    closedTaskIds,
  };
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
export function getReviewTasksToAdd(
  plan: TaskList | null,
  hasPrd: boolean,
  options?: { reviewOnly?: boolean }
): TaskEntry[] {
  if (!plan) {
    return [];
  }
  if (!hasPrd && !options?.reviewOnly) {
    return [];
  }
  return createMissingReviewTasks(plan, {
    reviewOnly: options?.reviewOnly,
    hasPrd,
  });
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
 * WorkReport の discoveredTasks から TASK 追加用タスクを生成する
 *
 * ルール:
 * - priority=high は個別タスクとして追加
 * - priority=medium/low は relatedTaskId 単位で集約（未指定は 1 つに集約）
 */
export function buildFollowupTaskEntries(
  plan: TaskList,
  sourceTaskId: string,
  discoveredTasks: DiscoveredTask[]
): TaskEntry[] {
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
