import { writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AppServerEngine,
  type AppServerEngineOptions,
} from '../engines/app-server.js';
import { ClaudeEngine, type ClaudeEngineOptions } from '../engines/claude.js';
import { loadPromptRaw } from '../prompts/loader.js';
import type { TaskEntry } from '../state/task.js';
import type { WorkReport } from '../state/work-report.js';
import type {
  Agent,
  WorkerInput,
  WorkerResult,
  AgentMode,
  SteerResult,
} from './types.js';

/**
 * Worker Agent 設定
 */
export interface WorkerAgentConfig {
  /** 作業ディレクトリ */
  cwd: string;
  /** プロンプトディレクトリ */
  promptsDir: string;
  /** Codex モデル名 */
  model?: string;
  /** 推論努力レベル */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** Claude モデル名（task.model=claude のときに使用、任意） */
  claudeModel?: string;
  /** Claude effort レベル（task.model=claude のときに使用、任意） */
  claudeEffort?: 'low' | 'medium' | 'high' | 'max';
  /** resume 時に再利用する threadId */
  resumeThreadId?: string;
  /** resume 対象 taskId */
  resumeTaskId?: string;
}

/**
 * Worker Agent
 *
 * タスク実装、テスト実行、コミットを担当する。
 * Codex Engine を使用。
 */
export class WorkerAgent implements Agent {
  readonly name = 'worker';
  readonly mode: AgentMode = 'worker';

  private engine: AppServerEngine;
  private claudeEngine: ClaudeEngine;
  private config: WorkerAgentConfig;
  private resumeThreadId: string | null;
  private resumeTaskId: string | null;
  private activeEngine: 'codex' | 'claude' | null = null;

  constructor(config: WorkerAgentConfig) {
    this.config = config;
    this.engine = new AppServerEngine();
    this.claudeEngine = new ClaudeEngine();
    this.resumeThreadId = config.resumeThreadId ?? null;
    this.resumeTaskId = config.resumeTaskId ?? null;
  }

  /**
   * Worker プロンプトを構築する
   */
  private async buildPrompt(input: WorkerInput): Promise<string> {
    const template = await loadPromptRaw('worker');
    const { iteration, task, codebasePatterns, prd, briefing } = input;

    // プレースホルダーを置換
    let prompt = template
      .replace('{ITERATION}', String(iteration))
      .replace('{TASK_ID}', task.id)
      .replace('{DESCRIPTION}', task.description);

    // TASK コンテキスト
    prompt = prompt.replace(
      '{TASK_CONTEXT_JSON}',
      JSON.stringify(
        {
          taskId: task.id,
          description: task.description,
          checks: task.checks ?? [],
          reviewType: task.reviewType ?? null,
          reviewGeneration: task.reviewGeneration ?? null,
        },
        null,
        2
      )
    );

    // Codebase Patterns セクション
    if (codebasePatterns) {
      prompt = prompt.replace('{CODEBASE_PATTERNS}', codebasePatterns);
    } else {
      prompt = prompt.replace('{CODEBASE_PATTERNS}', '(なし)');
    }

    // PRD セクション
    if (prd) {
      prompt = prompt.replace('{PRD_CONTENT}', prd);
    } else {
      prompt = prompt.replace('{PRD_CONTENT}', '(PRD.md が存在しません)');
    }

    // Manager ブリーフィング
    if (briefing) {
      prompt = prompt.replace('{WORKER_BRIEFING}', briefing);
    } else {
      prompt = prompt.replace('{WORKER_BRIEFING}', '(なし)');
    }

    // タスクモードガイド（実装 / product review / code review）
    prompt = prompt.replace('{TASK_MODE_GUIDE}', this.buildTaskModeGuide(task));

    return prompt;
  }

