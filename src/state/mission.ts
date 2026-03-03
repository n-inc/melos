import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { ValidationContract } from './validation.js';
import { normalizeValidationContract } from './validation.js';

export type MissionState =
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'aborted';

export type FeatureStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
export type MilestoneStatus =
  | 'pending'
  | 'in_progress'
  | 'validating'
  | 'done'
  | 'failed'
  | 'skipped';

export interface CheckItem {
  text: string;
  type?: string;
  passed?: boolean;
}

export interface MissionPlan {
  version: 2;
  mission: {
    id?: string;
    goal: string;
    constraints: string[];
    successCriteria: string[];
    prdFile?: string;
  };
  state: MissionState;
  milestones: Milestone[];
  createdAt: string;
  lastTransitionAt: string;
  activeMilestoneId: string | null;
  activeFeatureId: string | null;
  totalIterations: number;
  approvedAt?: string;
  approvalMethod?: 'auto' | 'interactive';
}

export interface Milestone {
  id: string;
  title: string;
  description: string;
  features: Feature[];
  validationContract: ValidationContract;
  status: MilestoneStatus;
  order: number;
}

export interface Feature {
  id: string;
  description: string;
  checks?: CheckItem[];
  status: FeatureStatus;
  model?: 'claude' | 'codex';
  briefing?: string;
  attempts: number;
  lastReportSummary?: string;
}

const ALLOWED_TRANSITIONS: Record<MissionState, MissionState[]> = {
  planning: ['awaiting_approval', 'aborted', 'failed'],
  awaiting_approval: ['planning', 'running', 'aborted', 'failed'],
  running: ['paused', 'completed', 'failed', 'aborted'],
  paused: ['running', 'aborted', 'failed'],
  completed: [],
  failed: [],
  aborted: [],
};

export function missionFileExists(path: string): boolean {
  return existsSync(path);
}

export async function loadMissionPlan(path: string): Promise<MissionPlan> {
  if (!missionFileExists(path)) {
    throw new Error(`Mission plan file not found: ${path}`);
  }

  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  validateMissionPlan(parsed);
  return normalizeMissionPlan(parsed);
}

export async function saveMissionPlan(path: string, plan: MissionPlan): Promise<void> {
  validateMissionPlan(plan);
  const normalized = normalizeMissionPlan(plan);
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
}

export function createMissionPlan(input: {
  missionId?: string;
  goal: string;
  constraints?: string[];
  successCriteria?: string[];
  prdFile?: string;
  milestones?: Milestone[];
  approvalMethod?: 'auto' | 'interactive';
  state?: MissionState;
}): MissionPlan {
  const now = new Date().toISOString();
  const milestones = normalizeMilestones(input.milestones ?? []);

  return normalizeMissionPlan({
    version: 2,
    mission: {
      id: input.missionId,
      goal: input.goal.trim(),
      constraints: (input.constraints ?? []).map((item) => item.trim()).filter(Boolean),
      successCriteria: (input.successCriteria ?? []).map((item) => item.trim()).filter(Boolean),
      prdFile: input.prdFile,
    },
    state: input.state ?? 'planning',
    milestones,
    createdAt: now,
    lastTransitionAt: now,
    activeMilestoneId: null,
    activeFeatureId: null,
    totalIterations: 0,
    approvalMethod: input.approvalMethod,
    approvedAt: undefined,
  });
}

export function transitionMissionState(
  plan: MissionPlan,
  nextState: MissionState,
  options: { approvedAt?: string; approvalMethod?: 'auto' | 'interactive' } = {}
): MissionPlan {
  const allowed = ALLOWED_TRANSITIONS[plan.state];
  if (!allowed.includes(nextState)) {
    throw new Error(`Invalid mission state transition: ${plan.state} -> ${nextState}`);
  }

  const now = new Date().toISOString();
  const updated: MissionPlan = {
    ...plan,
    state: nextState,
    lastTransitionAt: now,
  };

  if (nextState === 'running' && !updated.approvedAt) {
    updated.approvedAt = options.approvedAt ?? now;
    updated.approvalMethod = options.approvalMethod ?? updated.approvalMethod;
  }

  return normalizeMissionPlan(updated);
}

export function incrementMissionIterations(plan: MissionPlan): MissionPlan {
  return {
    ...plan,
    totalIterations: plan.totalIterations + 1,
  };
}

export function getMilestoneById(plan: MissionPlan, milestoneId: string): Milestone | null {
  return plan.milestones.find((milestone) => milestone.id === milestoneId) ?? null;
}

