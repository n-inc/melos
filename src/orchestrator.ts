import { join } from 'node:path';
import { existsSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

import { Engine, EngineResult } from './engines/base.js';
import { ClaudeEngine } from './engines/claude.js';
import { CodexEngine } from './engines/codex.js';
import {
  loadPlan,
  planExists,
  getPendingTasks,
  getNextTask,
  isAllTasksCompleted,
  addTasks,
  type Plan,
  type PlanTask,
} from './state/plan.js';
import {
  loadProgress,
  initializeProgress,
  progressExists,
  getCurrentIteration,
  saveProgress,
  type ExecutionMode,
  type Progress,
} from './state/progress.js';
import {
  saveStatus,
  createDefaultStatus,
  type MelosStatus,
  getFilesChangedCount,
  calculateEscalationRisk,
  addToRecentHistory,
  mapPromiseToOutcome,
  type HistoryEntry,
} from './state/status.js';
import { fetchGitState, waitForCI, getCIStatus } from './state/git.js';
import { extractPrdTitle } from './state/prd.js';
import {
  loadPrompt,
  type PromptVariables,
  type PromptType,
} from './prompts/loader.js';
import { initializeResearchFolder } from './state/research.js';
import type { PhaseType, PhaseEngineConfig } from './config/loader.js';
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
  /** モデル名（Claude: haiku, sonnet, opus / Codex: gpt-5.3-codex など） */
  model?: string;
  /** Codex 推論努力レベル */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Claude effort レベル（Opus 4.6+） */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Claude thinking budget（旧モデル向け、1024〜31999） */
  thinkingBudget?: number;
  /** カスタムエンジンマップ（テスト用） */
  engines?: Map<EngineType, Engine>;
  /** フェーズ別エンジン設定 */
  phaseEngines?: {
    research?: PhaseEngineConfig;
    task?: PhaseEngineConfig;
    verification?: PhaseEngineConfig;
    review?: PhaseEngineConfig;
  };
}

/**
 * モード表示名
 */
const MODE_NAMES: Record<ExecutionMode, string> = {
  default: 'デフォルト（探索 → タスク → 確認 → レビュー）',
  'review-only': 'レビューのみ',
  'ci-fix-only': 'CI修正のみ',
  'task-only': 'タスクのみ',
};

/**
 * フェーズ別デフォルトエンジン設定
 */
const DEFAULT_PHASE_ENGINES: Record<PhaseType, { engine: EngineType; reasoningEffort?: 'low' | 'medium' | 'high'; model?: string; effort?: 'low' | 'medium' | 'high' | 'max'; thinkingBudget?: number }> = {
  research: {
    engine: 'codex',
    reasoningEffort: 'high',
  },
  task: {
    engine: 'codex',
    reasoningEffort: 'high',
  },
  verification: {
    engine: 'codex',
    reasoningEffort: 'high',
  },
  review: {
    engine: 'codex',
    reasoningEffort: 'high',
  },
};

/**
 * フォールバック時のClaude設定
 */
const CLAUDE_FALLBACK_OPTIONS = {
  model: 'opus',
  effort: 'max' as const,
};

/**
 * フォールバック時のCodex設定
 */
