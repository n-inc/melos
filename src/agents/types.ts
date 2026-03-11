import type { MissionPlan, Milestone, Feature } from '../state/mission.js';
import type { ValidationCheckResult, ValidationReport } from '../state/validation.js';
import type {
  ProductReviewCheckpointResult,
  ReviewArtifact,
  ReviewDecision,
  ReviewFinding,
  ReviewType,
} from '../state/review.js';
import type { PullRequestState, PullRequestFollowUpState } from '../state/git-strategy.js';

export type AgentMode = 'manager' | 'worker';

export type SteerResult = 'accepted' | 'unavailable' | 'unsupported';

export interface AskUserPrompt {
  question: string;
  context?: string;
  options?: Array<{ label: string; description: string }>;
  recommendation?: string;
  allowFreeText?: boolean;
}

export interface WorkerFileChange {
  path: string;
  additions: number;
  deletions?: number;
}

export interface WorkerFeatureReport {
  iteration: number;
  milestoneId: string;
  featureId: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'BLOCKED';
  summary: string;
  failureContext?: {
    stage: 'worker' | 'post_process';
    kind: string;
    signature: string;
    command?: string;
    executionCwd?: string;
  };
  warnings: string[];
  filesChanged: WorkerFileChange[];
  validation: {
    testsRun: boolean;
    testsPassed: number;
    testsFailed: number;
    lintPassed: boolean;
    typecheckPassed: boolean;
  };
  checks: ValidationCheckResult[];
  pullRequest?: PullRequestState;
  pullRequestFollowUp?: PullRequestFollowUpState;
  review?: {
    reviewType: ReviewType;
    generation: number;
    passed: boolean;
    summary: string;
    findings: ReviewFinding[];
    artifacts: ReviewArtifact[];
    checkpointResults?: ProductReviewCheckpointResult[];
  };
  learnings: string[];
  requestsHelp: boolean;
  createdAt: string;
}

export type WorkerResult =
  | { type: 'success'; report: WorkerFeatureReport }
  | { type: 'partial'; report: WorkerFeatureReport }
  | { type: 'failed'; report: WorkerFeatureReport }
  | { type: 'blocked'; report: WorkerFeatureReport };

export interface ManagerInput {
  iteration: number;
  maxIterations: number;
  missionPlan: MissionPlan;
  prd: string | null;
  activeMilestone: Milestone | null;
  activeFeature: Feature | null;
  latestValidationReport: ValidationReport | null;
  latestWorkerReport: WorkerFeatureReport | null;
  pendingSteers?: string[];
  onAgentMessageDelta?: (chunk: string) => void;
  onCommandOutputDelta?: (chunk: string) => void;
  onAppServerEvent?: (method: string, params: unknown) => void;
}

export interface WorkerInput {
  iteration: number;
  missionPlan: MissionPlan;
  milestone: Milestone;
  feature: Feature;
  prd: string | null;
  briefing?: string;
  currentBranch?: string | null;
  baseBranch?: string;
  onAgentMessageDelta?: (chunk: string) => void;
  onCommandOutputDelta?: (chunk: string) => void;
  onAppServerEvent?: (method: string, params: unknown) => void;
}

export interface FollowUpFeatureDraft {
  decision?: 'feature' | 'ignore';
  description: string;
  trackingKey?: string;
  priority: 'high' | 'medium' | 'low';
  affectedChecks?: string[];
  rerunReviewTypes?: ReviewType[];
  affectedProductCheckpoints?: string[];
  rationale?: string;
  model?: string;
  waivedReason?: string;
}

export interface ReviewDispositionDraft {
  findingId: string;
  decision: ReviewDecision;
  rationale: string;
}

export interface Agent {
  readonly name: string;
  readonly mode: AgentMode;
}
