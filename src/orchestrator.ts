import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

import { Engine, EngineResult } from './engines/base.js';
import { ClaudeEngine } from './engines/claude.js';
import { CodexEngine } from './engines/codex.js';
import {
  loadPlan,
  planExists,
  getPendingTasks,
  getNextTask,
  type Plan,
  type PlanTask,
} from './state/plan.js';
import {
  loadProgress,
  initializeProgress,
  progressExists,
  getCurrentIteration,
  type ExecutionMode,
  type Progress,
} from './state/progress.js';
import {
  saveStatus,
  createDefaultStatus,
  type MarathonStatus,
} from './state/status.js';
import { fetchGitState, waitForCI } from './state/git.js';
import { extractPrdTitle } from './state/prd.js';
import {
  loadPrompt,
  type PromptVariables,
  type PromptType,
} from './prompts/loader.js';
import {
  detectFeedbackLoops,
  buildFeedbackInstructions,
} from './utils/feedback.js';
import { detectPromise, type PromiseType } from './utils/promise.js';
import {
  printIterationHeader,
  printIterationSummary,
  printCompletion,
  printNextIteration,
  printWarning,
  printHandoffContent,
  createSpinner,
  formatElapsed,
  type Spinner,
  type HandoffContent,
} from './ui/display.js';

/**
 * エンジンタイプ
 */
export type EngineType = 'claude' | 'codex';

/**
 * オーケストレーターの設定
 */
export interface OrchestratorConfig {
  /** 作業ディレクトリ */
  cwd: string;
  /** 実行モード */
  mode: ExecutionMode;
  /** 最大イテレーション数 */
  maxIterations: number;
  /** デフォルトエンジン */
  engine: EngineType;
  /** HITL モード */
  hitl: boolean;
  /** PRD ファイルパス */
  prdFile: string;
  /** プランファイルパス */
  planFile: string;
  /** 進捗ファイルパス */
  progressFile: string;
  /** ステータスファイルパス */
  statusFile: string;
}

/**
 * モード表示名
 */
const MODE_NAMES: Record<ExecutionMode, string> = {
  default: 'デフォルト（タスク → レビュー → CI）',
  'review-only': 'レビューのみ',
  'ci-fix-only': 'CI修正のみ',
  'task-only': 'タスクのみ',
};

/**
 * ループ実行結果
 */
export interface LoopResult {
  /** 成功フラグ */
  success: boolean;
  /** 完了したイテレーション数 */
  completedIterations: number;
  /** 終了理由 */
  reason: 'complete' | 'max_iterations' | 'error' | 'hitl_pause' | 'escalation';
  /** エラーメッセージ（エラー時） */
  error?: string;
}

/**
 * イテレーション実行結果
 */
export interface IterationResult {
  /** エンジン実行結果 */
  engineResult: EngineResult;
  /** 検出された Promise タイプ */
  promiseType: PromiseType | null;
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
  NC: '\x1b[0m', // No Color
} as const;

/**
 * カラー付きログ出力
 */
function log(color: keyof typeof Colors, message: string): void {
  process.stderr.write(`${Colors[color]}${message}${Colors.NC}\n`);
}

/**
 * メインオーケストレーター
 *
 * Marathon AFK/HITL ループを制御する。
 * 単一ループで タスク実行 → レビュー → PR対応 を統合。
 */
