import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendFeaturesToMilestone,
  areAllMilestonesDone,
  areMilestoneFeaturesDone,
  createMissionPlan,
  getNextPendingFeature,
  getNextPendingMilestone,
  loadMissionPlan,
  saveMissionPlan,
  transitionMissionState,
  updateFeatureStatus,
  updateMilestoneStatus,
} from '../mission.js';

describe('state/mission', () => {
  it('creates mission plan and resolves next pending milestone/feature', () => {
    const plan = createMissionPlan({
      missionId: 'auth',
      goal: 'Auth system',
      milestones: [
        {
          id: 'm1',
          title: 'Core',
          description: 'Implement core',
          status: 'pending',
          order: 1,
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            { id: 'm1-f1', description: 'Core feature', status: 'pending', attempts: 0 },
          ],
        },
      ],
    });

    const m = getNextPendingMilestone(plan);
    expect(m?.id).toBe('m1');

    const f = m ? getNextPendingFeature(m) : null;
    expect(f?.id).toBe('m1-f1');
  });

  it('enforces mission state transitions', () => {
    let plan = createMissionPlan({
      goal: 'Test',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          status: 'pending',
          order: 1,
          validationContract: { staticChecks: [], testSuites: [] },
          features: [{ id: 'm1-f1', description: 'feature', status: 'pending', attempts: 0 }],
        },
      ],
      state: 'planning',
    });

    plan = transitionMissionState(plan, 'awaiting_approval');
    plan = transitionMissionState(plan, 'running');
    plan = transitionMissionState(plan, 'paused');
    plan = transitionMissionState(plan, 'running');
    plan = transitionMissionState(plan, 'completed');

    expect(plan.state).toBe('completed');

    expect(() => transitionMissionState(plan, 'running')).toThrow(/Invalid mission state transition/);
  });

  it('updates feature/milestone statuses and completion checks', () => {
    let plan = createMissionPlan({
      goal: 'Status test',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          status: 'pending',
          order: 1,
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            { id: 'm1-f1', description: 'f1', status: 'pending', attempts: 0 },
            { id: 'm1-f2', description: 'f2', status: 'pending', attempts: 0 },
          ],
        },
      ],
    });

    plan = updateFeatureStatus(plan, 'm1', 'm1-f1', 'done');
    plan = updateFeatureStatus(plan, 'm1', 'm1-f2', 'skipped');

    expect(areMilestoneFeaturesDone(plan.milestones[0])).toBe(true);

    plan = updateMilestoneStatus(plan, 'm1', 'done');
    expect(areAllMilestonesDone(plan)).toBe(true);
  });

  it('appends follow-up features into milestone', () => {
    let plan = createMissionPlan({
      goal: 'Append test',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          status: 'pending',
          order: 1,
          validationContract: { staticChecks: [], testSuites: [] },
          features: [{ id: 'm1-f1', description: 'f1', status: 'pending', attempts: 0 }],
        },
      ],
    });

    plan = appendFeaturesToMilestone(plan, 'm1', [
      { id: 'm1-f2', description: 'follow-up', status: 'pending', attempts: 0, model: 'codex' },
    ]);

    expect(plan.milestones[0].features).toHaveLength(2);
    expect(plan.milestones[0].features[1]?.id).toBe('m1-f2');
    expect(plan.milestones[0].features[1]?.model).toBe('codex');
  });

  it('rejects legacy TASK array (hard cutover: MissionPlan v3 only)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-mission-hard-cutover-'));
    const taskPath = join(dir, 'TASK.json');
    writeFileSync(taskPath, JSON.stringify([
      { id: '1', description: 'legacy task', passes: false },
    ]), 'utf-8');

    await expect(loadMissionPlan(taskPath)).rejects.toThrow(/legacy task array/);
    await expect(loadMissionPlan(taskPath)).rejects.toThrow(/MissionPlan v3/);
  });

  it('shows actionable error when version is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-mission-missing-version-'));
    const taskPath = join(dir, 'TASK.json');
    writeFileSync(taskPath, JSON.stringify({
      mission: { goal: 'x', constraints: [], successCriteria: [] },
      milestones: [],
    }), 'utf-8');

    await expect(loadMissionPlan(taskPath)).rejects.toThrow(/top-level "version" は 2/);
    await expect(loadMissionPlan(taskPath)).rejects.toThrow(/期待形式/);
  });

  it('normalizes missing feature descriptions without crashing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-mission-missing-feature-description-'));
    const taskPath = join(dir, 'TASK.json');
    writeFileSync(taskPath, JSON.stringify({
      version: 2,
      mission: {
        goal: 'Normalization test',
        constraints: ['c1'],
        successCriteria: ['s1'],
      },
      state: 'planning',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          status: 'pending',
          order: 1,
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              status: 'pending',
              attempts: 0,
            },
          ],
        },
      ],
      createdAt: new Date().toISOString(),
      lastTransitionAt: new Date().toISOString(),
      activeMilestoneId: null,
      activeFeatureId: null,
      totalIterations: 0,
    }, null, 2), 'utf-8');

    const loaded = await loadMissionPlan(taskPath);
    expect(loaded.milestones[0]?.features[0]?.description).toBe('No description provided');
  });

  it('migrates legacy model fields into model for v3', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-mission-resolved-model-'));
    const taskPath = join(dir, 'TASK.json');
    writeFileSync(taskPath, JSON.stringify({
      version: 2,
      mission: {
        goal: 'Resolved model normalization',
        constraints: [],
        successCriteria: [],
      },
      state: 'planning',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          status: 'pending',
          order: 1,
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            {
              id: 'm1-f1',
              description: 'unset feature',
              status: 'pending',
              attempts: 0,
              resolvedModel: 'claude',
              resolvedModelSource: 'default',
            },
            {
              id: 'm1-f2',
              description: 'fixed feature',
              status: 'pending',
              attempts: 0,
              model: 'codex',
              resolvedModel: 'claude',
              resolvedModelSource: 'user',
            },
            {
              id: 'm1-f3',
              description: 'invalid source',
              status: 'pending',
              attempts: 0,
              resolvedModel: 'codex',
              resolvedModelSource: 'invalid',
            },
          ],
        },
      ],
      createdAt: new Date().toISOString(),
      lastTransitionAt: new Date().toISOString(),
      activeMilestoneId: null,
      activeFeatureId: null,
      totalIterations: 0,
    }, null, 2), 'utf-8');

    const loaded = await loadMissionPlan(taskPath);
    expect(loaded.version).toBe(3);
    expect(loaded.milestones[0]?.features[0]?.model).toBe('claude');
    expect(loaded.milestones[0]?.features[1]?.model).toBe('codex');
    expect(loaded.milestones[0]?.features[2]?.model).toBe('codex');
  });

  it('writes only model when mission plan is saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-mission-model-save-'));
    const taskPath = join(dir, 'TASK.json');
    const plan = createMissionPlan({
      goal: 'Save mission plan',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          status: 'pending',
          order: 1,
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            { id: 'm1-f1', description: 'feature', status: 'pending', attempts: 0, model: 'claude' },
          ],
        },
      ],
    });

    await saveMissionPlan(taskPath, plan);

    const saved = JSON.parse(readFileSync(taskPath, 'utf-8')) as {
      milestones: Array<{ features: Array<Record<string, unknown>> }>;
    };
    const feature = saved.milestones[0]?.features[0] ?? {};
    expect(feature.model).toBe('claude');
    expect(feature.requestedModel).toBeUndefined();
    expect(feature.effectiveModel).toBeUndefined();
  });
});
