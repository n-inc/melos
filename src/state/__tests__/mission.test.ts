import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendFeaturesToMilestone,
  areAllMilestonesDone,
  areMilestoneFeaturesDone,
  createMissionPlan,
  ensurePullRequestFollowUpMilestone,
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
      {
        id: 'm1-f2',
        description: 'follow-up',
        trackingKey: 'validation-jest-failure',
        kind: 'implementation',
        status: 'pending',
        attempts: 0,
        model: 'codex',
      },
    ]);

    expect(plan.milestones[0].features).toHaveLength(2);
    expect(plan.milestones[0].features[1]?.id).toBe('m1-f2');
    expect(plan.milestones[0].features[1]?.model).toBe('codex-latest');
    expect(plan.milestones[0].features[1]?.trackingKey).toBe('validation-jest-failure');
  });

  it('auto-generates a dedicated qa feature when qaChecks exist and keeps it last', () => {
    let plan = createMissionPlan({
      goal: 'QA plan',
      milestones: [
        {
          id: 'm1',
          title: 'Implementation',
          description: 'desc',
          status: 'pending',
          order: 1,
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'm1-qa-1',
                description: 'Verify hero copy',
                type: 'browser',
                requiredRunner: 'playwright-interactive',
                requiredArtifacts: ['screenshot'],
                passed: false,
                failureCount: 0,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement hero',
              cwd: 'frontend/apps/web',
              status: 'pending',
              attempts: 0,
            },
          ],
        },
      ],
    });

    expect(plan.milestones[0]?.features.map((feature) => ({
      id: feature.id,
      kind: feature.kind,
      cwd: feature.cwd,
      model: feature.model,
    }))).toEqual([
      {
        id: 'm1-f1',
        kind: 'implementation',
        cwd: 'frontend/apps/web',
        model: undefined,
      },
      {
        id: 'm1-f2',
        kind: 'qa',
        cwd: 'frontend/apps/web',
        model: 'codex-latest',
      },
    ]);

    plan = appendFeaturesToMilestone(plan, 'm1', [
      {
        id: 'm1-f3',
        description: 'Fix QA follow-up',
        kind: 'implementation',
        status: 'pending',
        attempts: 0,
      },
    ]);

    expect(plan.milestones[0]?.features.map((feature) => feature.kind)).toEqual([
      'implementation',
      'implementation',
      'qa',
    ]);
    expect(plan.milestones[0]?.features.at(-1)?.id).toBe('m1-f2');
  });

  it('inserts baseline and after qa features when qaChecks require before/after reproduction', () => {
    const plan = createMissionPlan({
      goal: 'QA baseline plan',
      milestones: [
        {
          id: 'm1',
          title: 'Implementation',
          description: 'desc',
          status: 'pending',
          order: 1,
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'm1-qa-1',
                description: 'Verify hero before/after state',
                type: 'browser',
                requiredRunner: 'playwright-interactive',
                requiredArtifacts: ['screenshot'],
                evidenceMode: 'before_after',
                reproduceBefore: true,
                passed: false,
                failureCount: 0,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement hero',
              cwd: 'frontend/apps/web',
              status: 'pending',
              attempts: 0,
            },
          ],
        },
      ],
    });

    expect(plan.milestones[0]?.features.map((feature) => ({
      id: feature.id,
      kind: feature.kind,
      qaPhase: feature.qaPhase,
    }))).toEqual([
      { id: 'm1-f1-baseline', kind: 'qa', qaPhase: 'baseline' },
      { id: 'm1-f1', kind: 'implementation', qaPhase: undefined },
      { id: 'm1-f3', kind: 'qa', qaPhase: 'after' },
    ]);
  });

  it('appends a single post-pr follow-up milestone with claude workers', () => {
    const plan = createMissionPlan({
      goal: 'PR automation',
      milestones: [
        {
          id: 'm1',
          title: 'Implementation',
          description: 'desc',
          status: 'pending',
          order: 1,
          validationContract: { staticChecks: [], testSuites: [] },
          features: [{ id: 'm1-f1', description: 'f1', status: 'pending', attempts: 0 }],
        },
        {
          id: 'm2',
          title: 'Final Review',
          description: 'desc',
          status: 'pending',
          order: 2,
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            {
              id: 'm2-f1',
              description: 'Run final product review',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
          ],
        },
      ],
    });

    const next = ensurePullRequestFollowUpMilestone(plan);
    expect(next.milestones).toHaveLength(3);
    expect(next.milestones[2]).toMatchObject({
      title: 'Post-PR Follow-up',
      features: [
        expect.objectContaining({
          kind: 'pull_request',
          model: 'claude-latest',
        }),
        expect.objectContaining({
          kind: 'pr_followup',
          model: 'claude-latest',
        }),
      ],
    });

    const idempotent = ensurePullRequestFollowUpMilestone(next);
    expect(idempotent.milestones).toHaveLength(3);
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
    expect(loaded.milestones[0]?.features[0]?.description).toBe('Feature m1-f1');
  });

  it('derives feature description from trackingKey when placeholder is stored', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-mission-tracking-key-description-'));
    const taskPath = join(dir, 'TASK.json');
    writeFileSync(taskPath, JSON.stringify({
      version: 3,
      mission: {
        goal: 'Tracking key normalization',
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
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            {
              id: 'm1-f1',
              description: 'No description provided',
              trackingKey: 'shared-jest-root-cause',
              status: 'pending',
              attempts: 0,
            },
          ],
        },
      ],
      activeMilestoneId: null,
      activeFeatureId: null,
      totalIterations: 0,
    }, null, 2), 'utf-8');

    const loaded = await loadMissionPlan(taskPath);
    expect(loaded.milestones[0]?.features[0]?.description).toBe('Resolve shared jest root cause');
    expect(loaded.milestones[0]?.features[0]?.trackingKey).toBe('shared-jest-root-cause');
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
    expect(loaded.milestones[0]?.features[0]?.model).toBe('claude-latest');
    expect(loaded.milestones[0]?.features[1]?.model).toBe('codex-latest');
    expect(loaded.milestones[0]?.features[2]?.model).toBe('codex-latest');
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
    expect(feature.model).toBe('claude-latest');
    expect(feature.requestedModel).toBeUndefined();
    expect(feature.effectiveModel).toBeUndefined();
  });

  it('persists trackingKey when mission plan is saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-mission-tracking-key-save-'));
    const taskPath = join(dir, 'TASK.json');
    const plan = createMissionPlan({
      goal: 'Save tracking key',
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
              description: 'Resolve shared root cause',
              trackingKey: 'shared-root-cause',
              status: 'pending',
              attempts: 0,
            },
          ],
        },
      ],
    });

    await saveMissionPlan(taskPath, plan);

    const saved = JSON.parse(readFileSync(taskPath, 'utf-8')) as {
      milestones: Array<{ features: Array<Record<string, unknown>> }>;
    };
    expect(saved.milestones[0]?.features[0]?.trackingKey).toBe('shared-root-cause');

    const loaded = await loadMissionPlan(taskPath);
    expect(loaded.milestones[0]?.features[0]?.trackingKey).toBe('shared-root-cause');
  });

  it('persists feature cwd when mission plan is saved and loaded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-mission-cwd-save-'));
    const taskPath = join(dir, 'TASK.json');
    const plan = createMissionPlan({
      goal: 'Save feature cwd',
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
              description: 'feature',
              cwd: 'frontend/apps/web',
              status: 'pending',
              attempts: 0,
            },
          ],
        },
      ],
      baseDir: dir,
    });

    await saveMissionPlan(taskPath, plan);

    const raw = JSON.parse(readFileSync(taskPath, 'utf-8')) as {
      milestones: Array<{ features: Array<Record<string, unknown>> }>;
    };
    expect(raw.milestones[0]?.features[0]?.cwd).toBe('frontend/apps/web');

    const loaded = await loadMissionPlan(taskPath);
    expect(loaded.milestones[0]?.features[0]?.cwd).toBe('frontend/apps/web');
  });

  it('rejects absolute feature cwd values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-mission-cwd-absolute-'));
    const taskPath = join(dir, 'TASK.json');
    writeFileSync(taskPath, JSON.stringify({
      version: 3,
      mission: {
        goal: 'Reject absolute cwd',
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
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            {
              id: 'm1-f1',
              description: 'feature',
              cwd: '/tmp/absolute-path',
              status: 'pending',
              attempts: 0,
            },
          ],
        },
      ],
      activeMilestoneId: null,
      activeFeatureId: null,
      totalIterations: 0,
    }, null, 2), 'utf-8');

    await expect(loadMissionPlan(taskPath)).rejects.toThrow(/Feature cwd must be relative/);
  });

  it('rejects feature cwd that escapes the repo root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-mission-cwd-escape-'));
    const taskPath = join(dir, 'TASK.json');
    writeFileSync(taskPath, JSON.stringify({
      version: 3,
      mission: {
        goal: 'Reject escaped cwd',
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
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            {
              id: 'm1-f1',
              description: 'feature',
              cwd: '../outside',
              status: 'pending',
              attempts: 0,
            },
          ],
        },
      ],
      activeMilestoneId: null,
      activeFeatureId: null,
      totalIterations: 0,
    }, null, 2), 'utf-8');

    await expect(loadMissionPlan(taskPath)).rejects.toThrow(/Feature cwd must stay inside the repo root/);
  });
});
