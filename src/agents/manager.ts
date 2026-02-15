import { ClaudeEngine, type ClaudeEngineOptions } from '../engines/claude.js';
import { loadPromptRaw } from '../prompts/loader.js';
import type { PlanTask } from '../state/plan.js';
import type { WorkOrder } from '../state/work-order.js';
import type { WorkReport } from '../state/work-report.js';
import type { Escalation } from '../state/escalation.js';
import type {
  Agent,
  ManagerDecision,
  ManagerInput,
  V2Mode,
} from './types.js';

/**
 * Manager Agent 設定
 */
export interface ManagerAgentConfig {
  /** 作業ディレクトリ */
  cwd: string;
  /** プロンプトディレクトリ */
  promptsDir: string;
  /** Claude モデル名 */
  model?: string;
  /** effort レベル */
  effort?: 'low' | 'medium' | 'high' | 'max';
}

/**
 * Manager Agent
 *
 * 判断、タスク分解、レビューを担当する。
 * Claude Engine を使用。
 */
export class ManagerAgent implements Agent {
  readonly name = 'manager';
  readonly mode: V2Mode = 'manager';

  private engine: ClaudeEngine;
  private config: ManagerAgentConfig;

  constructor(config: ManagerAgentConfig) {
    this.config = config;
    this.engine = new ClaudeEngine();
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

    const options: ClaudeEngineOptions = {
      cwd: this.config.cwd,
      model: this.config.model,
      effort: this.config.effort || 'high',
      skipPermissions: true,
      printMode: true,
    };

    const result = await this.engine.execute(prompt, options);

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
   * Claude の出力から判断を抽出する
   */
  private parseDecision(output: string): ManagerDecision {
    // WORK_ORDER.json の出力を探す
    const workOrderMatch = output.match(
      /```json\s*\n\s*\{[\s\S]*?"taskId"[\s\S]*?\}\s*\n```/
    );
    if (workOrderMatch) {
      try {
        const jsonStr = workOrderMatch[0]
          .replace(/```json\s*\n/, '')
          .replace(/\n```/, '');
        const workOrder = JSON.parse(jsonStr) as WorkOrder;
        return { type: 'dispatch_task', workOrder };
      } catch {
        // パース失敗は無視して続行
      }
    }

    // ESCALATION の出力を探す
    const escalationMatch = output.match(
      /```json\s*\n\s*\{[\s\S]*?"type"\s*:\s*"(QUESTION|APPROVAL|BLOCKER)"[\s\S]*?\}\s*\n```/
    );
    if (escalationMatch) {
      try {
        const jsonStr = escalationMatch[0]
          .replace(/```json\s*\n/, '')
          .replace(/\n```/, '');
        const escalation = JSON.parse(jsonStr) as Escalation;
        return { type: 'escalate', escalation };
      } catch {
        // パース失敗は無視して続行
      }
    }

    // HANDOFF.md の出力を探す
    const handoffMatch = output.match(
      /# (HANDOFF|Melos 引き継ぎレポート)[\s\S]*/
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

    const options: ClaudeEngineOptions = {
      cwd: this.config.cwd,
      model: this.config.model,
      effort: 'high',
      skipPermissions: true,
      printMode: true,
    };

    const result = await this.engine.execute(prompt, options);

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

    const options: ClaudeEngineOptions = {
      cwd: this.config.cwd,
      model: this.config.model,
      effort: 'medium',
      skipPermissions: true,
      printMode: true,
    };

    const result = await this.engine.execute(prompt, options);

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
}
