import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { ManagerAgent, MissionPlanningError, type ManagerAgentConfig } from './agents/manager.js';
import { WorkerAgent, type WorkerAgentConfig } from './agents/worker.js';
import type { ManagerInput, WorkerFeatureReport, WorkerInput, WorkerResult } from './agents/types.js';
import {
  type MissionPlan,
  type MissionState,
  type Milestone,
  type Feature,
  createMissionPlan,
  missionFileExists,
  loadMissionPlan,
  saveMissionPlan,
  transitionMissionState,
  ensurePullRequestFollowUpMilestone,
  getNextPendingMilestone,
  getNextPendingFeature,
  areAllMilestonesDone,
  areMilestoneFeaturesDone,
  setActiveMilestone,
  setActiveFeature,
  updateFeatureStatus,
  updateFeatureModel,
  updateMilestoneStatus,
  appendFeaturesToMilestone,
  incrementMissionIterations,
} from './state/mission.js';
import {
  type ReviewReport,
  isBlockingReviewFinding,
} from './state/review.js';
import {
  type ValidationCheck,
  type ValidationReport,
  type ValidationCheckResult,
  getAllValidationChecks,
  mergeValidationResults,
  hasValidationLoop,
} from './state/validation.js';
import {
  type GitStrategyState,
  createGitStrategyState,
  createMissionBranchName,
  createFeatureBranchName,
  registerFeatureBranch,
  saveGitStrategyState,
  loadGitStrategyState,
  setMissionBranch,
  updatePullRequestState,
  updatePullRequestFollowUpState,
  updateFeatureBranchStatus,
} from './state/git-strategy.js';
import {
  createBranch,
  checkoutBranch,
  getCurrentBranch,
  getHeadCommitHash,
  hasConflicts,
  isWorkingTreeClean,
  mergeBranch,
  runGitCommand,
} from './state/git.js';
import { EventLog } from './state/events.js';
import {
  replayMissionEvents,
  reduceMissionEvent,
  type MissionKernelState,
  type FeatureRetryRecord,
  createInitialKernelState,
  formatRuntimeWarningRecord,
  type RuntimeWarningSource,
} from './state/event-reducer.js';
import { loadSnapshot, saveSnapshot } from './state/snapshot.js';
import { Watchdog } from './state/watchdog.js';
import { wrapLogText, type LogActor } from './state/log-entry.js';
import { ModelRouter, type ModelRole } from './models/router.js';
import {
  CLAUDE_LATEST_ALIAS,
  CODEX_LATEST_ALIAS,
  getModelRotation,
  normalizeModelName,
  resolveDisplayModel,
  resolveModel,
  resolveModelEngine,
  type ModelEngine,
} from './models/registry.js';
import { getDefaultPromptsDir } from './prompts/index.js';
import type { RunIdentity } from './run-spec.js';
import type { MissionControlState, MissionMilestoneView, WorkerRunView } from './ui/tui-views.js';

export interface OrchestratorConfig {
  cwd: string;
  maxIterations: number;
  prdFile: string;
  missionFile: string;
  melosDir: string;
  plannerModel?: string;
  workerModel?: string;
  execution?: {
    maxFeatureAttempts?: number;
    retryInitialDelayMs?: number;
    retryMaxDelayMs?: number;
    stallTimeoutMs?: number;
  };
  verification?: {
    requireManualEvidence?: boolean;
    requireE2EEvidence?: boolean;
    failOnWorkerWarnings?: boolean;
  };
  managerEffort?: 'low' | 'medium' | 'high' | 'max';
  workerReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  interactivePlanning?: boolean;
  autoApprove?: boolean;
  dryRun?: boolean;
  quick?: boolean;
  runIdentity?: RunIdentity;
  prdOverride?: string;
  gitStrategy?: {
    enabled: boolean;
    baseBranch: string;
    missionId: string;
    autoPush: boolean;
    preMergeValidation: boolean;
    validationCommands: string[];
    pullRequestEnabled: boolean;
  };
  resume?: boolean;
  missionId?: string;
  runtimeUIMode?: 'tui' | 'plain' | 'headless';
  onStatusUpdate?: (state: MissionControlState) => void | Promise<void>;
}

export interface LoopResult {
  success: boolean;
  reason: 'completed' | 'failed' | 'aborted' | 'max_iterations';
  completedIterations: number;
  handoffContent?: string;
  error?: string;
}

interface RuntimeState {
  missionPlan: MissionPlan | null;
  iteration: number;
  prd: string | null;
  latestValidationReport: ValidationReport | null;
  latestWorkerReport: WorkerFeatureReport | null;
  latestReviewReport: ReviewReport | null;
  gitStrategy: GitStrategyState | null;
  startedAt: Date;
}

interface ResolvedExecutionConfig {
  maxFeatureAttempts: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  stallTimeoutMs: number;
}

interface ResolvedVerificationConfig {
  requireManualEvidence: boolean;
  requireE2EEvidence: boolean;
  failOnWorkerWarnings: boolean;
}

const MODEL_ROTATION: string[] = getModelRotation();
const DEFAULT_EXECUTION_CONFIG: ResolvedExecutionConfig = {
  maxFeatureAttempts: 3,
  retryInitialDelayMs: 10_000,
  retryMaxDelayMs: 300_000,
  stallTimeoutMs: 300_000,
};
const DEFAULT_VERIFICATION_CONFIG: ResolvedVerificationConfig = {
  requireManualEvidence: true,
  requireE2EEvidence: true,
  failOnWorkerWarnings: false,
};

export class Orchestrator {
  private readonly config: OrchestratorConfig;
  private readonly manager: ManagerAgent;
  private readonly worker: WorkerAgent;
  private readonly modelRouter: ModelRouter;
  private readonly eventLog: EventLog;
  private readonly watchdog: Watchdog;
  private readonly executionConfig: ResolvedExecutionConfig;
  private readonly verificationConfig: ResolvedVerificationConfig;

  private state: RuntimeState;
  private kernelState: MissionKernelState;

  private aborted = false;
  private pausePromise: Promise<void> | null = null;
  private resumePause: (() => void) | null = null;
  private workerRunCounter = 0;
  private pendingPrompt: string | null = null;
  private activityLabel = '';
  private statusRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private fatalFailureReason: string | null = null;
  private abortSignal: NodeJS.Signals | null = null;

  private setGitStrategyState(next: GitStrategyState | null): void {
    this.state.gitStrategy = next;
    this.kernelState.gitStrategy = next;
  }

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.executionConfig = {
      maxFeatureAttempts: config.execution?.maxFeatureAttempts ?? DEFAULT_EXECUTION_CONFIG.maxFeatureAttempts,
      retryInitialDelayMs: config.execution?.retryInitialDelayMs ?? DEFAULT_EXECUTION_CONFIG.retryInitialDelayMs,
      retryMaxDelayMs: config.execution?.retryMaxDelayMs ?? DEFAULT_EXECUTION_CONFIG.retryMaxDelayMs,
      stallTimeoutMs: config.execution?.stallTimeoutMs ?? DEFAULT_EXECUTION_CONFIG.stallTimeoutMs,
    };
    this.verificationConfig = {
      requireManualEvidence: config.verification?.requireManualEvidence ?? DEFAULT_VERIFICATION_CONFIG.requireManualEvidence,
      requireE2EEvidence: config.verification?.requireE2EEvidence ?? DEFAULT_VERIFICATION_CONFIG.requireE2EEvidence,
      failOnWorkerWarnings: config.verification?.failOnWorkerWarnings ?? DEFAULT_VERIFICATION_CONFIG.failOnWorkerWarnings,
    };

    this.modelRouter = new ModelRouter({
      assignments: {
        planner: normalizeModelName(config.plannerModel) ?? CODEX_LATEST_ALIAS,
        worker: normalizeModelName(config.workerModel) ?? CODEX_LATEST_ALIAS,
      },
      escalationPolicy: {
        enabled: true,
        maxEscalations: 2,
        chain: {
          haiku: 'sonnet',
          sonnet: CLAUDE_LATEST_ALIAS,
        },
      },
    });

    const promptsDir = getDefaultPromptsDir();

    const managerConfig: ManagerAgentConfig = {
      cwd: config.cwd,
      promptsDir,
      model: this.modelRouter.getModel('planner'),
      effort: config.managerEffort ?? 'high',
      requestTimeoutMs: 900_000,
      suppressTerminalOutput: config.runtimeUIMode !== 'plain',
      pullRequestAutomationEnabled: config.gitStrategy?.pullRequestEnabled === true,
    };
    this.manager = new ManagerAgent(managerConfig);

    const workerConfig: WorkerAgentConfig = {
      cwd: config.cwd,
      promptsDir,
      model: this.modelRouter.getModel('worker'),
      reasoningEffort: config.workerReasoningEffort ?? 'xhigh',
      claudeModel: this.modelRouter.getModel('worker'),
      claudeEffort: config.managerEffort ?? 'high',
      suppressTerminalOutput: config.runtimeUIMode !== 'plain',
    };
    this.worker = new WorkerAgent(workerConfig);

    this.eventLog = new EventLog({ melosDir: config.melosDir });
    this.watchdog = new Watchdog({
      timeoutMs: this.executionConfig.stallTimeoutMs,
    });

    this.state = {
      missionPlan: null,
      iteration: 0,
      prd: null,
      latestValidationReport: null,
      latestWorkerReport: null,
      latestReviewReport: null,
      gitStrategy: config.gitStrategy?.enabled
        ? createGitStrategyState({
          missionId: config.gitStrategy.missionId,
          baseBranch: config.gitStrategy.baseBranch,
          autoPush: config.gitStrategy.autoPush,
          preMergeValidation: config.gitStrategy.preMergeValidation,
          validationCommands: config.gitStrategy.validationCommands,
          pullRequestEnabled: config.gitStrategy.pullRequestEnabled,
        })
        : null,
      startedAt: new Date(),
    };

