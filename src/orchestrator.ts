import { existsSync, mkdirSync } from 'node:fs';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ManagerAgent, type ManagerAgentConfig } from './agents/manager.js';
import { WorkerAgent, type WorkerAgentConfig } from './agents/worker.js';
import type { ManagerInput, WorkerFeatureReport, WorkerInput, WorkerResult } from './agents/types.js';
import {
  type MissionPlan,
  type Milestone,
  type Feature,
  missionFileExists,
  loadMissionPlan,
  saveMissionPlan,
  transitionMissionState,
  createMissionPlan,
  getNextPendingMilestone,
  getNextPendingFeature,
  areAllMilestonesDone,
  areMilestoneFeaturesDone,
  setActiveMilestone,
  setActiveFeature,
  updateFeatureStatus,
  updateMilestoneStatus,
  appendFeaturesToMilestone,
  incrementMissionIterations,
} from './state/mission.js';
import {
  type ValidationReport,
  type ValidationCheckResult,
  getAllValidationChecks,
  mergeValidationResults,
  hasValidationLoop,
} from './state/validation.js';
import {
  type GitStrategyState,
  createGitStrategyState,
  createFeatureBranchName,
  registerFeatureBranch,
  saveGitStrategyState,
  loadGitStrategyState,
  updateFeatureBranchStatus,
} from './state/git-strategy.js';
import {
  createBranch,
  checkoutBranch,
  commitAll,
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
  createInitialKernelState,
} from './state/event-reducer.js';
import { loadSnapshot, saveSnapshot } from './state/snapshot.js';
import { Watchdog } from './state/watchdog.js';
import { TokenTracker } from './state/token-tracker.js';
import { ModelRouter, type ModelRole } from './models/router.js';
import type { MissionControlState, MissionMilestoneView, WorkerRunView } from './ui/tui-views.js';

export interface OrchestratorConfig {
  cwd: string;
  maxIterations: number;
  prdFile: string;
  missionFile: string;
  melosDir: string;
  plannerModel?: string;
  workerModel?: string;
  validatorModel?: string;
  researchModel?: string;
  managerEffort?: 'low' | 'medium' | 'high' | 'max';
  workerReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  interactivePlanning?: boolean;
  autoApprove?: boolean;
  dryRun?: boolean;
  gitStrategy?: {
    enabled: boolean;
    baseBranch: string;
    missionId: string;
    autoPush: boolean;
    preMergeValidation: boolean;
    validationCommands: string[];
  };
  resume?: boolean;
  missionId?: string;
  runtimeUIMode?: 'tui' | 'plain';
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
  gitStrategy: GitStrategyState | null;
  startedAt: Date;
}

const MODEL_ROTATION: string[] = ['gpt-5.3-codex', 'opus', 'sonnet', 'haiku'];

export class Orchestrator {
  private readonly config: OrchestratorConfig;
  private readonly manager: ManagerAgent;
  private readonly worker: WorkerAgent;
  private readonly modelRouter: ModelRouter;
  private readonly tokenTracker: TokenTracker;
  private readonly eventLog: EventLog;
  private readonly watchdog: Watchdog;

  private state: RuntimeState;
  private kernelState: MissionKernelState;

