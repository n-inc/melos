import { ClaudeEngine, type ClaudeEngineOptions } from '../engines/claude.js';
import { CodexEngine, type CodexEngineOptions } from '../engines/codex.js';
import type { EngineResult } from '../engines/base.js';
import { loadPromptRaw } from '../prompts/loader.js';
import type { PlanTask } from '../state/plan.js';
import type { WorkOrder } from '../state/work-order.js';
import type { WorkReport } from '../state/work-report.js';
import type { Escalation } from '../state/escalation.js';
import type {
  Agent,
  ManagerDecision,
  ManagerInput,
  AgentMode,
} from './types.js';

/**
 * Manager Agent 設定
 */
export interface ManagerAgentConfig {
  /** 作業ディレクトリ */
  cwd: string;
  /** プロンプトディレクトリ */
  promptsDir: string;
  /** Manager モデル名（Claude/Codex） */
  model?: string;
  /** effort レベル */
  effort?: 'low' | 'medium' | 'high' | 'max';
}

/** Codex 系モデル名パターン */
const CODEX_MODEL_PATTERN = /codex/i;

/**
 * Manager Agent
 *
 * 判断、タスク分解、レビューを担当する。
 * model に応じて Claude/Codex Engine を使用。
 */
export class ManagerAgent implements Agent {
  readonly name = 'manager';
  readonly mode: AgentMode = 'manager';

  private claudeEngine: ClaudeEngine;
  private codexEngine: CodexEngine;
  private config: ManagerAgentConfig;

  constructor(config: ManagerAgentConfig) {
    this.config = config;
    this.claudeEngine = new ClaudeEngine();
    this.codexEngine = new CodexEngine();
  }

  /**
   * Manager プロンプトを構築する
   */
  private async buildPrompt(input: ManagerInput): Promise<string> {
    const template = await loadPromptRaw('manager');

    // プレースホルダーを置換
    let prompt = template
      .replace('{ITERATION}', String(input.iteration))
      .replace('{MAX_ITERATIONS}', '30');

    // PLAN セクション
    if (input.plan) {
      prompt = prompt.replace(
        '{PLAN_JSON}',
        JSON.stringify(input.plan, null, 2)
      );
    } else {
      prompt = prompt.replace('{PLAN_JSON}', 'null (PLAN.json が存在しません)');
    }

    // PRD セクション
    if (input.prd) {
      prompt = prompt.replace('{PRD_CONTENT}', input.prd);
    } else {
      prompt = prompt.replace('{PRD_CONTENT}', '(PRD.md が存在しません)');
    }

    // PROGRESS セクション
    if (input.progress) {
      prompt = prompt.replace('{PROGRESS_CONTENT}', input.progress);
    } else {
      prompt = prompt.replace('{PROGRESS_CONTENT}', '(PROGRESS.md が存在しません)');
    }

    // WORK_REPORT セクション
    if (input.lastWorkReport) {
      prompt = prompt.replace(
        '{WORK_REPORT_JSON}',
        JSON.stringify(input.lastWorkReport, null, 2)
      );
    } else {
      prompt = prompt.replace('{WORK_REPORT_JSON}', 'null (前回の報告なし)');
    }

    // ESCALATION セクション
    if (input.pendingEscalation) {
      prompt = prompt.replace(
        '{ESCALATION_JSON}',
        JSON.stringify(input.pendingEscalation, null, 2)
      );
    } else {
      prompt = prompt.replace('{ESCALATION_JSON}', 'null');
    }

    return prompt;
  }

  /**
   * Manager を実行して判断を取得する
   */
  async run(input: ManagerInput): Promise<ManagerDecision> {
    const prompt = await this.buildPrompt(input);

    const result = await this.executeWithConfiguredEngine(
      prompt,
      this.config.effort || 'high'
    );

    if (!result.success) {
      return {
        type: 'error',
        message: result.error || 'Manager execution failed',
      };
    }

    // 出力から判断を抽出
    return this.parseDecision(result.output);
  }

