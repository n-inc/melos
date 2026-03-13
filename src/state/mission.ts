import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import type { ValidationContract } from './validation.js';
import { createEmptyValidationContract, normalizeValidationContract } from './validation.js';
import type { ProductReviewContract, ReviewType } from './review.js';
import { normalizeProductReviewContract } from './review.js';
import { CLAUDE_LATEST_ALIAS, CODEX_LATEST_ALIAS, normalizeModelName } from '../models/registry.js';

export type MissionState =
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'aborted';

export type FeatureStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';
export type FeatureKind = 'implementation' | 'qa' | 'review' | 'review_remediation' | 'pull_request' | 'pr_followup';
export type QaPhase = 'baseline' | 'after';
export type FeatureRecoveryStage = 'qa_rerun_attempted' | 'remediation_attempted';
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

export interface FeatureLastExecution {
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'BLOCKED';
  resultKind?: 'implemented' | 'verified_existing' | 'contract_gap' | 'tooling_gap' | 'env_blocked';
  changeScope?: 'tracked' | 'untracked' | 'gitignored' | 'none';
  problemKeys?: string[];
  filesChangedCount: number;
  createdAt?: string;
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
  productReviewContract?: ProductReviewContract;
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
  trackingKey?: string;
  cwd?: string;
  checks?: CheckItem[];
  kind: FeatureKind;
  qaPhase?: QaPhase;
  reviewType?: ReviewType;
  reviewGeneration?: number;
  scopedReviewCheckpointIds?: string[];
  status: FeatureStatus;
  model?: string;
  attempts: number;
  lastExecution?: FeatureLastExecution;
  recoveryStage?: FeatureRecoveryStage;
}

interface CreateMissionFeatureInput extends Omit<Feature, 'model' | 'kind' | 'qaPhase' | 'reviewType' | 'reviewGeneration'> {
  model?: string;
  kind?: FeatureKind;
  qaPhase?: QaPhase;
  reviewType?: ReviewType;
  reviewGeneration?: number;
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

const MISSING_DESCRIPTION_PLACEHOLDER = 'No description provided';
const POST_PR_MILESTONE_TITLE = 'Post-PR Follow-up';
const POST_PR_MILESTONE_DESCRIPTION = 'Create the PR and address actionable PR feedback before mission completion.';
const PULL_REQUEST_FEATURE_DESCRIPTION = 'Create or update GitHub pull request';
const PR_FOLLOWUP_FEATURE_DESCRIPTION = 'Wait for PR feedback and fix actionable issues';
const QA_FEATURE_DESCRIPTION = 'Execute milestone QA checklist';
const BASELINE_QA_FEATURE_DESCRIPTION = 'Capture baseline QA evidence before implementation changes';
const AFTER_QA_FEATURE_DESCRIPTION = 'Execute milestone QA checklist after implementation';

export function missionFileExists(path: string): boolean {
  return existsSync(path);
}

export async function loadMissionPlan(path: string): Promise<MissionPlan> {
  if (!missionFileExists(path)) {
    throw new Error(`Mission plan file not found: ${path}`);
  }

  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  const normalized = normalizeMissionPlan(parsed, { baseDir: dirname(path) });
  validateMissionPlan(normalized);
  return normalized;
}

export async function saveMissionPlan(path: string, plan: MissionPlan): Promise<void> {
  const normalized = normalizeMissionPlan(plan, { baseDir: dirname(path) });
  validateMissionPlan(normalized);
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
}

export function createMissionPlan(input: {
  missionId?: string;
  goal: string;
  constraints?: string[];
  successCriteria?: string[];
  productReviewContract?: ProductReviewContract;
  prdFile?: string;
  milestones?: CreateMissionMilestoneInput[];
  approvalMethod?: 'auto' | 'interactive';
  state?: MissionState;
  baseDir?: string;
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
    productReviewContract: input.productReviewContract,
    activeMilestoneId: null,
    activeFeatureId: null,
    totalIterations: 0,
  }, { baseDir: input.baseDir });
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
  return updateFeature(plan, milestoneId, featureId, (feature) => ({
    ...feature,
    status,
    attempts: options.incrementAttempts ? feature.attempts + 1 : feature.attempts,
  }));
}