export function getFeatureById(
  milestone: Milestone,
  featureId: string
): Feature | null {
  return milestone.features.find((feature) => feature.id === featureId) ?? null;
}

export function getActiveMilestone(plan: MissionPlan): Milestone | null {
  if (!plan.activeMilestoneId) {
    return null;
  }
  return getMilestoneById(plan, plan.activeMilestoneId);
}

export function getActiveFeature(plan: MissionPlan): Feature | null {
  const milestone = getActiveMilestone(plan);
  if (!milestone || !plan.activeFeatureId) {
    return null;
  }
  return getFeatureById(milestone, plan.activeFeatureId);
}

export function getNextPendingMilestone(plan: MissionPlan): Milestone | null {
  const milestones = [...plan.milestones].sort((a, b) => a.order - b.order);
  return milestones.find((milestone) => milestone.status === 'pending' || milestone.status === 'in_progress') ?? null;
}

export function getNextPendingFeature(milestone: Milestone): Feature | null {
  return milestone.features.find((feature) => feature.status === 'pending') ?? null;
}

export function areMilestoneFeaturesDone(milestone: Milestone): boolean {
  return milestone.features.every((feature) => feature.status === 'done' || feature.status === 'skipped');
}

export function areAllMilestonesDone(plan: MissionPlan): boolean {
  return plan.milestones.every((milestone) => milestone.status === 'done' || milestone.status === 'skipped');
}

export function setActiveMilestone(plan: MissionPlan, milestoneId: string | null): MissionPlan {
  return {
    ...plan,
    activeMilestoneId: milestoneId,
    activeFeatureId: milestoneId ? plan.activeFeatureId : null,
  };
}

export function setActiveFeature(plan: MissionPlan, featureId: string | null): MissionPlan {
  return {
    ...plan,
    activeFeatureId: featureId,
  };
}

export function updateMilestoneStatus(
  plan: MissionPlan,
  milestoneId: string,
  status: MilestoneStatus
): MissionPlan {
  return {
    ...plan,
    milestones: plan.milestones.map((milestone) =>
      milestone.id === milestoneId
        ? { ...milestone, status }
        : milestone
    ),
  };
}

export function updateFeatureStatus(
  plan: MissionPlan,
  milestoneId: string,
  featureId: string,
  status: FeatureStatus,
  options: { incrementAttempts?: boolean; lastReportSummary?: string; briefing?: string } = {}
): MissionPlan {
  return {
    ...plan,
    milestones: plan.milestones.map((milestone) => {
      if (milestone.id !== milestoneId) {
        return milestone;
      }
      return {
        ...milestone,
        features: milestone.features.map((feature) => {
          if (feature.id !== featureId) {
            return feature;
          }

          const attempts = options.incrementAttempts ? feature.attempts + 1 : feature.attempts;
          return {
            ...feature,
            status,
            attempts,
            lastReportSummary: options.lastReportSummary ?? feature.lastReportSummary,
            briefing: options.briefing ?? feature.briefing,
          };
        }),
      };
    }),
  };
}

export function appendFeaturesToMilestone(
  plan: MissionPlan,
  milestoneId: string,
  features: Feature[]
): MissionPlan {
  if (features.length === 0) {
    return plan;
  }

  return {
    ...plan,
    milestones: plan.milestones.map((milestone) => {
      if (milestone.id !== milestoneId) {
        return milestone;
      }

      const normalizedFeatures = features.map((feature, index) =>
        normalizeFeature({
          ...feature,
          id: asTrimmedString(feature.id) || `${milestoneId}-f${milestone.features.length + index + 1}`,
        })
      );

      return {
        ...milestone,
        features: [...milestone.features, ...normalizedFeatures],
      };
    }),
  };
}

function normalizeMissionPlan(plan: MissionPlan): MissionPlan {
  const milestones = normalizeMilestones(plan.milestones);

  let activeMilestoneId = plan.activeMilestoneId;
  if (activeMilestoneId && !milestones.some((milestone) => milestone.id === activeMilestoneId)) {
    activeMilestoneId = null;
  }

  let activeFeatureId = plan.activeFeatureId;
  if (activeMilestoneId) {
    const milestone = milestones.find((item) => item.id === activeMilestoneId);
    if (!milestone || !milestone.features.some((feature) => feature.id === activeFeatureId)) {
      activeFeatureId = null;
    }
  } else {
    activeFeatureId = null;
  }

  return {
    ...plan,
    mission: {
      ...plan.mission,
      goal: asTrimmedString(plan.mission.goal) || 'Untitled mission',
      constraints: normalizeStringList(plan.mission.constraints),
      successCriteria: normalizeStringList(plan.mission.successCriteria),
      prdFile: asTrimmedString(plan.mission.prdFile) || undefined,
      id: asTrimmedString(plan.mission.id) || undefined,
    },
    milestones,
    totalIterations: Math.max(0, Math.floor(plan.totalIterations)),
    activeMilestoneId,
    activeFeatureId,
  };
}

