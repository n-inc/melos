export {
  type TaskEngine,
  type TaskEntry,
  type TaskList,
  taskFileExists,
  loadTasks,
  saveTasks,
  updateTaskStatus,
  getPendingTasks,
  getNextTask,
  isAllTasksCompleted,
  addTasks,
} from './task.js';

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

export { getCIStatus } from './git.js';

export { type PrdFrontmatter, extractPrdTitle } from './prd.js';

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

export {
  type MelosSession,
  getSessionPath,
  sessionExists,
  loadSession,
  saveSession,
  clearSession,
} from './session.js';

export {
  type MelosRuntime,
  getRuntimePath,
  runtimeExists,
  loadRuntime,
  saveRuntime,
  clearRuntime,
  isProcessAlive,
  terminateProcess,
} from './runtime.js';
