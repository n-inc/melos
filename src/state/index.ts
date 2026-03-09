export {
  type MissionState,
  type FeatureKind,
  type FeatureStatus,
  type MilestoneStatus,
  type CheckItem,
  type Feature,
  type Milestone,
  type MissionPlan,
  missionFileExists,
  loadMissionPlan,
  saveMissionPlan,
  createMissionPlan,
  transitionMissionState,
  incrementMissionIterations,
  getMilestoneById,
  getFeatureById,
  getActiveMilestone,
  getActiveFeature,
  getNextPendingMilestone,
  getNextPendingFeature,
  areMilestoneFeaturesDone,
  areAllMilestonesDone,
  setActiveMilestone,
  setActiveFeature,
  updateMilestoneStatus,
  updateFeatureStatus,
  appendFeaturesToMilestone,
} from './mission.js';

export {
  type ReviewType,
  type ReviewFindingPriority,
  type ReviewFinding,
  type ReviewArtifact,
  type ProductReviewCheckpoint,
  type ProductReviewStartupStep,
  type ProductReviewContract,
  type ReviewReport,
  normalizeProductReviewContract,
  normalizeReviewFinding,
  normalizeReviewArtifact,
  isBlockingReviewFinding,
} from './review.js';

export {
  type CheckType,
  type ValidationRunner,
  type ValidationArtifact,
  type ValidationCheck,
  type ValidationContract,
  type ValidationCheckFailure,
  type ValidationCheckResult,
  type ValidationReport,
  type ValidationEvidenceMap,
  type ValidationFailureSummary,
  createEmptyValidationContract,
  getAllValidationChecks,
  cloneValidationContract,
  normalizeValidationCheck,
  normalizeValidationContract,
  mergeValidationResults,
  collectValidationFailures,
  hasValidationLoop,
} from './validation.js';

export {
  type GitStrategyConfig,
  type GitStrategyState,
  getGitStrategyPath,
  gitStrategyExists,
  loadGitStrategyState,
  saveGitStrategyState,
  createGitStrategyState,
  setActiveBranch,
} from './git-strategy.js';

export {
  type MissionEventType,
  type MissionEventBase,
  type MissionEvent,
  type EventLogOptions,
  EventLog,
} from './events.js';

export {
  type WorkerRunState,
  type RuntimeWarningSource,
  type RuntimeWarningRecord,
  type MissionKernelState,
  createInitialKernelState,
  formatRuntimeWarningRecord,
  runtimeWarningRecordFromEvent,
  reduceMissionEvent,
  replayMissionEvents,
} from './event-reducer.js';

export {
  type MissionSnapshot,
  getSnapshotPath,
  saveSnapshot,
  loadSnapshot,
} from './snapshot.js';

export {
  Watchdog,
} from './watchdog.js';

export { getCIStatus } from './git.js';

export { type PrdFrontmatter, extractPrdTitle } from './prd.js';

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
  type MelosRuntime,
  getRuntimePath,
  runtimeExists,
  loadRuntime,
  saveRuntime,
  clearRuntime,
  isProcessAlive,
  terminateProcess,
} from './runtime.js';