function normalizeMilestones(milestones: Milestone[]): Milestone[] {
  return [...milestones]
    .map((milestone, index) => normalizeMilestone(milestone, index))
    .sort((a, b) => a.order - b.order);
}

function normalizeMilestone(milestone: Milestone, index: number): Milestone {
  const order = Number.isFinite(milestone.order) ? Math.floor(milestone.order) : index + 1;
  const normalizedId = asTrimmedString(milestone.id) || `m${index + 1}`;
  return {
    id: normalizedId,
    title: asTrimmedString(milestone.title) || `Milestone ${index + 1}`,
    description: asTrimmedString(milestone.description) || 'No description provided',
    features: milestone.features.map((feature, featureIndex) =>
      normalizeFeature(feature, `${normalizedId}-f${featureIndex + 1}`)
    ),
    validationContract: normalizeValidationContract(milestone.validationContract),
    status: milestone.status,
    order,
  };
}

function normalizeFeature(feature: Feature, fallbackId?: string): Feature {
  const normalizedId = asTrimmedString(feature.id) || fallbackId || 'feature-1';
  return {
    id: normalizedId,
    description: asTrimmedString(feature.description) || 'No description provided',
    checks: feature.checks?.map((check) => ({
      text: check.text,
      type: check.type,
      passed: check.passed,
    })),
    status: feature.status,
    model: feature.model,
    briefing: asTrimmedString(feature.briefing) || undefined,
    attempts: Math.max(0, Math.floor(feature.attempts)),
    lastReportSummary: asTrimmedString(feature.lastReportSummary) || undefined,
  };
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => asTrimmedString(value))
    .filter((value) => value.length > 0);
}

function validateMissionPlan(plan: unknown): asserts plan is MissionPlan {
  if (typeof plan !== 'object' || plan === null) {
    throw new Error(
      'TASK.json の形式が不正です。Melos v0.8 では MissionPlan v2 オブジェクトのみ対応しています。'
    );
  }

  if (Array.isArray(plan)) {
    throw new Error([
      'TASK.json の形式が不正です: legacy task array は v0.8 でサポートされません（hard cutover）。',
      '期待形式: {"version":2,"mission":{...},"milestones":[...]}',
      '対応方法: TASK.json を MissionPlan v2 に置き換えてください。',
    ].join('\n'));
  }

  const candidate = plan as Record<string, unknown>;
  if (candidate.version !== 2) {
    const received = candidate.version === undefined
      ? 'undefined'
      : JSON.stringify(candidate.version);
    throw new Error([
      `TASK.json の形式が不正です: top-level "version" は 2 である必要があります（received=${received}）。`,
      '期待形式: {"version":2,"mission":{...},"milestones":[...]}',
      '対応方法: TASK.json を MissionPlan v2 に置き換えてください。',
    ].join('\n'));
  }

  const missionPlan = plan as MissionPlan;

  if (!missionPlan.mission || typeof missionPlan.mission.goal !== 'string' || missionPlan.mission.goal.trim().length === 0) {
    throw new Error('Mission goal is required');
  }

  if (!Array.isArray(missionPlan.milestones) || missionPlan.milestones.length === 0) {
    throw new Error('At least one milestone is required');
  }

  const milestoneIds = new Set<string>();
  for (const milestone of missionPlan.milestones) {
    if (!milestone.id || milestone.id.trim().length === 0) {
      throw new Error('Milestone id is required');
    }
    if (milestoneIds.has(milestone.id)) {
      throw new Error(`Duplicate milestone id: ${milestone.id}`);
    }
    milestoneIds.add(milestone.id);

    if (!Array.isArray(milestone.features) || milestone.features.length === 0) {
      throw new Error(`Milestone ${milestone.id} must include features`);
    }

    const featureIds = new Set<string>();
    for (const feature of milestone.features) {
      if (!feature.id || feature.id.trim().length === 0) {
        throw new Error(`Feature id is required in milestone ${milestone.id}`);
      }
      if (featureIds.has(feature.id)) {
        throw new Error(`Duplicate feature id in ${milestone.id}: ${feature.id}`);
      }
      featureIds.add(feature.id);
    }
  }
}
