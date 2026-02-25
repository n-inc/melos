import { ClaudeEngine, type ClaudeEngineOptions } from '../engines/claude.js';
import {
  AppServerEngine,
  type AppServerEngineOptions,
} from '../engines/app-server.js';
import type { EngineResult } from '../engines/base.js';
import { loadPromptRaw } from '../prompts/loader.js';
import type { TaskEntry } from '../state/task.js';
import type { WorkReport } from '../state/work-report.js';
import type { Escalation } from '../state/escalation.js';
import type {
  Agent,
  AskUserPrompt,
  ManagerDecision,
  ManagerInput,
  AgentMode,
  SteerResult,
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
  /** resume 時に再利用する threadId */
  resumeThreadId?: string;
}

/** Codex 系モデル名パターン */
const CODEX_MODEL_PATTERN = /codex/i;

const REVIEW_ONLY_INSTRUCTIONS = `### Review-Only モード固有ルール

- **Product Review は行わない**: review-only では \`reviewType: "code"\` のみを対象にし、\`reviewType: "product"\` は dispatch しない
- **「レビュー」はコードレビューのみを指す**: PRD との整合性確認や Product Review はこのモードでは実施しない
- **実装タスクは dispatch しない**: 既存の未完了実装タスクがあっても無視し、レビュータスクまたはレビュー起因の修正タスクのみを dispatch する
- **レビュー→修正→再レビュー**: レビューで P1/P2 が見つかった場合、Worker が discoveredTasks に報告 → それを修正タスクとして追加 → 修正後に次世代レビューへ
- **修正後は必ず再レビューを挟む**: 修正タスクが完了した直後に完了判定せず、全体の code review を再度実行してから完了判定する
- **完了条件**: レビューが CLEAN（discoveredTasks が空の SUCCESS）になったら HANDOFF.md を出力
- **修正タスクの粒度**: P1 は個別タスク、P2 はまとめて 1 タスクにする（既存の buildFollowupTaskEntries ルールに従う）`;

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
  private codexEngine: AppServerEngine;
  private config: ManagerAgentConfig;
  private activeEngine: 'codex' | 'claude' | null = null;
  private resumeThreadId: string | null;

  constructor(config: ManagerAgentConfig) {
    this.config = config;
    this.claudeEngine = new ClaudeEngine();
    this.codexEngine = new AppServerEngine();
    this.resumeThreadId = config.resumeThreadId ?? null;
  }

  /**
   * Manager プロンプトを構築する
   */
  private async buildPrompt(input: ManagerInput): Promise<string> {
    const template = await loadPromptRaw('manager');

    // プレースホルダーを置換
    let prompt = template
      .replace('{ITERATION}', String(input.iteration))
      .replace('{MAX_ITERATIONS}', String(input.maxIterations));

    const executionMode = input.executionMode ?? 'default';
    prompt = prompt
      .replace('{EXECUTION_MODE}', executionMode)
      .replace(
        '{MODE_INSTRUCTIONS}',
        executionMode === 'review-only' ? REVIEW_ONLY_INSTRUCTIONS : ''
      );

    // TASK セクション
    if (input.tasks) {
      prompt = prompt.replace(
        '{TASK_JSON}',
        JSON.stringify(input.tasks, null, 2)
      );
    } else {
      prompt = prompt.replace('{TASK_JSON}', 'null (TASK.json が存在しません)');
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

    const deferredSteers = (input.deferredSteers ?? [])
      .map((instruction) => instruction.trim())
      .filter((instruction) => instruction.length > 0);
    if (deferredSteers.length > 0) {
      const steerLines = deferredSteers
        .map((instruction, index) => `${index + 1}. ${instruction}`)
        .join('\n');
      prompt += `\n\n## Deferred User Steering (FIFO)\n以下は Claude 実行中に保留された追加指示です。今回の判断に反映してください。\n\n${steerLines}\n`;
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
      this.config.effort || 'high',
      {
        onAgentMessageDelta: input.onAgentMessageDelta,
        onCommandOutputDelta: input.onCommandOutputDelta,
        onAppServerEvent: input.onAppServerEvent,
      }
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

  getActiveThreadId(): string | null {
    return this.codexEngine.getActiveThreadId();
  }

  async steer(instruction: string): Promise<SteerResult> {
    if (this.activeEngine === null) {
      return 'unavailable';
    }
    if (this.activeEngine === 'claude') {
      return 'unsupported';
    }

    const accepted = await this.codexEngine.steer(instruction);
    return accepted ? 'accepted' : 'unavailable';
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

      if (this.isTaskDispatchCandidate(parsed)) {
        return {
          type: 'dispatch_task',
          taskId: parsed.taskId,
          briefing: typeof parsed.briefing === 'string' ? parsed.briefing : undefined,
        };
      }

      if (this.isEscalationCandidate(parsed)) {
        return { type: 'escalate', escalation: parsed };
      }
    }

    const taskDispatchId = this.extractTaskDispatchTaskId(output);
    if (taskDispatchId) {
      return { type: 'dispatch_task', taskId: taskDispatchId };
    }

    const askUserPrompt = this.extractAskUserPrompt(output);
    if (askUserPrompt) {
      return { type: 'ask_user', prompt: askUserPrompt };
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
      /# (HANDOFF|Melos 引き継ぎレポート)\s*\n\n(?:\*\*生成日時\*\*|生成日時)\s*:[\s\S]*/
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

  private isTaskDispatchCandidate(
    value: unknown
  ): value is {
    taskId: string;
    reason?: string;
    description?: string;
    briefing?: string;
  } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.taskId !== 'string') {
      return false;
    }

    const allowedKeys = new Set(['taskId', 'reason', 'description', 'briefing']);
    return Object.keys(candidate).every((key) => allowedKeys.has(key));
  }

  /**
   * TASK_DISPATCH 固定テキスト形式から taskId を抽出する
   *
   * 対応形式:
   * TASK_DISPATCH
   * task-1
   *
   * 互換形式（旧）:
   * TASK_DISPATCH
   * taskId: task-1
   */
  private extractTaskDispatchTaskId(output: string): string | null {
    const lines = output.split(/\r?\n/);
    let lastTaskId: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== 'TASK_DISPATCH') {
        continue;
      }

      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j].trim();

        if (line.length === 0) {
          continue;
        }

        if (line.startsWith('```')) {
          continue;
        }

        const keyed = line.match(/^taskId\s*:\s*(.+)$/i);
        if (keyed && keyed[1].trim().length > 0) {
          lastTaskId = this.cleanTaskIdCandidate(keyed[1]);
          break;
        }

        if (/^[A-Z_]+(?:\.(json|md))?$/i.test(line)) {
          break;
        }

        lastTaskId = this.cleanTaskIdCandidate(line);
        break;
      }
    }

    return lastTaskId;
  }

  /**
   * ASK_USER 固定テキスト形式から質問を抽出する
   *
   * 対応形式:
   * ASK_USER
   * Context: task-1
   * Question: Which option should we use?
   * Options:
   * - A: keep current
   * - B: switch behavior
   * Recommendation: B
   * AllowFreeText: true
   */
  private extractAskUserPrompt(output: string): AskUserPrompt | null {
    const lines = output.split(/\r?\n/);
    let lastPrompt: AskUserPrompt | null = null;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().toUpperCase() !== 'ASK_USER') {
        continue;
      }

      const parsed = this.parseAskUserPromptFromLines(lines, i + 1);
      if (parsed) {
        lastPrompt = parsed;
      }
    }

    return lastPrompt;
  }

  private parseAskUserPromptFromLines(
    lines: string[],
    startIndex: number
  ): AskUserPrompt | null {
    let question: string | null = null;
    let context: string | undefined;
    let recommendation: string | undefined;
    let allowFreeText: boolean | undefined;
    const options: Array<{ label: string; description: string }> = [];
    let readingOptions = false;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length === 0) {
        continue;
      }
      if (line.startsWith('```')) {
        break;
      }
      if (line.toUpperCase() === 'TASK_DISPATCH' || line.toUpperCase() === 'ASK_USER') {
        break;
      }
      if (line === '<promise>COMPLETE</promise>' || /^#\s/.test(line)) {
        break;
      }

      const questionMatch = line.match(/^question\s*:\s*(.+)$/i);
      if (questionMatch) {
        question = questionMatch[1].trim();
        readingOptions = false;
        continue;
      }

      const contextMatch = line.match(/^context\s*:\s*(.+)$/i);
      if (contextMatch) {
        context = contextMatch[1].trim();
        readingOptions = false;
        continue;
      }

      const recommendationMatch = line.match(/^recommendation\s*:\s*(.+)$/i);
      if (recommendationMatch) {
        recommendation = recommendationMatch[1].trim();
        readingOptions = false;
        continue;
      }

      const allowFreeTextMatch = line.match(/^allowfreetext\s*:\s*(.+)$/i);
      if (allowFreeTextMatch) {
        const raw = allowFreeTextMatch[1].trim().toLowerCase();
        allowFreeText = raw !== 'false';
        readingOptions = false;
        continue;
      }

      if (/^options\s*:\s*$/i.test(line)) {
        readingOptions = true;
        continue;
      }

      if (readingOptions) {
        const optionMatch = line.match(/^-+\s*([^:]+)\s*:\s*(.+)$/);
        if (optionMatch) {
          options.push({
            label: optionMatch[1].trim(),
            description: optionMatch[2].trim(),
          });
          continue;
        }
      }
    }

    if (!question || question.length === 0) {
      return null;
    }

    return {
      question,
      context,
      options: options.length > 0 ? options : undefined,
      recommendation,
      allowFreeText,
    };
  }

  private cleanTaskIdCandidate(value: string): string {
    return value.trim().replace(/^['"`]|['"`]$/g, '');
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
   * TASK.json がない場合にタスクを生成する
   */
  async generateTasks(prd: string, progress: string | null): Promise<TaskEntry[]> {
    const prompt = `
あなたは熟練したテックリードです。

以下のPRD（要件定義）を読み、実装タスクに分解してください。

## PRD

${prd}

## コードベースの既知パターン

${progress || '(なし)'}

## タスク分解のルール

タスクは「検証可能な最小デリバリー単位」で分解する。

1. **単独検証可能**: 各タスクの checks は他タスクの完了に依存せず単独で検証できること
2. **依存は順序で表現**: 先行タスクの成果物を前提にしてよいが、checks は自己完結させる
3. **分割の判断**: バックエンドが単体テストで検証できるならフロント分離可。検証できない中間成果物だけのタスクは作らない

各タスクには必ず具体的な checks を付与し、「このタスクだけで検証合格できるか？」を確認する。

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
      throw new Error(`Failed to generate tasks: ${result.error}`);
    }

    // JSON を抽出
    const jsonMatch = result.output.match(/```json\s*\n([\s\S]*?)\n```/);
    if (!jsonMatch) {
      throw new Error('Could not parse task JSON from output');
    }

    const tasks = JSON.parse(jsonMatch[1]) as TaskEntry[];
    return tasks;
  }

  /**
   * Worker の報告をレビューする
   */
  async reviewWorkReport(
    task: Pick<TaskEntry, 'id' | 'description' | 'checks'>,
    workReport: WorkReport
  ): Promise<{ approved: boolean; feedback?: string }> {
    const prompt = `
あなたは熟練したテックリードです。

Worker の実行報告をレビューしてください。

## タスク情報 (TASK)

${JSON.stringify(task, null, 2)}

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
    effort: NonNullable<ManagerAgentConfig['effort']>,
    callbacks: {
      onAgentMessageDelta?: (chunk: string) => void;
      onCommandOutputDelta?: (chunk: string) => void;
      onAppServerEvent?: (method: string, params: unknown) => void;
    } = {}
  ): Promise<EngineResult> {
    if (this.shouldUseCodexEngine(this.config.model)) {
      this.activeEngine = 'codex';
      const threadId = this.resumeThreadId ?? undefined;
      if (threadId) {
        this.resumeThreadId = null;
      }
      const options: AppServerEngineOptions = {
        cwd: this.config.cwd,
        model: this.config.model,
        reasoningEffort: this.mapEffortForCodex(effort),
        execMode: true,
        threadId,
        onStream: callbacks.onAgentMessageDelta,
        onCommandOutput: callbacks.onCommandOutputDelta,
        onEvent: callbacks.onAppServerEvent,
      };
      return this.codexEngine.execute(prompt, options).finally(() => {
        this.activeEngine = null;
      });
    }

    this.activeEngine = 'claude';
    const options: ClaudeEngineOptions = {
      cwd: this.config.cwd,
      model: this.config.model,
      effort,
      skipPermissions: true,
      printMode: true,
    };
    return this.claudeEngine.execute(prompt, options).finally(() => {
      this.activeEngine = null;
    });
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
  ): NonNullable<AppServerEngineOptions['reasoningEffort']> {
    if (effort === 'max') {
      return 'xhigh';
    }
    return effort;
  }
}