    this.kernelState = createInitialKernelState();
    this.kernelState.gitStrategy = this.state.gitStrategy;
    this.watchdog.onStuck(() => {
      this.emitEvent('error', 'system', {
        message: 'worker appears stuck (watchdog timeout)',
      });
      if (this.state.missionPlan?.state === 'running') {
        this.pause();
      }
    });
  }

  async run(): Promise<LoopResult> {
    this.ensureMelosDir();
    await this.loadState();
    this.watchdog.start();

    if (!this.config.resume) {
      this.emitEvent('mission_started', 'orchestrator', {
        message: 'mission run started',
      });
    } else {
      this.emitEvent('mission_resumed', 'orchestrator', {
        message: 'mission run resumed',
      });
    }
    await this.emitStatusUpdate();

    try {
      while (!this.aborted) {
        if (this.fatalFailureReason) {
          return {
            success: false,
            reason: 'failed',
            completedIterations: this.state.missionPlan?.totalIterations ?? 0,
            error: this.fatalFailureReason,
          };
        }

        const missionPlan = this.state.missionPlan;
        if (!missionPlan) {
          if (this.config.quick) {
            await this.createQuickMissionPlan();
          } else {
            await this.runPlanningPhase();
          }
          continue;
        }

        switch (missionPlan.state) {
          case 'planning':
            if (this.config.quick) {
              await this.createQuickMissionPlan();
            } else {
              await this.runPlanningPhase();
            }
            break;

          case 'awaiting_approval':
            await this.runApprovalPhase();
            break;

          case 'running':
            if (missionPlan.totalIterations >= this.config.maxIterations) {
              return {
                success: false,
                reason: 'max_iterations',
                completedIterations: missionPlan.totalIterations,
              };
            }
            await this.runExecutionIteration();
            break;

          case 'paused':
            await this.waitForResume();
            break;

          case 'completed':
            return {
              success: true,
              reason: 'completed',
              completedIterations: missionPlan.totalIterations,
              handoffContent: await this.writeHandoff(),
            };

          case 'failed':
            return {
              success: false,
              reason: 'failed',
              completedIterations: missionPlan.totalIterations,
            };

          case 'aborted':
            return {
              success: false,
              reason: 'aborted',
              completedIterations: missionPlan.totalIterations,
            };

          default:
            throw new Error(`Unsupported mission state: ${(missionPlan as { state?: unknown }).state}`);
        }
      }

      return {
        success: false,
        reason: this.fatalFailureReason ? 'failed' : 'aborted',
        completedIterations: this.state.missionPlan?.totalIterations ?? 0,
        error: this.fatalFailureReason ?? undefined,
      };
    } finally {
      this.watchdog.stop();
      if (this.statusRefreshTimer) {
        clearTimeout(this.statusRefreshTimer);
        this.statusRefreshTimer = null;
      }
      await this.persistRuntimeState();
      await this.emitStatusUpdate();
    }
  }

  pause(): void {
    if (!this.state.missionPlan || this.state.missionPlan.state !== 'running') {
      return;
    }

    this.activityLabel = 'Mission paused. Press R to resume.';
    this.state.missionPlan = transitionMissionState(this.state.missionPlan, 'paused');
    void this.persistMissionPlan();
    this.emitEvent('mission_interrupted', 'orchestrator', { reason: 'paused by user' });
    void this.emitStatusUpdate();
  }

  resume(): void {
    if (!this.state.missionPlan || this.state.missionPlan.state !== 'paused') {
      return;
    }

    this.activityLabel = 'Resuming mission execution...';
    this.state.missionPlan = transitionMissionState(this.state.missionPlan, 'running');
    void this.persistMissionPlan();
    this.emitEvent('mission_resumed', 'orchestrator', { reason: 'resumed by user' });
    if (this.resumePause) {
      this.resumePause();
      this.resumePause = null;
      this.pausePromise = null;
    }
    void this.emitStatusUpdate();
  }

  abort(signal?: NodeJS.Signals): void {
    this.aborted = true;
    if (signal && this.abortSignal === null) {
      this.abortSignal = signal;
    }
    this.activityLabel = 'Abort requested. Stopping active work...';
    this.manager.abort();
    this.worker.abort();

    if (this.state.missionPlan && this.state.missionPlan.state !== 'completed') {
      const reason = this.abortSignal
        ? `aborted by signal ${this.abortSignal}`
        : 'aborted by signal';
      this.state.missionPlan = {
        ...this.state.missionPlan,
        state: 'aborted',
      };
      void this.persistMissionPlan();
      this.emitEvent('mission_failed', 'orchestrator', {
        reason,
        signal: this.abortSignal ?? undefined,
      });
    }

    if (this.resumePause) {
      this.resumePause();
      this.resumePause = null;
      this.pausePromise = null;
    }
  }

  async steer(instruction: string): Promise<{ status: 'accepted' | 'unavailable'; message?: string }> {
    const text = instruction.trim();
    if (text.length === 0) {
      return { status: 'unavailable', message: 'empty steer' };
    }

    this.emitEvent('user_steer', 'orchestrator', { instruction: text });

    if (/^pause$/i.test(text)) {
      this.pause();
      return { status: 'accepted' };
    }
    if (/^resume$/i.test(text)) {
      this.resume();
      return { status: 'accepted' };
    }

    const skipMatch = text.match(/^skip\s+(m\d+-f\d+)$/i);
    if (skipMatch && this.state.missionPlan) {
      const target = skipMatch[1];
      const milestone = this.findMilestoneByFeatureId(target);
      if (!milestone) {
        return { status: 'unavailable', message: `feature not found: ${target}` };
      }
      this.state.missionPlan = updateFeatureStatus(
        this.state.missionPlan,
        milestone.id,
        target,
        'skipped'
      );
      await this.persistMissionPlan();
      await this.emitStatusUpdate();
      return { status: 'accepted' };
    }

    return { status: 'accepted' };
  }

  async cycleModel(role: ModelRole): Promise<void> {
    const current = this.modelRouter.getModel(role);
    const normalized = normalizeModelName(current) ?? current.toLowerCase();
    const index = MODEL_ROTATION.findIndex((candidate) => candidate === normalized);
    const nextModel = index >= 0
      ? MODEL_ROTATION[(index + 1) % MODEL_ROTATION.length]
      : MODEL_ROTATION[0];
    this.modelRouter.setModel(role, nextModel);
    if (role === 'planner') {
      this.manager.setModel(nextModel);
    }
    if (role === 'worker') {
      this.worker.setRuntimeModel(nextModel);
    }
    this.emitEvent('manager_decision', 'orchestrator', {
      action: 'model_changed',
      role,
      model: nextModel,
      message: `model for ${role} changed to ${resolveDisplayModel(nextModel)}`,
    });
    await this.emitStatusUpdate();
  }

  async setActiveFeatureModel(model: string | null): Promise<void> {
    const missionPlan = this.state.missionPlan;
    if (!missionPlan) {
      return;
    }

    const activeMilestoneId = missionPlan.activeMilestoneId;
    const activeFeatureId = missionPlan.activeFeatureId;
    if (!activeMilestoneId || !activeFeatureId) {
      this.emitEvent('manager_decision', 'orchestrator', {
        action: 'feature_model_selection_ignored',
        reason: 'no_active_feature',
      });
      await this.emitStatusUpdate();
      return;
    }

    const milestone = missionPlan.milestones.find((item) => item.id === activeMilestoneId);
    const feature = milestone?.features.find((item) => item.id === activeFeatureId);
    if (!milestone || !feature) {
      this.emitEvent('manager_decision', 'orchestrator', {
        action: 'feature_model_selection_ignored',
        reason: 'active_feature_not_found',
        milestoneId: activeMilestoneId,
        featureId: activeFeatureId,
      });
      await this.emitStatusUpdate();
      return;
    }

    if (feature.status === 'done') {
      this.emitEvent('manager_decision', 'orchestrator', {
        action: 'feature_model_selection_ignored',
        reason: 'feature_done',
        milestoneId: activeMilestoneId,
        featureId: activeFeatureId,
      });
      await this.emitStatusUpdate();
      return;
    }

    const normalizedModel = normalizeModelName(model);
    this.state.missionPlan = updateFeatureModel(
      missionPlan,
      activeMilestoneId,
      activeFeatureId,
      normalizedModel ?? null
    );
    this.kernelState.missionPlan = this.state.missionPlan;

    this.emitEvent('manager_decision', 'orchestrator', {
      action: 'feature_model_selected',
      milestoneId: activeMilestoneId,
      featureId: activeFeatureId,
      model: normalizedModel ?? null,
      source: normalizedModel ? 'user' : 'unset',
    });
    await this.persistMissionPlan();
    await this.emitStatusUpdate();
  }

  private async loadState(): Promise<void> {
    if (this.config.prdOverride) {
      this.state.prd = this.config.prdOverride;
    } else if (existsSync(this.config.prdFile)) {
      this.state.prd = await readFile(this.config.prdFile, 'utf-8');
    }

    if (this.config.resume) {
      const snapshot = await loadSnapshot<{ kernel: MissionKernelState }>(this.config.melosDir);
      if (snapshot?.state?.kernel) {
        this.kernelState = normalizeKernelState(snapshot.state.kernel);
        const replayEvents = this.eventLog.readAfter(snapshot.seq);
        for (const event of replayEvents) {
          this.kernelState = reduceMissionEvent(this.kernelState, event);
        }
      } else {
        this.kernelState = replayMissionEvents(this.eventLog.readAll());
      }
    }

    if (missionFileExists(this.config.missionFile)) {
      this.state.missionPlan = await loadMissionPlan(this.config.missionFile);
      if (this.state.missionPlan && this.config.resume && isRecoverableResumeState(this.state.missionPlan.state)) {
        this.state.missionPlan = recoverMissionPlanForResume(this.state.missionPlan);
        this.activityLabel = 'Resuming interrupted mission from the next actionable feature...';
        await saveMissionPlan(this.config.missionFile, this.state.missionPlan);
      }
    }

    if (!this.state.missionPlan) {
      this.activityLabel = 'Planning mission from PRD.md...';
    }

    if (this.state.gitStrategy && this.config.resume) {
      const persisted = await loadGitStrategyState(this.config.melosDir);
      if (persisted) {
        this.setGitStrategyState(persisted);
      }
    }

    if (this.state.missionPlan && this.state.gitStrategy?.config.pullRequestEnabled) {
      const nextPlan = ensurePullRequestFollowUpMilestone(this.state.missionPlan);
      if (nextPlan !== this.state.missionPlan) {
        this.state.missionPlan = nextPlan;
        await saveMissionPlan(this.config.missionFile, nextPlan);
      }
    }

    this.state.latestValidationReport = this.kernelState.latestValidationReport ?? null;
    this.state.latestReviewReport = this.kernelState.latestReviewReport ?? null;
    this.kernelState.missionPlan = this.state.missionPlan ?? null;
    this.kernelState.gitStrategy = this.state.gitStrategy;
    await this.emitStatusUpdate();
  }

  private async createQuickMissionPlan(): Promise<void> {
    const prd = this.state.prd?.trim() ?? '';
    const heading = prd
      .split(/\r?\n/)
      .find((line) => line.startsWith('# '))
      ?.replace(/^#\s+/, '')
      .trim();
    const objective = heading && heading.length > 0 ? heading : 'Quick mission';

    let plan = createMissionPlan({
      missionId: this.resolveMissionId(),
      goal: objective,
      milestones: [
        {
          id: 'm1',
          title: 'Quick Execution',
          description: objective,
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: prd || objective,
              status: 'pending',
              attempts: 0,
              model: this.modelRouter.getModel('worker'),
            },
          ],
        },
      ],
      state: 'running',
    });
    plan = setActiveMilestone(plan, 'm1');
    plan = setActiveFeature(plan, 'm1-f1');

    this.state.missionPlan = plan;
    this.kernelState.missionPlan = plan;
    this.activityLabel = 'Quick mission plan created. Starting execution...';

    this.emitEvent('plan_created', 'manager', { plan, quick: true });
    await this.persistMissionPlan();
    await this.emitStatusUpdate();
  }

  private async runPlanningPhase(): Promise<void> {
    const current = this.state.missionPlan;
    const planningStream = createBufferedProgressEmitter((line) => {
      this.emitEvent('manager_decision', 'manager', {
        phase: 'planning',
        message: `planning: ${line}`,
      });
    });
    const planningCommandStream = createBufferedProgressEmitter((line) => {
      this.emitEvent('manager_decision', 'manager', {
        phase: 'planning',
        message: `planning: [CMD] ${line}`,
      });
    });

    this.activityLabel = `Planning mission with ${this.modelRouter.getModel('planner')}...`;
    this.emitEvent('manager_started', 'manager', {
      phase: 'planning',
      message: `Planning mission with manager model (${this.modelRouter.getModel('planner')})`,
    });
    await this.emitStatusUpdate();

    let generated: MissionPlan;
    try {
      generated = await this.manager.generateMissionPlan({
        missionId: this.resolveMissionId(),
        prd: this.state.prd,
        interactiveGoal: this.config.interactivePlanning ? current?.mission.goal : undefined,
        fallbackOnFailure: false,
        onAgentMessageDelta: (chunk) => {
          planningStream.push(chunk);
        },
        onCommandOutputDelta: (chunk) => {
          planningCommandStream.push(chunk);
        },
        onAppServerEvent: (method, params) => {
          const detail = formatAgentEventDetail(method, params);
          if (!detail) {
            return;
          }
          this.emitEvent('manager_decision', 'manager', {
            phase: 'planning',
            message: `planning: ${detail}`,
          });
        },
      });
    } catch (error) {
      if (error instanceof MissionPlanningError) {
        this.activityLabel = `Planning failed: ${truncateMessage(error.detail, 180)}`;
        this.emitEvent('manager_error', 'manager', {
          phase: 'planning',
          message: `planning failed: ${error.detail}`,
          reason: error.reason,
          detail: error.detail,
          outputPreview: error.outputPreview ?? null,
        });
        this.emitEvent('mission_failed', 'orchestrator', {
          reason: error.reason,
          detail: error.detail,
        });
        this.fatalFailureReason = error.detail;
        this.aborted = true;
        await this.emitStatusUpdate();
        return;
      }
      throw error;
    } finally {
      planningStream.flush();
      planningCommandStream.flush();
    }

    const planWithFollowUp = this.state.gitStrategy?.config.pullRequestEnabled
      ? ensurePullRequestFollowUpMilestone(generated)
      : generated;
    const withPhase = transitionMissionState(planWithFollowUp, 'awaiting_approval');
    const activeMilestone = getNextPendingMilestone(withPhase);
    const activeFeature = activeMilestone ? getNextPendingFeature(activeMilestone) : null;

    let next = withPhase;
    next = setActiveMilestone(next, activeMilestone?.id ?? null);
    next = setActiveFeature(next, activeFeature?.id ?? null);

    this.state.missionPlan = next;
    this.kernelState.missionPlan = next;
    this.activityLabel = 'Plan generated. Waiting for approval.';

    this.emitEvent('plan_created', 'manager', { plan: next });
    await this.persistMissionPlan();
    await this.emitStatusUpdate();
  }

  private async runApprovalPhase(): Promise<void> {
    const missionPlan = this.requireMissionPlan();
    this.activityLabel = 'Waiting for mission approval input...';

    const approved = this.config.autoApprove
      ? true
      : await this.promptPlanApproval();

    if (!approved) {
      if (this.state.missionPlan && this.state.missionPlan.state !== 'awaiting_approval') {
        await this.persistMissionPlan();
        await this.emitStatusUpdate();
        return;
      }
      if (!this.aborted) {
        this.activityLabel = 'Approval required. Press y to continue or Ctrl+C to abort.';
        await this.emitStatusUpdate();
      }
      return;
    }

    this.state.missionPlan = transitionMissionState(missionPlan, 'running');
    this.activityLabel = 'Mission approved. Starting execution...';
    await this.persistMissionPlan();
    await this.emitStatusUpdate();
  }

  private async runExecutionIteration(): Promise<void> {
    let missionPlan = this.requireMissionPlan();
    this.activityLabel = 'Preparing next mission iteration...';
    this.emitEvent('iteration_started', 'orchestrator', {
      state: missionPlan.state,
      iteration: missionPlan.totalIterations + 1,
    });

    const pendingMilestone = getNextPendingMilestone(missionPlan);
    if (!pendingMilestone) {
      if (areAllMilestonesDone(missionPlan)) {
        this.activityLabel = 'All milestones are done. Completing mission...';
        missionPlan = transitionMissionState(missionPlan, 'completed');
        this.state.missionPlan = missionPlan;
        this.emitEvent('mission_completed', 'orchestrator', {
          totalIterations: missionPlan.totalIterations,
        });
        await this.persistMissionPlan();
        await this.emitStatusUpdate();
        return;
      }

      missionPlan = transitionMissionState(missionPlan, 'failed');
      this.state.missionPlan = missionPlan;
      this.emitEvent('mission_failed', 'orchestrator', {
        reason: 'no pending milestone but mission not completed',
      });
      await this.persistMissionPlan();
      await this.emitStatusUpdate();
      return;
    }

    missionPlan = this.releaseReadyFeatureRetries(missionPlan);
    this.state.missionPlan = missionPlan;
    this.kernelState.missionPlan = missionPlan;
    missionPlan = setActiveMilestone(missionPlan, pendingMilestone.id);
    missionPlan = updateMilestoneStatus(missionPlan, pendingMilestone.id, 'in_progress');
    this.activityLabel = `Milestone ${pendingMilestone.id} in progress.`;

    const activeMilestone = missionPlan.milestones.find((milestone) => milestone.id === pendingMilestone.id);
    if (!activeMilestone) {
      throw new Error(`Milestone not found after activation: ${pendingMilestone.id}`);
    }

    if (areMilestoneFeaturesDone(activeMilestone)) {
      this.state.missionPlan = missionPlan;
      await this.runMilestoneValidation(pendingMilestone.id);
      return;
    }

    const nextFeature = getNextPendingFeature(activeMilestone);
    if (!nextFeature) {
      this.state.missionPlan = missionPlan;
      await this.runMilestoneValidation(pendingMilestone.id);
      return;
    }

    const scheduledRetry = this.findFeatureRetry(pendingMilestone.id, nextFeature.id);
    if (scheduledRetry) {
      await this.waitForScheduledFeatureRetry(scheduledRetry);
      return;
    }

    missionPlan = setActiveFeature(missionPlan, nextFeature.id);
    missionPlan = updateFeatureStatus(missionPlan, pendingMilestone.id, nextFeature.id, 'in_progress', {
      incrementAttempts: true,
    });

    this.state.missionPlan = missionPlan;
    this.activityLabel = `Preparing briefing for ${nextFeature.id}...`;
    await this.persistMissionPlan();
    await this.emitStatusUpdate();

    const updatedMilestone = this.requireMissionPlan().milestones.find((milestone) => milestone.id === pendingMilestone.id);
    const updatedFeature = updatedMilestone?.features.find((feature) => feature.id === nextFeature.id);
    if (!updatedMilestone || !updatedFeature) {
      throw new Error(`Active feature context not found: ${pendingMilestone.id}/${nextFeature.id}`);
    }

    this.emitEvent('manager_started', 'manager', {
      phase: 'briefing',
      milestoneId: updatedMilestone.id,
      featureId: updatedFeature.id,
      message: `Manager started feature briefing for ${updatedFeature.id}`,
    });
    let briefing: string | undefined;
    briefing = await this.manager.generateFeatureBriefing({
      ...this.buildManagerInput(updatedMilestone, updatedFeature),
      onAppServerEvent: (method, params) => {
        const detail = formatAgentEventDetail(method, params);
        if (!detail) {
          return;
        }
        this.emitEvent('manager_decision', 'manager', {
          action: 'briefing',
          milestoneId: updatedMilestone.id,
          featureId: updatedFeature.id,
          message: detail,
        });
      },
    });
    this.emitEvent('manager_decision', 'manager', {
      action: 'briefing',
      milestoneId: updatedMilestone.id,
      featureId: updatedFeature.id,
      message: `Manager finished feature briefing for ${updatedFeature.id}`,
    });
    const dispatchModelState = resolveFeatureModelState(
      updatedFeature,
      normalizeModelName(this.modelRouter.getModel('worker')) ?? CODEX_LATEST_ALIAS
    );
    this.emitEvent('manager_decision', 'manager', {
      action: 'dispatch_feature',
      milestoneId: updatedMilestone.id,
      featureId: updatedFeature.id,
      model: resolveDisplayModel(dispatchModelState.model),
      modelSource: dispatchModelState.source,
    });

    this.activityLabel = `Worker executing ${updatedFeature.id}...`;
    const rawResult = await this.executeFeature(updatedMilestone, updatedFeature, briefing);
    await this.syncPullRequestStateFromReport(updatedFeature, rawResult.report);
    const result = this.shouldApplyWorkerWarningPolicy(updatedFeature)
      ? this.applyWorkerWarningPolicy(updatedMilestone.id, updatedFeature.id, rawResult)
      : rawResult;
    this.state.latestWorkerReport = result.report;
    this.recordValidationEvidence(updatedMilestone.id, result.report.checks);
    this.emitWorkerWarnings(updatedMilestone.id, updatedFeature.id, result.report.warnings);

    if (updatedFeature.kind === 'review') {
      await this.handleReviewFeatureResult(updatedMilestone, updatedFeature, result);
      return;
    }
    if (updatedFeature.kind === 'qa') {
      await this.handleQaFeatureResult(updatedMilestone, updatedFeature, result);
      return;
    }
    if (updatedFeature.kind === 'pull_request' || updatedFeature.kind === 'pr_followup') {
      await this.handleOperationalFeatureResult(updatedMilestone, updatedFeature, result);
      return;
    }
    await this.handleImplementationFeatureResult(updatedMilestone, updatedFeature, result);
  }

  private async runMilestoneValidation(milestoneId: string): Promise<void> {
    let missionPlan = this.requireMissionPlan();
    const milestone = missionPlan.milestones.find((item) => item.id === milestoneId);
    if (!milestone) {
      throw new Error(`Milestone not found: ${milestoneId}`);
    }

    missionPlan = updateMilestoneStatus(missionPlan, milestoneId, 'validating');
    this.state.missionPlan = missionPlan;
    this.activityLabel = `Validating milestone ${milestoneId}...`;
    await this.persistMissionPlan();
    await this.emitStatusUpdate();

    this.emitEvent('validation_started', 'orchestrator', { milestoneId });
    const checks = getAllValidationChecks(milestone.validationContract);
    const results: ValidationCheckResult[] = [];
    const evidenceByCheckId = this.kernelState.validationEvidence?.[milestoneId] ?? {};

    for (const check of checks) {
      if (check.type === 'browser') {
        const result = evaluateBrowserValidationCheck(this.config.cwd, check, evidenceByCheckId[check.id]);
        results.push(result);
        if (result.warning) {
          this.emitValidationWarning({
            milestoneId,
            checkId: check.id,
            message: result.warning,
          });
        }
        continue;
      }

      if (check.type === 'manual') {
        const result = this.evaluateEvidenceValidationCheck(milestoneId, check, evidenceByCheckId[check.id]);
        results.push(result);
        if (result.warning) {
          this.emitValidationWarning({
            milestoneId,
            checkId: check.id,
            message: result.warning,
          });
        }
        continue;
      }

      if (check.type === 'e2e') {
        const result = this.evaluateEvidenceValidationCheck(milestoneId, check, evidenceByCheckId[check.id]);
        results.push(result);
        if (result.warning) {
          this.emitValidationWarning({
            milestoneId,
            checkId: check.id,
            message: result.warning,
          });
        }
        continue;
      }

      if (!check.command) {
        results.push({
          checkId: check.id,
          passed: false,
          output: 'no command',
        });
        continue;
      }

      const commandResult = runGitCommand(this.config.cwd, check.command);
      const passed = commandResult.exitCode === 0;

      results.push({
        checkId: check.id,
        passed,
        exitCode: commandResult.exitCode,
        durationMs: commandResult.durationMs,
        output: `${commandResult.stdout}\n${commandResult.stderr}`.trim(),
        failure: passed
          ? undefined
          : {
            summary: `${check.id} failed (${commandResult.exitCode})`,
            affectedFiles: [],
            errorMessages: truncateLines(
              `${commandResult.stdout}\n${commandResult.stderr}`.split(/\r?\n/).filter((line) => line.trim().length > 0),
              8
            ),
          },
      });

      this.emitEvent('command_executed', 'system', {
        checkId: check.id,
        command: check.command,
        exitCode: commandResult.exitCode,
      });
    }

    const passed = results.every((result) => result.passed);
    const attempt = Math.max(...checks.map((check) => check.failureCount), 0) + 1;
    const report: ValidationReport = {
      milestoneId,
      timestamp: new Date().toISOString(),
      passed,
      results,
      attempt,
    };

    this.state.latestValidationReport = report;
    this.kernelState.latestValidationReport = report;
    await this.persistValidationReport(report);

    missionPlan = this.requireMissionPlan();
    missionPlan = this.replaceMilestone(missionPlan, milestoneId, (current) => ({
      ...current,
      validationContract: mergeValidationResults(current.validationContract, report),
    }));

    this.emitEvent('validation_result', 'orchestrator', {
      milestoneId,
      passed,
      attempt,
      results,
    });

    if (passed) {
      this.activityLabel = `Validation passed for ${milestoneId}.`;
      missionPlan = updateMilestoneStatus(missionPlan, milestoneId, 'done');
      missionPlan = setActiveFeature(missionPlan, null);
      missionPlan = setActiveMilestone(missionPlan, null);

      if (areAllMilestonesDone(missionPlan)) {
        missionPlan = transitionMissionState(missionPlan, 'completed');
        this.emitEvent('mission_completed', 'orchestrator', {
          totalIterations: missionPlan.totalIterations,
        });
      }

      this.state.missionPlan = missionPlan;
      this.kernelState.missionPlan = missionPlan;
      await this.persistMissionPlan();
      await this.emitStatusUpdate();
      return;
    }

    const updatedMilestone = missionPlan.milestones.find((item) => item.id === milestoneId);
    if (!updatedMilestone) {
      throw new Error(`Milestone not found after validation merge: ${milestoneId}`);
    }

    if (hasValidationLoop(updatedMilestone.validationContract, 3)) {
      this.activityLabel = `Validation loop detected on ${milestoneId}. Awaiting decision.`;
      const choice = await this.resolveValidationEscalation(updatedMilestone);
      missionPlan = this.requireMissionPlan();
      if (choice === 'abort') {
        missionPlan = transitionMissionState(missionPlan, 'aborted');
      } else if (choice === 'skip') {
        missionPlan = updateMilestoneStatus(missionPlan, milestoneId, 'skipped');
      } else if (choice === 'retry') {
        missionPlan = this.replaceMilestone(missionPlan, milestoneId, (current) => ({
          ...current,
          validationContract: {
            ...current.validationContract,
            staticChecks: current.validationContract.staticChecks.map((check) => ({ ...check, failureCount: 0 })),
            testSuites: current.validationContract.testSuites.map((check) => ({ ...check, failureCount: 0 })),
            qaChecks: current.validationContract.qaChecks?.map((check) => ({ ...check, failureCount: 0 })),
          },
        }));
        missionPlan = updateMilestoneStatus(missionPlan, milestoneId, 'in_progress');
      } else {
        missionPlan = transitionMissionState(missionPlan, 'paused');
      }

      this.state.missionPlan = missionPlan;
      this.kernelState.missionPlan = missionPlan;
      await this.persistMissionPlan();
      await this.emitStatusUpdate();
      return;
    }

    const followUps = await this.manager.generateFollowUpFeatures({
      milestoneId,
      failures: results.filter((result) => !result.passed),
      missionPlan,
      onAppServerEvent: (method, params) => {
        const detail = formatAgentEventDetail(method, params);
        if (!detail) {
          return;
        }
        this.emitEvent('manager_decision', 'manager', {
          action: 'followup_planning',
          milestoneId,
          message: detail,
        });
      },
    });

    const followUpResult = this.applyValidationFollowUps(missionPlan, milestoneId, followUps);
    missionPlan = followUpResult.plan;
    missionPlan = updateMilestoneStatus(missionPlan, milestoneId, 'in_progress');
    this.state.missionPlan = missionPlan;
    this.kernelState.missionPlan = missionPlan;
    this.activityLabel = `Validation failed for ${milestoneId}. Generated follow-up features.`;

    if (followUpResult.addedFeatures.length > 0) {
      this.emitEvent('task_added', 'manager', {
        milestoneId,
        features: followUpResult.addedFeatures,
        followUpFeatures: followUpResult.addedFeatures,
      });
    }

    await this.persistMissionPlan();
    await this.emitStatusUpdate();
  }

  private evaluateEvidenceValidationCheck(
    milestoneId: string,
    check: ValidationCheck,
    evidence: ValidationCheckResult | undefined
  ): ValidationCheckResult {
    if (evidence) {
      return {
        ...evidence,
        checkId: check.id,
        output: evidence.output ?? `worker-reported ${check.type} validation ${evidence.passed ? 'passed' : 'failed'}`,
      };
    }

    const warning = `${check.type} verification was not reported by the worker: ${check.description}`;
    const evidenceRequired = check.type === 'manual'
      ? this.verificationConfig.requireManualEvidence
      : this.verificationConfig.requireE2EEvidence;
    if (!evidenceRequired) {
      return {
        checkId: check.id,
        passed: true,
        output: `${check.type} validation evidence missing`,
        warning,
      };
    }

    return {
      checkId: check.id,
      passed: false,
      output: `${check.type} validation evidence missing`,
      warning,
      failure: {
        summary: `${check.type} validation was not reported by the worker`,
        affectedFiles: [],
        errorMessages: [
          `milestone=${milestoneId}`,
          check.description,
        ],
        rootCause: `${check.type}-evidence-missing`,
      },
    };
  }

  private async executeFeature(
    milestone: Milestone,
    feature: Feature,
    briefing?: string
  ): Promise<WorkerResult> {
    const selectedWorkerModel = normalizeModelName(this.modelRouter.getModel('worker')) ?? CODEX_LATEST_ALIAS;
    let missionPlan = this.requireMissionPlan();
    let runtimeFeature = missionPlan.milestones
      .find((item) => item.id === milestone.id)
      ?.features.find((item) => item.id === feature.id) ?? feature;

    let modelState = resolveFeatureModelState(runtimeFeature, selectedWorkerModel);
    if (!runtimeFeature.model) {
      missionPlan = updateFeatureModel(
        missionPlan,
        milestone.id,
        feature.id,
        modelState.model
      );
      this.state.missionPlan = missionPlan;
      this.kernelState.missionPlan = missionPlan;
      await this.persistMissionPlan();
      await this.emitStatusUpdate();

      runtimeFeature = missionPlan.milestones
        .find((item) => item.id === milestone.id)
        ?.features.find((item) => item.id === feature.id) ?? runtimeFeature;
      modelState = resolveFeatureModelState(runtimeFeature, selectedWorkerModel);
      this.emitEvent('manager_decision', 'orchestrator', {
        action: 'feature_model_selected',
        milestoneId: milestone.id,
        featureId: feature.id,
        model: resolveDisplayModel(modelState.model),
        source: 'default',
      });
    }

    const resolvedExecutionModel = resolveModel(modelState.model, selectedWorkerModel);
    const executionFeature: Feature = {
      ...runtimeFeature,
      model: modelState.model,
    };
    this.worker.setRuntimeModel(modelState.model);

    let branchName: string | null = null;
    let currentBranch: string | null = null;
    let baseBranch: string | undefined;
    let mergeTargetBranch: string | undefined;

    if (this.state.gitStrategy) {
      baseBranch = this.state.gitStrategy.config.baseBranch;
      if (this.state.gitStrategy.config.pullRequestEnabled) {
        const missionBranch = await this.ensureMissionBranch();
        currentBranch = missionBranch;
        if (this.requiresDedicatedFeatureBranch(feature)) {
          branchName = createFeatureBranchName(
            this.state.gitStrategy.config.missionId,
            feature.id,
            feature.description
          );
          mergeTargetBranch = missionBranch;
          const baseCommitHash = getHeadCommitHash(this.config.cwd);
          createBranch(this.config.cwd, branchName, missionBranch);
          this.setGitStrategyState(registerFeatureBranch(this.state.gitStrategy, {
            name: branchName,
            taskId: feature.id,
            baseCommitHash,
          }));
          currentBranch = branchName;
          await saveGitStrategyState(this.config.melosDir, this.state.gitStrategy);
          this.emitEvent('branch_created', 'system', {
            branchName,
            baseBranch: missionBranch,
            baseCommitHash,
            branchType: 'feature',
          });
        }
      } else {
        if (this.requiresDedicatedFeatureBranch(feature)) {
          branchName = createFeatureBranchName(
            this.state.gitStrategy.config.missionId,
            feature.id,
            feature.description
          );
          mergeTargetBranch = baseBranch;
          const baseCommitHash = getHeadCommitHash(this.config.cwd);
          createBranch(this.config.cwd, branchName, baseBranch);
          this.setGitStrategyState(registerFeatureBranch(this.state.gitStrategy, {
            name: branchName,
            taskId: feature.id,
            baseCommitHash,
          }));
          currentBranch = branchName;
          await saveGitStrategyState(this.config.melosDir, this.state.gitStrategy);
          this.emitEvent('branch_created', 'system', {
            branchName,
            baseBranch,
            baseCommitHash,
            branchType: 'feature',
          });
        }
      }
    }

    const runId = ++this.workerRunCounter;
    const workerStartedAt = new Date();
    const workerRunType = feature.kind === 'review'
      ? 'review'
      : feature.kind === 'qa'
        ? 'qa'
        : 'implement';
    if (feature.kind === 'review') {
      this.emitEvent('review_started', 'orchestrator', {
        milestoneId: milestone.id,
        featureId: feature.id,
        reviewType: feature.reviewType,
        generation: feature.reviewGeneration ?? 1,
      });
    }
    this.emitEvent('worker_started', 'worker', {
      runId,
      type: workerRunType,
      milestoneId: milestone.id,
      featureId: feature.id,
      branch: currentBranch ?? branchName,
      engine: resolvedExecutionModel.engine,
      model: resolvedExecutionModel.displayModel,
      modelSource: modelState.source,
    });

    if (this.config.dryRun) {
      const report: WorkerFeatureReport = {
        iteration: this.requireMissionPlan().totalIterations + 1,
        milestoneId: milestone.id,
        featureId: feature.id,
        status: 'SUCCESS',
        summary: '[dry-run] execution skipped',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: false,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: false,
          typecheckPassed: false,
        },
        checks: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      };
      if (feature.kind === 'review' && feature.reviewType) {
        report.review = {
          reviewType: feature.reviewType,
          generation: feature.reviewGeneration ?? 1,
          passed: true,
          summary: '[dry-run] final review skipped',
          findings: [],
          artifacts: [],
        };
      }
      const result: WorkerResult = { type: 'success', report };
      this.emitEvent('worker_finished', 'worker', {
        runId,
        durationMs: Date.now() - workerStartedAt.getTime(),
        status: report.status,
        summary: report.summary,
      });
      return result;
    }

    const workerInput: WorkerInput = {
      iteration: this.requireMissionPlan().totalIterations + 1,
      missionPlan: this.requireMissionPlan(),
      milestone,
      feature: executionFeature,
      prd: this.state.prd,
      briefing,
      currentBranch,
      baseBranch,
      onAppServerEvent: (method, params) => {
        const detail = formatAgentEventDetail(method, params);
        if (!detail) {
          return;
        }
        this.emitEvent('worker_checkpoint', 'worker', {
          runId,
          message: detail,
        });
      },
    };

    const workerReplyStream = createBufferedProgressEmitter((line) => {
      this.emitEvent('worker_checkpoint', 'worker', {
        runId,
        message: `[REPLY] ${line}`,
      });
    });

    workerInput.onAgentMessageDelta = (chunk) => {
      workerReplyStream.push(chunk);
    };

    let result: WorkerResult;
    try {
      result = await this.worker.run(workerInput);
      this.watchdog.touch();
    } finally {
      workerReplyStream.flush();
    }

    if (resolvedExecutionModel.engine === 'codex') {
      const activeThreadId = this.worker.getActiveThreadId();
      if (activeThreadId) {
        const missionId = this.requireMissionPlan().mission.id ?? this.resolveMissionId();
        this.worker.setResumeSession(activeThreadId, missionId);
      }
    }

    if (branchName && this.state.gitStrategy) {
      const postProcess = await this.runGitPostProcess(
        branchName,
        mergeTargetBranch ?? baseBranch ?? this.state.gitStrategy.config.baseBranch,
        result.report
      );
      result.report.summary = postProcess.summary;
      if (!postProcess.ok && (result.type === 'success' || result.type === 'partial')) {
        result = {
          type: 'failed',
          report: {
            ...result.report,
            status: 'FAILED',
            summary: postProcess.summary,
            requestsHelp: true,
          },
        };
      }
    }

    this.emitEvent(
      result.type === 'success' ? 'worker_finished' : 'worker_error',
      'worker',
      {
        runId,
        durationMs: Date.now() - workerStartedAt.getTime(),
        status: result.report.status,
        summary: result.report.summary,
      }
    );

    return result;
  }

  private requiresDedicatedFeatureBranch(feature: Feature): boolean {
    return feature.kind === 'implementation' || feature.kind === 'review_remediation';
  }

  private async ensureMissionBranch(): Promise<string> {
    if (!this.state.gitStrategy) {
      throw new Error('git strategy is not enabled');
    }

    const existingMissionBranch = this.state.gitStrategy.missionBranch
      ?? createMissionBranchName(this.state.gitStrategy.config.missionId);

    try {
      checkoutBranch(this.config.cwd, existingMissionBranch);
    } catch {
      createBranch(this.config.cwd, existingMissionBranch, this.state.gitStrategy.config.baseBranch);
      this.emitEvent('branch_created', 'system', {
        branchName: existingMissionBranch,
        baseBranch: this.state.gitStrategy.config.baseBranch,
        baseCommitHash: getHeadCommitHash(this.config.cwd),
        branchType: 'mission',
      });
    }

    this.setGitStrategyState(setMissionBranch(this.state.gitStrategy, existingMissionBranch));
    await saveGitStrategyState(this.config.melosDir, this.state.gitStrategy);
    return existingMissionBranch;
  }

  private shouldApplyWorkerWarningPolicy(feature: Feature): boolean {
    return feature.kind === 'implementation' || feature.kind === 'review_remediation';
  }

  private async syncPullRequestStateFromReport(
    feature: Feature,
    report: WorkerFeatureReport
  ): Promise<void> {
    if (!this.state.gitStrategy) {
      return;
    }

    let next = this.state.gitStrategy;
    let changed = false;

    if (report.pullRequest) {
      next = updatePullRequestState(next, report.pullRequest);
      changed = true;
      this.emitEvent('manager_decision', 'orchestrator', {
        action: report.pullRequest.action === 'created' ? 'pull_request_created' : 'pull_request_updated',
        featureId: feature.id,
        url: report.pullRequest.url,
        number: report.pullRequest.number,
        headBranch: report.pullRequest.headBranch,
        baseBranch: report.pullRequest.baseBranch,
        message: `${report.pullRequest.action} PR ${report.pullRequest.url}`,
      });
    }

    if (report.pullRequestFollowUp) {
      next = updatePullRequestFollowUpState(next, report.pullRequestFollowUp);
      changed = true;
      this.emitEvent('manager_decision', 'orchestrator', {
        action: 'pull_request_follow_up_progress',
        featureId: feature.id,
        quietUntil: report.pullRequestFollowUp.quietUntil,
        lastExternalActivityAt: report.pullRequestFollowUp.lastExternalActivityAt,
        handledFeedbackCount: report.pullRequestFollowUp.handledFeedbackIds.length,
        message: report.pullRequestFollowUp.quietUntil
          ? `PR follow-up waiting for quiet window until ${report.pullRequestFollowUp.quietUntil}`
          : 'PR follow-up progress updated',
      });
    }

    if (!changed) {
      return;
    }

    this.setGitStrategyState(next);
    await saveGitStrategyState(this.config.melosDir, next);
  }

  private async handleOperationalFeatureResult(
    milestone: Milestone,
    feature: Feature,
    result: WorkerResult
  ): Promise<void> {
    let missionPlan = this.requireMissionPlan();
    missionPlan = incrementMissionIterations(missionPlan);

    if (result.type === 'blocked' || result.report.status === 'BLOCKED') {
      missionPlan = this.clearFeatureRetry(missionPlan, milestone.id, feature.id);
      missionPlan = updateFeatureStatus(missionPlan, milestone.id, feature.id, 'pending');
      missionPlan = updateMilestoneStatus(missionPlan, milestone.id, 'in_progress');
      missionPlan = setActiveMilestone(missionPlan, milestone.id);
      missionPlan = setActiveFeature(missionPlan, feature.id);
      missionPlan = transitionMissionState(missionPlan, 'paused');
      this.state.missionPlan = missionPlan;
      this.kernelState.missionPlan = missionPlan;
      this.emitEvent('iteration_completed', 'orchestrator', {
        iteration: missionPlan.totalIterations,
        milestoneId: milestone.id,
        featureId: feature.id,
        status: 'blocked',
      });
      this.activityLabel = `${feature.id} blocked. Resolve the PR automation issue and resume.`;
      await this.persistMissionPlan();
      await this.emitStatusUpdate();
      return;
    }

    if (result.type === 'success') {
      missionPlan = this.clearFeatureRetry(missionPlan, milestone.id, feature.id);
      missionPlan = updateFeatureStatus(missionPlan, milestone.id, feature.id, 'done');
      this.state.missionPlan = missionPlan;
      this.kernelState.missionPlan = missionPlan;
      this.emitEvent('iteration_completed', 'orchestrator', {
        iteration: missionPlan.totalIterations,
        milestoneId: milestone.id,
        featureId: feature.id,
        status: 'done',
      });
      this.activityLabel = `Completed ${feature.id}.`;
      await this.persistMissionPlan();
      await this.emitStatusUpdate();
      return;
    }

    const runtimeFeature = missionPlan.milestones
      .find((item) => item.id === milestone.id)
      ?.features.find((item) => item.id === feature.id);
    const attempts = runtimeFeature?.attempts ?? feature.attempts;

    if (attempts < this.executionConfig.maxFeatureAttempts) {
      missionPlan = updateFeatureStatus(missionPlan, milestone.id, feature.id, 'pending');
      const retry = this.scheduleFeatureRetry(missionPlan, milestone.id, feature.id, attempts + 1, result.report);
      this.state.missionPlan = missionPlan;
      this.kernelState.missionPlan = missionPlan;
      this.emitEvent('manager_decision', 'orchestrator', {
        action: 'feature_retry_scheduled',
        milestoneId: milestone.id,
        featureId: feature.id,
        attempt: attempts,
        nextAttempt: retry.nextAttempt,
        dueAt: retry.dueAt,
        message: `Retry ${feature.id} as attempt ${retry.nextAttempt} at ${retry.dueAt}`,
      });
      this.emitEvent('iteration_completed', 'orchestrator', {
        iteration: missionPlan.totalIterations,
        milestoneId: milestone.id,
        featureId: feature.id,
        status: 'retry_pending',
      });
      this.activityLabel = `Retrying ${feature.id} at ${retry.dueAt}.`;
      await this.persistMissionPlan();
      await this.emitStatusUpdate();
      return;
    }

    missionPlan = this.clearFeatureRetry(missionPlan, milestone.id, feature.id);
    missionPlan = updateFeatureStatus(missionPlan, milestone.id, feature.id, 'failed');
    missionPlan = updateMilestoneStatus(missionPlan, milestone.id, 'failed');
    missionPlan = transitionMissionState(missionPlan, 'failed');
    this.state.missionPlan = missionPlan;
    this.kernelState.missionPlan = missionPlan;
    this.emitEvent('iteration_completed', 'orchestrator', {
      iteration: missionPlan.totalIterations,
      milestoneId: milestone.id,
      featureId: feature.id,
      status: 'failed',
    });
    this.emitEvent('mission_failed', 'orchestrator', {
      reason: `${feature.kind} feature failed`,
      milestoneId: milestone.id,
      featureId: feature.id,
      summary: result.report.summary,
    });
    this.activityLabel = `${feature.id} failed.`;
    await this.persistMissionPlan();
    await this.emitStatusUpdate();
  }

  private async handleQaFeatureResult(
    milestone: Milestone,
    feature: Feature,
    result: WorkerResult
  ): Promise<void> {
    let missionPlan = this.requireMissionPlan();
    missionPlan = incrementMissionIterations(missionPlan);

    if (result.type === 'blocked' || result.report.status === 'BLOCKED') {
      missionPlan = this.clearFeatureRetry(missionPlan, milestone.id, feature.id);
      missionPlan = updateFeatureStatus(missionPlan, milestone.id, feature.id, 'pending');
      missionPlan = updateMilestoneStatus(missionPlan, milestone.id, 'in_progress');
      missionPlan = setActiveMilestone(missionPlan, milestone.id);
      missionPlan = setActiveFeature(missionPlan, feature.id);
      missionPlan = transitionMissionState(missionPlan, 'paused');
      this.state.missionPlan = missionPlan;
      this.kernelState.missionPlan = missionPlan;
      this.emitEvent('iteration_completed', 'orchestrator', {
        iteration: missionPlan.totalIterations,
        milestoneId: milestone.id,
        featureId: feature.id,
        status: 'blocked',
      });
      this.activityLabel = `${feature.id} blocked. Resolve the QA environment issue and resume.`;
      await this.persistMissionPlan();
      await this.emitStatusUpdate();
      return;
    }

    missionPlan = this.clearFeatureRetry(missionPlan, milestone.id, feature.id);
    missionPlan = updateFeatureStatus(missionPlan, milestone.id, feature.id, 'done');
    this.state.missionPlan = missionPlan;
    this.kernelState.missionPlan = missionPlan;
    this.emitEvent('iteration_completed', 'orchestrator', {
      iteration: missionPlan.totalIterations,
      milestoneId: milestone.id,
      featureId: feature.id,
      status: 'done',
    });
    this.activityLabel = result.type === 'success'
      ? `Completed ${feature.id}.`
      : `QA execution finished for ${feature.id}; milestone validation will determine pass/fail.`;
    await this.persistMissionPlan();
    await this.emitStatusUpdate();
  }

  private applyWorkerWarningPolicy(
    milestoneId: string,
    featureId: string,
    result: WorkerResult
  ): WorkerResult {
    if (!this.verificationConfig.failOnWorkerWarnings || result.report.warnings.length === 0) {
      return result;
    }
    if (result.type === 'blocked') {
      return result;
    }

    const warningSummary = result.report.warnings.join('; ');
    this.emitEvent('manager_decision', 'orchestrator', {
      action: 'worker_warning_blocked',
      milestoneId,
      featureId,
      message: `Worker warnings are configured as blocking failures for ${featureId}: ${warningSummary}`,
    });

    return {
      type: 'failed',
      report: {
        ...result.report,
        status: 'FAILED',
        summary: [
          result.report.summary,
          'Worker warnings are configured as blocking failures.',
          warningSummary,
        ].filter((line) => line.trim().length > 0).join('\n'),
        requestsHelp: true,
      },
    };
  }

  private async handleImplementationFeatureResult(
    milestone: Milestone,
    feature: Feature,
    result: WorkerResult
  ): Promise<void> {
    let missionPlan = this.requireMissionPlan();
    missionPlan = incrementMissionIterations(missionPlan);

    if (result.type === 'blocked' || result.report.status === 'BLOCKED') {
      missionPlan = this.clearFeatureRetry(missionPlan, milestone.id, feature.id);
      missionPlan = updateFeatureStatus(missionPlan, milestone.id, feature.id, 'pending');
      missionPlan = updateMilestoneStatus(missionPlan, milestone.id, 'in_progress');
      missionPlan = setActiveMilestone(missionPlan, milestone.id);
      missionPlan = setActiveFeature(missionPlan, feature.id);
      missionPlan = transitionMissionState(missionPlan, 'paused');
      this.state.missionPlan = missionPlan;
      this.kernelState.missionPlan = missionPlan;
      this.emitEvent('iteration_completed', 'orchestrator', {
        iteration: missionPlan.totalIterations,
        milestoneId: milestone.id,
        featureId: feature.id,
        status: 'blocked',
      });
      this.activityLabel = `${feature.id} blocked. Resolve the worker issue and resume.`;
      await this.persistMissionPlan();
      await this.emitStatusUpdate();
      return;
    }

    if (result.type === 'success') {
      missionPlan = this.clearFeatureRetry(missionPlan, milestone.id, feature.id);
      missionPlan = updateFeatureStatus(missionPlan, milestone.id, feature.id, 'done');
      this.state.missionPlan = missionPlan;
      this.kernelState.missionPlan = missionPlan;
      this.emitEvent('iteration_completed', 'orchestrator', {
        iteration: missionPlan.totalIterations,
        milestoneId: milestone.id,
        featureId: feature.id,
        status: 'done',
      });
      this.activityLabel = `Completed ${feature.id}.`;
      await this.persistMissionPlan();
      await this.emitStatusUpdate();
      return;
    }

    const runtimeFeature = missionPlan.milestones
      .find((item) => item.id === milestone.id)
      ?.features.find((item) => item.id === feature.id);
    const attempts = runtimeFeature?.attempts ?? feature.attempts;

    if (attempts < this.executionConfig.maxFeatureAttempts) {
      missionPlan = updateFeatureStatus(missionPlan, milestone.id, feature.id, 'pending');
      const retry = this.scheduleFeatureRetry(missionPlan, milestone.id, feature.id, attempts + 1, result.report);
      this.state.missionPlan = missionPlan;
      this.kernelState.missionPlan = missionPlan;
      this.emitEvent('manager_decision', 'orchestrator', {
        action: 'feature_retry_scheduled',
        milestoneId: milestone.id,
        featureId: feature.id,
        attempt: attempts,
        nextAttempt: retry.nextAttempt,
        dueAt: retry.dueAt,
        message: `Retry ${feature.id} as attempt ${retry.nextAttempt} at ${retry.dueAt}`,
      });
      this.emitEvent('iteration_completed', 'orchestrator', {
        iteration: missionPlan.totalIterations,
        milestoneId: milestone.id,
        featureId: feature.id,
        status: 'retry_pending',
      });
      this.activityLabel = `Retrying ${feature.id} at ${retry.dueAt}.`;
      await this.persistMissionPlan();
      await this.emitStatusUpdate();
      return;
    }

    missionPlan = this.clearFeatureRetry(missionPlan, milestone.id, feature.id);
    missionPlan = updateFeatureStatus(missionPlan, milestone.id, feature.id, 'failed');
    const failures = this.createImplementationFailureResults(feature, result.report);
    const followUps = await this.manager.generateImplementationFollowUpFeatures({
      milestoneId: milestone.id,
      featureId: feature.id,
      failures,
      missionPlan,
      onAppServerEvent: (method, params) => {
        const detail = formatAgentEventDetail(method, params);
        if (!detail) {
          return;
        }
        this.emitEvent('manager_decision', 'manager', {
          action: 'execution_followup_planning',
          milestoneId: milestone.id,
          featureId: feature.id,
          message: detail,
        });
      },
    });
    const followUpResult = this.applyValidationFollowUps(
      missionPlan,
      milestone.id,
      followUps.length > 0
        ? followUps
        : [{
          description: `Resolve exhausted execution failure for ${feature.description}`,
          trackingKey: `feature-failure-${feature.id}`,
          model: CODEX_LATEST_ALIAS,
        }]
    );
    missionPlan = updateMilestoneStatus(followUpResult.plan, milestone.id, 'in_progress');
    missionPlan = setActiveMilestone(missionPlan, milestone.id);
    missionPlan = setActiveFeature(missionPlan, null);
    this.state.missionPlan = missionPlan;
    this.kernelState.missionPlan = missionPlan;

    if (followUpResult.addedFeatures.length > 0 || followUpResult.updatedFeatures.length > 0) {
      this.emitEvent('task_added', 'manager', {
        milestoneId: milestone.id,
        featureId: feature.id,
        features: [
          ...followUpResult.updatedFeatures,
          ...followUpResult.addedFeatures,
        ],
        followUpFeatures: followUpResult.addedFeatures,
      });
    }

    this.emitEvent('manager_decision', 'orchestrator', {
      action: 'feature_retry_exhausted',
      milestoneId: milestone.id,
      featureId: feature.id,
      attempts,
      message: `Retry budget exhausted for ${feature.id} after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
    });
    this.emitEvent('iteration_completed', 'orchestrator', {
      iteration: missionPlan.totalIterations,
      milestoneId: milestone.id,
      featureId: feature.id,
      status: 'failed',
    });
    this.activityLabel = `Retry budget exhausted for ${feature.id}. Generated remediation features.`;
    await this.persistMissionPlan();
    await this.emitStatusUpdate();
  }

  private createImplementationFailureResults(
    feature: Feature,
    report: WorkerFeatureReport
  ): ValidationCheckResult[] {
    const errorMessages = truncateLines(
      [
        report.summary,
        ...report.warnings,
      ]
        .flatMap((line) => line.split(/\r?\n/))
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      8
    );

    return [{
      checkId: feature.id,
      passed: false,
      output: report.summary,
      failure: {
        summary: `feature execution failed: ${feature.description}`,
        affectedFiles: report.filesChanged.map((file) => file.path),
        errorMessages,
        rootCause: errorMessages[0] ?? report.status,
      },
    }];
  }

  private scheduleFeatureRetry(
    missionPlan: MissionPlan,
    milestoneId: string,
    featureId: string,
    nextAttempt: number,
    report: WorkerFeatureReport
  ): FeatureRetryRecord {
    const delayMs = this.computeFeatureRetryDelay(nextAttempt - 1);
    const retry: FeatureRetryRecord = {
      milestoneId,
      featureId,
      nextAttempt,
      dueAt: new Date(Date.now() + delayMs).toISOString(),
      lastStatus: report.status === 'PARTIAL' || report.status === 'BLOCKED' ? report.status : 'FAILED',
      reason: this.extractFeatureRetryReason(report),
      summary: report.summary,
    };

    const existing = this.kernelState.featureRetries ?? [];
    this.kernelState.featureRetries = [
      ...existing.filter((item) => !(item.milestoneId === milestoneId && item.featureId === featureId)),
      retry,
    ];

    this.kernelState.missionPlan = missionPlan;
    return retry;
  }

  private extractFeatureRetryReason(report: WorkerFeatureReport): string {
    const candidates = [
      report.warnings[0],
      report.summary.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0),
      report.status,
    ];
    return candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0) ?? 'worker failure';
  }

  private computeFeatureRetryDelay(failedAttempt: number): number {
    const exponent = Math.max(0, failedAttempt - 1);
    const delayMs = this.executionConfig.retryInitialDelayMs * (2 ** exponent);
    return Math.min(delayMs, this.executionConfig.retryMaxDelayMs);
  }

  private releaseReadyFeatureRetries(missionPlan: MissionPlan): MissionPlan {
    const queue = this.kernelState.featureRetries ?? [];
    if (queue.length === 0) {
      return missionPlan;
    }

    const now = Date.now();
    const remaining: FeatureRetryRecord[] = [];
    const released: FeatureRetryRecord[] = [];
    for (const item of queue) {
      const dueAtMs = Date.parse(item.dueAt);
      if (Number.isFinite(dueAtMs) && dueAtMs > now) {
        remaining.push(item);
        continue;
      }
      released.push(item);
    }

    if (released.length === 0) {
      return missionPlan;
    }

    this.kernelState.featureRetries = remaining;
    for (const retry of released) {
      this.emitEvent('manager_decision', 'orchestrator', {
        action: 'feature_retry_released',
        milestoneId: retry.milestoneId,
        featureId: retry.featureId,
        nextAttempt: retry.nextAttempt,
        message: `Retry ${retry.featureId} is ready to run (attempt ${retry.nextAttempt})`,
      });
    }

    return missionPlan;
  }

  private clearFeatureRetry(
    missionPlan: MissionPlan,
    milestoneId: string,
    featureId: string
  ): MissionPlan {
    const queue = this.kernelState.featureRetries ?? [];
    if (queue.length === 0) {
      return missionPlan;
    }

    this.kernelState.featureRetries = queue.filter((item) => !(item.milestoneId === milestoneId && item.featureId === featureId));
    this.kernelState.missionPlan = missionPlan;
    return missionPlan;
  }

  private findFeatureRetry(
    milestoneId: string,
    featureId: string
  ): FeatureRetryRecord | null {
    const queue = this.kernelState.featureRetries ?? [];
    return queue.find((item) => item.milestoneId === milestoneId && item.featureId === featureId) ?? null;
  }

  private async waitForScheduledFeatureRetry(retry: FeatureRetryRecord): Promise<void> {
    const dueAtMs = Date.parse(retry.dueAt);
    if (!Number.isFinite(dueAtMs)) {
      this.kernelState.featureRetries = (this.kernelState.featureRetries ?? [])
        .filter((item) => !(item.milestoneId === retry.milestoneId && item.featureId === retry.featureId));
      await this.persistRuntimeState();
      return;
    }

    this.activityLabel = `Waiting to retry ${retry.featureId} (attempt ${retry.nextAttempt})...`;
    await this.emitStatusUpdate();

    while (!this.aborted) {
      const remainingMs = dueAtMs - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await delay(Math.min(remainingMs, 500));
    }

    if (this.aborted) {
      return;
    }

    this.state.missionPlan = this.releaseReadyFeatureRetries(this.requireMissionPlan());
    this.kernelState.missionPlan = this.state.missionPlan;
    await this.persistMissionPlan();
    await this.emitStatusUpdate();
  }

  private async runGitPostProcess(
    branchName: string,
    targetBranch: string,
    report: WorkerFeatureReport
  ): Promise<{ ok: boolean; summary: string }> {
    try {
      if (!isWorkingTreeClean(this.config.cwd)) {
        const message = [
          report.summary,
          `Commit required before merge into ${targetBranch} from ${branchName}.`,
          'Please commit the feature changes using the git-committer skill and retry.',
        ].join('\n');
        this.emitEvent('error', 'system', {
          branchName,
          featureId: report.featureId,
          message: 'git strategy requires committed changes before merge',
        });
        if (this.state.gitStrategy) {
          this.setGitStrategyState(updateFeatureBranchStatus(this.state.gitStrategy, branchName, 'abandoned'));
          await saveGitStrategyState(this.config.melosDir, this.state.gitStrategy);
        }
        checkoutBranch(this.config.cwd, targetBranch);
        return {
          ok: false,
          summary: message,
        };
      }

      if (this.state.gitStrategy?.config.preMergeValidation) {
        for (const command of this.state.gitStrategy.config.validationCommands) {
          const result = runGitCommand(this.config.cwd, command);
          this.emitEvent('command_executed', 'system', {
            command,
            exitCode: result.exitCode,
          });
          if (result.exitCode !== 0) {
            if (this.state.gitStrategy) {
              this.setGitStrategyState(updateFeatureBranchStatus(this.state.gitStrategy, branchName, 'abandoned'));
              await saveGitStrategyState(this.config.melosDir, this.state.gitStrategy);
            }
            checkoutBranch(this.config.cwd, targetBranch);
            return {
              ok: false,
              summary: `${report.summary}\nPre-merge validation failed: ${command}`,
            };
          }
        }
      }

      if (hasConflicts(this.config.cwd, branchName, targetBranch)) {
        const missionPlan = this.requireMissionPlan();
        const activeMilestoneId = missionPlan.activeMilestoneId;
        if (activeMilestoneId) {
          const milestone = missionPlan.milestones.find((item) => item.id === activeMilestoneId);
          const nextId = `${activeMilestoneId}-f${(milestone?.features.length ?? 0) + 1}`;
          this.state.missionPlan = appendFeaturesToMilestone(missionPlan, activeMilestoneId, [{
            id: nextId,
            description: `Resolve merge conflict for ${branchName}`,
            kind: 'implementation',
            status: 'pending',
            attempts: 0,
            model: CODEX_LATEST_ALIAS,
          }]);
        }
        if (this.state.gitStrategy) {
          this.setGitStrategyState(updateFeatureBranchStatus(this.state.gitStrategy, branchName, 'abandoned'));
          await saveGitStrategyState(this.config.melosDir, this.state.gitStrategy);
        }
        checkoutBranch(this.config.cwd, targetBranch);
        return {
          ok: false,
          summary: `${report.summary}\nMerge conflict detected for ${branchName}`,
        };
      }

      mergeBranch(this.config.cwd, branchName, targetBranch);
      this.emitEvent('branch_merged', 'system', {
        branchName,
        baseBranch: targetBranch,
        mergeTargetBranch: targetBranch,
      });
      if (this.state.gitStrategy) {
        this.setGitStrategyState(updateFeatureBranchStatus(this.state.gitStrategy, branchName, 'merged', {
          mergedAt: new Date().toISOString(),
        }));
        await saveGitStrategyState(this.config.melosDir, this.state.gitStrategy);
      }
      checkoutBranch(this.config.cwd, targetBranch);

      return {
        ok: true,
        summary: report.summary,
      };
    } catch (error) {
      try {
        checkoutBranch(this.config.cwd, targetBranch);
      } catch {
        // ignore cleanup failure
      }
      this.emitEvent('error', 'system', {
        message: `git post process failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return {
        ok: false,
        summary: `${report.summary}\nGit post process failed`,
      };
    }
  }

  private async resolveValidationEscalation(
    milestone: Milestone
  ): Promise<'retry' | 'skip' | 'abort' | 'modify'> {
    if (!this.config.interactivePlanning || !process.stdin.isTTY) {
      return 'retry';
    }

    const promptMessage = this.isTuiInputMode()
      ? '検証ループ: r=再試行 / s=スキップ / a=中止 / m=手動修正'
      : 'Validation loop detected. Choose action [retry/skip/abort/modify]:';
    await this.setPendingPrompt(promptMessage);

    if (!this.isTuiInputMode()) {
      process.stderr.write(`\n${promptMessage} `);
    }
    const answer = this.isTuiInputMode()
      ? await readSingleKey(process.stdin, ['r', 's', 'a', 'm'])
      : await readLine(process.stdin);
    await this.setPendingPrompt(null);

    if (answer === '\u0003' || this.aborted) {
      return 'abort';
    }

    const normalized = answer.trim().toLowerCase();
    const mapped = this.isTuiInputMode() ? mapEscalationSingleKey(normalized) : normalized;
    if (mapped === 'skip' || mapped === 'abort' || mapped === 'modify') {
      this.emitEvent('escalation_answered', 'orchestrator', {
        milestoneId: milestone.id,
        answer: mapped,
      });
      return mapped;
    }
    if (mapped === 'retry') {
      this.emitEvent('escalation_answered', 'orchestrator', {
        milestoneId: milestone.id,
        answer: 'retry',
      });
      return 'retry';
    }

    this.emitEvent('escalation_answered', 'orchestrator', {
      milestoneId: milestone.id,
      answer: 'retry',
    });
    return 'retry';
  }

  private async waitForResume(): Promise<void> {
    if (!this.state.missionPlan || this.state.missionPlan.state !== 'paused') {
      return;
    }
    this.activityLabel = 'Mission paused. Waiting for resume command...';

    if (!this.pausePromise) {
      this.pausePromise = new Promise<void>((resolve) => {
        this.resumePause = resolve;
      });
    }

    await this.pausePromise;
  }

  private buildManagerInput(
    activeMilestone: Milestone | null,
    activeFeature: Feature | null
  ): ManagerInput {
    return {
      iteration: this.requireMissionPlan().totalIterations + 1,
      maxIterations: this.config.maxIterations,
      missionPlan: this.requireMissionPlan(),
      prd: this.state.prd,
      activeMilestone,
      activeFeature,
      latestValidationReport: this.state.latestValidationReport,
      latestWorkerReport: this.state.latestWorkerReport,
      pendingSteers: [],
    };
  }

  private requireMissionPlan(): MissionPlan {
    if (!this.state.missionPlan) {
      throw new Error('Mission plan is not initialized');
    }
    return this.state.missionPlan;
  }

  private findMilestoneByFeatureId(featureId: string): Milestone | null {
    const missionPlan = this.state.missionPlan;
    if (!missionPlan) {
      return null;
    }

    for (const milestone of missionPlan.milestones) {
      if (milestone.features.some((feature) => feature.id === featureId)) {
        return milestone;
      }
    }
    return null;
  }

  private replaceMilestone(
    missionPlan: MissionPlan,
    milestoneId: string,
    update: (milestone: Milestone) => Milestone
  ): MissionPlan {
    return {
      ...missionPlan,
      milestones: missionPlan.milestones.map((milestone) =>
        milestone.id === milestoneId ? update(milestone) : milestone
      ),
    };
  }

  private async handleReviewFeatureResult(
    milestone: Milestone,
    feature: Feature,
    result: WorkerResult
  ): Promise<void> {
    const reviewReport = this.createReviewReport(milestone.id, feature, result.report);
    this.state.latestReviewReport = reviewReport;
    this.kernelState.latestReviewReport = reviewReport;
    await this.persistReviewReport(reviewReport);

    const blockingFindings = reviewReport.findings.filter((finding) => isBlockingReviewFinding(finding));
    this.emitEvent('review_result', 'orchestrator', {
      milestoneId: milestone.id,
      featureId: feature.id,
      reviewType: reviewReport.reviewType,
      generation: reviewReport.generation,
      passed: reviewReport.passed,
      blockingFindingCount: blockingFindings.length,
      totalFindings: reviewReport.findings.length,
      summary: reviewReport.summary,
      report: reviewReport,
    });

    let missionPlan = this.requireMissionPlan();
    missionPlan = incrementMissionIterations(missionPlan);

    if (result.type === 'blocked' || result.report.status === 'BLOCKED') {
      missionPlan = updateFeatureStatus(missionPlan, milestone.id, feature.id, 'pending');
      missionPlan = updateMilestoneStatus(missionPlan, milestone.id, 'in_progress');
      missionPlan = setActiveMilestone(missionPlan, milestone.id);
      missionPlan = setActiveFeature(missionPlan, feature.id);
      missionPlan = transitionMissionState(missionPlan, 'paused');
      this.state.missionPlan = missionPlan;
      this.kernelState.missionPlan = missionPlan;
      this.emitEvent('iteration_completed', 'orchestrator', {
        iteration: missionPlan.totalIterations,
        milestoneId: milestone.id,
        featureId: feature.id,
        status: 'blocked',
      });
      this.activityLabel = `${formatReviewLabel(feature)} blocked. Resolve the review environment or contract issue and resume.`;
      await this.persistMissionPlan();
      await this.emitStatusUpdate();
      return;
    }

    if (blockingFindings.length === 0 && reviewReport.passed) {
      missionPlan = updateFeatureStatus(missionPlan, milestone.id, feature.id, 'done');
      this.state.missionPlan = missionPlan;
      this.kernelState.missionPlan = missionPlan;
      this.emitEvent('iteration_completed', 'orchestrator', {
        iteration: missionPlan.totalIterations,
        milestoneId: milestone.id,
        featureId: feature.id,
        status: 'done',
      });
      this.activityLabel = `${formatReviewLabel(feature)} passed.`;
      await this.persistMissionPlan();
      await this.emitStatusUpdate();
      return;
    }

    const followUps = await this.manager.generateReviewFollowUpFeatures({
      milestoneId: milestone.id,
      reviewType: reviewReport.reviewType,
      generation: reviewReport.generation,
      findings: blockingFindings,
      missionPlan,
      onAppServerEvent: (method, params) => {
        const detail = formatAgentEventDetail(method, params);
        if (!detail) {
          return;
        }
        this.emitEvent('manager_decision', 'manager', {
          action: 'review_followup_planning',
          milestoneId: milestone.id,
          featureId: feature.id,
          message: detail,
        });
      },
    });

    const followUpResult = this.applyReviewFollowUps(
      missionPlan,
      milestone.id,
      feature,
      reviewReport,
      followUps.length > 0
        ? followUps
        : [{
          description: `Address blocking ${reviewReport.reviewType} review findings`,
          trackingKey: `final-review-${reviewReport.reviewType}-g${reviewReport.generation}`,
          model: CODEX_LATEST_ALIAS,
        }]
    );

    missionPlan = updateMilestoneStatus(followUpResult.plan, milestone.id, 'in_progress');
    missionPlan = setActiveMilestone(missionPlan, milestone.id);
    missionPlan = setActiveFeature(missionPlan, null);
    this.state.missionPlan = missionPlan;
    this.kernelState.missionPlan = missionPlan;
    this.emitEvent('iteration_completed', 'orchestrator', {
      iteration: missionPlan.totalIterations,
      milestoneId: milestone.id,
      featureId: feature.id,
      status: 'done',
    });

    if (followUpResult.addedFeatures.length > 0 || followUpResult.updatedFeatures.length > 0) {
      this.emitEvent('task_added', 'manager', {
        milestoneId: milestone.id,
        featureId: feature.id,
        reviewType: reviewReport.reviewType,
        generation: reviewReport.generation,
        features: [
          ...followUpResult.updatedFeatures,
          ...followUpResult.addedFeatures,
          ...followUpResult.addedReviewFeatures,
        ],
        followUpFeatures: followUpResult.addedFeatures,
        rerunReviewFeatures: followUpResult.addedReviewFeatures,
      });
    }

    const addedRemediations = followUpResult.addedFeatures.length + followUpResult.updatedFeatures.length;
    this.activityLabel = [
      `${formatReviewLabel(feature)} failed with ${blockingFindings.length} blocking finding${blockingFindings.length === 1 ? '' : 's'}.`,
      `Added ${addedRemediations} remediation feature${addedRemediations === 1 ? '' : 's'} and scheduled ${followUpResult.addedReviewFeatures.length} review reruns.`,
    ].join(' ');
    await this.persistMissionPlan();
    await this.emitStatusUpdate();
  }

  private createReviewReport(
    milestoneId: string,
    feature: Feature,
    report: WorkerFeatureReport
  ): ReviewReport {
    const fallbackReviewType = feature.reviewType ?? 'code';
    const fallbackGeneration = feature.reviewGeneration ?? 1;
    const findings = report.review?.findings ?? [];
    const artifacts = report.review?.artifacts ?? [];
    return {
      milestoneId,
      featureId: feature.id,
      reviewType: report.review?.reviewType ?? fallbackReviewType,
      generation: report.review?.generation ?? fallbackGeneration,
      timestamp: new Date().toISOString(),
      passed: report.review?.passed ?? findings.every((finding) => !isBlockingReviewFinding(finding)),
      summary: report.review?.summary?.trim() || report.summary,
      findings,
      artifacts,
      blockingFindingCount: findings.filter((finding) => isBlockingReviewFinding(finding)).length,
    };
  }

  private applyReviewFollowUps(
    missionPlan: MissionPlan,
    milestoneId: string,
    feature: Feature,
    reviewReport: ReviewReport,
    followUps: Array<{
      description: string;
      trackingKey?: string;
      model?: string;
    }>
  ): {
    plan: MissionPlan;
    addedFeatures: Feature[];
    updatedFeatures: Feature[];
    addedReviewFeatures: Feature[];
  } {
    const milestone = missionPlan.milestones.find((item) => item.id === milestoneId);
    if (!milestone) {
      return {
        plan: missionPlan,
        addedFeatures: [],
        updatedFeatures: [],
        addedReviewFeatures: [],
      };
    }

    const currentGeneration = reviewReport.generation;
    const features = milestone.features.map((item) => {
      if (item.id === feature.id) {
        return { ...item, status: 'done' as const };
      }
      if (
        feature.reviewType === 'product'
        && item.kind === 'review'
        && item.reviewGeneration === currentGeneration
        && item.reviewType === 'code'
        && (item.status === 'pending' || item.status === 'in_progress')
      ) {
        return { ...item, status: 'skipped' as const };
      }
      return { ...item };
    });

    const updatedFeatures: Feature[] = [];
    const appendDrafts: Array<{ description: string; trackingKey?: string; model?: string }> = [];
    for (const draft of followUps) {
      const trackingKey = draft.trackingKey?.trim();
      const matchIndex = trackingKey
        ? features.findIndex((candidate) =>
          candidate.kind !== 'review'
          && candidate.trackingKey === trackingKey
          && (candidate.status === 'pending' || candidate.status === 'in_progress' || candidate.status === 'failed')
        )
        : -1;

      if (matchIndex >= 0) {
        const existing = features[matchIndex];
        const merged: Feature = {
          ...existing,
          kind: existing.kind === 'review' ? 'review_remediation' : existing.kind,
          description: this.pickMoreSpecificFeatureDescription(existing.description, draft.description),
          trackingKey: existing.trackingKey ?? trackingKey,
          model: existing.model ?? normalizeModelName(draft.model) ?? CODEX_LATEST_ALIAS,
          status: existing.status === 'failed' ? 'pending' : existing.status,
        };
        features[matchIndex] = merged;
        updatedFeatures.push(merged);
        continue;
      }

      appendDrafts.push({
        description: draft.description,
        trackingKey,
        model: normalizeModelName(draft.model) ?? CODEX_LATEST_ALIAS,
      });
    }

    let nextPlan = this.replaceMilestone(missionPlan, milestoneId, (current) => ({
      ...current,
      features,
    }));

    let addedFeatures: Feature[] = [];
    if (appendDrafts.length > 0) {
      const milestoneForAppend = nextPlan.milestones.find((item) => item.id === milestoneId);
      const baseCount = milestoneForAppend?.features.length ?? 0;
      addedFeatures = appendDrafts.map((draft, index) => ({
        id: `${milestoneId}-f${baseCount + index + 1}`,
        description: draft.description,
        trackingKey: draft.trackingKey,
        cwd: feature.cwd,
        kind: 'review_remediation',
        status: 'pending',
        attempts: 0,
        model: draft.model ?? CODEX_LATEST_ALIAS,
      }));
      nextPlan = appendFeaturesToMilestone(nextPlan, milestoneId, addedFeatures);
    }

    const nextGeneration = currentGeneration + 1;
    const milestoneForReviews = nextPlan.milestones.find((item) => item.id === milestoneId);
    const reviewBaseCount = milestoneForReviews?.features.length ?? 0;
    const addedReviewFeatures: Feature[] = [
      {
        id: `${milestoneId}-f${reviewBaseCount + 1}`,
        description: 'Re-run final product review after remediation',
        cwd: feature.cwd,
        kind: 'review',
        reviewType: 'product',
        reviewGeneration: nextGeneration,
        status: 'pending',
        attempts: 0,
        model: CODEX_LATEST_ALIAS,
      },
      {
        id: `${milestoneId}-f${reviewBaseCount + 2}`,
        description: 'Re-run final code review after remediation',
        kind: 'review',
        reviewType: 'code',
        reviewGeneration: nextGeneration,
        status: 'pending',
        attempts: 0,
        model: CODEX_LATEST_ALIAS,
      },
    ];
    nextPlan = appendFeaturesToMilestone(nextPlan, milestoneId, addedReviewFeatures);

    return {
      plan: nextPlan,
      addedFeatures,
      updatedFeatures,
      addedReviewFeatures,
    };
  }

  private applyValidationFollowUps(
    missionPlan: MissionPlan,
    milestoneId: string,
    followUps: Array<{
      description: string;
      trackingKey?: string;
      model?: string;
    }>
  ): {
    plan: MissionPlan;
    addedFeatures: Feature[];
    updatedFeatures: Feature[];
  } {
    const milestone = missionPlan.milestones.find((item) => item.id === milestoneId);
    if (!milestone || followUps.length === 0) {
      return {
        plan: missionPlan,
        addedFeatures: [],
        updatedFeatures: [],
      };
    }

    const updatedFeatures: Feature[] = [];
    const features = milestone.features.map((feature) => ({ ...feature }));
    const appendDrafts: Array<{ description: string; trackingKey?: string; model?: string }> = [];

    for (const draft of followUps) {
      const trackingKey = draft.trackingKey?.trim();
      const matchIndex = trackingKey
        ? features.findIndex((feature) =>
          feature.trackingKey === trackingKey
          && (feature.status === 'pending' || feature.status === 'in_progress' || feature.status === 'failed')
        )
        : -1;

      if (matchIndex >= 0) {
        const existing = features[matchIndex];
        const merged: Feature = {
          ...existing,
          description: this.pickMoreSpecificFeatureDescription(existing.description, draft.description),
          trackingKey: existing.trackingKey ?? trackingKey,
          model: existing.model ?? normalizeModelName(draft.model) ?? CODEX_LATEST_ALIAS,
          status: existing.status === 'failed' ? 'pending' : existing.status,
        };
        features[matchIndex] = merged;
        updatedFeatures.push(merged);
        continue;
      }

      appendDrafts.push({
        description: draft.description,
        trackingKey,
        model: normalizeModelName(draft.model) ?? CODEX_LATEST_ALIAS,
      });
    }

    let nextPlan = this.replaceMilestone(missionPlan, milestoneId, (current) => ({
      ...current,
      features,
    }));

    if (appendDrafts.length === 0) {
      return {
        plan: nextPlan,
        addedFeatures: [],
        updatedFeatures,
      };
    }

    const milestoneForAppend = nextPlan.milestones.find((item) => item.id === milestoneId);
    const baseCount = milestoneForAppend?.features.length ?? 0;
    const addedFeatures: Feature[] = appendDrafts.map((draft, index) => ({
      id: `${milestoneId}-f${baseCount + index + 1}`,
      description: draft.description,
      trackingKey: draft.trackingKey,
      kind: 'implementation',
      status: 'pending',
      attempts: 0,
      model: draft.model ?? CODEX_LATEST_ALIAS,
    }));

    nextPlan = appendFeaturesToMilestone(nextPlan, milestoneId, addedFeatures);
    return {
      plan: nextPlan,
      addedFeatures,
      updatedFeatures,
    };
  }

  private pickMoreSpecificFeatureDescription(left: string, right: string): string {
    const normalizedLeft = left.trim();
    const normalizedRight = right.trim();
    return normalizedRight.length > normalizedLeft.length ? normalizedRight : normalizedLeft;
  }

  private async promptPlanApproval(): Promise<boolean> {
    if (this.config.runtimeUIMode === 'headless') {
      const promptMessage = '承認待ち: `melos approve` で承認 / `melos reject` で差し戻し / `melos cancel` で中止';
      await this.setPendingPrompt(promptMessage);
      const decision = await this.waitForHeadlessApprovalDecision();
      await this.setPendingPrompt(null);
      return decision === 'approve';
    }

    if (!process.stdin.isTTY) {
      return true;
    }

    const promptMessage = this.isTuiInputMode()
      ? '承認待ち: y=承認 / Ctrl+C=中止'
      : 'Approve this mission plan? [y + Enter to approve, Ctrl+C to abort]:';
    await this.setPendingPrompt(promptMessage);
    if (!this.isTuiInputMode()) {
      process.stderr.write(`\n${promptMessage} `);
    }

    const rawAnswer = this.isTuiInputMode()
      ? await readSingleKey(process.stdin, ['y'])
      : await readLine(process.stdin);
    await this.setPendingPrompt(null);
    if (rawAnswer === '\u0003' || this.aborted) {
      return false;
    }
    const answer = rawAnswer.trim().toLowerCase();
    return answer === 'y' || answer === 'yes' || answer === 'approve';
  }

  private async waitForHeadlessApprovalDecision(): Promise<'approve' | 'reject' | 'abort'> {
    while (!this.aborted) {
      if (!missionFileExists(this.config.missionFile)) {
        await delay(400);
        continue;
      }

      try {
        const latest = await loadMissionPlan(this.config.missionFile);
        this.state.missionPlan = latest;
        this.kernelState.missionPlan = latest;
        await this.emitStatusUpdate();

        if (latest.state === 'running') {
          return 'approve';
        }
        if (latest.state === 'planning') {
          return 'reject';
        }
        if (latest.state === 'aborted' || latest.state === 'failed') {
          return 'abort';
        }
      } catch {
        // ignore transient parse/write races and continue polling
      }

      await delay(400);
    }

    return 'abort';
  }

  private ensureMelosDir(): void {
    mkdirSync(this.config.melosDir, { recursive: true });
    mkdirSync(join(this.config.melosDir, 'validations'), { recursive: true });
    mkdirSync(join(this.config.melosDir, 'reviews'), { recursive: true });
  }

  private emitEvent(
    type: Parameters<EventLog['emit']>[0]['type'],
    agent: Parameters<EventLog['emit']>[0]['agent'],
    payload: Record<string, unknown>
  ): void {
    const iteration = this.state.missionPlan?.totalIterations ?? this.state.iteration;
    const enrichedPayload = this.config.runIdentity
      ? { ...payload, runIdentity: this.config.runIdentity }
      : payload;
    const event = this.eventLog.emit({
      type,
      agent,
      iteration,
      payload: enrichedPayload,
    });
    this.kernelState = reduceMissionEvent(this.kernelState, event);
    this.kernelState.missionPlan = this.state.missionPlan;
    this.watchdog.touch();
    this.scheduleStatusRefresh();
  }

  private scheduleStatusRefresh(): void {
    if (!this.config.onStatusUpdate) {
      return;
    }
    if (this.statusRefreshTimer) {
      return;
    }
    this.statusRefreshTimer = setTimeout(() => {
      this.statusRefreshTimer = null;
      void this.emitStatusUpdate();
    }, 60);
    this.statusRefreshTimer.unref();
  }

  private recordValidationEvidence(milestoneId: string, checks: ValidationCheckResult[]): void {
    if (checks.length === 0) {
      return;
    }

    const nextMilestoneEvidence = {
      ...(this.kernelState.validationEvidence?.[milestoneId] ?? {}),
    };
    for (const check of checks) {
      nextMilestoneEvidence[check.checkId] = {
        ...check,
        failure: check.failure
          ? {
            ...check.failure,
            affectedFiles: [...check.failure.affectedFiles],
            errorMessages: [...check.failure.errorMessages],
          }
          : undefined,
      };
    }

    this.kernelState.validationEvidence = {
      ...(this.kernelState.validationEvidence ?? {}),
      [milestoneId]: nextMilestoneEvidence,
    };
  }

  private emitWorkerWarnings(milestoneId: string, featureId: string, warnings: string[]): void {
    for (const warning of warnings) {
      this.emitRuntimeWarning({
        source: 'worker',
        milestoneId,
        featureId,
        message: warning,
      });
    }
  }

  private emitValidationWarning(input: {
    milestoneId: string;
    checkId: string;
    message: string;
  }): void {
    this.emitRuntimeWarning({
      source: 'validation',
      milestoneId: input.milestoneId,
      checkId: input.checkId,
      message: input.message,
    });
  }

  private emitRuntimeWarning(input: {
    source: RuntimeWarningSource;
    message: string;
    milestoneId?: string;
    featureId?: string;
    checkId?: string;
  }): void {
    const message = input.message.trim();
    if (message.length === 0) {
      return;
    }

    this.emitEvent(
      'warning_emitted',
      input.source === 'worker' ? 'worker' : 'orchestrator',
      {
        source: input.source,
        message,
        milestoneId: input.milestoneId,
        featureId: input.featureId,
        checkId: input.checkId,
      }
    );
  }

  private async emitStatusUpdate(): Promise<void> {
    if (!this.config.onStatusUpdate) {
      return;
    }

    const missionState = this.buildMissionControlState(this.state.missionPlan);
    await this.config.onStatusUpdate(missionState);
  }

  private buildMissionControlState(missionPlan: MissionPlan | null): MissionControlState {
    const assignments = this.modelRouter.getAssignments();
    const defaultWorkerModel = normalizeModelName(assignments.worker.model) ?? CODEX_LATEST_ALIAS;
    const elapsedLabel = formatElapsed(this.state.startedAt);
    const activeBranch = this.state.gitStrategy?.activeBranch
      ?? (getCurrentBranch(this.config.cwd) || null);
    const workerRuns: WorkerRunView[] = this.kernelState.workerRuns.slice(-20).map((run) => ({
      id: run.id,
      type: run.type,
      featureId: run.featureId,
      milestoneId: run.milestoneId,
      status: run.status,
      durationLabel: computeDurationLabel(run.startedAt, run.endedAt),
      engine: run.engine,
      model: run.model,
      log: run.log,
    }));
    const currentActor = this.resolveCurrentActor(missionPlan);
    const logEntries = this.kernelState.logEntries.slice(-500);

    if (!missionPlan) {
      const fallbackTitle = extractGoalFromPrd(this.state.prd) ?? 'Mission planning';
      const fallbackActivity = this.pendingPrompt
        ? `Waiting for input: ${this.pendingPrompt}`
        : (this.activityLabel.trim().length > 0
          ? this.activityLabel.trim()
          : 'Planning mission from PRD.md...');
      return {
        missionId: this.resolveMissionId(),
        missionTitle: fallbackTitle,
        missionState: 'planning',
        prdPreviewLines: buildPrdPreviewLines(this.state.prd),
        taskPreviewLines: buildTaskPlanningLines(),
        activity: fallbackActivity,
        elapsedLabel,
        progressLabel: '0/0 (0%)',
        progressPercent: 0,
        activeMilestoneId: null,
        activeFeatureId: null,
        activeBranch,
        currentActor,
        logEntries,
        milestones: [],
        progressLog: this.kernelState.progressLog.slice(-80),
        managerLog: (this.kernelState.managerLog ?? []).slice(-120),
        workerRuns,
        modelAssignments: assignments,
        reviewStatus: buildReviewStatus(this.state.latestReviewReport, null),
        pendingPrompt: this.pendingPrompt,
      };
    }

    const milestones: MissionMilestoneView[] = missionPlan.milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      status: milestone.status,
      features: milestone.features.map((feature) => {
        const modelState = resolveFeatureModelState(feature, defaultWorkerModel);
        return {
          id: feature.id,
          description: feature.description,
          status: feature.status,
          attempts: feature.attempts,
          model: modelState.model,
          modelStateSource: modelState.source,
        };
      }),
      qaChecks: (milestone.validationContract.qaChecks ?? []).map((check) => ({
        id: check.id,
        description: check.description,
        passed: check.passed,
        failureCount: check.failureCount,
        requiredRunner: check.requiredRunner,
        requiredArtifacts: check.requiredArtifacts,
      })),
    }));

    const totalFeatures = missionPlan.milestones.reduce((sum, milestone) => sum + milestone.features.length, 0);
    const completedFeatures = missionPlan.milestones.reduce(
      (sum, milestone) => sum + milestone.features.filter((feature) => feature.status === 'done' || feature.status === 'skipped').length,
      0
    );
    const progressPercent = totalFeatures === 0 ? 0 : Math.floor((completedFeatures / totalFeatures) * 100);

    const progressLabel = `${completedFeatures}/${totalFeatures} (${progressPercent}%)`;
    const activity = this.resolveActivityLabel(missionPlan);

    return {
      missionId: missionPlan.mission.id ?? this.resolveMissionId(),
      missionTitle: missionPlan.mission.goal,
      missionState: missionPlan.state,
      prdPreviewLines: buildPrdPreviewLines(this.state.prd),
      taskPreviewLines: buildTaskPreviewLines(missionPlan, defaultWorkerModel),
      activity,
      elapsedLabel,
      progressLabel,
      progressPercent,
      activeMilestoneId: missionPlan.activeMilestoneId,
      activeFeatureId: missionPlan.activeFeatureId,
      activeBranch,
      currentActor,
      logEntries,
      milestones,
      progressLog: this.kernelState.progressLog.slice(-80),
      managerLog: (this.kernelState.managerLog ?? []).slice(-120),
      workerRuns,
      modelAssignments: assignments,
      reviewStatus: buildReviewStatus(this.state.latestReviewReport, missionPlan.activeFeatureId),
      pendingPrompt: this.pendingPrompt,
    };
  }

  private resolveActivityLabel(missionPlan: MissionPlan): string {
    if (this.pendingPrompt) {
      return `Waiting for input: ${this.pendingPrompt}`;
    }
    if (this.activityLabel.trim().length > 0) {
      return this.activityLabel.trim();
    }
    switch (missionPlan.state) {
      case 'planning':
        return 'Planning mission from PRD.md...';
      case 'awaiting_approval':
        return 'Plan ready. Waiting for approval.';
      case 'running':
        if (missionPlan.activeFeatureId) {
          const activeReviewFeature = missionPlan.milestones
            .flatMap((milestone) => milestone.features)
            .find((feature) => feature.id === missionPlan.activeFeatureId && feature.kind === 'review');
          if (activeReviewFeature) {
            return `Running ${formatReviewLabel(activeReviewFeature)}...`;
          }
          return `Running ${missionPlan.activeFeatureId}...`;
        }
        return 'Running mission iteration...';
      case 'paused':
        return 'Mission paused. Press R to resume.';
      case 'completed':
        return 'Mission completed.';
      case 'failed':
        return 'Mission failed.';
      case 'aborted':
        return 'Mission aborted.';
      default:
        return 'Preparing mission runtime...';
    }
  }

  private resolveCurrentActor(missionPlan: MissionPlan | null): LogActor {
    if (!missionPlan) {
      return this.kernelState.currentActor === 'idle' ? 'planning' : this.kernelState.currentActor;
    }

    if (missionPlan.state === 'planning') {
      return this.kernelState.currentActor === 'idle' ? 'planning' : this.kernelState.currentActor;
    }
    if (missionPlan.state === 'awaiting_approval') {
      return 'manager';
    }
    if (missionPlan.state === 'running') {
      if (this.kernelState.activeWorkerRunId !== null) {
        return 'worker';
      }
      return this.kernelState.currentActor === 'idle' ? 'manager' : this.kernelState.currentActor;
    }
    if (missionPlan.state === 'paused') {
      return this.kernelState.currentActor === 'idle' ? 'manager' : this.kernelState.currentActor;
    }
    return 'idle';
  }

  private async persistMissionPlan(): Promise<void> {
    if (!this.state.missionPlan) {
      return;
    }

    await saveMissionPlan(this.config.missionFile, this.state.missionPlan);
    this.kernelState.missionPlan = this.state.missionPlan;
    await this.persistRuntimeState();
  }

  private isTuiInputMode(): boolean {
    return this.config.runtimeUIMode === 'tui';
  }

  private async setPendingPrompt(prompt: string | null): Promise<void> {
    this.pendingPrompt = prompt;
    this.emitEvent('manager_decision', 'orchestrator', {
      action: 'pending_input',
      message: prompt ?? 'pending input cleared',
    });
    await this.emitStatusUpdate();
  }

  private async persistRuntimeState(): Promise<void> {
    this.kernelState.gitStrategy = this.state.gitStrategy;
    await saveSnapshot(this.config.melosDir, {
      seq: this.eventLog.getCurrentSeq(),
      savedAt: new Date().toISOString(),
      state: {
        kernel: this.kernelState,
      },
    });
    this.emitEvent('snapshot_created', 'system', {
      seq: this.eventLog.getCurrentSeq(),
    });
  }

  private async persistValidationReport(report: ValidationReport): Promise<void> {
    const path = join(
      this.config.melosDir,
      'validations',
      `${report.milestoneId}-attempt-${report.attempt}.json`
    );
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  }

  private async persistReviewReport(report: ReviewReport): Promise<void> {
    const path = join(
      this.config.melosDir,
      'reviews',
      `${report.featureId}.json`
    );
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  }

  private resolveMissionId(): string {
    if (this.config.missionId && this.config.missionId.trim().length > 0) {
      return this.config.missionId.trim();
    }
    if (this.config.gitStrategy?.missionId) {
      return this.config.gitStrategy.missionId;
    }
    return 'mission';
  }

  private async writeHandoff(): Promise<string> {
    const missionPlan = this.requireMissionPlan();
    const completedFeatures = missionPlan.milestones.flatMap((milestone) =>
      milestone.features
        .filter((feature) => feature.status === 'done' || feature.status === 'skipped')
        .map((feature) => `- [x] ${feature.id}: ${feature.description}`)
    );
    const warnings = uniqueRuntimeWarnings(this.kernelState.warnings ?? [])
      .map((warning) => `- ${formatRuntimeWarningRecord(warning)}`);
    const latestReview = this.state.latestReviewReport;
    const reviewLines = latestReview
      ? [
        `Last review: ${latestReview.reviewType} g${latestReview.generation} (${latestReview.passed ? 'passed' : 'failed'})`,
        `Summary: ${latestReview.summary}`,
        `Blocking findings: ${latestReview.blockingFindingCount}`,
      ]
      : ['No final review report'];
    const gitStrategy = this.state.gitStrategy;
    const gitLines = gitStrategy
      ? [
        `Base branch: ${gitStrategy.config.baseBranch}`,
        `Mission branch: ${gitStrategy.missionBranch ?? '-'}`,
        `Active branch: ${gitStrategy.activeBranch ?? '-'}`,
        `Pull request: ${gitStrategy.pullRequest ? `${gitStrategy.pullRequest.url} (${gitStrategy.pullRequest.action})` : '-'}`,
        `Quiet until: ${gitStrategy.quietUntil ?? '-'}`,
        `Last external activity: ${gitStrategy.lastExternalActivityAt ?? '-'}`,
        `Handled feedback count: ${gitStrategy.handledFeedbackIds.length}`,
      ]
      : ['Git strategy disabled'];

    const content = [
      '# Melos Mission Handoff',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Mission: ${missionPlan.mission.goal}`,
      `State: ${missionPlan.state}`,
      '',
      '## Completed Features',
      '',
      ...(completedFeatures.length > 0 ? completedFeatures : ['- none']),
      '',
      '## Validation',
      '',
      this.state.latestValidationReport
        ? `Last report: ${this.state.latestValidationReport.milestoneId} attempt ${this.state.latestValidationReport.attempt} (${this.state.latestValidationReport.passed ? 'passed' : 'failed'})`
        : 'No validation report',
      '',
      '## Final Review',
      '',
      ...reviewLines,
      '',
      '## Git / Pull Request',
      '',
      ...gitLines,
      '',
      '## Warnings',
      '',
      ...(warnings.length > 0 ? warnings : ['- none']),
    ].join('\n');

    const handoffPath = join(this.config.cwd, 'HANDOFF.md');
    await writeFile(handoffPath, `${content}\n`, 'utf-8');
    return content;
  }
}

function extractGoalFromPrd(prd: string | null): string | null {
  if (!prd) {
    return null;
  }

  const lines = prd.split(/\r?\n/);
  const generic = new Set(['概要', '背景', '背景・動機', '目的', 'summary', 'overview', 'background', 'goal']);
  const headings = lines
    .filter((line) => /^\s{0,3}#{1,6}\s+\S/.test(line))
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, '').trim())
    .filter((line) => line.length > 0);
  const preferred = headings.find((heading) => !generic.has(heading.toLowerCase()));
  if (preferred) {
    return truncateMessage(preferred, 160);
  }
  if (headings[0]) {
    return truncateMessage(headings[0], 160);
  }

  const firstText = lines.find((line) => line.trim().length > 0);
  if (!firstText) {
    return null;
  }
  const normalized = firstText
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .trim();
  return normalized.length > 0 ? truncateMessage(normalized, 160) : null;
}

function buildPrdPreviewLines(prd: string | null): string[] {
  if (!prd) {
    return ['(PRD not found)'];
  }
  const rawLines = prd.split(/\r?\n/);
  if (rawLines.every((line) => line.trim().length === 0)) {
    return ['(PRD is empty)'];
  }
  return rawLines.map((line) => line.replace(/\t/g, '  '));
}

function buildTaskPreviewLines(
  missionPlan: MissionPlan,
  defaultWorkerModel: string
): string[] {
  const lines: string[] = [];
  lines.push('# Structured TASK View');
  lines.push(`state=${missionPlan.state}`);
  lines.push(`totalIterations=${missionPlan.totalIterations}`);
  lines.push(`activeMilestone=${missionPlan.activeMilestoneId ?? '-'}`);
  lines.push(`activeFeature=${missionPlan.activeFeatureId ?? '-'}`);
  lines.push(`goal=${missionPlan.mission.goal}`);
  lines.push('');
  lines.push('Milestones / Features');

  for (const milestone of missionPlan.milestones) {
    lines.push(`${asMilestoneCheckbox(milestone.status)} ${milestone.id} ${milestone.title} [${milestone.status}]`);
    for (const feature of milestone.features) {
      const activeMark = missionPlan.activeFeatureId === feature.id ? '>' : ' ';
      const modelState = resolveFeatureModelState(feature, defaultWorkerModel);
      const badge = toFeatureModelBadge(feature, modelState.source);
      const reviewMeta = feature.kind === 'review'
        ? ` [review:${feature.reviewType ?? 'unknown'} g${feature.reviewGeneration ?? 1}]`
        : feature.kind === 'qa'
          ? ' [qa]'
        : feature.kind === 'review_remediation'
          ? ' [review-remediation]'
          : '';
      lines.push(
        `  ${activeMark}${asFeatureCheckbox(feature.status)} ${feature.id} [${feature.status}]${reviewMeta} [${badge}:${resolveDisplayModel(modelState.model)}] attempts=${feature.attempts} ${feature.description}`
      );
    }
    const validationChecks = [
      ...milestone.validationContract.staticChecks,
      ...milestone.validationContract.testSuites,
      ...(milestone.validationContract.qaChecks ?? []),
    ];
    if (validationChecks.length > 0) {
      lines.push('  validation checks:');
      for (const check of validationChecks) {
        const description = typeof check.description === 'string' && check.description.trim().length > 0
          ? check.description.trim()
          : '(no description)';
        const command = typeof check.command === 'string' && check.command.trim().length > 0
          ? check.command.trim()
          : null;
        const actionLabel = command
          ? command
          : (check.type === 'manual' || check.type === 'e2e'
              ? 'manual step (follow description)'
              : check.type === 'browser'
                ? 'browser QA (worker evidence required)'
                : 'command not specified');
        lines.push(`    - [${check.passed ? 'x' : ' '}] ${check.id} (${check.type}) ${description} :: ${actionLabel}`);
      }
      const qaChecks = milestone.validationContract.qaChecks ?? [];
      if (qaChecks.length > 0) {
        const qaPassed = qaChecks.filter((check) => check.passed).length;
        const qaFailed = qaChecks.filter((check) => !check.passed && check.failureCount > 0).length;
        const qaPending = qaChecks.length - qaPassed - qaFailed;
        lines.push(`  qa summary: total=${qaChecks.length} passed=${qaPassed} failed=${qaFailed} pending=${qaPending}`);
      }
    }
    lines.push('');
  }
  lines.push('Tip: Open TASK.json directly for raw JSON if needed.');
  return lines;
}

function buildTaskPlanningLines(): string[] {
  return [
    '# TASK generation in progress',
    '',
    'TASK.json has not been created yet.',
    'Manager is reading PRD.md and generating milestones/features/validation contracts.',
    'TASK.json preview will appear here once the mission plan is generated.',
  ];
}

function evaluateBrowserValidationCheck(
  cwd: string,
  check: ValidationCheck,
  evidence: ValidationCheckResult | undefined
): ValidationCheckResult {
  if (!evidence) {
    return createBrowserValidationFailure(check.id, 'browser validation was not reported by the worker', [
      check.description,
    ]);
  }

  if (evidence.passed === false) {
    return {
      ...evidence,
      checkId: check.id,
      output: evidence.output ?? 'browser validation reported failure',
    };
  }

  if (typeof evidence.warning === 'string' && evidence.warning.trim().length > 0) {
    return createBrowserValidationFailure(check.id, 'browser validation reported warning', [
      evidence.warning.trim(),
    ], {
      ...evidence,
      warning: evidence.warning.trim(),
    });
  }

  if (!evidence.runner || evidence.runner.trim().length === 0) {
    return createBrowserValidationFailure(check.id, 'browser validation did not report a runner', [
      check.description,
    ], evidence);
  }

  if (check.requiredRunner && evidence.runner !== check.requiredRunner) {
    return createBrowserValidationFailure(check.id, `browser validation used unexpected runner: ${evidence.runner}`, [
      `expected runner: ${check.requiredRunner}`,
    ], evidence);
  }

  const missingArtifacts = getMissingBrowserArtifacts(check, evidence);
  if (missingArtifacts.length > 0) {
    return createBrowserValidationFailure(check.id, 'browser validation is missing required evidence', missingArtifacts, evidence);
  }

  const missingPaths = getMissingBrowserArtifactPaths(cwd, evidence);
  if (missingPaths.length > 0) {
    return createBrowserValidationFailure(check.id, 'browser validation reported artifact paths that do not exist', missingPaths, evidence);
  }

  return {
    ...evidence,
    checkId: check.id,
    passed: true,
    output: evidence.output ?? `browser validation passed via ${evidence.runner}`,
  };
}

function createBrowserValidationFailure(
  checkId: string,
  summary: string,
  errorMessages: string[],
  base?: ValidationCheckResult
): ValidationCheckResult {
  return {
    ...base,
    checkId,
    passed: false,
    output: base?.output ?? summary,
    failure: {
      summary,
      affectedFiles: [],
      errorMessages,
    },
  };
}

function getMissingBrowserArtifacts(check: ValidationCheck, evidence: ValidationCheckResult): string[] {
  const requiredArtifacts = check.requiredArtifacts && check.requiredArtifacts.length > 0
    ? check.requiredArtifacts
    : undefined;
  const available = new Set<string>();

  if (hasNonEmptyValue(evidence.screenshotPath) || hasNonEmptyValue(evidence.screenshotUrl)) {
    available.add('screenshot');
  }
  if (hasNonEmptyValue(evidence.videoPath) || hasNonEmptyValue(evidence.videoUrl)) {
    available.add('video');
  }

  if (!requiredArtifacts) {
    return available.size > 0
      ? []
      : ['expected at least one browser artifact: screenshot or video'];
  }

  return requiredArtifacts
    .filter((artifact) => !available.has(artifact))
    .map((artifact) => `missing ${artifact}`);
}

function getMissingBrowserArtifactPaths(cwd: string, evidence: ValidationCheckResult): string[] {
  const missing: string[] = [];

  if (hasNonEmptyValue(evidence.screenshotPath) && !existsSync(resolveArtifactPath(cwd, evidence.screenshotPath))) {
    missing.push(`screenshotPath not found: ${evidence.screenshotPath}`);
  }
  if (hasNonEmptyValue(evidence.videoPath) && !existsSync(resolveArtifactPath(cwd, evidence.videoPath))) {
    missing.push(`videoPath not found: ${evidence.videoPath}`);
  }

  return missing;
}

function resolveArtifactPath(cwd: string, artifactPath: string): string {
  return isAbsolute(artifactPath) ? artifactPath : join(cwd, artifactPath);
}

function hasNonEmptyValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

type FeatureModelSource = 'explicit' | 'default';

interface FeatureModelState {
  model: string;
  engine: ModelEngine;
  source: FeatureModelSource;
}

function resolveFeatureModelState(
  feature: Pick<Feature, 'model'>,
  defaultModel: string
): FeatureModelState {
  const explicitModel = normalizeModelName(feature.model);
  if (explicitModel) {
    return {
      model: explicitModel,
      engine: resolveModelEngine(explicitModel),
      source: 'explicit',
    };
  }

  return {
    model: normalizeModelName(defaultModel) ?? CODEX_LATEST_ALIAS,
    engine: resolveModelEngine(defaultModel),
    source: 'default',
  };
}

function toFeatureModelBadge(
  feature: Pick<Feature, 'model'>,
  source: FeatureModelSource
): 'E' | 'D' {
  return feature.model || source === 'explicit' ? 'E' : 'D';
}

function asFeatureCheckbox(status: Feature['status']): string {
  switch (status) {
    case 'done':
    case 'skipped':
      return '[x]';
    case 'in_progress':
      return '[~]';
    case 'failed':
      return '[!]';
    default:
      return '[ ]';
  }
}

function asMilestoneCheckbox(status: Milestone['status']): string {
  switch (status) {
    case 'done':
    case 'skipped':
      return '[x]';
    case 'in_progress':
    case 'validating':
      return '[~]';
    case 'failed':
      return '[!]';
    default:
      return '[ ]';
  }
}

function formatReviewLabel(feature: Pick<Feature, 'description' | 'reviewType' | 'reviewGeneration'>): string {
  const generation = feature.reviewGeneration ?? 1;
  if (feature.reviewType) {
    return `${feature.reviewType} review g${generation}`;
  }
  return truncateMessage(feature.description, 80);
}

function formatElapsed(startedAt: Date): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function buildReviewStatus(
  reviewReport: ReviewReport | null,
  activeFeatureId: string | null
): MissionControlState['reviewStatus'] {
  if (!reviewReport) {
    return null;
  }
  return {
    reviewType: reviewReport.reviewType,
    generation: reviewReport.generation,
    activeFeatureId,
    latestFindingCount: reviewReport.findings.length,
    blockingFindingCount: reviewReport.blockingFindingCount,
    passed: reviewReport.passed,
    summary: reviewReport.summary,
  };
}

function computeDurationLabel(startedAt: string, endedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return `${minutes}m ${remain.toString().padStart(2, '0')}s`;
}

function truncateMessage(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function createBufferedProgressEmitter(
  emitLine: (line: string) => void,
  maxLength = 180
): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = '';

  const emitBufferedLine = (line: string): void => {
    const normalized = line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim();
    if (!normalized) {
      return;
    }
    const wrapped = wrapLogText(normalized, maxLength, 8);
    if (wrapped.length === 0) {
      return;
    }
    emitLine(wrapped.join('\n'));
  };

  const flushLongBuffer = (): void => {
    while (buffer.trim().length > maxLength) {
      const splitAt = findStreamingSplitIndex(buffer, maxLength);
      const prefix = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt).trimStart();
      emitBufferedLine(prefix);
    }
  };

  return {
    push(chunk: string): void {
      if (!chunk) {
        return;
      }
      buffer += chunk.replace(/\r/g, '\n');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        emitBufferedLine(line);
      }
      flushLongBuffer();
    },
    flush(): void {
      emitBufferedLine(buffer);
      buffer = '';
    },
  };
}

function truncateLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  return [...lines.slice(0, maxLines - 1), `... +${lines.length - (maxLines - 1)} lines`];
}

export function readLine(stream: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve) => {
    let buffer = '';
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.includes('\u0003')) {
        stream.removeListener('data', onData);
        resolve('\u0003');
        return;
      }

      // raw mode では Enter なしで単キー入力されるため、approval 用 y/n を即時解釈する
      if (text.length === 1 && (text === 'y' || text === 'Y' || text === 'n' || text === 'N')) {
        stream.removeListener('data', onData);
        resolve(text);
        return;
      }

      const newlineIndex = findLineBreakIndex(text);
      if (newlineIndex >= 0) {
        buffer += text.slice(0, newlineIndex);
        stream.removeListener('data', onData);
        resolve(buffer);
        return;
      }
      buffer += text;
    };
    stream.on('data', onData);
  });
}

export function readSingleKey(stream: NodeJS.ReadStream, allowedKeys: string[]): Promise<string> {
  const normalizedAllowed = new Set(allowedKeys.map((key) => key.toLowerCase()));
  return new Promise((resolve) => {
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.includes('\u0003')) {
        stream.removeListener('data', onData);
        resolve('\u0003');
        return;
      }

      for (const char of text) {
        if (char.trim().length === 0) {
          continue;
        }
        const lower = char.toLowerCase();
        if (normalizedAllowed.has(lower)) {
          stream.removeListener('data', onData);
          resolve(lower);
          return;
        }
      }
    };
    stream.on('data', onData);
  });
}

function findLineBreakIndex(text: string): number {
  const crIndex = text.indexOf('\r');
  const lfIndex = text.indexOf('\n');
  if (crIndex < 0) {
    return lfIndex;
  }
  if (lfIndex < 0) {
    return crIndex;
  }
  return Math.min(crIndex, lfIndex);
}

function normalizeStreamingText(value: string): string | null {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return null;
  }
  return compact;
}

function findStreamingSplitIndex(value: string, maxLength: number): number {
  const preferred = [
    value.lastIndexOf('. ', maxLength),
    value.lastIndexOf('。', maxLength),
    value.lastIndexOf('、', maxLength),
    value.lastIndexOf(', ', maxLength),
    value.lastIndexOf(' ', maxLength),
  ].find((index) => index >= Math.floor(maxLength * 0.55));

  if (preferred === undefined || preferred < 0) {
    return maxLength;
  }
  return preferred + (value[preferred] === ' ' ? 0 : 1);
}

interface AgentEventLogDetail {
  kind: string;
  message: string;
  detailLines?: string[];
}

export function formatAgentEventDetail(method: string, params: unknown): string | null {
  const detail = extractAgentEventLogDetail(method, params);
  if (!detail) {
    return null;
  }
  return [`[${detail.kind}] ${detail.message}`, ...(detail.detailLines ?? [])].join('\n');
}

function extractAgentEventLogDetail(method: string, params: unknown): AgentEventLogDetail | null {
  const safeMethod = method.trim();
  if (!safeMethod) {
    return null;
  }
  const safeMethodLower = safeMethod.toLowerCase();

  if (safeMethodLower === 'manager/fallback') {
    const reason = extractString(params, 'reason');
    const detail = extractString(params, 'detail');
    const outputPreview = extractString(params, 'outputPreview');
    if (reason && detail) {
      return { kind: 'FALLBACK', message: `${reason} (${detail})` };
    }
    if (reason && outputPreview) {
      return { kind: 'FALLBACK', message: `${reason} (${outputPreview})` };
    }
    if (reason) {
      return { kind: 'FALLBACK', message: reason };
    }
    return { kind: 'FALLBACK', message: 'manager fallback triggered' };
  }

  if (safeMethodLower.endsWith('/summarytextdelta')) {
    const delta = extractString(params, 'delta');
    const normalized = delta ? normalizeStreamingText(delta) : null;
    return normalized && isMeaningfulLogFragment(normalized) ? { kind: 'THINK', message: normalized } : null;
  }
  if (safeMethodLower.includes('reasoning')) {
    return null;
  }

  if (
    safeMethodLower.includes('ratelimits')
    || safeMethodLower.includes('agent_message_delta')
    || safeMethodLower.includes('agent_message_content_delta')
    || safeMethodLower.includes('agentmessage/delta')
    || safeMethodLower.includes('/task_complete')
    || safeMethodLower.includes('/turn/completed')
    || safeMethodLower.includes('/mcp_startup')
  ) {
    return null;
  }

  if (
    safeMethod === 'item/started'
    || safeMethod.endsWith('/item_started')
    || safeMethod.endsWith('/item/started')
  ) {
    const item = extractEventItem(params);
    const type = normalizeItemType(extractString(item, 'type') ?? '');
    if (type === 'commandexecution') {
      const command = extractString(item, 'command');
      return { kind: 'BASH', message: command?.trim() || '(command)' };
    }
    if (type === 'fileread') {
      const filePath = extractString(item, 'filePath') ?? extractString(item, 'file_path');
      if (!filePath) {
        return { kind: 'READ', message: '(file)' };
      }
      const limit = extractNumber(item, 'limit');
      return { kind: 'READ', message: limit !== null ? `${filePath} (${limit} lines)` : filePath };
    }
    if (type === 'filewrite' || type === 'fileedit') {
      const filePath = extractString(item, 'filePath') ?? extractString(item, 'file_path');
      return { kind: 'WRITE', message: filePath ?? '(file)' };
    }
    if (type === 'filechange') {
      return describeFileChangeLogDetail(item, 'WRITE');
    }
    if (type === 'mcptoolcall') {
      const server = extractString(item, 'server');
      const tool = extractString(item, 'tool');
      if (server && tool) {
        return { kind: 'TOOL', message: `${server}/${tool}` };
      }
      return tool ? { kind: 'TOOL', message: tool } : null;
    }
    return null;
  }

  if (
    safeMethod === 'item/completed'
    || safeMethod.endsWith('/item_completed')
    || safeMethod.endsWith('/item/completed')
  ) {
    const item = extractEventItem(params);
    const type = normalizeItemType(extractString(item, 'type') ?? '');
    if (type === 'commandexecution') {
      const exitCode = extractNumber(item, 'exitCode');
      const durationMs = extractNumber(item, 'durationMs');
      const parts = [
        exitCode !== null ? `exit=${exitCode}` : null,
        durationMs !== null ? `${durationMs}ms` : null,
      ].filter((v): v is string => v !== null);
      return { kind: 'DONE', message: parts.length > 0 ? parts.join(' ') : 'command finished' };
    }
    if (type === 'filechange') {
      return describeFileChangeLogDetail(item, 'DONE');
    }
    if (type === 'mcptoolcall') {
      const tool = extractString(item, 'tool');
      const error = extractString(item, 'error');
      if (error) {
        return { kind: 'ERR', message: tool ? `tool failed ${tool}` : 'tool failed' };
      }
      return { kind: 'DONE', message: tool ? `tool completed ${tool}` : 'tool completed' };
    }
    return null;
  }

  if (safeMethod.endsWith('/outputDelta')) {
    return null;
  }

  if (safeMethod.endsWith('/delta')) {
    const delta = extractString(params, 'delta');
    if (delta && /tool_use_error|sibling tool call errored/i.test(delta)) {
      return { kind: 'ERR', message: 'tool call failed' };
    }
    const normalized = delta ? normalizeStreamingText(delta) : null;
    return normalized && isMeaningfulLogFragment(normalized) ? { kind: 'INFO', message: normalized } : null;
  }

  if (safeMethod.endsWith('/tool_use')) {
    const name = extractString(params, 'name');
    const input = extractRecord(params, 'input');
    if (!name) {
      return null;
    }
    if (name === 'Bash') {
      const command = extractString(input, 'command');
      return { kind: 'BASH', message: command?.trim() || '(command)' };
    }
    if (name === 'Read') {
      const filePath = extractString(input, 'file_path');
      const limit = extractNumber(input, 'limit');
      if (!filePath) {
        return { kind: 'READ', message: '(file)' };
      }
      return { kind: 'READ', message: limit !== null ? `${filePath} (${limit} lines)` : filePath };
    }
    if (name === 'Write' || name === 'Edit') {
      const filePath = extractString(input, 'file_path');
      return { kind: 'WRITE', message: filePath ?? '(file)' };
    }
    return { kind: 'TOOL', message: name };
  }

  if (safeMethod.endsWith('/tool_result')) {
    const content = extractString(params, 'content');
    const summarized = content ? summarizeToolResult(content) : null;
    const normalized = summarized ? normalizeStreamingText(summarized) : null;
    if (!normalized || !isMeaningfulLogFragment(normalized)) {
      return null;
    }
    return { kind: 'INFO', message: normalized };
  }

  if (safeMethod.endsWith('/result')) {
    return null;
  }

  return null;
}

function describeFileChangeLogDetail(
  item: Record<string, unknown> | null,
  kind: 'WRITE' | 'DONE'
): AgentEventLogDetail {
  const previews = extractFileChangePreviews(item);
  if (previews.length === 0) {
    const filePath = extractFirstFileChangePath(item);
    return {
      kind,
      message: filePath
        ? (kind === 'DONE' ? `write ${filePath}` : filePath)
        : (kind === 'DONE' ? 'write completed' : '(file)'),
    };
  }

  const totals = previews.reduce((acc, preview) => ({
    added: acc.added + preview.added,
    removed: acc.removed + preview.removed,
  }), { added: 0, removed: 0 });

  if (previews.length === 1) {
    const preview = previews[0];
    return {
      kind,
      message: kind === 'DONE'
        ? `write ${preview.path} (+${preview.added} -${preview.removed})`
        : `${preview.path} (+${preview.added} -${preview.removed})`,
      detailLines: kind === 'DONE' ? preview.diffLines : undefined,
    };
  }

  const detailLines = buildMultiFileChangeDetailLines(previews);
  return {
    kind,
    message: kind === 'DONE'
      ? `write ${previews.length} files (+${totals.added} -${totals.removed})`
      : `${previews.length} files (+${totals.added} -${totals.removed})`,
    detailLines: kind === 'DONE' ? detailLines : undefined,
  };
}

interface FileChangePreview {
  path: string;
  added: number;
  removed: number;
  diffLines: string[];
}

function extractFileChangePreviews(item: Record<string, unknown> | null): FileChangePreview[] {
  if (!item) {
    return [];
  }
  const changes = item.changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    return [];
  }

  const previews: FileChangePreview[] = [];
  for (const rawChange of changes) {
    if (!rawChange || typeof rawChange !== 'object' || Array.isArray(rawChange)) {
      continue;
    }
    const change = rawChange as Record<string, unknown>;
    const path = typeof change.path === 'string' ? change.path : '(unknown)';
    const diff = typeof change.diff === 'string' ? change.diff : '';
    const parsed = parseUnifiedDiffPreview(diff);
    previews.push({
      path,
      added: parsed.added,
      removed: parsed.removed,
      diffLines: parsed.lines,
    });
  }
  return previews;
}

function buildMultiFileChangeDetailLines(previews: FileChangePreview[]): string[] {
  const lines: string[] = [];
  const maxFiles = 2;
  for (const preview of previews.slice(0, maxFiles)) {
    lines.push(`${preview.path} (+${preview.added} -${preview.removed})`);
    lines.push(...preview.diffLines);
  }
  if (previews.length > maxFiles) {
    lines.push(`... +${previews.length - maxFiles} more files`);
  }
  return lines;
}

function parseUnifiedDiffPreview(diff: string): { added: number; removed: number; lines: string[] } {
  let added = 0;
  let removed = 0;
  const lines: string[] = [];
  let omitted = 0;

  for (const rawLine of diff.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('+')) {
      added += 1;
    } else if (line.startsWith('-')) {
      removed += 1;
    }

    if (!(line.startsWith('@@') || line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('\\'))) {
      continue;
    }

    if (lines.length < 12) {
      lines.push(truncateMessage(line, 220));
    } else {
      omitted += 1;
    }
  }

  if (omitted > 0) {
    lines.push(`... +${omitted} more diff lines`);
  }

  return { added, removed, lines };
}

function extractString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const candidate = record[key];
  return typeof candidate === 'string' ? candidate : null;
}

function extractRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const candidate = record[key];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  return candidate as Record<string, unknown>;
}

function extractEventItem(value: unknown): Record<string, unknown> | null {
  const direct = extractRecord(value, 'item');
  if (direct) {
    return direct;
  }
  const msg = extractRecord(value, 'msg');
  if (!msg) {
    return null;
  }
  return extractRecord(msg, 'item');
}

function extractNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const candidate = record[key];
  return typeof candidate === 'number' ? candidate : null;
}

function extractFirstFileChangePath(item: Record<string, unknown> | null): string | null {
  if (!item) {
    return null;
  }
  const changes = item.changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    return null;
  }
  const first = changes[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    return null;
  }
  const path = (first as Record<string, unknown>).path;
  return typeof path === 'string' ? path : null;
}

function normalizeItemType(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

function isMeaningfulLogFragment(value: string): boolean {
  const compact = value.trim();
  if (compact.length < 2) {
    return false;
  }
  if (/^[{}[\](),.:;"'`0-9+\-_/\\]+$/.test(compact)) {
    return false;
  }
  if (/^codex\/event\//.test(compact.toLowerCase())) {
    return false;
  }
  if (/^<tool_use_error>/i.test(compact)) {
    return false;
  }
  return true;
}