export function updateFeatureModel(
  plan: MissionPlan,
  milestoneId: string,
  featureId: string,
  model: string | null
): MissionPlan {
  return updateFeature(plan, milestoneId, featureId, (feature) => ({
    ...feature,
    model: model ?? undefined,
  }));
}

export function updateFeature(
  plan: MissionPlan,
  milestoneId: string,
  featureId: string,
  update: (feature: Feature) => Feature
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
          return update(feature);
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
      const existingBaselineQaFeatures = milestone.features.filter(
        (feature) => feature.kind === 'qa' && feature.qaPhase === 'baseline'
      );
      const existingAfterQaFeatures = milestone.features.filter(
        (feature) => feature.kind === 'qa' && feature.qaPhase !== 'baseline'
      );
      const existingNonQaFeatures = milestone.features.filter((feature) => feature.kind !== 'qa');
      const insertedBaselineQaFeatures = normalizedFeatures.filter(
        (feature) => feature.kind === 'qa' && feature.qaPhase === 'baseline'
      );
      const insertedAfterQaFeatures = normalizedFeatures.filter(
        (feature) => feature.kind === 'qa' && feature.qaPhase !== 'baseline'
      );
      const insertedNonQaFeatures = normalizedFeatures.filter((feature) => feature.kind !== 'qa');

      return {
        ...milestone,
        features: [
          ...existingBaselineQaFeatures,
          ...insertedBaselineQaFeatures,
          ...existingNonQaFeatures,
          ...insertedNonQaFeatures,
          ...existingAfterQaFeatures,
          ...insertedAfterQaFeatures,
        ],
      };
    }),
  };
}

export function ensurePullRequestFollowUpMilestone(plan: MissionPlan): MissionPlan {
  const milestoneIndex = plan.milestones.findIndex((milestone) =>
    milestone.features.some((feature) => feature.kind === 'pull_request' || feature.kind === 'pr_followup')
  );
  if (milestoneIndex >= 0) {
    const milestone = plan.milestones[milestoneIndex]!;
    const hasPullRequest = milestone.features.some((feature) => feature.kind === 'pull_request');
    const hasFollowUp = milestone.features.some((feature) => feature.kind === 'pr_followup');
    if (hasPullRequest && hasFollowUp) {
      return plan;
    }

    const missingFeatures = [
      !hasPullRequest
        ? {
          id: `${milestone.id}-f${milestone.features.length + 1}`,
          description: PULL_REQUEST_FEATURE_DESCRIPTION,
          kind: 'pull_request' as const,
          status: 'pending' as const,
          model: CLAUDE_LATEST_ALIAS,
          attempts: 0,
        }
        : null,
      !hasFollowUp
        ? {
          id: `${milestone.id}-f${milestone.features.length + (hasPullRequest ? 1 : 2)}`,
          description: PR_FOLLOWUP_FEATURE_DESCRIPTION,
          kind: 'pr_followup' as const,
          status: 'pending' as const,
          model: CLAUDE_LATEST_ALIAS,
          attempts: 0,
        }
        : null,
    ].filter((feature): feature is NonNullable<typeof feature> => Boolean(feature));

    return normalizeMissionPlan({
      ...plan,
      milestones: plan.milestones.map((item, index) =>
        index === milestoneIndex
          ? {
            ...item,
            title: POST_PR_MILESTONE_TITLE,
            description: POST_PR_MILESTONE_DESCRIPTION,
            features: [...item.features, ...missingFeatures],
          }
          : item
      ),
    });
  }

  const nextMilestoneId = `m${plan.milestones.length + 1}`;
  return normalizeMissionPlan({
    ...plan,
    milestones: [
      ...plan.milestones,
      {
        id: nextMilestoneId,
        title: POST_PR_MILESTONE_TITLE,
        description: POST_PR_MILESTONE_DESCRIPTION,
        status: 'pending',
        validationContract: createEmptyValidationContract(),
        features: [
          {
            id: `${nextMilestoneId}-f1`,
            description: PULL_REQUEST_FEATURE_DESCRIPTION,
            kind: 'pull_request',
            status: 'pending',
            model: CLAUDE_LATEST_ALIAS,
            attempts: 0,
          },
          {
            id: `${nextMilestoneId}-f2`,
            description: PR_FOLLOWUP_FEATURE_DESCRIPTION,
            kind: 'pr_followup',
            status: 'pending',
            model: CLAUDE_LATEST_ALIAS,
            attempts: 0,
          },
        ],
      },
    ],
  });
}

