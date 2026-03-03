import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import { Orchestrator } from '../orchestrator.js';
import { ManagerAgent } from '../agents/manager.js';
import { WorkerAgent } from '../agents/worker.js';
import { createMissionPlan } from '../state/mission.js';
import type { MissionControlState } from '../ui/tui-views.js';

describe('Orchestrator v0.8', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs mission state machine to completion', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Sample mission\n\nImplement feature.', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'sample',
      goal: 'Sample mission',
      constraints: ['No backward compatibility'],
      successCriteria: ['tests pass'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Build core',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement core feature',
              status: 'pending',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');
    jest.spyOn(WorkerAgent.prototype, 'run').mockResolvedValue({
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: 'm1',
        featureId: 'm1-f1',
        status: 'SUCCESS',
        summary: 'done',
        filesChanged: [],
        validation: {
          testsRun: true,
          testsPassed: 1,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: [],
        discoveredFeatures: [],
        learnings: [],
        requestsHelp: false,
        tokenUsage: {
          input: 100,
          output: 50,
          cached: 10,
        },
        createdAt: new Date().toISOString(),
      },
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 10,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(result.reason).toBe('completed');
  });

  it('exposes full PRD/TASK content and streams manager logs during planning', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-doc-stream-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(
      prdPath,
      ['# Full PRD', 'line-1', 'line-2', 'line-3', '- checklist 1', '- checklist 2'].join('\n'),
      'utf-8'
    );

    const planned = createMissionPlan({
      missionId: 'doc-stream',
      goal: 'Verify full preview and manager stream',
      constraints: ['No backward compatibility'],
      successCriteria: ['status updates include full content'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'single dry-run feature',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Do work',
              status: 'pending',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockImplementation(async (input) => {
      input.onAppServerEvent?.('item/started', {
        item: {
          type: 'FileRead',
          filePath: 'PRD.md',
          limit: 3,
        },
      });
      return planned;
    });
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');

    const snapshots: MissionControlState[] = [];
    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 2,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: true,
      resume: false,
      onStatusUpdate: async (state) => {
        snapshots.push(state);
      },
    });

    const result = await orchestrator.run();
    expect(result.success).toBe(true);

    const anySnapshot = snapshots.find((state) => state.prdPreviewLines && state.taskPreviewLines);
    expect(anySnapshot?.prdPreviewLines).toEqual(expect.arrayContaining(['line-1', 'line-2', 'line-3']));
    expect(anySnapshot?.taskPreviewLines).toEqual(expect.arrayContaining(['# TASK generation in progress']));

    const plannedSnapshot = snapshots.find((state) =>
      state.taskPreviewLines?.some((line) => line.includes('Milestones / Features'))
    );
    expect(plannedSnapshot?.taskPreviewLines).toEqual(expect.arrayContaining(['Milestones / Features']));
    expect(plannedSnapshot?.taskPreviewLines).toEqual(expect.arrayContaining(['Tip: Open TASK.json directly for raw JSON if needed.']));

    const progressMessages = snapshots.flatMap((state) => state.progressLog.map((entry) => entry.message));
    expect(progressMessages.some((message) => message.includes('planning: Read PRD.md'))).toBe(true);
  });

  it('creates follow-up feature on validation failure and recovers', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-followup-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    const passFlagPath = join(cwd, '.pass-validation');

    writeFileSync(prdPath, '# Validation recovery mission', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'recovery',
      goal: 'Recover from validation failures',
      constraints: ['No backward compatibility'],
      successCriteria: ['Validation passes'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Build and validate',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [
              {
                id: 'flag-check',
                description: 'validation flag exists',
                type: 'command',
                command: `[ -f "${passFlagPath}" ]`,
                passed: false,
                failureCount: 0,
              },
            ],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Initial feature',
              status: 'pending',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');
    jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Create validation pass flag',
        priority: 'high',
        model: 'codex',
      },
    ]);

    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => {
      if (input.feature.id === 'm1-f2') {
        writeFileSync(passFlagPath, 'ok', 'utf-8');
      }
      return {
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: input.milestone.id,
          featureId: input.feature.id,
          status: 'SUCCESS',
          summary: `done ${input.feature.id}`,
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          discoveredFeatures: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 20,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(result.reason).toBe('completed');
    expect(existsSync(passFlagPath)).toBe(true);
  });

  it('replays events after snapshot on resume', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-resume-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Resume mission\n\nReplay after snapshot.', 'utf-8');

    const completedPlan = createMissionPlan({
      missionId: 'resume-test',
      goal: 'Resume replay test',
      constraints: ['No backward compatibility'],
      successCriteria: ['Replay event after snapshot'],
      milestones: [
        {
          id: 'm1',
          title: 'Done',
          description: 'Already completed',
          order: 1,
          status: 'done',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'done',
              status: 'done',
              attempts: 1,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'completed',
    });
    writeFileSync(missionPath, `${JSON.stringify(completedPlan, null, 2)}\n`, 'utf-8');

    const eventsPath = join(melosDir, 'events.jsonl');
    writeFileSync(eventsPath, [
      JSON.stringify({
        seq: 1,
        type: 'mission_started',
        timestamp: '2026-01-01T00:00:00.000Z',
        iteration: 0,
        agent: 'orchestrator',
        payload: { message: 'start' },
      }),
      JSON.stringify({
        seq: 2,
        type: 'command_executed',
        timestamp: '2026-01-01T00:00:01.000Z',
        iteration: 1,
        agent: 'system',
        payload: { command: 'echo before snapshot', exitCode: 0 },
      }),
      JSON.stringify({
        seq: 3,
        type: 'command_executed',
        timestamp: '2026-01-01T00:00:02.000Z',
        iteration: 1,
        agent: 'system',
        payload: { command: 'echo after snapshot', exitCode: 0 },
      }),
      '',
    ].join('\n'), 'utf-8');

    writeFileSync(join(melosDir, 'state.json'), JSON.stringify({
      seq: 2,
      savedAt: '2026-01-01T00:00:01.500Z',
      state: {
        kernel: {
          missionPlan: completedPlan,
          iteration: 1,
          workerRuns: [],
          progressLog: [{ timestamp: '2026-01-01T00:00:01.000Z', message: 'snapshot base' }],
          activeWorkerRunId: null,
          gitStrategy: null,
          tokenUsage: {
            total: { input: 0, output: 0, cached: 0, cost: 0 },
            byRole: {},
          },
        },
      },
    }, null, 2), 'utf-8');

    const snapshots: Array<{ progressLog: Array<{ message: string }> }> = [];
    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 3,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: true,
      onStatusUpdate: async (state) => {
        snapshots.push({
          progressLog: state.progressLog.map((entry) => ({ message: entry.message })),
        });
      },
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(result.reason).toBe('completed');
    const flattened = snapshots.flatMap((snapshot) => snapshot.progressLog.map((entry) => entry.message));
    expect(flattened.some((message) => message.includes('echo after snapshot'))).toBe(true);
  });

  it('cycles model assignment for a role from Mission Control command', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-model-cycle-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Model cycle mission\n', 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 1,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: true,
      resume: false,
    });

    const router = (orchestrator as unknown as {
      modelRouter: { getModel: (role: 'validator') => string };
    }).modelRouter;

    expect(router.getModel('validator')).toBe('gpt-5.3-codex');
    await orchestrator.cycleModel('validator');
    expect(router.getModel('validator')).toBe('opus');
    await orchestrator.cycleModel('validator');
    expect(router.getModel('validator')).toBe('sonnet');
  });

  it('executes worker with opus after pre-approval model switch', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-worker-opus-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Worker model switch mission\n\nVerify worker model.', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'worker-opus',
      goal: 'Verify worker model switch before approval',
      constraints: ['No backward compatibility'],
      successCriteria: ['worker uses opus'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Single feature execution',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement feature',
              status: 'pending',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');

    const workerInputs: Array<{ featureModel?: string }> = [];
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => {
      workerInputs.push({ featureModel: input.feature.model });
      return {
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: input.milestone.id,
          featureId: input.feature.id,
          status: 'SUCCESS',
          summary: 'done',
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          discoveredFeatures: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
    });

    const states: Array<{
      workerModel: string;
      workerRuns: Array<{ engine?: string; model?: string }>;
    }> = [];

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 10,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
      onStatusUpdate: async (state) => {
        states.push({
          workerModel: state.modelAssignments.worker.model,
          workerRuns: state.workerRuns.map((run) => ({ engine: run.engine, model: run.model })),
        });
      },
    });

    await orchestrator.cycleModel('worker');
    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(workerInputs).toEqual([{ featureModel: 'claude' }]);
    expect(states.some((state) => state.workerModel === 'opus')).toBe(true);
    expect(
      states.some((state) => state.workerRuns.some((run) => run.engine === 'claude' && run.model === 'opus'))
    ).toBe(true);
  });
});