  private buildTaskModeGuide(task: Pick<TaskEntry, 'id' | 'reviewType'>): string {
    const mode = this.detectReviewMode(task);
    if (mode === 'product') {
      return [
        '- このタスクは **Product Review** です。実装はせず、PRD.md と現在実装の整合性を監査してください。',
        '- PRD の各要件について「満たしている根拠（ファイル/関数/テスト）」を確認してください。',
        '- 通常ケースだけでなく、失敗しやすい条件や境界条件を想定した確認を含めてください。',
        '- 要件未達や仕様乖離は `discoveredTasks` に追加し、再現条件と影響を記載してください。',
        '- 指摘があってもレビュー実行自体が完了していれば `status` は `SUCCESS` にしてください。',
      ].join('\n');
    }

    if (mode === 'code') {
      return [
        '- このタスクは **Code Review** です。実装はせず、コード観点の監査を実施してください。',
        '- レビュー範囲は **Changed files中心**（`git diff` 対象 + 必要な関連箇所）で確認してください。',
        '- 通常ケースだけでなく、失敗しやすい条件や境界条件を想定した確認を含めてください。',
        '- P1/P2 相当の問題（バグ、セキュリティ、重大ロジック不整合、保守性の重大劣化）を優先して検出してください。',
        '- 指摘事項は `discoveredTasks` に追加し、優先度と根拠を明記してください。',
        '- 指摘があってもレビュー実行自体が完了していれば `status` は `SUCCESS` にしてください。',
      ].join('\n');
    }

    return '- このタスクは通常の実装タスクです。TASK.json の目的と checks を満たすように実装・検証・報告を行ってください。';
  }

  private detectReviewMode(task: Pick<TaskEntry, 'id' | 'reviewType'>): 'product' | 'code' | null {
    if (task.reviewType === 'product' || task.reviewType === 'code') {
      return task.reviewType;
    }
    const taskId = task.id;
    if (taskId.startsWith('review-product-g')) {
      return 'product';
    }
    if (taskId.startsWith('review-code-g')) {
      return 'code';
    }
    return null;
  }

  /**
   * Worker を実行してタスクを実装する
   */
  async run(input: WorkerInput): Promise<WorkerResult> {
    const prompt = await this.buildPrompt(input);
    const executeWithClaude = this.shouldExecuteWithClaude(input.task);
    const streamTranscript: string[] = [];
    this.activeEngine = executeWithClaude ? 'claude' : 'codex';

    const result = await (executeWithClaude
      ? this.claudeEngine.execute(prompt, this.buildClaudeOptions())
      : this.engine.execute(
        prompt,
        this.buildCodexOptions(input.task, {
          onAgentMessageDelta: (chunk) => {
            streamTranscript.push(chunk);
            input.onAgentMessageDelta?.(chunk);
          },
          onCommandOutputDelta: (chunk) => {
            streamTranscript.push(`[command] ${chunk}`);
            input.onCommandOutputDelta?.(chunk);
          },
          onAppServerEvent: (method, params) => {
            streamTranscript.push(`[event] ${method} ${safeStringify(params)}\n`);
            input.onAppServerEvent?.(method, params);
          },
        })
      ))
      .finally(() => {
        this.activeEngine = null;
      });

    // 実行ログをファイルに保存
    const logFilePath = await this.saveExecutionLog(
      input.iteration,
      input.task.id,
      result.output,
      result.error,
      streamTranscript.join('')
    );

    const report = this.parseWorkReport(input.iteration, input.task, result.output, result.success);
    report.logFilePath = logFilePath;

    if (report.status === 'SUCCESS') {
      return { type: 'success', report };
    } else if (report.status === 'PARTIAL') {
      return { type: 'partial', report };
    } else if (report.status === 'BLOCKED') {
      return { type: 'blocked', report };
    } else {
      return { type: 'failed', report };
    }
  }

  /**
   * 実行ログをファイルに保存する
   */
  private async saveExecutionLog(
    iteration: number,
    taskId: string,
    output: string,
    error?: string,
    streamTranscript?: string
  ): Promise<string> {
    const logsDir = join(this.config.cwd, '.melos', 'worker-logs');
    mkdirSync(logsDir, { recursive: true });

    const filename = `${iteration}-${taskId}.log`;
    const filepath = join(logsDir, filename);
    const content = `=== Worker Execution Log ===
Iteration: ${iteration}
TaskId: ${taskId}
Timestamp: ${new Date().toISOString()}

=== Output ===
${output}

${streamTranscript ? `=== Stream Transcript ===\n${streamTranscript}\n\n` : ''}
${error ? `=== Error ===\n${error}` : ''}
`;
    await writeFile(filepath, content, 'utf-8');
    return filepath;
  }