const CODEX_FALLBACK_OPTIONS = {
  reasoningEffort: 'high' as const,
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
 * Melos AFK/HITL ループを制御する。
 * 単一ループで タスク実行 → レビュー → PR対応 を統合。
 */
export class Orchestrator {
  private config: OrchestratorConfig;
  private engines: Map<EngineType, Engine>;
  private currentIteration: number = 1;
  private startIteration: number = 1;
  private aborted: boolean = false;
  private status: MelosStatus;
  private loopStartTime: Date = new Date();
  private currentSpinner: Spinner | null = null;
  private prdTitle: string | null = null;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    if (config.engines) {
      this.engines = config.engines;
    } else {
      this.engines = new Map();
      this.engines.set('claude', new ClaudeEngine());
      this.engines.set('codex', new CodexEngine());
    }
    this.status = createDefaultStatus();
  }

  /**
   * オーケストレーターを実行する
   */
  async run(): Promise<LoopResult> {
    // バリデーション
    this.validateConfig();

    // .gitignore に .melos/ を追加
    this.ensureGitignore();

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
    log('BLUE', 'Melos AFK - 自律ループ');
    log('BLUE', '========================================');
    log('BLUE', '');

    // PRD タイトルを取得
    if (this.config.mode === 'default') {
      const prdPath = join(this.config.cwd, this.config.prdFile);
      this.prdTitle = await extractPrdTitle(prdPath);
    }

    this.printConfig();
    await this.logPlannedWork();

    // 統一ループを実行
    const result = await this.runUnifiedLoop();

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
    // デフォルトモードでは PRD ファイルのみ必須（PLAN は探索フェーズで生成）
    if (this.config.mode === 'default') {
      if (!existsSync(join(this.config.cwd, this.config.prdFile))) {
        throw new Error(`PRD ファイルが見つかりません: ${this.config.prdFile}`);
      }
    }
  }

  /**
   * .gitignore に .melos/ を追加（存在しない場合のみ）
   */
  private ensureGitignore(): void {
    const gitignorePath = join(this.config.cwd, '.gitignore');
    const melosEntry = '.melos/';

    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      // 既に .melos/ がある場合はスキップ
      if (content.includes(melosEntry) || content.includes('.melos')) {
        return;
      }
      // 末尾に追加（改行で区切る）
      const newContent = content.endsWith('\n') ? melosEntry + '\n' : '\n' + melosEntry + '\n';
      appendFileSync(gitignorePath, newContent);
      log('BLUE', '.gitignore に .melos/ を追加しました');
    } else {
      // .gitignore がない場合は新規作成
      writeFileSync(gitignorePath, melosEntry + '\n');
      log('BLUE', '.gitignore を作成し、.melos/ を追加しました');
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
  private printConfig(): void {
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

    // フェーズ別エンジン設定を表示
    log('CYAN', 'フェーズ別エンジン設定:');
    const phaseLabels: Array<{ phase: PhaseType; label: string }> = [
      { phase: 'research', label: '探索:    ' },
      { phase: 'task', label: 'タスク:  ' },
      { phase: 'verification', label: '確認:    ' },
      { phase: 'review', label: 'レビュー:' },
    ];
    for (const { phase, label } of phaseLabels) {
      const { engine, options } = this.getEngineForPhase(phase);
      const optionStr = this.formatEngineOptions(engine, options);
      log('CYAN', `  ${label} ${optionStr}`);
    }

    if (this.config.hitl) {
      log('CYAN', 'HITL モード: 有効');
    }
    log('CYAN', '');
    log('CYAN', 'Ctrl+C でいつでも一時停止できます');
    log('BLUE', '');
  }

  /**
   * エンジンオプションを表示用にフォーマット
   */
  private formatEngineOptions(
    engine: EngineType,
    options: { reasoningEffort?: 'low' | 'medium' | 'high'; model?: string; effort?: 'low' | 'medium' | 'high' | 'max'; thinkingBudget?: number }
  ): string {
    if (engine === 'claude') {
      const model = options.model ?? 'opus';
      if (options.effort) {
        return `claude/${model} (effort: ${options.effort})`;
      }
      const thinking = options.thinkingBudget ?? 31999;
      return `claude/${model} (thinking: ${thinking})`;
    } else {
      const reasoning = options.reasoningEffort ?? 'high';
      return `codex (reasoning: ${reasoning})`;
    }
  }

  /**
   * フェーズに応じたエンジン設定を取得
   */
  private getEngineForPhase(phase: PhaseType): {
    engine: EngineType;
    options: {
      reasoningEffort?: 'low' | 'medium' | 'high';
      model?: string;
      effort?: 'low' | 'medium' | 'high' | 'max';
      thinkingBudget?: number;
    };
  } {
    const phaseConfig = this.config.phaseEngines?.[phase];
    const defaultConfig = DEFAULT_PHASE_ENGINES[phase];

    return {
      engine: phaseConfig?.engine ?? defaultConfig.engine,
      options: {
        reasoningEffort: phaseConfig?.reasoningEffort ?? defaultConfig.reasoningEffort,
        model: phaseConfig?.model ?? defaultConfig.model ?? this.config.model,
        effort: phaseConfig?.effort ?? defaultConfig.effort,
        thinkingBudget: phaseConfig?.thinkingBudget ?? defaultConfig.thinkingBudget,
      },
    };
  }

  /**
   * フォールバック付きでエンジンを実行
   */
  private async executeWithFallback(
    phase: PhaseType,
    prompt: string,
    options: { cwd: string }
  ): Promise<EngineResult> {
    const { engine: primaryEngine, options: engineOptions } = this.getEngineForPhase(phase);
    const fallbackEngine: EngineType = primaryEngine === 'claude' ? 'codex' : 'claude';

    const primary = this.engines.get(primaryEngine);
    const fallback = this.engines.get(fallbackEngine);

    if (!primary) {
      throw new Error(`エンジンが見つかりません: ${primaryEngine}`);
    }

    try {
      log('BLUE', `[${phase}] ${primaryEngine} エンジンで実行中...`);
      return await primary.execute(prompt, {
        ...options,
        ...engineOptions,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('YELLOW', `[${phase}] ${primaryEngine} でエラー発生: ${message}`);

      if (fallback) {
        log('YELLOW', `[${phase}] ${fallbackEngine} にフォールバック...`);

        const fallbackOptions = fallbackEngine === 'claude'
          ? CLAUDE_FALLBACK_OPTIONS
          : CODEX_FALLBACK_OPTIONS;

        return await fallback.execute(prompt, {
          ...options,
          ...fallbackOptions,
        });
      }

      throw error;
    }
  }

  /**
   * 探索フェーズを実行
   */
  private async runResearchPhase(): Promise<{ success: boolean; error?: string }> {
    log('BLUE', '');
    log('BLUE', '========================================');
    log('BLUE', '探索フェーズを開始します');
    log('BLUE', '========================================');
    log('BLUE', '');

    // research フォルダを初期化
    initializeResearchFolder(this.config.cwd);

    // プロンプトを構築
    const prompt = await this.buildPrompt('research', this.config.maxIterations);

    // フォールバック付きで実行
    const result = await this.executeWithFallback('research', prompt, {
      cwd: this.config.cwd,
    });

    // RESEARCH_COMPLETE を検出
    if (result.output.includes('<promise>RESEARCH_COMPLETE</promise>')) {
      log('GREEN', '探索フェーズが完了しました');
      return { success: true };
    }

    // エラーまたは未完了
    log('YELLOW', '探索フェーズが正常に完了しませんでした');
    return { success: false, error: '探索フェーズが完了しませんでした' };
  }

  /**
   * 実装確認フェーズを実行
   */
  private async runVerificationPhase(): Promise<{ success: boolean; issues: string[] }> {
    log('BLUE', '');
    log('BLUE', '========================================');
    log('BLUE', '実装確認フェーズを開始します');
    log('BLUE', '========================================');
    log('BLUE', '');

    // 簡易的な確認プロンプトを構築
    const prdPath = join(this.config.cwd, this.config.prdFile);
    const progressPath = join(this.config.cwd, this.config.progressFile);

    let prdContent = '';
    let progressContent = '';
    try {
      prdContent = await readFile(prdPath, 'utf-8');
    } catch {
      prdContent = '（PRD.md が見つかりません）';
    }
    try {
      progressContent = await readFile(progressPath, 'utf-8');
    } catch {
      progressContent = '（PROGRESS.md が見つかりません）';
    }

    const prompt = `## Melos 実装確認フェーズ

**PRD**:
\`\`\`markdown
${prdContent}
\`\`\`

**Progress file**:
\`\`\`markdown
${progressContent}
\`\`\`

---

## 目的

PRD.md に記載された要件が全て実装されているかを確認する。

## 確認項目

1. PRD.md に明記された機能要件が全て実装されているか
2. 基本的な動作が期待通りか
3. 明らかな不足がないか

## 出力フォーマット

### 全て実装済みの場合:
<promise>VERIFICATION_PASS</promise>

### 未実装がある場合:
<promise>VERIFICATION_FAIL</promise>
<verification_issues>
- [未実装要件1]: 説明
- [未実装要件2]: 説明
</verification_issues>
`;

    const result = await this.executeWithFallback('verification', prompt, {
      cwd: this.config.cwd,
    });

    const parsed = this.parseVerificationResult(result.output);
    log(parsed.success ? 'GREEN' : 'YELLOW', `実装確認フェーズ: ${parsed.success ? 'PASS' : 'FAIL'}`);
    return parsed;
  }

  /**
   * レビューフェーズを実行
   */
  private async runReviewPhase(): Promise<{ hasIssues: boolean; issues: string[] }> {
    log('BLUE', '');
    log('BLUE', '========================================');
    log('BLUE', 'レビューフェーズを開始します');
    log('BLUE', '========================================');
    log('BLUE', '');

    // diff を取得
    const diffResult = spawnSync('git', ['diff', 'main', '--name-only'], {
      encoding: 'utf-8',
      cwd: this.config.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (diffResult.status !== 0 || !diffResult.stdout.trim()) {
      log('YELLOW', '差分がありません。レビューをスキップします。');
      return { hasIssues: false, issues: [] };
    }

    const prompt = `## コードレビュー

以下の変更をレビューしてください。
P1（必須修正）または P2（推奨修正）の指摘がある場合は報告してください。

変更されたファイル:
${diffResult.stdout}

git diff main の内容を確認して、以下の観点でレビューしてください：
1. バグの可能性
2. セキュリティの問題
3. パフォーマンスの問題
4. 重大なロジックエラー

**出力フォーマット**:

指摘がない場合:
<review_verdict>CLEAN</review_verdict>

指摘がある場合:
<review_verdict>ISSUES</review_verdict>
<review_issues>
- [P1] ファイル名: 問題の説明
- [P2] ファイル名: 問題の説明
</review_issues>
`;

    const result = await this.executeWithFallback('review', prompt, {
      cwd: this.config.cwd,
    });

    return this.parseReviewResult(result.output);
  }

  /**
   * 実装確認フェーズを実行すべきか判定
   */
  private shouldRunVerificationPhase(): boolean {
    return this.config.mode === 'default';
  }

  /**
   * レビューフェーズを実行すべきか判定
   */
  private shouldRunReviewPhase(): boolean {
    return this.config.mode !== 'task-only' && this.config.mode !== 'ci-fix-only';
  }

  /**
   * verify-* タスクの次番号を取得
   */
  private getNextVerificationIndex(plan: Plan): number {
    let max = 0;
    for (const task of plan) {
      const match = /^verify-(\d+)$/.exec(task.id);
      if (!match) continue;
      const value = Number.parseInt(match[1], 10);
      if (!Number.isNaN(value)) {
        max = Math.max(max, value);
      }
    }
    return max + 1;
  }

  /**
   * 実装確認の指摘からタスクを生成
   */
  private buildVerificationTasks(plan: Plan, issues: string[]): PlanTask[] {
    const normalized = issues.length > 0 ? issues : ['実装確認が失敗しました（詳細なし）'];
    const start = this.getNextVerificationIndex(plan);
    return normalized.map((issue, index) => ({
      id: `verify-${start + index}`,
      description: `[VERIFY] ${issue}`,
      passes: false,
    }));
  }

  /**
   * review-* タスクの次番号を取得
   */
  private getNextReviewIndex(plan: Plan): number {
    let max = 0;
    for (const task of plan) {
      const match = /^review-(\d+)$/.exec(task.id);
      if (!match) continue;
      const value = Number.parseInt(match[1], 10);
      if (!Number.isNaN(value)) {
        max = Math.max(max, value);
      }
    }
    return max + 1;
  }

  /**
   * レビュー指摘からタスクを生成（P1/P2 のみ）
   */
  private buildReviewTasks(plan: Plan, issues: string[]): PlanTask[] {
    const actionable = issues.filter(
      (issue) => issue.startsWith('[P1]') || issue.startsWith('[P2]')
    );
    if (actionable.length === 0) {
      return [];
    }
    const start = this.getNextReviewIndex(plan);
    return actionable.map((issue, index) => ({
      id: `review-${start + index}`,
      description: issue,
      passes: false,
    }));
  }

  /**
   * 全タスク完了時にレビューを実行し、必要ならタスク追加/完了を確定
   */
  private async runReviewIfAllTasksCompleted(
    planPath: string
  ): Promise<'continue' | 'complete'> {
    if (!planExists(planPath)) {
      return 'continue';
    }

    let plan: Plan;
    try {
      plan = await loadPlan(planPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('YELLOW', `プランファイルの読み込みに失敗: ${message}`);
      return 'continue';
    }

    if (!isAllTasksCompleted(plan)) {
      return 'continue';
    }

    if (this.shouldRunVerificationPhase()) {
      const verification = await this.runVerificationPhase();
      if (!verification.success) {
        const verificationTasks = this.buildVerificationTasks(
          plan,
          verification.issues
        );
        await addTasks(planPath, verificationTasks);
        log('YELLOW', `実装確認の指摘を ${verificationTasks.length} 件タスクに追加しました。`);
        return 'continue';
      }
    }

    const reviewResult = await this.runReviewPhase();
    const reviewTasks = this.buildReviewTasks(plan, reviewResult.issues);

    if (reviewTasks.length > 0) {
      await addTasks(planPath, reviewTasks);
      log('YELLOW', `レビュー指摘を ${reviewTasks.length} 件タスクに追加しました。`);
      return 'continue';
    }

    if (reviewResult.hasIssues) {
      log('YELLOW', 'レビュー指摘は P1/P2 以外のため、タスク追加なし。');
    }

    const handoff = await this.readHandoff();
    printCompletion(this.config.mode, this.currentIteration, handoff);
    return 'complete';
  }

  /**
   * HANDOFF.md を生成
   */
  private async generateHandoff(): Promise<void> {
    const progressPath = join(this.config.cwd, this.config.progressFile);
    const handoffPath = join(this.config.cwd, 'HANDOFF.md');

    let progress;
    try {
      progress = await loadProgress(progressPath);
    } catch {
      progress = null;
    }

    let content = `# HANDOFF.md

## 完了日時
${new Date().toISOString()}

## 実行サマリー
- イテレーション数: ${this.currentIteration}
- モード: ${this.config.mode}

## 実装内容
${progress?.currentObjective || '（記載なし）'}

## 学習・発見事項
${progress?.learnings || '（記載なし）'}

## Codebase Patterns
${progress?.codebasePatterns || '（記載なし）'}
`;

    // Claude.md改善提案セクション
    if (progress?.claudeMdImprovements) {
      content += `
## Claude.md改善提案

以下は実装中に発見した、Claude.mdやagents.mdに追記すべき内容です:

${progress.claudeMdImprovements}
`;
    }

    await writeFile(handoffPath, content, 'utf-8');
    log('GREEN', 'HANDOFF.md を生成しました');
  }

  /**
   * 統一ループを実行
   *
   * 単一ループで以下を処理:
   * 1. 探索フェーズ → PLAN.json 生成/更新
   * 2. タスク実行フェーズ
   * 3. 実装確認フェーズ
   * 4. レビューフェーズ
   * 5. 完了 → HANDOFF.md 生成
   */
  private async runUnifiedLoop(): Promise<LoopResult> {
    // 探索フェーズを実行（PLAN.json がない場合、または調査が必要な場合）
    const planPath = join(this.config.cwd, this.config.planFile);
    if (!planExists(planPath)) {
      const researchResult = await this.runResearchPhase();
      if (!researchResult.success) {
        return {
          success: false,
          completedIterations: 0,
          reason: 'error',
          error: researchResult.error,
        };
      }

      // HITL モードの場合、探索フェーズ完了後に一時停止
      if (this.config.hitl) {
        log('GREEN', '');
        log('GREEN', '========================================');
        log('GREEN', 'HITL モード: 探索フェーズ完了');
        log('GREEN', '========================================');
        log('NC', '');
        log('NC', 'PLAN.json が生成されました。');
        log('NC', '続行する場合は再度 melos --hitl を実行してください。');
        this.status.status = 'paused';
        await this.saveCurrentStatus();
        return {
          success: true,
          completedIterations: 0,
          reason: 'hitl_pause',
        };
      }
    }

    const max = this.config.maxIterations;
    const sessionIterations = () => this.currentIteration - this.startIteration;

    while (sessionIterations() < max && !this.aborted) {
      // Git状態を更新
      this.updateGitState();

      // 全タスク完了時はレビューに移行（task-only / ci-fix-only は除外）
      if (this.shouldRunReviewPhase()) {
        const reviewOutcome = await this.runReviewIfAllTasksCompleted(planPath);
        if (reviewOutcome === 'complete') {
          return {
            success: true,
            completedIterations: this.currentIteration,
            reason: 'complete',
          };
        }
      }

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
      const result = await this.runIteration(promptType, max);

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
        log('NC', '続行する場合は再度 melos --hitl を実行してください。');
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

    const message = `Melos ${MODE_NAMES[this.config.mode]} 完了`;
    const escapedMessage = message.replace(/"/g, '\\"');
    spawnSync(
      'osascript',
      [
        '-e',
        `display notification "${escapedMessage}" with title "Melos"`,
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
        `display notification "${escapedMessage}" with title "Melos - エスカレーション" sound name "Basso"`,
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
    log('NC', '確認後、npx melos で再開できます。');
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

    // エスカレーションリスクを計算
    this.status.escalationRisk = calculateEscalationRisk(
      this.status.recentHistory ?? [],
      nextTask?.id ?? null
    );

    await this.saveCurrentStatus();

    // エンジンを決定（タスクの model フィールド > フェーズ設定 > デフォルト）
    const engineType = await this.getEngineForNextTask();
    const engine = this.engines.get(engineType);
    const phaseConfig = this.getEngineForPhase('task');

    if (!engine) {
      throw new Error(`エンジンが見つかりません: ${engineType}`);
    }

    // エンジンオプションを決定（CLI指定 > フェーズ設定）
    const engineOptions = {
      model: this.config.model ?? phaseConfig.options.model,
      reasoningEffort: this.config.reasoningEffort ?? phaseConfig.options.reasoningEffort,
      effort: this.config.effort ?? phaseConfig.options.effort,
      thinkingBudget: this.config.thinkingBudget ?? phaseConfig.options.thinkingBudget,
    };

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
      this.prdTitle,
      engineOptions.model,
      engineOptions.thinkingBudget,
      engineOptions.reasoningEffort,
      engineOptions.effort
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
    const prompt = await this.buildPrompt(promptType, maxIterations, nextTask?.id);

    // エンジンを実行
    const engineResult = await engine.execute(prompt, {
      cwd: this.config.cwd,
      ...engineOptions,
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

    // 新フィールドを更新
    const iterationEndTime = new Date();
    const durationSeconds = Math.round(
      (iterationEndTime.getTime() - iterationStartTime.getTime()) / 1000
    );
    const filesChanged = getFilesChangedCount(this.config.cwd);
    const outcome = mapPromiseToOutcome(promiseResult.type, engineResult.success);

    this.status.lastIterationSummary = {
      outcome,
      taskId: this.status.currentTask?.id ?? null,
      durationSeconds,
      filesChanged,
      keyActions: [], // Future: extract from engine output
      error: engineResult.error ?? null,
    };

    const historyEntry: HistoryEntry = {
      iteration: this.currentIteration,
      outcome,
      taskId: this.status.currentTask?.id ?? null,
    };
    this.status.recentHistory = addToRecentHistory(
      this.status.recentHistory ?? [],
      historyEntry
    );

    // stateSignals を更新
    const ciStatus = getCIStatus(this.config.cwd);
    this.status.stateSignals = {
      ciStatus,
      reviewPending: false, // Future: detect from gh pr comments
      blockedBy: null,
    };

    await this.saveCurrentStatus();

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
      return this.getEngineForPhase('task').engine;
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

    return this.getEngineForPhase('task').engine;
  }

  /**
   * プロンプトを構築する
   */
  private async buildPrompt(
    promptType: PromptType,
    maxIterations: number,
    currentTaskId?: string
  ): Promise<string> {
    const variables: PromptVariables = {
      iteration: this.currentIteration,
      maxIterations,
      progressFile: this.config.progressFile,
      planFile: this.config.planFile,
      currentTaskId,
    };

    return loadPrompt(promptType, variables);
  }

  /**
   * 実装確認結果をパース
   */
  private parseVerificationResult(
    output: string
  ): { success: boolean; issues: string[] } {
    if (output.includes('<promise>VERIFICATION_PASS</promise>')) {
      return { success: true, issues: [] };
    }

    const issuesMatch = output.match(
      /<verification_issues>([\s\S]*?)<\/verification_issues>/
    );
    const issues: string[] = [];
    if (issuesMatch) {
      const lines = issuesMatch[1].split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('-')) {
          issues.push(trimmed.slice(1).trim());
        }
      }
    }

    return { success: false, issues };
  }

  /**
   * レビュー結果をパース
   */
  private parseReviewResult(output: string): { hasIssues: boolean; issues: string[] } {
    const verdictMatch = output.match(/<review_verdict>(CLEAN|ISSUES)<\/review_verdict>/);
    if (!verdictMatch || verdictMatch[1] === 'CLEAN') {
      return { hasIssues: false, issues: [] };
    }

    const issuesMatch = output.match(/<review_issues>([\s\S]*?)<\/review_issues>/);
    const issues: string[] = [];
    if (issuesMatch) {
      const issuesContent = issuesMatch[1];
      const lines = issuesContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('-')) {
          issues.push(trimmed.slice(1).trim());
        }
      }
    }

    return { hasIssues: issues.length > 0, issues };
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
 * PLAN.json が存在する場合はタスク数 × 2 をデフォルトとする
 */
export async function getDefaultMaxIterations(
  mode: ExecutionMode,
  planPath?: string
): Promise<number> {
  // PLAN.json からタスク数を取得して 2 倍
  if (planPath && planExists(planPath)) {
    try {
      const plan = await loadPlan(planPath);
      if (plan.length > 0) {
        return plan.length * 2;
      }
    } catch {
      // パース失敗時はフォールバック
    }
  }

  // フォールバック（PLAN.json がない場合）
  switch (mode) {
    case 'default':
    case 'task-only':
      return 30;
    case 'review-only':
    case 'ci-fix-only':
      return 5;
  }
}
