import { writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodexEngine, type CodexEngineOptions } from '../engines/codex.js';
import { loadPromptRaw } from '../prompts/loader.js';
import type { WorkOrder } from '../state/work-order.js';
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
  private config: WorkerAgentConfig;

  constructor(config: WorkerAgentConfig) {
    this.config = config;
    this.engine = new CodexEngine();
  }

  /**
   * Worker プロンプトを構築する
   */
  private async buildPrompt(input: WorkerInput): Promise<string> {
    const template = await loadPromptRaw('worker');
    const { workOrder, codebasePatterns, prd } = input;

    // プレースホルダーを置換
    let prompt = template
      .replace('{ITERATION}', String(workOrder.iteration))
      .replace('{TASK_ID}', workOrder.taskId)
      .replace('{DESCRIPTION}', workOrder.description);

    // WORK_ORDER セクション
    prompt = prompt.replace(
      '{WORK_ORDER_JSON}',
      JSON.stringify(workOrder, null, 2)
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
    prompt = prompt.replace('{TASK_MODE_GUIDE}', this.buildTaskModeGuide(workOrder.taskId));

    return prompt;
  }

  private buildTaskModeGuide(taskId: string): string {
    const mode = this.detectReviewMode(taskId);
    if (mode === 'product') {
      return [
        '- このタスクは **Product Review** です。実装はせず、PRD.md と現在実装の整合性を監査してください。',
        '- PRD の各要件について「満たしている根拠（ファイル/関数/テスト）」を確認してください。',
        '- 要件未達や仕様乖離は `discoveredTasks` に追加し、再現条件と影響を記載してください。',
        '- 指摘があってもレビュー実行自体が完了していれば `status` は `SUCCESS` にしてください。',
      ].join('\n');
    }

    if (mode === 'code') {
      return [
        '- このタスクは **Code Review** です。実装はせず、コード観点の監査を実施してください。',
        '- レビュー範囲は **Changed files中心**（`git diff` 対象 + 必要な関連箇所）で確認してください。',
        '- P1/P2 相当の問題（バグ、セキュリティ、重大ロジック不整合、保守性の重大劣化）を優先して検出してください。',
        '- 指摘事項は `discoveredTasks` に追加し、優先度と根拠を明記してください。',
        '- 指摘があってもレビュー実行自体が完了していれば `status` は `SUCCESS` にしてください。',
      ].join('\n');
    }

    return '- このタスクは通常の実装タスクです。WORK_ORDER に従って実装・検証・報告を行ってください。';
  }

  private detectReviewMode(taskId: string): 'product' | 'code' | null {
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

    const options: CodexEngineOptions = {
      cwd: this.config.cwd,
      model: this.config.model,
      reasoningEffort: this.config.reasoningEffort || 'high',
      execMode: true,
    };

    const result = await this.engine.execute(prompt, options);

    // 実行ログをファイルに保存
    const logFilePath = await this.saveExecutionLog(
      input.workOrder.iteration,
      input.workOrder.taskId,
      result.output,
      result.error
    );

    const report = this.parseWorkReport(input.workOrder, result.output, result.success);
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
    workOrder: WorkOrder,
    output: string,
    engineSuccess: boolean
  ): WorkReport {
    const now = new Date().toISOString();

    // デフォルトの WorkReport
    const report: WorkReport = {
      iteration: workOrder.iteration,
      taskId: workOrder.taskId,
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
    if (report.successCriteriaResults.length === 0 && workOrder.successCriteria) {
      report.successCriteriaResults = workOrder.successCriteria.map((criterion) => ({
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
    return this.engine.isAvailable();
  }

  /**
   * 実行中の Worker プロセスを中断する
   */
  abort(): void {
    this.engine.abort();
  }
}