function normalizeMissionPlan(plan: unknown, options?: { baseDir?: string }): MissionPlan {
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
  const milestones = normalizeMilestones(
    Array.isArray(candidate.milestones) ? candidate.milestones : [],
    options?.baseDir
  );

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
    productReviewContract: normalizeProductReviewContract(candidate.productReviewContract, options?.baseDir),
    totalIterations: normalizeNonNegativeInteger(candidate.totalIterations),
    activeMilestoneId,
    activeFeatureId,
  };
}

function normalizeMilestones(milestones: unknown[], baseDir?: string): Milestone[] {
  return milestones.map((milestone, index) => normalizeMilestone(milestone, index, baseDir));
}

function normalizeMilestone(milestone: unknown, index: number, baseDir?: string): Milestone {
  const rawMilestone = asRecord(milestone);
  const normalizedId = asTrimmedString(rawMilestone.id) || `m${index + 1}`;
  const validationContract = normalizeValidationContract(rawMilestone.validationContract as Partial<ValidationContract> | null | undefined);
  return {
    id: normalizedId,
    title: asTrimmedString(rawMilestone.title) || `Milestone ${index + 1}`,
    description: asTrimmedString(rawMilestone.description) || 'No description provided',
    features: ensureMilestoneQaFeatures(
      normalizedId,
      normalizeFeatureList(rawMilestone.features, normalizedId, baseDir),
      validationContract
    ),
    validationContract,
    status: normalizeMilestoneStatus(rawMilestone.status),
  };
}

function normalizeFeatureList(features: unknown, milestoneId: string, baseDir?: string): Feature[] {
  if (!Array.isArray(features)) {
    return [];
  }
  return features.map((feature, featureIndex) =>
    normalizeFeature(feature, `${milestoneId}-f${featureIndex + 1}`, baseDir)
  );
}

function normalizeFeature(feature: unknown, fallbackId?: string, baseDir?: string): Feature {
  const rawFeature = asRecord(feature);
  const normalizedId = asTrimmedString(rawFeature.id) || fallbackId || 'feature-1';
  const trackingKey = normalizeTrackingKey(rawFeature.trackingKey);
  const checks = normalizeFeatureChecks(rawFeature.checks);
  const reviewType = normalizeReviewType(rawFeature.reviewType);
  const model = normalizeFeatureModel(rawFeature.model)
    ?? normalizeFeatureModel(rawFeature.requestedModel)
    ?? normalizeFeatureModel(rawFeature.effectiveModel)
    ?? normalizeFeatureModel(rawFeature.resolvedModel);
  const scopedReviewCheckpointIds = normalizeStringList(rawFeature.scopedReviewCheckpointIds);
  return {
    id: normalizedId,
    description: synthesizeFeatureDescription(rawFeature, {
      fallbackId: normalizedId,
      trackingKey,
      checks,
    }),
    trackingKey,
    cwd: normalizeFeatureCwd(rawFeature.cwd, baseDir),
    checks,
    kind: normalizeFeatureKind(rawFeature.kind, reviewType),
    qaPhase: normalizeQaPhase(rawFeature.qaPhase, normalizeFeatureKind(rawFeature.kind, reviewType)),
    reviewType,
    reviewGeneration: normalizeReviewGeneration(rawFeature.reviewGeneration),
    scopedReviewCheckpointIds: scopedReviewCheckpointIds.length > 0 ? scopedReviewCheckpointIds : undefined,
    status: normalizeFeatureStatus(rawFeature.status),
    model,
    attempts: normalizeNonNegativeInteger(rawFeature.attempts),
    lastExecution: normalizeFeatureLastExecution(rawFeature.lastExecution),
    recoveryStage: normalizeFeatureRecoveryStage(rawFeature.recoveryStage),
  };
}