  /**
   * Codex の出力から WorkReport を生成する
   */
  private parseWorkReport(
    iteration: number,
    task: Pick<TaskEntry, 'id' | 'checks'>,
    output: string,
    engineSuccess: boolean
  ): WorkReport {
    const now = new Date().toISOString();

    // デフォルトの WorkReport
    const report: WorkReport = {
      iteration,
      taskId: task.id,
      status: engineSuccess ? 'SUCCESS' : 'FAILED',
      summary: '',
      filesChanged: [],
      verification: {
        testsRun: false,
        testsPassed: 0,
        testsFailed: 0,
        lintPassed: false,
        typecheckPassed: false,
      },
      successCriteriaResults: [],
      issues: [],
      discoveredTasks: [],
      learnings: [],
      requestsHelp: false,
      createdAt: now,
    };

    // 出力から WORK_REPORT JSON を探す
    const reportMatch = output.match(
      /```json\s*\n\s*\{[\s\S]*?"status"\s*:\s*"(SUCCESS|PARTIAL|FAILED|BLOCKED)"[\s\S]*?\}\s*\n```/
    );

    if (reportMatch) {
      try {
        const jsonStr = reportMatch[0]
          .replace(/```json\s*\n/, '')
          .replace(/\n```/, '');
        const parsed = JSON.parse(jsonStr) as Partial<WorkReport>;

        // パースした値でマージ
        if (parsed.status) report.status = parsed.status;
        if (parsed.summary) report.summary = parsed.summary;
        if (parsed.filesChanged) report.filesChanged = parsed.filesChanged;
        if (parsed.verification) {
          report.verification = { ...report.verification, ...parsed.verification };
        }
        if (parsed.successCriteriaResults) {
          report.successCriteriaResults = parsed.successCriteriaResults;
        }
        if (parsed.issues) report.issues = parsed.issues;
        if (parsed.discoveredTasks) report.discoveredTasks = parsed.discoveredTasks;
        if (parsed.learnings) report.learnings = parsed.learnings;
        if (parsed.keyDecisions) report.keyDecisions = parsed.keyDecisions;
        if (parsed.criticalFiles) report.criticalFiles = parsed.criticalFiles;
        if (parsed.nextSteps) report.nextSteps = parsed.nextSteps;
        if (parsed.requestsHelp !== undefined) report.requestsHelp = parsed.requestsHelp;
        if (parsed.helpReason) report.helpReason = parsed.helpReason;
      } catch {
        // パース失敗は無視
      }
    }

    // Promise タグからステータスを推定
    if (output.includes('<promise>TASK_DONE</promise>')) {
      report.status = 'SUCCESS';
    } else if (output.includes('<promise>ESCALATE</promise>')) {
      report.status = 'BLOCKED';
      report.requestsHelp = true;
    }

    // サマリーが空の場合は出力から抽出
    if (!report.summary) {
      report.summary = this.extractSummary(output);
    }

    // 成功基準の結果を生成（未設定の場合）
    const criteriaFromChecks = (task.checks ?? [])
      .map((check) => check.text.trim())
      .filter((text) => text.length > 0);
    if (report.successCriteriaResults.length === 0 && criteriaFromChecks.length > 0) {
      report.successCriteriaResults = criteriaFromChecks.map((criterion) => ({
        criterion,
        passed: report.status === 'SUCCESS',
      }));
    }

    return report;
  }

  /**
   * 出力からサマリーを抽出する
   */
  private extractSummary(output: string): string {
    // ## Summary や ## 概要 などのセクションを探す
    const summaryMatch = output.match(
      /##\s*(Summary|概要|サマリー)\s*\n([\s\S]*?)(?=\n##|\n```|$)/i
    );

    if (summaryMatch) {
      return summaryMatch[2].trim().slice(0, 500);
    }

    // 最初の段落を返す
    const firstParagraph = output.split(/\n\n/)[0];
    return firstParagraph.slice(0, 500);
  }

