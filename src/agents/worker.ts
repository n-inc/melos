import { writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodexEngine, type CodexEngineOptions } from '../engines/codex.js';
import { ClaudeEngine, type ClaudeEngineOptions } from '../engines/claude.js';
import { loadPromptRaw } from '../prompts/loader.js';
import type { TaskEntry } from '../state/task.js';
import type { WorkReport } from '../state/work-report.js';
import type { Agent, WorkerInput, WorkerResult, AgentMode } from './types.js';

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

  private engine: CodexEngine;
  private claudeEngine: ClaudeEngine;
  private config: WorkerAgentConfig;

  constructor(config: WorkerAgentConfig) {
    this.config = config;
    this.engine = new CodexEngine();
    this.claudeEngine = new ClaudeEngine();
  }

  /**
   * Worker プロンプトを構築する
   */
  private async buildPrompt(input: WorkerInput): Promise<string> {
    const template = await loadPromptRaw('worker');
    const { iteration, task, codebasePatterns, prd } = input;

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
    const taskModel = input.task.model;
    const executeWithClaude = taskModel === 'claude';

    const result = executeWithClaude
      ? await this.claudeEngine.execute(prompt, this.buildClaudeOptions())
      : await this.engine.execute(prompt, this.buildCodexOptions());

    // 実行ログをファイルに保存
    const logFilePath = await this.saveExecutionLog(
      input.iteration,
      input.task.id,
      result.output,
      result.error
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
    error?: string
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

  private buildCodexOptions(): CodexEngineOptions {
    return {
      cwd: this.config.cwd,
      model: this.config.model,
      reasoningEffort: this.config.reasoningEffort || 'medium',
      execMode: true,
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
}