function normalizeFeatureCwd(value: unknown, baseDir?: string): string | undefined {
  const raw = asTrimmedString(value);
  if (!raw) {
    return undefined;
  }
  if (isAbsolute(raw)) {
    throw new Error(`Feature cwd must be relative to the repo root: ${raw}`);
  }

  const normalized = normalize(raw);
  if (normalized === '.' || normalized.length === 0) {
    return undefined;
  }
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`Feature cwd must stay inside the repo root: ${raw}`);
  }

  if (baseDir) {
    const resolved = resolve(baseDir, normalized);
    const relativePath = relative(baseDir, resolved);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`Feature cwd must stay inside the repo root: ${raw}`);
    }
  }

  return normalized.replace(/\\/g, '/');
}

function ensureMilestoneQaFeatures(
  milestoneId: string,
  features: Feature[],
  validationContract: ValidationContract
): Feature[] {
  const qaChecks = validationContract.qaChecks ?? [];
  const nonQaFeatures = features.filter((feature) => feature.kind !== 'qa');
  if (qaChecks.length === 0) {
    return nonQaFeatures;
  }

  const existingBaselineQaFeature = features.find((feature) => feature.kind === 'qa' && feature.qaPhase === 'baseline');
  const existingAfterQaFeature = features.find((feature) => feature.kind === 'qa' && feature.qaPhase !== 'baseline');
  const derivedCwd = deriveQaFeatureCwd(nonQaFeatures);
  const needsBaselineQa = qaChecks.some((check) => check.evidenceMode === 'before_after' && check.reproduceBefore === true);
  const baselineQaFeature: Feature | null = needsBaselineQa
    ? {
      id: existingBaselineQaFeature?.id ?? `${milestoneId}-f1-baseline`,
      description: existingBaselineQaFeature?.description?.trim() || BASELINE_QA_FEATURE_DESCRIPTION,
      trackingKey: existingBaselineQaFeature?.trackingKey,
      cwd: existingBaselineQaFeature?.cwd ?? derivedCwd,
      checks: existingBaselineQaFeature?.checks,
      kind: 'qa',
      qaPhase: 'baseline',
      status: existingBaselineQaFeature?.status ?? 'pending',
      model: CODEX_LATEST_ALIAS,
      attempts: existingBaselineQaFeature?.attempts ?? 0,
      lastExecution: existingBaselineQaFeature?.lastExecution,
      recoveryStage: existingBaselineQaFeature?.recoveryStage,
    }
    : null;
  const afterQaFeature: Feature = {
    id: existingAfterQaFeature?.id ?? `${milestoneId}-f${nonQaFeatures.length + (needsBaselineQa ? 2 : 1)}`,
    description: existingAfterQaFeature?.description?.trim() || (needsBaselineQa ? AFTER_QA_FEATURE_DESCRIPTION : QA_FEATURE_DESCRIPTION),
    trackingKey: existingAfterQaFeature?.trackingKey,
    cwd: existingAfterQaFeature?.cwd ?? derivedCwd,
    checks: existingAfterQaFeature?.checks,
    kind: 'qa',
    qaPhase: 'after',
    status: existingAfterQaFeature?.status ?? 'pending',
    model: CODEX_LATEST_ALIAS,
    attempts: existingAfterQaFeature?.attempts ?? 0,
    lastExecution: existingAfterQaFeature?.lastExecution,
    recoveryStage: existingAfterQaFeature?.recoveryStage,
  };

  return [
    ...(baselineQaFeature ? [baselineQaFeature] : []),
    ...nonQaFeatures,
    afterQaFeature,
  ];
}

function deriveQaFeatureCwd(features: Feature[]): string | undefined {
  const uniqueCwds = Array.from(new Set(
    features
      .map((feature) => feature.cwd?.trim())
      .filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0)
  ));
  return uniqueCwds.length === 1 ? uniqueCwds[0] : undefined;
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

