import type { PlanTask } from '../state/plan.js';
import type { WorkOrder } from '../state/work-order.js';
import type { WorkReport } from '../state/work-report.js';
import type { Escalation } from '../state/escalation.js';

/**
 * v2 実行モード
 */
export type V2Mode = 'manager' | 'worker';

/**
 * Manager の判断結果
 */
export type ManagerDecision =
  | { type: 'dispatch_task'; workOrder: WorkOrder }
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
 * v2 イテレーション結果
 */
export interface V2IterationResult {
  /** イテレーション番号 */
  iteration: number;
  /** 実行フェーズ */
  phase: 'manager' | 'worker' | 'review';
  /** タスクID */
  taskId: string | null;
  /** 成功/失敗 */
  success: boolean;
  /** 完了フラグ（全タスク完了時） */
  completed: boolean;
  /** エスカレーション（あれば） */
  escalation?: Escalation;
  /** エラーメッセージ */
  error?: string;
}

/**
 * v2 オーケストレーター設定
 */
export interface V2OrchestratorConfig {
  /** 作業ディレクトリ */
  cwd: string;
  /** PLAN.json パス */
  planPath: string;
  /** PROGRESS.md パス */
  progressPath: string;
  /** .melos ディレクトリパス */
  melosDir: string;
  /** PRD.md パス */
  prdPath: string;
  /** HANDOFF.md パス */
  handoffPath: string;
  /** 最大イテレーション数 */
  maxIterations: number;
  /** Manager エンジン（claude） */
  managerEngine: 'claude';
  /** Worker エンジン（codex） */
  workerEngine: 'codex';
  /** ドライランモード（Worker を実行しない） */
  dryRun?: boolean;
}

/**
 * Manager への入力
 */
export interface ManagerInput {
  /** 現在のイテレーション */
  iteration: number;
  /** PLAN.json の内容 */
  plan: PlanTask[] | null;
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
  /** WorkOrder */
  workOrder: WorkOrder;
  /** PROGRESS.md の Codebase Patterns セクション */
  codebasePatterns: string | null;
}

/**
 * Agent 共通インターフェース
 */
export interface Agent {
  /** Agent 名 */
  readonly name: string;
  /** Agent のモード */
  readonly mode: V2Mode;
}
