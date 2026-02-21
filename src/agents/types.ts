import type { TaskEntry } from '../state/task.js';
import type { WorkReport } from '../state/work-report.js';
import type { Escalation } from '../state/escalation.js';

/**
 * Agent モード
 */
export type AgentMode = 'manager' | 'worker';

/**
 * Manager の判断結果
 */
export type ManagerDecision =
  | { type: 'dispatch_task'; taskId: string; briefing?: string }
  | { type: 'review_complete'; approved: boolean; feedback?: string }
  | { type: 'escalate'; escalation: Escalation }
  | { type: 'complete'; handoffContent: string }
  | { type: 'error'; message: string };

/**
 * Worker の実行結果
 */
export type WorkerResult =
  | { type: 'success'; report: WorkReport }
  | { type: 'partial'; report: WorkReport }
  | { type: 'failed'; report: WorkReport }
  | { type: 'blocked'; report: WorkReport; escalation?: Escalation };

/**
 * Manager への入力
 */
export interface ManagerInput {
  /** 現在のイテレーション */
  iteration: number;
  /** 最大イテレーション数 */
  maxIterations: number;
  /** TASK.json の内容 */
  tasks: TaskEntry[] | null;
  /** PRD.md の内容 */
  prd: string | null;
  /** PROGRESS.md の内容 */
  progress: string | null;
  /** 前回の WorkReport */
  lastWorkReport: WorkReport | null;
  /** 未回答のエスカレーション */
  pendingEscalation: Escalation | null;
}

/**
 * Worker への入力
 */
export interface WorkerInput {
  /** 現在のイテレーション */
  iteration: number;
  /** 実行対象タスク */
  task: TaskEntry;
  /** PROGRESS.md の Codebase Patterns セクション */
  codebasePatterns: string | null;
  /** PRD.md の内容 */
  prd: string | null;
  /** Manager が合成したタスク固有ブリーフィング */
  briefing?: string;
}

/**
 * Agent 共通インターフェース
 */
export interface Agent {
  /** Agent 名 */
  readonly name: string;
  /** Agent のモード */
  readonly mode: AgentMode;
}