function normalizeFeatureLastExecution(value: unknown): FeatureLastExecution | undefined {
  const raw = asRecord(value);
  if (raw.status !== 'SUCCESS' && raw.status !== 'PARTIAL' && raw.status !== 'FAILED' && raw.status !== 'BLOCKED') {
    return undefined;
  }

  const resultKind = raw.resultKind === 'implemented'
    || raw.resultKind === 'verified_existing'
    || raw.resultKind === 'contract_gap'
    || raw.resultKind === 'tooling_gap'
    || raw.resultKind === 'env_blocked'
    ? raw.resultKind
    : undefined;
  const changeScope = raw.changeScope === 'tracked'
    || raw.changeScope === 'untracked'
    || raw.changeScope === 'gitignored'
    || raw.changeScope === 'none'
    ? raw.changeScope
    : undefined;
  const problemKeys = normalizeStringList(raw.problemKeys);
  return {
    status: raw.status,
    resultKind,
    changeScope,
    problemKeys: problemKeys.length > 0 ? problemKeys : undefined,
    filesChangedCount: normalizeNonNegativeInteger(raw.filesChangedCount),
    createdAt: asTrimmedString(raw.createdAt) || undefined,
  };
}

function normalizeFeatureRecoveryStage(value: unknown): FeatureRecoveryStage | undefined {
  return value === 'qa_rerun_attempted' || value === 'remediation_attempted'
    ? value
    : undefined;
}

function normalizeQaPhase(value: unknown, kind: FeatureKind): QaPhase | undefined {
  if (kind !== 'qa') {
    return undefined;
  }
  return value === 'baseline' ? 'baseline' : 'after';
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDescriptionText(value: unknown): string {
  const normalized = asTrimmedString(value);
  if (normalized === MISSING_DESCRIPTION_PLACEHOLDER) {
    return '';
  }
  return normalized;
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

function normalizeFeatureKind(value: unknown, reviewType?: ReviewType): FeatureKind {
  const normalized = asTrimmedString(value);
  if (
    normalized === 'implementation'
    || normalized === 'qa'
    || normalized === 'review'
    || normalized === 'review_remediation'
    || normalized === 'pull_request'
    || normalized === 'pr_followup'
  ) {
    return normalized;
  }
  return reviewType ? 'review' : 'implementation';
}

function normalizeReviewType(value: unknown): ReviewType | undefined {
  const normalized = asTrimmedString(value).toLowerCase();
  if (normalized === 'product' || normalized === 'code') {
    return normalized;
  }
  return undefined;
}

function normalizeReviewGeneration(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized >= 1 ? normalized : undefined;
}

function normalizeTrackingKey(value: unknown): string | undefined {
  const normalized = asTrimmedString(value);
  return normalized.length > 0 ? normalized : undefined;
}

function synthesizeFeatureDescription(
  rawFeature: Record<string, unknown>,
  input: {
    fallbackId: string;
    trackingKey?: string;
    checks?: CheckItem[];
  }
): string {
  const explicitDescription = normalizeDescriptionText(rawFeature.description);
  if (explicitDescription.length > 0) {
    return explicitDescription;
  }

  if (input.checks && input.checks.length > 0) {
    const checkSummary = input.checks
      .map((check) => check.text.trim())
      .filter((text) => text.length > 0)
      .slice(0, 2)
      .join(' / ');
    if (checkSummary.length > 0) {
      return truncateDescription(`Address ${checkSummary}`);
    }
  }

  if (input.trackingKey) {
    return truncateDescription(`Resolve ${humanizeTrackingKey(input.trackingKey)}`);
  }

  return `Feature ${input.fallbackId}`;
}

function humanizeTrackingKey(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateDescription(value: string, maxLength: number = 200): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
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

    const qaFeatures = milestone.features.filter((feature) => feature.kind === 'qa');
    if (qaFeatures.length > 2) {
      throw new Error(`Milestone ${milestone.id} may include at most two qa features`);
    }
    if (qaFeatures.length > 0 && (milestone.validationContract.qaChecks?.length ?? 0) === 0) {
      throw new Error(`Milestone ${milestone.id} has a qa feature but no qaChecks`);
    }
    const qaPhases = new Set(qaFeatures.map((feature) => feature.qaPhase ?? 'after'));
    if (qaPhases.size !== qaFeatures.length) {
      throw new Error(`Milestone ${milestone.id} has duplicate qa phases`);
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
      if (feature.kind === 'review' && !feature.reviewType) {
        throw new Error(`Review feature ${feature.id} must specify reviewType`);
      }
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