function summarizeToolResult(content: string): string | null {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) {
    return null;
  }
  if (/tool_use_error|sibling tool call errored/i.test(normalized)) {
    return 'tool call failed';
  }
  if (/no matches found/i.test(normalized)) {
    return 'No matches found';
  }

  const noisyDump = /(^|\s)\d+→|(^|\s)\d+-|\bResult \d+→/m.test(normalized);
  if (noisyDump || normalized.length > 260) {
    return `verbose tool output omitted (${normalized.length} chars)`;
  }

  return normalized;
}

function mapEscalationSingleKey(value: string): 'retry' | 'skip' | 'abort' | 'modify' | null {
  switch (value) {
    case 'r':
      return 'retry';
    case 's':
      return 'skip';
    case 'a':
      return 'abort';
    case 'm':
      return 'modify';
    default:
      return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecoverableResumeState(state: MissionState): boolean {
  return state === 'aborted' || state === 'paused';
}

function recoverMissionPlanForResume(plan: MissionPlan): MissionPlan {
  let recovered: MissionPlan = {
    ...plan,
    state: 'running',
    milestones: plan.milestones.map((milestone) => ({
      ...milestone,
      status: milestone.status === 'done' || milestone.status === 'skipped'
        ? milestone.status
        : 'in_progress',
      features: milestone.features.map((feature) => ({
        ...feature,
        status: feature.status === 'done' || feature.status === 'skipped'
          ? feature.status
          : 'pending',
      })),
    })),
  };
  const activeMilestone = getNextPendingMilestone(recovered);
  recovered = setActiveMilestone(recovered, activeMilestone?.id ?? null);
  const activeFeature = activeMilestone ? getNextPendingFeature(activeMilestone) : null;
  recovered = setActiveFeature(recovered, activeFeature?.id ?? null);
  return recovered;
}

function normalizeKernelState(kernel: MissionKernelState): MissionKernelState {
  const base = createInitialKernelState();
  const workerRuns = Array.isArray(kernel.workerRuns)
    ? kernel.workerRuns.map((run) => ({
      ...run,
      log: Array.isArray(run.log) ? run.log : [],
    }))
    : [];
  const progressLog = Array.isArray(kernel.progressLog) ? kernel.progressLog : [];
  const managerLog = Array.isArray(kernel.managerLog) ? kernel.managerLog : [];
  const logEntries = Array.isArray(kernel.logEntries) ? kernel.logEntries : [];
  const warnings = Array.isArray(kernel.warnings)
    ? kernel.warnings
      .map((warning) => normalizeStoredRuntimeWarning(warning))
      .filter((warning): warning is NonNullable<MissionKernelState['warnings']>[number] => warning !== null)
    : [];
  const validationEvidence = normalizeValidationEvidenceMap(kernel.validationEvidence);
  const featureRetries = Array.isArray(kernel.featureRetries)
    ? kernel.featureRetries
      .map((retry) => normalizeStoredFeatureRetry(retry))
      .filter((retry): retry is FeatureRetryRecord => retry !== null)
    : [];

  return {
    ...base,
    ...kernel,
    workerRuns,
    progressLog,
    managerLog,
    logEntries,
    warnings,
    validationEvidence,
    latestValidationReport: kernel.latestValidationReport ?? null,
    featureRetries,
    currentActor: kernel.currentActor ?? 'idle',
  };
}

function normalizeStoredRuntimeWarning(
  value: unknown
): NonNullable<MissionKernelState['warnings']>[number] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  if (message.length === 0) {
    return null;
  }

  const source = record.source === 'worker' || record.source === 'validation' || record.source === 'system'
    ? record.source
    : 'system';

  return {
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString(),
    iteration: typeof record.iteration === 'number' ? Math.max(0, Math.floor(record.iteration)) : 0,
    source,
    message,
    milestoneId: typeof record.milestoneId === 'string' ? record.milestoneId : undefined,
    featureId: typeof record.featureId === 'string' ? record.featureId : undefined,
    checkId: typeof record.checkId === 'string' ? record.checkId : undefined,
    seq: typeof record.seq === 'number' ? record.seq : undefined,
  };
}

function normalizeStoredFeatureRetry(value: unknown): FeatureRetryRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const milestoneId = typeof record.milestoneId === 'string' ? record.milestoneId.trim() : '';
  const featureId = typeof record.featureId === 'string' ? record.featureId.trim() : '';
  const dueAt = typeof record.dueAt === 'string' ? record.dueAt : '';
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  if (milestoneId.length === 0 || featureId.length === 0 || dueAt.length === 0 || reason.length === 0) {
    return null;
  }

  return {
    milestoneId,
    featureId,
    nextAttempt: typeof record.nextAttempt === 'number' ? Math.max(1, Math.floor(record.nextAttempt)) : 1,
    dueAt,
    lastStatus: record.lastStatus === 'PARTIAL' || record.lastStatus === 'BLOCKED' ? record.lastStatus : 'FAILED',
    reason,
    summary: typeof record.summary === 'string' && record.summary.trim().length > 0
      ? record.summary.trim()
      : undefined,
  };
}

