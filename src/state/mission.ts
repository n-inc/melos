import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { ValidationContract } from './validation.js';
import { normalizeValidationContract } from './validation.js';
import { normalizeModelName } from '../models/registry.js';

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
  version: 3;
  mission: {
    id?: string;
    goal: string;
    constraints: string[];
    successCriteria: string[];
  };
  state: MissionState;
  milestones: Milestone[];
  activeMilestoneId: string | null;
  activeFeatureId: string | null;
  totalIterations: number;
}

export interface Milestone {
  id: string;
  title: string;
  description: string;
  features: Feature[];
  validationContract: ValidationContract;
  status: MilestoneStatus;
}

export interface Feature {
  id: string;
  description: string;
  checks?: CheckItem[];
  status: FeatureStatus;
  model?: string;
  attempts: number;
}

interface CreateMissionFeatureInput extends Omit<Feature, 'model'> {
  model?: string;
  requestedModel?: string;
  effectiveModel?: string;
  resolvedModel?: string;
  resolvedModelSource?: 'user' | 'default';
  briefing?: string;
  lastReportSummary?: string;
}

interface CreateMissionMilestoneInput extends Omit<Milestone, 'features'> {
  features: CreateMissionFeatureInput[];
  order?: number;
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
  const normalized = normalizeMissionPlan(parsed);
  validateMissionPlan(normalized);
  return normalized;
}

export async function saveMissionPlan(path: string, plan: MissionPlan): Promise<void> {
  const normalized = normalizeMissionPlan(plan);
  validateMissionPlan(normalized);
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
}

export function createMissionPlan(input: {
  missionId?: string;
  goal: string;
  constraints?: string[];
  successCriteria?: string[];
  prdFile?: string;
  milestones?: CreateMissionMilestoneInput[];
  approvalMethod?: 'auto' | 'interactive';
  state?: MissionState;
}): MissionPlan {
  const milestones = normalizeMilestones(input.milestones ?? []);

  return normalizeMissionPlan({
    version: 3,
    mission: {
      id: input.missionId,
      goal: input.goal.trim(),
      constraints: (input.constraints ?? []).map((item) => item.trim()).filter(Boolean),
      successCriteria: (input.successCriteria ?? []).map((item) => item.trim()).filter(Boolean),
    },
    state: input.state ?? 'planning',
    milestones,
    activeMilestoneId: null,
    activeFeatureId: null,
    totalIterations: 0,
  });
}

export function transitionMissionState(
  plan: MissionPlan,
  nextState: MissionState
): MissionPlan {
  const allowed = ALLOWED_TRANSITIONS[plan.state];
  if (!allowed.includes(nextState)) {
    throw new Error(`Invalid mission state transition: ${plan.state} -> ${nextState}`);
  }
  return normalizeMissionPlan({
    ...plan,
    state: nextState,
  });
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
  return plan.milestones.find((milestone) => milestone.status === 'pending' || milestone.status === 'in_progress') ?? null;
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
  options: { incrementAttempts?: boolean } = {}
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
          };
        }),
      };
    }),
  };
}