export class Orchestrator {
  private config: OrchestratorConfig;
  private engines: Map<EngineType, Engine>;
  private currentIteration: number = 1;
  private startIteration: number = 1;
  private aborted: boolean = false;
  private status: MarathonStatus;
  private loopStartTime: Date = new Date();
  private currentSpinner: Spinner | null = null;
  private prdTitle: string | null = null;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.engines = new Map();
    this.engines.set('claude', new ClaudeEngine());
    this.engines.set('codex', new CodexEngine());
    this.status = createDefaultStatus();
  }

  /**
   * オーケストレーターを実行する
   */
  async run(): Promise<LoopResult> {
    // バリデーション
    this.validateConfig();

    // ループ開始時刻を記録
    this.loopStartTime = new Date();

    // 進捗ファイルを初期化または読み込み
    const progress = await this.initOrLoadProgress();
    this.currentIteration = getCurrentIteration(progress) + 1;
    this.startIteration = this.currentIteration;

    // ステータスを初期化
    await this.initializeStatus();

    log('BLUE', '');
    log('BLUE', '========================================');
    log('BLUE', 'Marathon AFK - 自律ループ');
    log('BLUE', '========================================');
    log('BLUE', '');

    // PRD タイトルを取得
    if (this.config.mode === 'default') {
      const prdPath = join(this.config.cwd, this.config.prdFile);
      this.prdTitle = await extractPrdTitle(prdPath);
    }

    // フィードバックループを検出
    const feedbackLoops = await detectFeedbackLoops(
      this.config.planFile,
      'main',
      this.config.cwd
    );
    const feedbackInstructions = buildFeedbackInstructions(feedbackLoops);

    this.printConfig(feedbackInstructions);
    await this.logPlannedWork();

    // 統一ループを実行
    const result = await this.runUnifiedLoop(feedbackInstructions);

    if (result.success && result.reason === 'complete') {
      this.notifyCompletion();
    } else if (result.reason === 'escalation') {
      this.notifyEscalation();
    }

    // 完了時にステータスを更新
    // HITL pause の場合は runUnifiedLoop で既に paused を設定済みなので上書きしない
    if (result.reason !== 'hitl_pause') {
      this.status.status = result.success ? 'completed' : 'error';
      await this.saveCurrentStatus();
    }

    return result;
  }

  /**
   * ステータスを初期化
   */
  private async initializeStatus(): Promise<void> {
    const statusPath = join(this.config.cwd, this.config.statusFile);

    // タスク情報を取得
    const { completedTasks, totalTasks, nextTask } = await this.getTaskInfo();

    // Git状態を取得
    const gitState = fetchGitState(this.config.cwd);

    this.status = {
      iteration: this.currentIteration,
      maxIterations: this.config.maxIterations,
      currentTask: nextTask
        ? { id: nextTask.id, description: nextTask.description }
        : null,
      completedTasks,
      totalTasks,
      startedAt: this.loopStartTime.toISOString(),
      engineStartedAt: null,
      engine: this.config.engine,
      status: 'running',
      gitState,
      updatedAt: new Date().toISOString(),
    };

    await saveStatus(statusPath, this.status);
  }

  /**
   * 現在のステータスを保存
   */
  private async saveCurrentStatus(): Promise<void> {
    const statusPath = join(this.config.cwd, this.config.statusFile);
    await saveStatus(statusPath, this.status);
  }

  /**
   * Git状態を更新
   */
  private updateGitState(): void {
    this.status.gitState = fetchGitState(this.config.cwd);
  }

  /**
   * タスク情報を取得
   */
  private async getTaskInfo(): Promise<{
    completedTasks: number;
    totalTasks: number;
    nextTask: PlanTask | undefined;
  }> {
    const planPath = join(this.config.cwd, this.config.planFile);

    if (!planExists(planPath)) {
      return { completedTasks: 0, totalTasks: 0, nextTask: undefined };
    }

    try {
      const plan = await loadPlan(planPath);
      const completed = plan.filter((t) => t.passes).length;
      const next = getNextTask(plan);

      return {
        completedTasks: completed,
        totalTasks: plan.length,
        nextTask: next,
      };
    } catch {
      return { completedTasks: 0, totalTasks: 0, nextTask: undefined };
    }
  }

  /**
   * HANDOFF.md を読み込む
   */
  private async readHandoff(): Promise<HandoffContent | null> {
    const handoffPath = join(this.config.cwd, 'HANDOFF.md');

    if (!existsSync(handoffPath)) {
      return null;
    }

    try {
      const content = await readFile(handoffPath, 'utf-8');
      return {
        content,
        filePath: handoffPath,
      };
    } catch {
      return null;
    }
  }

  /**
   * 設定を検証する
   */
  private validateConfig(): void {
    // デフォルトモードでは PRD と PLAN ファイルが必須
    if (this.config.mode === 'default') {
      if (!existsSync(join(this.config.cwd, this.config.prdFile))) {
        throw new Error(`PRD ファイルが見つかりません: ${this.config.prdFile}`);
      }

      if (!planExists(join(this.config.cwd, this.config.planFile))) {
        throw new Error(`プランファイルが見つかりません: ${this.config.planFile}`);
      }
    }
  }

  /**
   * 進捗ファイルを初期化または読み込む
   */
  private async initOrLoadProgress(): Promise<Progress> {
    const progressPath = join(this.config.cwd, this.config.progressFile);

    if (progressExists(progressPath)) {
      return loadProgress(progressPath);
    }

    // 新規作成
    return initializeProgress(
      progressPath,
      this.config.mode,
      this.config.maxIterations
    );
  }

  /**
   * 設定を出力する
   */
  private printConfig(feedbackInstructions: string): void {
    // PRD タイトルを優先的に表示
    if (this.prdTitle) {
      log('CYAN', `PRD: ${this.prdTitle}`);
    }
    log('GREEN', `モード: ${MODE_NAMES[this.config.mode]}`);
    if (this.config.mode === 'default') {
      log('GREEN', `PRDファイル: ${this.config.prdFile}`);
      log('GREEN', `プランファイル: ${this.config.planFile}`);
    }
    log('GREEN', `進捗ファイル: ${this.config.progressFile}`);
    log('YELLOW', `最大イテレーション: ${this.config.maxIterations}`);
    log('CYAN', `デフォルトエンジン: ${this.config.engine}`);
    log('YELLOW', `フィードバック: ${feedbackInstructions ? '検出済み' : 'なし'}`);
    if (this.config.hitl) {
      log('CYAN', 'HITL モード: 有効');
    }
    log('CYAN', '');
    log('CYAN', 'Ctrl+C でいつでも一時停止できます');
    log('BLUE', '');
  }

  /**
   * 統一ループを実行
   *
   * 単一ループで以下を処理:
   * 1. 未完了タスクあり → 1つ実行
   * 2. 全タスク完了 → レビュー実行
   *    - P1/P2あり → タスク追加して続行
   *    - P1/P2なし → PRチェックへ
   * 3. PRあり → CI・コメント確認
   *    - 問題あり → タスク追加して続行
   *    - 問題なし → 完了
   */
  private async runUnifiedLoop(feedbackInstructions: string): Promise<LoopResult> {
    const max = this.config.maxIterations;
    const sessionIterations = () => this.currentIteration - this.startIteration;

    while (sessionIterations() < max && !this.aborted) {
      // Git状態を更新
      this.updateGitState();

      // モードに応じた処理
      let promptType: PromptType;
      if (this.config.mode === 'review-only') {
        promptType = this.config.hitl ? 'hitl-loop' : 'loop';
      } else if (this.config.mode === 'ci-fix-only') {
        // CI修正の前にCI待機
        if (this.status.gitState.pullRequest) {
          log('YELLOW', 'CI完了を待機中...');
          await waitForCI(this.config.cwd);
        }
        promptType = this.config.hitl ? 'hitl-loop' : 'loop';
      } else {
        // デフォルト / task-only モード: 統一プロンプトを使用
        promptType = this.config.hitl ? 'hitl-loop' : 'loop';
      }

      // イテレーション実行
      const result = await this.runIteration(
        promptType,
        feedbackInstructions,
        max
      );

      // Promise タイプに応じた処理
      switch (result.promiseType) {
        case 'ESCALATE':
          await this.printEscalation();
          return {
            success: false,
            completedIterations: this.currentIteration,
            reason: 'escalation',
          };

        case 'COMPLETE': {
          const handoff = await this.readHandoff();
          printCompletion(this.config.mode, this.currentIteration, handoff);
          return {
            success: true,
            completedIterations: this.currentIteration,
            reason: 'complete',
          };
        }

        case 'TASK_DONE':
          printNextIteration();
          break;

        default:
          printWarning('Promise が検出されませんでした。続行します...');
          break;
      }

      // HITL モードでは1イテレーションで終了
      if (this.config.hitl) {
        log('GREEN', '');
        log('GREEN', '========================================');
        log('GREEN', 'HITL モード: 1イテレーション完了');
        log('GREEN', '========================================');
        log('NC', '');
        log('NC', '続行する場合は再度 marathon --hitl を実行してください。');
        log('NC', `進捗: ${this.config.progressFile}`);
        this.status.status = 'paused';
        await this.saveCurrentStatus();
        return {
          success: true,
          completedIterations: this.currentIteration,
          reason: 'hitl_pause',
        };
      }

      this.currentIteration++;
    }

    // 最大イテレーションに到達
    const completedInSession = sessionIterations();
    log('YELLOW', '');
    log('YELLOW', '========================================');
    log('YELLOW', `セッション内で ${completedInSession} 回実行しました（上限: ${max}）`);
    log('YELLOW', '========================================');
    log('YELLOW', '');
    log('NC', 'イテレーション上限でループが停止しました。');
    log('NC', `進捗は保存されています: ${this.config.progressFile}`);

    // HANDOFF.md の内容を表示
    const handoff = await this.readHandoff();
    if (handoff) {
      printHandoffContent(handoff);
    }

    return {
      success: false,
      completedIterations: this.currentIteration - 1,
      reason: 'max_iterations',
    };
  }

  /**
   * 予定タスクをログ出力する
   */
  private async logPlannedWork(): Promise<void> {
    const planPath = join(this.config.cwd, this.config.planFile);

    if (!planExists(planPath)) {
      log('YELLOW', '予定タスク: PLAN.json が見つかりません');
      log('BLUE', '');
      return;
    }

    try {
      const plan = await loadPlan(planPath);
      const pending = getPendingTasks(plan);

      if (pending.length === 0) {
        log('YELLOW', '予定タスク: 未完了タスクはありません');
        log('BLUE', '');
        return;
      }

      log('BLUE', '-------- 予定タスク --------');
      pending.slice(0, 10).forEach((task) => {
        log('NC', `- ${task.id}: ${task.description}`);
      });
      if (pending.length > 10) {
        log('NC', `... 他${pending.length - 10}件`);
      }
      log('BLUE', '');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('YELLOW', `予定タスクの読み込みに失敗しました: ${message}`);
      log('BLUE', '');
    }
  }

  /**
   * macOS 通知とビープ音を鳴らす
   */
  private notifyCompletion(): void {
    process.stderr.write('\x07');

    if (process.platform !== 'darwin') {
      return;
    }

    const message = `Marathon ${MODE_NAMES[this.config.mode]} 完了`;
    const escapedMessage = message.replace(/"/g, '\\"');
    spawnSync(
      'osascript',
      [
        '-e',
        `display notification "${escapedMessage}" with title "Marathon"`,
      ],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
      }
    );
  }

  /**
   * エスカレーション時のmacOS通知とビープ音を鳴らす
   */
  private notifyEscalation(): void {
    // 警告音を2回鳴らす
    process.stderr.write('\x07\x07');

    if (process.platform !== 'darwin') {
      return;
    }

    const message = '人間の介入が必要です。HANDOFF.md を確認してください。';
    const escapedMessage = message.replace(/"/g, '\\"');
    spawnSync(
      'osascript',
      [
        '-e',
        `display notification "${escapedMessage}" with title "Marathon - エスカレーション" sound name "Basso"`,
      ],
      {
        stdio: ['ignore', 'ignore', 'ignore'],
      }
    );
  }

  /**
   * エスカレーション時のメッセージを出力
   */
  private async printEscalation(): Promise<void> {
    log('RED', '');
    log('RED', '========================================');
    log('RED', '⚠️  エスカレーション');
    log('RED', '========================================');
    log('RED', '');
    log('YELLOW', '人間の介入が必要な状況が発生しました。');
    log('NC', '');
    log('NC', '確認後、npx marathon で再開できます。');
    log('NC', `進捗: ${this.config.progressFile}`);

    // HANDOFF.md の内容を表示
    const handoff = await this.readHandoff();
    if (handoff) {
      printHandoffContent(handoff);
    } else {
      log('YELLOW', 'HANDOFF.md が見つかりませんでした。');
    }
  }

  /**
   * 単一イテレーションを実行
   */
  private async runIteration(
    promptType: PromptType,
    feedbackInstructions: string,
    maxIterations: number
  ): Promise<IterationResult> {
    const iterationStartTime = new Date();

    // タスク情報を更新
    const { completedTasks, totalTasks, nextTask } = await this.getTaskInfo();

    // ステータスを更新（セッション内のイテレーション番号を使用）
    this.status.iteration = this.currentIteration - this.startIteration + 1;
    this.status.maxIterations = maxIterations;
    this.status.currentTask = nextTask
      ? { id: nextTask.id, description: nextTask.description }
      : null;
    this.status.completedTasks = completedTasks;
    this.status.totalTasks = totalTasks;
    await this.saveCurrentStatus();

    // エンジンを決定（タスクの model フィールド > デフォルト）
    const engineType = await this.getEngineForNextTask();
    const engine = this.engines.get(engineType);

    if (!engine) {
      throw new Error(`エンジンが見つかりません: ${engineType}`);
    }

    // ヘッダーを表示（セッション内のイテレーション番号を使用）
    const sessionIteration = this.currentIteration - this.startIteration + 1;
    printIterationHeader(
      sessionIteration,
      maxIterations,
      this.config.mode,
      this.status.currentTask,
      completedTasks,
      totalTasks,
      this.loopStartTime.toISOString(),
      engineType,
      this.prdTitle
    );

    // スピナーを開始
    this.currentSpinner = createSpinner(
      `${engine.name} 実行中...`,
      iterationStartTime
    );

    // ステータスにエンジン開始時刻を記録
    this.status.engineStartedAt = iterationStartTime.toISOString();
    this.status.engine = engineType;
    await this.saveCurrentStatus();

    // プロンプトを生成
    const prompt = await this.buildPrompt(
      promptType,
      feedbackInstructions,
      maxIterations
    );

    // エンジンを実行
    const engineResult = await engine.execute(prompt, {
      cwd: this.config.cwd,
    });

    // スピナーを停止
    if (this.currentSpinner) {
      if (engineResult.success) {
        this.currentSpinner.succeed(`${engine.name} 完了`);
      } else {
        this.currentSpinner.fail(`${engine.name} 失敗`);
      }
      this.currentSpinner = null;
    }

    // ステータスを更新
    this.status.engineStartedAt = null;
    await this.saveCurrentStatus();

    // エンジン実行が失敗した場合はエラーをログに出力
    if (!engineResult.success) {
      log('RED', '');
      log('RED', `エンジン実行に失敗しました (exit code: ${engineResult.exitCode})`);
      if (engineResult.error) {
        log('RED', `エラー: ${engineResult.error}`);
      }
    }

    // Promise タグを検出
    const promiseResult = detectPromise(engineResult.output);

    // イテレーション完了サマリーを表示
    const duration = formatElapsed(iterationStartTime);
    const diffSummary = this.getGitDiffSummary();
    const progressUpdate = await this.getProgressUpdateSummary();

    printIterationSummary(
      duration,
      promiseResult.type,
      diffSummary,
      progressUpdate
    );

    return {
      engineResult,
      promiseType: promiseResult.type,
    };
  }

  /**
   * git diff のサマリーを取得
   */
  private getGitDiffSummary(): string | null {
    const diffResult = spawnSync('git', ['diff', '--stat'], {
      encoding: 'utf-8',
      cwd: this.config.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (diffResult.status === 0 && diffResult.stdout.trim()) {
      return diffResult.stdout.trim();
    }
    return null;
  }

  /**
   * 進捗更新のサマリーを取得
   */
  private async getProgressUpdateSummary(): Promise<string | null> {
    const progressPath = join(this.config.cwd, this.config.progressFile);

    if (!progressExists(progressPath)) {
      return null;
    }

    try {
      const progress = await loadProgress(progressPath);
      const latestEntry = progress.entries[progress.entries.length - 1];

      if (!latestEntry) {
        return null;
      }

      const firstLine = latestEntry.content
        .split('\n')
        .find((line) => line.trim().length > 0);
      const summary = firstLine ? firstLine.trim() : '更新内容なし';
      const clipped =
        summary.length > 100 ? `${summary.slice(0, 97)}...` : summary;
      const date = latestEntry.date ? ` (${latestEntry.date})` : '';

      return `- Iteration ${latestEntry.iteration}${date}: ${clipped}`;
    } catch {
      return null;
    }
  }

  /**
   * 次のタスクに対応するエンジンを取得
   */
  private async getEngineForNextTask(): Promise<EngineType> {
    const planPath = join(this.config.cwd, this.config.planFile);

    if (!planExists(planPath)) {
      return this.config.engine;
    }

    try {
      const plan: Plan = await loadPlan(planPath);
      const nextTask: PlanTask | undefined = getNextTask(plan);

      if (nextTask?.model === 'claude' || nextTask?.model === 'codex') {
        return nextTask.model;
      }
    } catch (error) {
      // プランファイルの読み込みに失敗した場合はデフォルトを使用
      const errorMessage = error instanceof Error ? error.message : String(error);
      log('YELLOW', `プランファイルの読み込みに失敗: ${errorMessage}`);
    }

    return this.config.engine;
  }

  /**
   * プロンプトを構築する
   */
  private async buildPrompt(
    promptType: PromptType,
    feedbackInstructions: string,
    maxIterations: number
  ): Promise<string> {
    const variables: PromptVariables = {
      iteration: this.currentIteration,
      maxIterations,
      progressFile: this.config.progressFile,
      planFile: this.config.planFile,
      feedbackInstructions,
    };

    return loadPrompt(promptType, variables);
  }

  /**
   * ループを中断する
   */
  abort(): void {
    this.aborted = true;
  }
}

/**
 * デフォルト設定を取得
 */
export function getDefaultConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    cwd: process.cwd(),
    mode: 'default',
    maxIterations: 30,
    engine: 'claude',
    hitl: false,
    prdFile: 'PRD.md',
    planFile: 'PLAN.json',
    progressFile: 'PROGRESS.md',
    statusFile: 'STATUS.json',
    ...overrides,
  };
}

/**
 * モードに応じたデフォルトイテレーション数を取得
 */
export function getDefaultMaxIterations(mode: ExecutionMode): number {
  switch (mode) {
    case 'default':
    case 'task-only':
      return 30;
    case 'review-only':
    case 'ci-fix-only':
      return 5;
  }
}
