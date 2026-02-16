import { join } from 'node:path';
import { existsSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import { ManagerAgent, type ManagerAgentConfig } from './agents/manager.js';
import { WorkerAgent, type WorkerAgentConfig } from './agents/worker.js';
import type { ManagerInput, WorkerInput, ManagerDecision, WorkerResult } from './agents/types.js';
import {
  loadPlan,
  planExists,
  updateTaskStatus,
  type Plan,
} from './state/plan.js';
import {
  type WorkOrder,
  saveWorkOrder,
} from './state/work-order.js';
import {
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
        if (this.config.dryRun) {
          log('YELLOW', '[DRY-RUN] Worker 実行をスキップ');
          log('CYAN', `タスク: ${decision.workOrder.taskId}`);
          log('CYAN', `説明: ${decision.workOrder.description}`);
          return { reason: 'continue' };
        }

        // Worker にタスクを実行させる
        const workerResult = await this.runWorker(decision.workOrder);

        // 結果を保存
        this.state.lastWorkOrder = decision.workOrder;
        this.state.lastWorkReport = workerResult.report;
        await saveWorkOrder(this.config.melosDir, decision.workOrder);
        await saveWorkReport(this.config.melosDir, workerResult.report);

        // 成功した場合、プランを更新
        if (workerResult.type === 'success') {
          this.state.plan = await updateTaskStatus(
            this.config.planFile,
            decision.workOrder.taskId,
            true
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
    const content = learnings
      .map((l) => `- [${taskId}] ${l}`)
      .join('\n');

    const section = `\n### Learnings (${now})\n${content}\n`;

    if (existsSync(this.config.progressFile)) {
      appendFileSync(this.config.progressFile, section);
    } else {
      await writeFile(this.config.progressFile, `# Progress Log\n${section}`);
    }

    // 状態を更新
    this.state.progress = await readFile(this.config.progressFile, 'utf-8');
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