  /**
   * 実行中の Manager プロセスを中断する
   */
  abort(): void {
    this.claudeEngine.abort();
    this.codexEngine.abort();
  }

  /**
   * Claude の出力から判断を抽出する
   */
  private parseDecision(output: string): ManagerDecision {
    // fenced JSON と生JSON（ログ混在）を両方収集し、末尾優先で判定する
    const jsonBlocks = this.extractJsonBlocks(output);
    const rawJsonBlocks = this.extractRawJsonBlocks(output);
    const candidates = [...jsonBlocks, ...rawJsonBlocks];

    for (let i = candidates.length - 1; i >= 0; i--) {
      const parsed = this.tryParseJsonObject(candidates[i]);
      if (!parsed) {
        continue;
      }

      if (this.isWorkOrderCandidate(parsed)) {
        return { type: 'dispatch_task', workOrder: parsed };
      }

      if (this.isEscalationCandidate(parsed)) {
        return { type: 'escalate', escalation: parsed };
      }
    }

    // HANDOFF.md の出力を探す（```markdown ブロック内または実際の完了レポート）
    // 注意: プロンプト内のテンプレートではなく、実際の引き継ぎレポートのみをマッチ
    const markdownBlockMatch = output.match(
      /```markdown\s*\n(# (HANDOFF|Melos 引き継ぎレポート)[\s\S]*?)\n```/
    );
    if (markdownBlockMatch) {
      return { type: 'complete', handoffContent: markdownBlockMatch[1] };
    }

    // 実際の引き継ぎレポート（生成日時と完了したタスクを含む）
    const handoffMatch = output.match(
      /# (HANDOFF|Melos 引き継ぎレポート)\s*\n\n\*\*生成日時\*\*:[\s\S]*/
    );
    if (handoffMatch) {
      return { type: 'complete', handoffContent: handoffMatch[0] };
    }

    // COMPLETE promise を探す
    if (output.includes('<promise>COMPLETE</promise>')) {
      return {
        type: 'complete',
        handoffContent: '# Melos 完了\n\n全てのタスクが完了しました。',
      };
    }

    // デフォルト: エラー
    return {
      type: 'error',
      message: 'Could not parse Manager decision from output',
    };
  }

  /**
   * 出力から全ての JSON ブロックを抽出する
   */
  private extractJsonBlocks(output: string): string[] {
    const blocks: string[] = [];
    const regex = /```json\s*\n([\s\S]*?)\n```/g;
    let match;
    while ((match = regex.exec(output)) !== null) {
      blocks.push(match[1]);
    }
    return blocks;
  }

  /**
   * ログ混在テキストからトップレベル JSON object を抽出する
   * - "{}" のネスト深さで範囲を判定
   * - 文字列内の "{}" は無視
   */
  private extractRawJsonBlocks(output: string): string[] {
    const blocks: string[] = [];
    let depth = 0;
    let startIndex = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < output.length; i++) {
      const char = output[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (depth > 0 && char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        if (depth === 0) {
          startIndex = i;
        }
        depth++;
        continue;
      }

      if (char === '}' && depth > 0) {
        depth--;
        if (depth === 0 && startIndex >= 0) {
          blocks.push(output.slice(startIndex, i + 1));
          startIndex = -1;
        }
      }
    }

    return blocks;
  }

  /**
   * JSON object を安全にパースする
   */
  private tryParseJsonObject(value: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  private isWorkOrderCandidate(value: unknown): value is WorkOrder {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.taskId === 'string' &&
      typeof candidate.description === 'string' &&
      Array.isArray(candidate.instructions)
    );
  }

  private isEscalationCandidate(value: unknown): value is Escalation {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    const type = candidate.type;
    return (
      (type === 'QUESTION' || type === 'APPROVAL' || type === 'BLOCKER') &&
      typeof candidate.question === 'string'
    );
  }

