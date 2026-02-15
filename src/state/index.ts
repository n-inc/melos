export {
  type TaskEngine,
  type PlanTask,
  type Plan,
  planExists,
  loadPlan,
  savePlan,
  updateTaskStatus,
  getPendingTasks,
  getNextTask,
  isAllTasksCompleted,
  addTasks,
} from './plan.js';

export {
  type ExecutionMode,
  type ProgressHeader,
  type IterationEntry,
  type Progress,
  progressExists,
  loadProgress,
  parseProgress,
  saveProgress,
  serializeProgress,
  initializeProgress,
  addIteration,
  getCurrentIteration,
  addCodebasePattern,
} from './progress.js';

export {
  type RunStatus,
  type CurrentTask,
  type GitState,
  type MelosStatus,
  type IterationOutcome,
  type LastIterationSummary,
  type RiskLevel,
  type EscalationRisk,
  type CIStatus,
  type StateSignals,
  type HistoryEntry,
  type RecentHistory,
  createDefaultStatus,
  createDefaultGitState,
  statusExists,
  loadStatus,
  saveStatus,
  updateStatus,
  markEngineStarted,
  markEngineCompleted,
  markIterationStarted,
  updateGitState,
  updateTaskProgress,
  clearStatus,
  getFilesChangedCount,
  calculateEscalationRisk,
  addToRecentHistory,
  mapPromiseToOutcome,
} from './status.js';

export { getCIStatus } from './git.js';

export { type PrdFrontmatter, extractPrdTitle } from './prd.js';

// v2: Manager + Worker アーキテクチャ用
export {
  type WorkOrder,
  type WorkOrderContext,
  type WorkOrderConstraints,
  getWorkOrderPath,
  workOrderExists,
  loadWorkOrder,
  saveWorkOrder,
  createWorkOrder,
  clearWorkOrder,
} from './work-order.js';

export {
  type WorkReportStatus,
  type FileChange,
  type VerificationResult,
  type CriterionResult,
  type DiscoveredTask,
  type WorkReport,
  getWorkReportPath,
  workReportExists,
  loadWorkReport,
  saveWorkReport,
  createWorkReport,
  clearWorkReport,
  isAllCriteriaPassed,
  isVerificationPassed,
} from './work-report.js';

export {
  type EscalationType,
  type EscalationStatus,
  type EscalationOption,
  type Escalation,
  getEscalationPath,
  escalationExists,
  loadEscalation,
  saveEscalation,
  createEscalation,
  createQuestionEscalation,
  createApprovalEscalation,
  createBlockerEscalation,
  answerEscalation,
  clearEscalation,
  generateEscalationId,
} from './escalation.js';
