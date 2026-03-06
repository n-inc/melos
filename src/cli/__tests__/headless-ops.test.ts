import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { jest } from '@jest/globals';

import {
  applyApprovalDecision,
  readMissionLogs,
  readMissionStatus,
} from '../../cli.js';
import { createMissionPlan, loadMissionPlan, saveMissionPlan } from '../../state/mission.js';
import { saveRuntime } from '../../state/runtime.js';
import { saveSnapshot } from '../../state/snapshot.js';

describe('cli headless operations', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'melos-headless-ops-'));
    mkdirSync(join(rootDir, '.melos'), { recursive: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('reads mission status payload from TASK/events/runtime', async () => {
    const missionPath = join(rootDir, 'TASK.json');
    const mission = createMissionPlan({
      missionId: 'persona-lp',
      goal: 'Persona LP',
      state: 'running',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'in_progress',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            { id: 'm1-f1', description: 'f1', status: 'done', attempts: 1 },
            { id: 'm1-f2', description: 'f2', status: 'in_progress', attempts: 1 },
          ],
        },
      ],
    });
    await saveMissionPlan(missionPath, mission);

    await saveRuntime(join(rootDir, '.melos'), {
      pid: 43210,
      startedAt: '2026-03-03T00:00:00.000Z',
      cwd: rootDir,
    });
    jest.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    writeFileSync(
      join(rootDir, '.melos', 'events.jsonl'),
      `${JSON.stringify({
        seq: 11,
        type: 'manager_decision',
        timestamp: '2026-03-03T00:00:01.000Z',
        iteration: 0,
        agent: 'manager',
        payload: { message: 'pending input cleared' },
      })}\n`,
      'utf-8'
    );
    await saveSnapshot(join(rootDir, '.melos'), {
      seq: 11,
      savedAt: '2026-03-03T00:00:01.000Z',
      state: {
        kernel: {
          missionPlan: mission,
          iteration: 0,
          workerRuns: [],
          progressLog: [],
          managerLog: [],
          logEntries: [],
          currentActor: 'manager',
          activeWorkerRunId: null,
          gitStrategy: null,
          tokenUsage: {
            total: { input: 0, output: 0, cached: 0, cost: 0 },
            byRole: {},
          },
        },
      },
    });

    const status = await readMissionStatus(rootDir);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(43210);
    expect(status.initialized).toBe(true);
    expect(status.mission.state).toBe('running');
    expect(status.mission.progress.label).toBe('1/2 (50%)');
    expect(status.lastEvent?.seq).toBe(11);
    expect(status.lastEvent?.type).toBe('manager_decision');
    expect(status.cursor.nextSeq).toBe(12);
  });

  it('reads logs with after-seq/actor/tail filters', async () => {
    const eventsPath = join(rootDir, '.melos', 'events.jsonl');
    writeFileSync(
      eventsPath,
      [
        {
          seq: 1,
          type: 'mission_started',
          timestamp: '2026-03-03T00:00:00.000Z',
          iteration: 0,
          agent: 'orchestrator',
          payload: {},
        },
        {
          seq: 2,
          type: 'manager_decision',
          timestamp: '2026-03-03T00:00:01.000Z',
          iteration: 0,
          agent: 'manager',
          payload: { message: 'plan_created' },
        },
        {
          seq: 3,
          type: 'worker_started',
          timestamp: '2026-03-03T00:00:02.000Z',
          iteration: 1,
          agent: 'worker',
          payload: { runId: 1 },
        },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf-8'
    );

    const managerOnly = await readMissionLogs(rootDir, {
      afterSeq: 1,
      actor: 'manager',
    });
    expect(managerOnly.entries).toHaveLength(1);
    expect(managerOnly.entries[0]?.seq).toBe(2);
    expect(managerOnly.cursor.nextSeq).toBe(4);

    const tailOne = await readMissionLogs(rootDir, {
      afterSeq: 0,
      tail: 1,
    });
    expect(tailOne.entries).toHaveLength(1);
    expect(tailOne.entries[0]?.seq).toBe(3);
  });

  it('returns empty logs payload when events.jsonl is missing', async () => {
    const logs = await readMissionLogs(rootDir, {
      afterSeq: 0,
      actor: 'all',
    });
    expect(logs.entries).toEqual([]);
    expect(logs.cursor.nextSeq).toBe(0);
  });

  it('approve/reject update awaiting_approval mission state', async () => {
    const missionPath = join(rootDir, 'TASK.json');
    const mission = createMissionPlan({
      missionId: 'review',
      goal: 'Review',
      state: 'awaiting_approval',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'pending',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [{ id: 'm1-f1', description: 'f1', status: 'pending', attempts: 0 }],
        },
      ],
    });
    await saveMissionPlan(missionPath, mission);

    const approveMessage = await applyApprovalDecision(rootDir, 'approve');
    expect(approveMessage).toContain('state=running');
    expect((await loadMissionPlan(missionPath)).state).toBe('running');

    await expect(applyApprovalDecision(rootDir, 'reject')).rejects.toThrow(/awaiting_approval/);

    await saveMissionPlan(missionPath, {
      ...(await loadMissionPlan(missionPath)),
      state: 'awaiting_approval',
    });
    const rejectMessage = await applyApprovalDecision(rootDir, 'reject');
    expect(rejectMessage).toContain('state=planning');
    expect((await loadMissionPlan(missionPath)).state).toBe('planning');
  });

  it('reports unknown mission status when TASK.json is invalid', async () => {
    writeFileSync(join(rootDir, 'TASK.json'), '{invalid', 'utf-8');
    const status = await readMissionStatus(rootDir);
    expect(status.mission.state).toBe('unknown');
    expect(status.mission.progress.label).toBe('0/0 (0%)');
    expect(status.warnings.some((line) => line.includes('TASK.json'))).toBe(true);
  });

  it('transitions TASK.json to running on approval without extra metadata', async () => {
    const missionPath = join(rootDir, 'TASK.json');
    const mission = createMissionPlan({
      missionId: 'meta',
      goal: 'meta',
      state: 'awaiting_approval',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'pending',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [{ id: 'm1-f1', description: 'f1', status: 'pending', attempts: 0 }],
        },
      ],
    });
    await saveMissionPlan(missionPath, mission);

    await applyApprovalDecision(rootDir, 'approve');
    const raw = JSON.parse(readFileSync(missionPath, 'utf-8')) as { state?: string; approvalMethod?: string; approvedAt?: string };
    expect(raw.state).toBe('running');
    expect(raw.approvalMethod).toBeUndefined();
    expect(raw.approvedAt).toBeUndefined();
  });

  it('validates actor filters with explicit error', async () => {
    writeFileSync(
      join(rootDir, '.melos', 'events.jsonl'),
      `${JSON.stringify({
        seq: 1,
        type: 'mission_started',
        timestamp: '2026-03-03T00:00:00.000Z',
        iteration: 0,
        agent: 'orchestrator',
        payload: {},
      })}\n`,
      'utf-8'
    );

    await expect(readMissionLogs(rootDir, {
      afterSeq: 0,
      actor: 'invalid-actor',
    })).rejects.toThrow(/--actor/);
  });
});