  private aborted = false;
  private pausePromise: Promise<void> | null = null;
  private resumePause: (() => void) | null = null;
  private workerRunCounter = 0;
  private pendingPrompt: string | null = null;
  private activityLabel = '';
  private statusRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private managerHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: OrchestratorConfig) {
    this.config = config;

    this.modelRouter = new ModelRouter({
      assignments: {
        planner: config.plannerModel ?? 'opus',
        worker: config.workerModel ?? 'gpt-5.3-codex',
        validator: config.validatorModel ?? 'gpt-5.3-codex',
        research: config.researchModel ?? 'opus',
      },
      escalationPolicy: {
        enabled: true,
        maxEscalations: 2,
        chain: {
          haiku: 'sonnet',
          sonnet: 'opus',
        },
      },
    });

    const managerConfig: ManagerAgentConfig = {
      cwd: config.cwd,
      promptsDir: join(config.cwd, 'prompts'),
      model: this.modelRouter.getModel('planner'),
      effort: config.managerEffort ?? 'high',
      requestTimeoutMs: 180_000,
      suppressTerminalOutput: config.runtimeUIMode === 'tui',
    };
    this.manager = new ManagerAgent(managerConfig);

    const workerConfig: WorkerAgentConfig = {
      cwd: config.cwd,
      promptsDir: join(config.cwd, 'prompts'),
      model: this.modelRouter.getModel('worker'),
      reasoningEffort: config.workerReasoningEffort ?? 'high',
      claudeModel: this.modelRouter.getModel('worker'),
      claudeEffort: config.managerEffort ?? 'high',
      suppressTerminalOutput: config.runtimeUIMode === 'tui',
    };
    this.worker = new WorkerAgent(workerConfig);

    this.tokenTracker = new TokenTracker();
    this.eventLog = new EventLog({ melosDir: config.melosDir });
    this.watchdog = new Watchdog();

    this.state = {
      missionPlan: null,
      iteration: 0,
      prd: null,
      latestValidationReport: null,
      latestWorkerReport: null,
      gitStrategy: config.gitStrategy?.enabled
        ? createGitStrategyState({
          missionId: config.gitStrategy.missionId,
          baseBranch: config.gitStrategy.baseBranch,
          autoPush: config.gitStrategy.autoPush,
          preMergeValidation: config.gitStrategy.preMergeValidation,
          validationCommands: config.gitStrategy.validationCommands,
        })
        : null,
      startedAt: new Date(),
    };

    this.kernelState = createInitialKernelState();
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
        const missionPlan = this.state.missionPlan;
        if (!missionPlan) {
          await this.runPlanningPhase();
          continue;
        }

        switch (missionPlan.state) {
          case 'planning':
            await this.runPlanningPhase();
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
        reason: 'aborted',
        completedIterations: this.state.missionPlan?.totalIterations ?? 0,
      };
    } finally {
      this.watchdog.stop();
      if (this.statusRefreshTimer) {
        clearTimeout(this.statusRefreshTimer);
        this.statusRefreshTimer = null;
      }
      this.stopManagerHeartbeat();
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

  abort(): void {
    this.aborted = true;
    this.activityLabel = 'Abort requested. Stopping active work...';
    this.manager.abort();
    this.worker.abort();

    if (this.state.missionPlan && this.state.missionPlan.state !== 'completed') {
      this.state.missionPlan = {
        ...this.state.missionPlan,
        state: 'aborted',
        lastTransitionAt: new Date().toISOString(),
      };
      void this.persistMissionPlan();
      this.emitEvent('mission_failed', 'orchestrator', { reason: 'aborted by signal' });
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
    const normalized = current.toLowerCase();
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
      message: `model for ${role} changed to ${nextModel}`,
    });
    await this.emitStatusUpdate();
  }

  private async loadState(): Promise<void> {
    if (existsSync(this.config.prdFile)) {
      this.state.prd = await readFile(this.config.prdFile, 'utf-8');
    }

    if (this.config.resume) {
      const snapshot = await loadSnapshot<{ kernel: MissionKernelState }>(this.config.melosDir);
      if (snapshot?.state?.kernel) {
        this.kernelState = snapshot.state.kernel;
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
    }

    if (!this.state.missionPlan) {
      this.state.missionPlan = createMissionPlan({
        missionId: this.resolveMissionId(),
        goal: extractGoalFromPrd(this.state.prd) ?? 'Mission goal is not defined',
        constraints: ['No backward compatibility layer'],
        successCriteria: ['All validations pass'],
        prdFile: this.config.prdFile,
        milestones: [
          {
            id: 'm1',
            title: 'Initial planning milestone',
            description: 'Generate mission plan from PRD',
            order: 1,
            status: 'pending',
            validationContract: {
              staticChecks: [],
              testSuites: [],
            },
            features: [
              {
                id: 'm1-f1',
                description: 'Generate complete mission plan',
                status: 'pending',
                attempts: 0,
                model: 'codex',
              },
            ],
          },
        ],
        state: 'planning',
      });
      await this.persistMissionPlan();
    }

    if (this.state.gitStrategy && this.config.resume) {
      const persisted = await loadGitStrategyState(this.config.melosDir);
      if (persisted) {
        this.state.gitStrategy = persisted;
      }
    }

    this.kernelState.missionPlan = this.state.missionPlan;
    await this.emitStatusUpdate();
  }

  private async runPlanningPhase(): Promise<void> {
    const current = this.state.missionPlan;
    if (!current) {
      return;
    }

    this.activityLabel = `Planning mission with ${this.modelRouter.getModel('planner')}...`;
    this.emitEvent('manager_started', 'manager', {
      phase: 'planning',
      message: `Planning mission with manager model (${this.modelRouter.getModel('planner')})`,
    });
    this.startManagerHeartbeat({
      phase: 'planning',
      message: 'Manager is planning mission',
    });
    await this.emitStatusUpdate();

    let generated: MissionPlan;
    try {
      generated = await this.manager.generateMissionPlan({
        missionId: this.resolveMissionId(),
        prd: this.state.prd,
        interactiveGoal: this.config.interactivePlanning ? current.mission.goal : undefined,
        approvalMethod: this.config.autoApprove ? 'auto' : 'interactive',
        prdFile: this.config.prdFile,
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
    } finally {
      this.stopManagerHeartbeat();
    }

    const withPhase = transitionMissionState(generated, 'awaiting_approval');
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
      if (!this.aborted) {
        this.activityLabel = 'Approval required. Press y to continue or Ctrl+C to abort.';
        await this.emitStatusUpdate();
      }
      return;
    }

    this.state.missionPlan = transitionMissionState(missionPlan, 'running', {
      approvalMethod: this.config.autoApprove ? 'auto' : 'interactive',
    });
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

    missionPlan = setActiveMilestone(missionPlan, pendingMilestone.id);
    missionPlan = updateMilestoneStatus(missionPlan, pendingMilestone.id, 'in_progress');
    this.activityLabel = `Milestone ${pendingMilestone.id} in progress.`;

    if (areMilestoneFeaturesDone(pendingMilestone)) {
      this.state.missionPlan = missionPlan;
      await this.runMilestoneValidation(pendingMilestone.id);
      return;
    }

    const nextFeature = getNextPendingFeature(pendingMilestone);
    if (!nextFeature) {
      this.state.missionPlan = missionPlan;
      await this.runMilestoneValidation(pendingMilestone.id);
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
    this.startManagerHeartbeat({
      phase: 'briefing',
      milestoneId: updatedMilestone.id,
      featureId: updatedFeature.id,
      message: `Manager is preparing briefing for ${updatedFeature.id}`,
    });
    let briefing: string | undefined;
    try {
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
    } finally {
      this.stopManagerHeartbeat();
    }
    this.emitEvent('manager_decision', 'manager', {
      action: 'briefing',
      milestoneId: updatedMilestone.id,
      featureId: updatedFeature.id,
      message: `Manager finished feature briefing for ${updatedFeature.id}`,
    });
    this.emitEvent('manager_decision', 'manager', {
      action: 'dispatch_feature',
      milestoneId: updatedMilestone.id,
      featureId: updatedFeature.id,
      model: updatedFeature.model ?? 'codex',
    });

    this.activityLabel = `Worker executing ${updatedFeature.id}...`;
    const result = await this.executeFeature(updatedMilestone, updatedFeature, briefing);
    this.state.latestWorkerReport = result.report;

    if (result.report.tokenUsage) {
      this.tokenTracker.record({
        role: 'worker',
        model: this.modelRouter.getModel('worker'),
        input: result.report.tokenUsage.input,
        output: result.report.tokenUsage.output,
        cached: result.report.tokenUsage.cached,
      });
      this.emitEvent('token_usage', 'worker', {
        role: 'worker',
        model: this.modelRouter.getModel('worker'),
        ...result.report.tokenUsage,
      });
    }

    const status = result.type === 'success'
      ? 'done'
      : result.type === 'partial'
        ? 'failed'
        : result.type === 'blocked'
          ? 'failed'
          : 'failed';

    missionPlan = this.requireMissionPlan();
    missionPlan = updateFeatureStatus(
      missionPlan,
      updatedMilestone.id,
      updatedFeature.id,
      status,
      {
        lastReportSummary: result.report.summary,
        briefing,
      }
    );

    if (result.report.discoveredFeatures.length > 0) {
      const followups = result.report.discoveredFeatures.map((discovered, index) => ({
        id: `${updatedMilestone.id}-f${updatedMilestone.features.length + index + 1}`,
        description: discovered.description,
        status: 'pending' as const,
        attempts: 0,
        model: discovered.priority === 'high' ? 'codex' : updatedFeature.model ?? 'codex',
      }));
      missionPlan = appendFeaturesToMilestone(missionPlan, updatedMilestone.id, followups);
      this.emitEvent('task_added', 'orchestrator', {
        milestoneId: updatedMilestone.id,
        features: followups,
      });
    }

    missionPlan = incrementMissionIterations(missionPlan);
    this.state.missionPlan = missionPlan;
    this.kernelState.missionPlan = missionPlan;

    this.emitEvent('iteration_completed', 'orchestrator', {
      iteration: missionPlan.totalIterations,
      milestoneId: updatedMilestone.id,
      featureId: updatedFeature.id,
      status,
    });
    this.activityLabel = `Completed ${updatedFeature.id}.`;

    await this.persistMissionPlan();
    await this.emitStatusUpdate();
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

    for (const check of checks) {
      if (!check.command) {
        results.push({
          checkId: check.id,
          passed: check.type === 'manual',
          output: check.type === 'manual' ? 'manual check pending (treated as pass by default)' : 'no command',
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
            e2eChecks: current.validationContract.e2eChecks?.map((check) => ({ ...check, failureCount: 0 })),
            manualSteps: current.validationContract.manualSteps?.map((check) => ({ ...check, failureCount: 0 })),
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

    const milestoneForFollowUps = missionPlan.milestones.find((item) => item.id === milestoneId);
    const baseCount = milestoneForFollowUps?.features.length ?? 0;
    const followUpFeatures: Feature[] = followUps.map((draft, index) => ({
      id: `${milestoneId}-f${baseCount + index + 1}`,
      description: draft.description,
      status: 'pending',
      attempts: 0,
      model: draft.model ?? 'codex',
    }));

    missionPlan = appendFeaturesToMilestone(missionPlan, milestoneId, followUpFeatures);
    missionPlan = updateMilestoneStatus(missionPlan, milestoneId, 'in_progress');
    this.state.missionPlan = missionPlan;
    this.kernelState.missionPlan = missionPlan;
    this.activityLabel = `Validation failed for ${milestoneId}. Generated follow-up features.`;

    this.emitEvent('task_added', 'manager', {
      milestoneId,
      followUpFeatures,
    });

    await this.persistMissionPlan();
    await this.emitStatusUpdate();
  }

  private async executeFeature(
    milestone: Milestone,
    feature: Feature,
    briefing?: string
  ): Promise<WorkerResult> {
    const selectedWorkerModel = this.modelRouter.getModel('worker');
    const selectedWorkerEngine = this.modelRouter.resolveEngine(selectedWorkerModel);
    const executionFeature: Feature = {
      ...feature,
      model: selectedWorkerEngine === 'claude' ? 'claude' : 'codex',
    };
    this.worker.setRuntimeModel(selectedWorkerModel);

    let branchName: string | null = null;
    let baseBranch: string | undefined;

    if (this.state.gitStrategy) {
      baseBranch = this.state.gitStrategy.config.baseBranch;
      branchName = createFeatureBranchName(
        this.state.gitStrategy.config.missionId,
        feature.id,
        feature.description
      );

      const baseCommitHash = getHeadCommitHash(this.config.cwd);
      createBranch(this.config.cwd, branchName, baseBranch);
      this.state.gitStrategy = registerFeatureBranch(this.state.gitStrategy, {
        name: branchName,
        taskId: feature.id,
        baseCommitHash,
      });

      await saveGitStrategyState(this.config.melosDir, this.state.gitStrategy);
      this.emitEvent('branch_created', 'system', {
        branchName,
        baseBranch,
        baseCommitHash,
      });
    }

    const runId = ++this.workerRunCounter;
    const workerStartedAt = new Date();
    this.emitEvent('worker_started', 'worker', {
      runId,
      type: 'implement',
      milestoneId: milestone.id,
      featureId: feature.id,
      branch: branchName,
      engine: selectedWorkerEngine,
      model: selectedWorkerModel,
    });

    if (this.config.dryRun) {
      const report: WorkerFeatureReport = {
        iteration: this.requireMissionPlan().totalIterations + 1,
        milestoneId: milestone.id,
        featureId: feature.id,
        status: 'SUCCESS',
        summary: '[dry-run] execution skipped',
        filesChanged: [],
        validation: {
          testsRun: false,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: false,
          typecheckPassed: false,
        },
        checks: [],
        discoveredFeatures: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      };
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
      currentBranch: branchName,
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

    const result = await this.worker.run(workerInput);
    this.watchdog.touch();

    if (branchName && this.state.gitStrategy) {
      result.report.summary = await this.runGitPostProcess(branchName, baseBranch ?? this.state.gitStrategy.config.baseBranch, result.report);
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

  private async runGitPostProcess(
    branchName: string,
    baseBranch: string,
    report: WorkerFeatureReport
  ): Promise<string> {
    try {
      if (!isWorkingTreeClean(this.config.cwd)) {
        const commitHash = commitAll(
          this.config.cwd,
          `feat(mission): ${report.featureId} ${truncateMessage(report.summary, 60)}`
        );
        this.emitEvent('commit_created', 'system', {
          branchName,
          commitHash,
          featureId: report.featureId,
        });
        this.state.gitStrategy = this.state.gitStrategy
          ? updateFeatureBranchStatus(this.state.gitStrategy, branchName, 'ready', { commitHash })
          : this.state.gitStrategy;
      }

      if (this.state.gitStrategy?.config.preMergeValidation) {
        for (const command of this.state.gitStrategy.config.validationCommands) {
          const result = runGitCommand(this.config.cwd, command);
          this.emitEvent('command_executed', 'system', {
            command,
            exitCode: result.exitCode,
          });
          if (result.exitCode !== 0) {
            this.state.gitStrategy = this.state.gitStrategy
              ? updateFeatureBranchStatus(this.state.gitStrategy, branchName, 'abandoned')
              : this.state.gitStrategy;
            await saveGitStrategyState(this.config.melosDir, this.state.gitStrategy!);
            checkoutBranch(this.config.cwd, baseBranch);
            return `${report.summary}\nPre-merge validation failed: ${command}`;
          }
        }
      }

      if (hasConflicts(this.config.cwd, branchName, baseBranch)) {
        const missionPlan = this.requireMissionPlan();
        const activeMilestoneId = missionPlan.activeMilestoneId;
        if (activeMilestoneId) {
          const milestone = missionPlan.milestones.find((item) => item.id === activeMilestoneId);
          const nextId = `${activeMilestoneId}-f${(milestone?.features.length ?? 0) + 1}`;
          this.state.missionPlan = appendFeaturesToMilestone(missionPlan, activeMilestoneId, [{
            id: nextId,
            description: `Resolve merge conflict for ${branchName}`,
            status: 'pending',
            attempts: 0,
            model: 'codex',
          }]);
        }
        this.state.gitStrategy = this.state.gitStrategy
          ? updateFeatureBranchStatus(this.state.gitStrategy, branchName, 'abandoned')
          : this.state.gitStrategy;
        await saveGitStrategyState(this.config.melosDir, this.state.gitStrategy!);
        checkoutBranch(this.config.cwd, baseBranch);
        return `${report.summary}\nMerge conflict detected for ${branchName}`;
      }

      mergeBranch(this.config.cwd, branchName, baseBranch);
      this.emitEvent('branch_merged', 'system', {
        branchName,
        baseBranch,
      });
      this.state.gitStrategy = this.state.gitStrategy
        ? updateFeatureBranchStatus(this.state.gitStrategy, branchName, 'merged', { mergedAt: new Date().toISOString() })
        : this.state.gitStrategy;
      await saveGitStrategyState(this.config.melosDir, this.state.gitStrategy!);
      checkoutBranch(this.config.cwd, baseBranch);

      return report.summary;
    } catch (error) {
      try {
        checkoutBranch(this.config.cwd, baseBranch);
      } catch {
        // ignore cleanup failure
      }
      this.emitEvent('error', 'system', {
        message: `git post process failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      return `${report.summary}\nGit post process failed`;
    }
  }

  private async resolveValidationEscalation(
    milestone: Milestone
  ): Promise<'retry' | 'skip' | 'abort' | 'modify'> {
    if (!this.config.interactivePlanning || !process.stdin.isTTY) {
      return 'retry';
    }

    const promptMessage = this.isTuiInputMode()
      ? 'Validation loop detected (single key): r=retry / s=skip / a=abort / m=modify'
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

  private async promptPlanApproval(): Promise<boolean> {
    if (!process.stdin.isTTY) {
      return true;
    }

    const promptMessage = this.isTuiInputMode()
      ? 'Awaiting approval (single key): y=approve / Ctrl+C=abort'
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

  private ensureMelosDir(): void {
    mkdirSync(this.config.melosDir, { recursive: true });
    mkdirSync(join(this.config.melosDir, 'validations'), { recursive: true });
  }

  private emitEvent(
    type: Parameters<EventLog['emit']>[0]['type'],
    agent: Parameters<EventLog['emit']>[0]['agent'],
    payload: Record<string, unknown>
  ): void {
    const iteration = this.state.missionPlan?.totalIterations ?? this.state.iteration;
    const event = this.eventLog.emit({
      type,
      agent,
      iteration,
      payload,
    });
    this.kernelState = reduceMissionEvent(this.kernelState, event);
    this.kernelState.missionPlan = this.state.missionPlan;
    this.watchdog.touch();
    this.scheduleStatusRefresh();
  }

  private scheduleStatusRefresh(): void {
    if (!this.config.onStatusUpdate || !this.state.missionPlan) {
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

  private startManagerHeartbeat(input: {
    phase: 'planning' | 'briefing' | 'followup';
    message: string;
    milestoneId?: string;
    featureId?: string;
  }): void {
    this.stopManagerHeartbeat();
    const startedAt = Date.now();
    this.managerHeartbeatTimer = setInterval(() => {
      const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
      this.emitEvent('manager_decision', 'manager', {
        phase: input.phase,
        milestoneId: input.milestoneId,
        featureId: input.featureId,
        message: `${input.message} (${elapsedSec}s elapsed)`,
      });
    }, 5_000);
    this.managerHeartbeatTimer.unref();
  }

  private stopManagerHeartbeat(): void {
    if (!this.managerHeartbeatTimer) {
      return;
    }
    clearInterval(this.managerHeartbeatTimer);
    this.managerHeartbeatTimer = null;
  }

  private async emitStatusUpdate(): Promise<void> {
    if (!this.config.onStatusUpdate || !this.state.missionPlan) {
      return;
    }

    const missionPlan = this.state.missionPlan;
    const missionState = this.buildMissionControlState(missionPlan);
    await this.config.onStatusUpdate(missionState);
  }

  private buildMissionControlState(missionPlan: MissionPlan): MissionControlState {
    const assignments = this.modelRouter.getAssignments();
    const milestones: MissionMilestoneView[] = missionPlan.milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      status: milestone.status,
      order: milestone.order,
      features: milestone.features.map((feature) => ({
        id: feature.id,
        description: feature.description,
        status: feature.status,
        attempts: feature.attempts,
      })),
    }));

    const totalFeatures = missionPlan.milestones.reduce((sum, milestone) => sum + milestone.features.length, 0);
    const completedFeatures = missionPlan.milestones.reduce(
      (sum, milestone) => sum + milestone.features.filter((feature) => feature.status === 'done' || feature.status === 'skipped').length,
      0
    );
    const progressPercent = totalFeatures === 0 ? 0 : Math.floor((completedFeatures / totalFeatures) * 100);

    const progressLabel = `${completedFeatures}/${totalFeatures} (${progressPercent}%)`;
    const elapsedLabel = formatElapsed(this.state.startedAt);
    const activity = this.resolveActivityLabel(missionPlan);
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

    return {
      missionId: missionPlan.mission.id ?? this.resolveMissionId(),
      missionTitle: missionPlan.mission.goal,
      missionState: missionPlan.state,
      prdPreviewLines: buildPrdPreviewLines(this.state.prd),
      taskPreviewLines: buildTaskPreviewLines(missionPlan),
      activity,
      elapsedLabel,
      progressLabel,
      progressPercent,
      activeMilestoneId: missionPlan.activeMilestoneId,
      activeFeatureId: missionPlan.activeFeatureId,
      activeBranch,
      milestones,
      progressLog: this.kernelState.progressLog.slice(-80),
      managerLog: (this.kernelState.managerLog ?? []).slice(-120),
      workerRuns,
      modelAssignments: assignments,
      tokenUsage: this.tokenTracker.getSnapshot(),
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
        return missionPlan.activeFeatureId
          ? `Running ${missionPlan.activeFeatureId}...`
          : 'Running mission iteration...';
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
      '## Token Usage',
      '',
      `Estimated cost: $${this.tokenTracker.getEstimatedCost().toFixed(4)}`,
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

  const heading = prd.split(/\r?\n/).find((line) => line.startsWith('# '));
  if (!heading) {
    return null;
  }

  const goal = heading.replace(/^#\s+/, '').trim();
  return goal.length > 0 ? goal : null;
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

function buildTaskPreviewLines(missionPlan: MissionPlan): string[] {
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
      lines.push(
        `  ${activeMark}${asFeatureCheckbox(feature.status)} ${feature.id} [${feature.status}] attempts=${feature.attempts} ${feature.description}`
      );
    }
    const validationChecks = [
      ...milestone.validationContract.staticChecks,
      ...milestone.validationContract.testSuites,
      ...(milestone.validationContract.e2eChecks ?? []),
      ...(milestone.validationContract.manualSteps ?? []),
    ];
    if (validationChecks.length > 0) {
      lines.push('  validation checks:');
      for (const check of validationChecks) {
        const command = typeof check.command === 'string' && check.command.trim().length > 0
          ? check.command
          : '(manual or not specified)';
        lines.push(`    - [${check.passed ? 'x' : ' '}] ${check.id} (${check.type}) :: ${command}`);
      }
    }
    lines.push('');
  }

  lines.push('Raw TASK.json');
  lines.push('```json');
  lines.push(...JSON.stringify(missionPlan, null, 2).split(/\r?\n/));
  lines.push('```');
  return lines;
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
  return truncateMessage(compact, 140);
}

export function formatAgentEventDetail(method: string, params: unknown): string | null {
  const safeMethod = method.trim();
  if (!safeMethod) {
    return null;
  }
  const safeMethodLower = safeMethod.toLowerCase();

  if (
    safeMethodLower.includes('token_count')
    || safeMethodLower.includes('ratelimits')
    || safeMethodLower.includes('thread/tokenusage')
    || safeMethodLower.includes('agent_message_delta')
    || safeMethodLower.includes('agent_message_content_delta')
    || safeMethodLower.includes('agentmessage/delta')
    || safeMethodLower.includes('reasoning')
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
      return command ? `Execute ${truncateMessage(command, 120)}` : 'Execute command';
    }
    if (type === 'fileread') {
      const filePath = extractString(item, 'filePath') ?? extractString(item, 'file_path');
      if (!filePath) {
        return 'Read file';
      }
      const limit = extractNumber(item, 'limit');
      return limit !== null ? `Read ${filePath} (${limit} lines)` : `Read ${filePath}`;
    }
    if (type === 'filewrite' || type === 'fileedit') {
      const filePath = extractString(item, 'filePath') ?? extractString(item, 'file_path');
      return filePath ? `Write ${filePath}` : 'Write file';
    }
    if (type === 'filechange') {
      const filePath = extractFirstFileChangePath(item);
      return filePath ? `Write ${filePath}` : 'Write file';
    }
    if (type === 'mcptoolcall') {
      const server = extractString(item, 'server');
      const tool = extractString(item, 'tool');
      if (server && tool) {
        return `Tool ${server}/${tool}`;
      }
      return tool ? `Tool ${tool}` : null;
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
        exitCode !== null ? `exit ${exitCode}` : null,
        durationMs !== null ? `${durationMs}ms` : null,
      ].filter((v): v is string => v !== null);
      return parts.length > 0 ? `Command finished (${parts.join(', ')})` : 'Command finished';
    }
    if (type === 'filechange') {
      const filePath = extractFirstFileChangePath(item);
      if (filePath) {
        return `Write completed ${filePath}`;
      }
      return 'Write completed';
    }
    if (type === 'mcptoolcall') {
      const tool = extractString(item, 'tool');
      const error = extractString(item, 'error');
      if (error) {
        return tool ? `Tool failed ${tool}` : 'Tool call failed';
      }
      return tool ? `Tool completed ${tool}` : 'Tool call completed';
    }
    return null;
  }

  if (safeMethod.endsWith('/outputDelta')) {
    return null;
  }

  if (safeMethod.endsWith('/delta')) {
    const delta = extractString(params, 'delta');
    const normalized = delta ? normalizeStreamingText(delta) : null;
    return normalized && isMeaningfulLogFragment(normalized) ? `Message ${normalized}` : null;
  }

  if (safeMethod.endsWith('/tool_use')) {
    const name = extractString(params, 'name');
    const input = extractRecord(params, 'input');
    if (!name) {
      return null;
    }
    if (name === 'Bash') {
      const command = extractString(input, 'command');
      return command ? `Execute ${truncateMessage(command, 120)}` : 'Execute command';
    }
    if (name === 'Read') {
      const filePath = extractString(input, 'file_path');
      const limit = extractNumber(input, 'limit');
      if (!filePath) {
        return 'Read file';
      }
      return limit !== null ? `Read ${filePath} (${limit} lines)` : `Read ${filePath}`;
    }
    if (name === 'Write' || name === 'Edit') {
      const filePath = extractString(input, 'file_path');
      return filePath ? `Write ${filePath}` : 'Write file';
    }
    return `Tool ${name}`;
  }

  if (safeMethod.endsWith('/tool_result')) {
    const content = extractString(params, 'content');
    const normalized = content ? normalizeStreamingText(content) : null;
    if (!normalized || !isMeaningfulLogFragment(normalized)) {
      return null;
    }
    return `Result ${normalized}`;
  }

  if (safeMethod.endsWith('/result')) {
    return null;
  }

  return null;
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
  return true;
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