export function updateFeatureModel(
  plan: MissionPlan,
  milestoneId: string,
  featureId: string,
  model: string | null
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
          return {
            ...feature,
            model: model ?? undefined,
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

function normalizeMissionPlan(plan: unknown): MissionPlan {
  if (Array.isArray(plan)) {
    throw new Error([
      'TASK.json の形式が不正です: legacy task array は v0.8 でサポートされません（hard cutover）。',
      '期待形式: {"version":3,"mission":{...},"milestones":[...]}',
      '対応方法: TASK.json を MissionPlan v3 に置き換えてください。',
    ].join('\n'));
  }

  if (typeof plan !== 'object' || plan === null) {
    throw new Error(
      'TASK.json の形式が不正です。Melos v0.8 では MissionPlan オブジェクトのみ対応しています。'
    );
  }

  const candidate = plan as Record<string, unknown>;
  const version = candidate.version;
  if (version !== 2 && version !== 3) {
    const received = version === undefined ? 'undefined' : JSON.stringify(version);
    throw new Error([
      `TASK.json の形式が不正です: top-level "version" は 2 または 3 である必要があります（received=${received}）。`,
      '期待形式: {"version":3,"mission":{...},"milestones":[...]}',
      '対応方法: TASK.json を MissionPlan v3 に置き換えてください。',
    ].join('\n'));
  }

  const rawMission = asRecord(candidate.mission);
  const milestones = normalizeMilestones(Array.isArray(candidate.milestones) ? candidate.milestones : []);

  let activeMilestoneId = asTrimmedString(candidate.activeMilestoneId) || null;
  if (activeMilestoneId && !milestones.some((milestone) => milestone.id === activeMilestoneId)) {
    activeMilestoneId = null;
  }

  let activeFeatureId = asTrimmedString(candidate.activeFeatureId) || null;
  if (activeMilestoneId) {
    const milestone = milestones.find((item) => item.id === activeMilestoneId);
    if (!milestone || !milestone.features.some((feature) => feature.id === activeFeatureId)) {
      activeFeatureId = null;
    }
  } else {
    activeFeatureId = null;
  }

  return {
    version: 3,
    mission: {
      goal: asTrimmedString(rawMission.goal) || 'Untitled mission',
      constraints: normalizeStringList(rawMission.constraints),
      successCriteria: normalizeStringList(rawMission.successCriteria),
      id: asTrimmedString(rawMission.id) || undefined,
    },
    state: normalizeMissionState(candidate.state),
    milestones,
    totalIterations: normalizeNonNegativeInteger(candidate.totalIterations),
    activeMilestoneId,
    activeFeatureId,
  };
}

function normalizeMilestones(milestones: unknown[]): Milestone[] {
  return milestones.map((milestone, index) => normalizeMilestone(milestone, index));
}

function normalizeMilestone(milestone: unknown, index: number): Milestone {
  const rawMilestone = asRecord(milestone);
  const normalizedId = asTrimmedString(rawMilestone.id) || `m${index + 1}`;
  return {
    id: normalizedId,
    title: asTrimmedString(rawMilestone.title) || `Milestone ${index + 1}`,
    description: asTrimmedString(rawMilestone.description) || 'No description provided',
    features: normalizeFeatureList(rawMilestone.features, normalizedId),
    validationContract: normalizeValidationContract(rawMilestone.validationContract as Partial<ValidationContract> | null | undefined),
    status: normalizeMilestoneStatus(rawMilestone.status),
  };
}

function normalizeFeatureList(features: unknown, milestoneId: string): Feature[] {
  if (!Array.isArray(features)) {
    return [];
  }
  return features.map((feature, featureIndex) =>
    normalizeFeature(feature, `${milestoneId}-f${featureIndex + 1}`)
  );
}

function normalizeFeature(feature: unknown, fallbackId?: string): Feature {
  const rawFeature = asRecord(feature);
  const normalizedId = asTrimmedString(rawFeature.id) || fallbackId || 'feature-1';
  const model = normalizeFeatureModel(rawFeature.model)
    ?? normalizeFeatureModel(rawFeature.requestedModel)
    ?? normalizeFeatureModel(rawFeature.effectiveModel)
    ?? normalizeFeatureModel(rawFeature.resolvedModel);
  return {
    id: normalizedId,
    description: asTrimmedString(rawFeature.description) || 'No description provided',
    checks: normalizeFeatureChecks(rawFeature.checks),
    status: normalizeFeatureStatus(rawFeature.status),
    model,
    attempts: normalizeNonNegativeInteger(rawFeature.attempts),
  };
}

function normalizeFeatureChecks(value: unknown): CheckItem[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const checks = value
    .filter((check) => typeof check === 'object' && check !== null)
    .map((check) => {
      const record = check as Record<string, unknown>;
      return {
        text: asTrimmedString(record.text),
        type: asTrimmedString(record.type) || undefined,
        passed: typeof record.passed === 'boolean' ? record.passed : undefined,
      };
    })
    .filter((check) => check.text.length > 0);
  return checks.length > 0 ? checks : undefined;
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

function normalizeFeatureModel(value: unknown): string | undefined {
  return normalizeModelName(typeof value === 'string' ? value : undefined);
}

function validateMissionPlan(plan: unknown): asserts plan is MissionPlan {
  if (typeof plan !== 'object' || plan === null) {
    throw new Error(
      'TASK.json の形式が不正です。Melos v0.8 では MissionPlan v3 オブジェクトのみ対応しています。'
    );
  }

  if (Array.isArray(plan)) {
    throw new Error([
      'TASK.json の形式が不正です: legacy task array は v0.8 でサポートされません（hard cutover）。',
      '期待形式: {"version":3,"mission":{...},"milestones":[...]}',
      '対応方法: TASK.json を MissionPlan v3 に置き換えてください。',
    ].join('\n'));
  }

  const candidate = plan as Record<string, unknown>;
  if (candidate.version !== 3) {
    const received = candidate.version === undefined
      ? 'undefined'
      : JSON.stringify(candidate.version);
    throw new Error([
      `TASK.json の形式が不正です: top-level "version" は 3 である必要があります（received=${received}）。`,
      '期待形式: {"version":3,"mission":{...},"milestones":[...]}',
      '対応方法: TASK.json を MissionPlan v3 に置き換えてください。',
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

function normalizeMissionState(value: unknown): MissionState {
  switch (value) {
    case 'planning':
    case 'awaiting_approval':
    case 'running':
    case 'paused':
    case 'completed':
    case 'failed':
    case 'aborted':
      return value;
    default:
      return 'planning';
  }
}

function normalizeMilestoneStatus(value: unknown): MilestoneStatus {
  switch (value) {
    case 'pending':
    case 'in_progress':
    case 'validating':
    case 'done':
    case 'failed':
    case 'skipped':
      return value;
    default:
      return 'pending';
  }
}

function normalizeFeatureStatus(value: unknown): FeatureStatus {
  switch (value) {
    case 'pending':
    case 'in_progress':
    case 'done':
    case 'failed':
    case 'skipped':
      return value;
    default:
      return 'pending';
  }
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
