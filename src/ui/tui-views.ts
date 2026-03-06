import type { ModelAssignment, ModelRole } from '../models/router.js';
import type { FeatureStatus, MilestoneStatus, MissionState } from '../state/mission.js';
import type { TokenUsageSnapshot } from '../state/token-tracker.js';
import type { LogActor, UnifiedLogEntry } from '../state/log-entry.js';

export type ViewId = 'overview' | 'features' | 'workers' | 'models' | 'prd' | 'task';

export interface WorkerRunView {
  id: number;
  type: 'implement' | 'validate' | 'research';
  featureId?: string;
  featureTitle?: string;
  milestoneId?: string;
  status: 'running' | 'done' | 'failed';
  durationLabel: string;
  engine?: 'claude' | 'codex';
  model?: string;
  log: UnifiedLogEntry[];
}

export interface MissionFeatureView {
  id: string;
  description: string;
  status: FeatureStatus;
  attempts: number;
  requestedModel?: 'claude' | 'codex';
  effectiveModel?: 'claude' | 'codex';
  modelStateSource?: 'requested' | 'effective' | 'default';
}

export interface MissionMilestoneView {
  id: string;
  title: string;
  status: MilestoneStatus;
  features: MissionFeatureView[];
}

export interface MissionControlState {
  missionId: string;
  missionTitle: string;
  missionState: MissionState;
  prdPreviewLines?: string[];
  taskPreviewLines?: string[];
  activity: string;
  elapsedLabel: string;
  progressLabel: string;
  progressPercent: number;
  activeMilestoneId: string | null;
  activeFeatureId: string | null;
  activeBranch: string | null;
  currentActor: LogActor;
  logEntries: UnifiedLogEntry[];
  milestones: MissionMilestoneView[];
  progressLog: Array<{ timestamp: string; message: string }>;
  managerLog?: Array<{ timestamp: string; message: string }>;
  workerRuns: WorkerRunView[];
  modelAssignments: Record<ModelRole, ModelAssignment>;
  tokenUsage: TokenUsageSnapshot;
  pendingPrompt?: string | null;
}

export interface ViewPort {
  width: number;
  height: number;
}

export interface KeyEvent {
  type: string;
  raw?: string;
}

export interface TUIView {
  readonly id: ViewId;
  render(
    viewport: ViewPort,
    state: MissionControlState,
    context?: {
      scrollOffset?: number;
      logSourceLock?: 'auto' | 'worker' | 'manager';
      secondaryVisible?: boolean;
      sourceSwitchNotice?: string | null;
      useColor?: boolean;
    }
  ): string[];
  handleKey?(key: KeyEvent, state: MissionControlState): boolean;
}