  /**
   * PLAN.json がない場合にタスクを生成する
   */
  async generatePlan(prd: string, progress: string | null): Promise<PlanTask[]> {
    const prompt = `
あなたは熟練したテックリードです。

以下のPRD（要件定義）を読み、実装タスクに分解してください。

## PRD

${prd}

## コードベースの既知パターン

${progress || '(なし)'}

## タスク分解のルール

1. **論理的な完結性**: 1タスクで論理的に完結する単位
2. **コンテキストの共有**: 関連する変更は同じタスクにまとめる
3. **検証可能性**: タスク完了時に検証できる単位
4. **失敗時の影響**: 失敗しても巻き戻しやすい単位

## 出力形式

以下のJSON形式でタスクリストを出力してください:

\`\`\`json
[
  {
    "id": "task-1",
    "description": "タスクの説明",
    "passes": false
  }
]
\`\`\`
`;

    const result = await this.executeWithConfiguredEngine(prompt, 'high');

    if (!result.success) {
      throw new Error(`Failed to generate plan: ${result.error}`);
    }

    // JSON を抽出
    const jsonMatch = result.output.match(/```json\s*\n([\s\S]*?)\n```/);
    if (!jsonMatch) {
      throw new Error('Could not parse plan JSON from output');
    }

    const tasks = JSON.parse(jsonMatch[1]) as PlanTask[];
    return tasks;
  }

  /**
   * Worker の報告をレビューする
   */
  async reviewWorkReport(
    workOrder: WorkOrder,
    workReport: WorkReport
  ): Promise<{ approved: boolean; feedback?: string }> {
    const prompt = `
あなたは熟練したテックリードです。

Worker の実行報告をレビューしてください。

## 指示内容 (WORK_ORDER)

${JSON.stringify(workOrder, null, 2)}

## 報告内容 (WORK_REPORT)

${JSON.stringify(workReport, null, 2)}

## 判断基準

1. 全ての成功基準が満たされているか
2. テスト/lint/typecheckがパスしているか
3. 重大な問題が報告されていないか

## 出力形式

\`\`\`json
{
  "approved": true または false,
  "feedback": "承認しない場合のフィードバック"
}
\`\`\`
`;

    const result = await this.executeWithConfiguredEngine(prompt, 'medium');

    if (!result.success) {
      return { approved: false, feedback: 'Review execution failed' };
    }

    // JSON を抽出
    const jsonMatch = result.output.match(/```json\s*\n([\s\S]*?)\n```/);
    if (!jsonMatch) {
      return { approved: false, feedback: 'Could not parse review result' };
    }

    const review = JSON.parse(jsonMatch[1]) as {
      approved: boolean;
      feedback?: string;
    };
    return review;
  }

  /**
   * 設定モデルに応じたエンジンでプロンプトを実行する
   */
  private executeWithConfiguredEngine(
    prompt: string,
    effort: NonNullable<ManagerAgentConfig['effort']>
  ): Promise<EngineResult> {
    if (this.shouldUseCodexEngine(this.config.model)) {
      const options: CodexEngineOptions = {
        cwd: this.config.cwd,
        model: this.config.model,
        reasoningEffort: this.mapEffortForCodex(effort),
        execMode: true,
      };
      return this.codexEngine.execute(prompt, options);
    }

    const options: ClaudeEngineOptions = {
      cwd: this.config.cwd,
      model: this.config.model,
      effort,
      skipPermissions: true,
      printMode: true,
    };
    return this.claudeEngine.execute(prompt, options);
  }

  /**
   * モデル名に応じて Codex を使うべきか判定する
   * - model 未指定: Codex をデフォルト使用
   * - model 指定あり: codex 文字列を含む場合のみ Codex を使用
   */
  private shouldUseCodexEngine(model: string | undefined): boolean {
    if (typeof model !== 'string' || model.trim().length === 0) {
      return true;
    }
    return CODEX_MODEL_PATTERN.test(model);
  }

  /**
   * Manager の effort 値を Codex の reasoning effort に変換する
   */
  private mapEffortForCodex(
    effort: NonNullable<ManagerAgentConfig['effort']>
  ): NonNullable<CodexEngineOptions['reasoningEffort']> {
    if (effort === 'max') {
      return 'xhigh';
    }
    return effort;
  }
}