  /**
   * Codex が利用可能か確認する
   */
  async isAvailable(): Promise<boolean> {
    const [codexAvailable, claudeAvailable] = await Promise.all([
      this.engine.isAvailable(),
      this.claudeEngine.isAvailable(),
    ]);
    return codexAvailable || claudeAvailable;
  }

  /**
   * 実行中の Worker プロセスを中断する
   */
  abort(): void {
    this.engine.abort();
    this.claudeEngine.abort();
  }

  getActiveThreadId(): string | null {
    return this.engine.getActiveThreadId();
  }

  setResumeSession(threadId: string, taskId: string): void {
    this.resumeThreadId = threadId;
    this.resumeTaskId = taskId;
  }

  async steer(instruction: string): Promise<SteerResult> {
    if (this.activeEngine === null) {
      return 'unavailable';
    }
    if (this.activeEngine === 'claude') {
      return 'unsupported';
    }

    const accepted = await this.engine.steer(instruction);
    return accepted ? 'accepted' : 'unavailable';
  }

  private buildCodexOptions(
    task: Pick<TaskEntry, 'id'>,
    callbacks: Pick<
      WorkerInput,
      'onAgentMessageDelta' | 'onCommandOutputDelta' | 'onAppServerEvent'
    > = {}
  ): AppServerEngineOptions {
    const shouldResume = this.resumeThreadId !== null
      && this.resumeTaskId !== null
      && this.resumeTaskId === task.id;
    const threadId = shouldResume && this.resumeThreadId
      ? this.resumeThreadId
      : undefined;
    if (shouldResume) {
      this.resumeThreadId = null;
      this.resumeTaskId = null;
    }

    return {
      cwd: this.config.cwd,
      model: this.config.model,
      reasoningEffort: this.config.reasoningEffort || 'high',
      execMode: true,
      threadId,
      onStream: callbacks.onAgentMessageDelta,
      onCommandOutput: callbacks.onCommandOutputDelta,
      onEvent: callbacks.onAppServerEvent,
    };
  }

  private buildClaudeOptions(): ClaudeEngineOptions {
    return {
      cwd: this.config.cwd,
      model: this.resolveClaudeModel(),
      effort: this.config.claudeEffort,
      skipPermissions: true,
      printMode: true,
    };
  }

  private resolveClaudeModel(): string | undefined {
    const candidate = this.config.claudeModel;
    if (!candidate || candidate.trim().length === 0) {
      return undefined;
    }

    // task.model=claude 指定時に Codex 系モデル名を誤って渡さない
    if (candidate.toLowerCase().includes('codex')) {
      return undefined;
    }

    return candidate;
  }

  private shouldExecuteWithClaude(
    task: Pick<TaskEntry, 'id' | 'description' | 'model' | 'checks' | 'reviewType'>
  ): boolean {
    if (task.model === 'claude') {
      return true;
    }
    if (task.model === 'codex') {
      return false;
    }

    // レビュータスクは通常の実装ルートに含めない
    if (this.detectReviewMode(task) !== null) {
      return false;
    }

    return this.isFrontendDesignTask(task);
  }

  private isFrontendDesignTask(
    task: Pick<TaskEntry, 'description' | 'checks'>
  ): boolean {
    const checkTexts =
      task.checks
        ?.map((check) => check.text)
        .filter((text): text is string => typeof text === 'string') ?? [];
    const searchableText = [task.description, ...checkTexts].join('\n').toLowerCase();

    const frontendKeywords = [
      'frontend',
      'front-end',
      'web',
      'ui',
      'ux',
      'screen',
      'page',
      'component',
      'フロントエンド',
      '画面',
      'ページ',
      'コンポーネント',
      'ui/ux',
    ];
    const designKeywords = [
      'design',
      'styling',
      'style',
      'layout',
      'css',
      'scss',
      'tailwind',
      'theme',
      'visual',
      'デザイン',
      'スタイル',
      'レイアウト',
      '見た目',
      'テーマ',
      'トークン',
    ];

    const hasFrontendSignal = frontendKeywords.some((keyword) =>
      searchableText.includes(keyword)
    );
    const hasDesignSignal = designKeywords.some((keyword) =>
      searchableText.includes(keyword)
    );

    return hasFrontendSignal && hasDesignSignal;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