function normalizeValidationEvidenceMap(
  value: MissionKernelState['validationEvidence']
): NonNullable<MissionKernelState['validationEvidence']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const next: NonNullable<MissionKernelState['validationEvidence']> = {};
  for (const [milestoneId, rawChecks] of Object.entries(value)) {
    if (!rawChecks || typeof rawChecks !== 'object' || Array.isArray(rawChecks)) {
      continue;
    }

    const normalizedChecks: Record<string, ValidationCheckResult> = {};
    for (const [checkId, rawResult] of Object.entries(rawChecks)) {
      if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
        continue;
      }

      const result = rawResult as ValidationCheckResult;
      if (typeof result.passed !== 'boolean') {
        continue;
      }

      normalizedChecks[checkId] = {
        ...result,
        checkId,
        output: typeof result.output === 'string' ? result.output : undefined,
        warning: typeof result.warning === 'string' ? result.warning : undefined,
        runner: typeof result.runner === 'string' ? result.runner : undefined,
        screenshotPath: typeof result.screenshotPath === 'string' ? result.screenshotPath : undefined,
        videoPath: typeof result.videoPath === 'string' ? result.videoPath : undefined,
        screenshotUrl: typeof result.screenshotUrl === 'string' ? result.screenshotUrl : undefined,
        videoUrl: typeof result.videoUrl === 'string' ? result.videoUrl : undefined,
        failure: result.failure
          ? {
            ...result.failure,
            affectedFiles: Array.isArray(result.failure.affectedFiles) ? result.failure.affectedFiles : [],
            errorMessages: Array.isArray(result.failure.errorMessages) ? result.failure.errorMessages : [],
          }
          : undefined,
      };
    }

    next[milestoneId] = normalizedChecks;
  }

  return next;
}

function uniqueRuntimeWarnings(
  warnings: NonNullable<MissionKernelState['warnings']>
): NonNullable<MissionKernelState['warnings']> {
  const seen = new Set<string>();
  const next: NonNullable<MissionKernelState['warnings']> = [];

  for (const warning of warnings) {
    const key = [
      warning.source,
      warning.featureId ?? '',
      warning.milestoneId ?? '',
      warning.checkId ?? '',
      warning.message,
    ].join('\u0000');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    next.push(warning);
  }

  return next;
}
