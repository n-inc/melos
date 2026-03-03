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

    const status = await readMissionStatus(rootDir);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(43210);
    expect(status.missionState).toBe('running');
    expect(status.progressLabel).toBe('1/2 (50%)');
    expect(status.lastEventSeq).toBe(11);
    expect(status.lastEventType).toBe('manager_decision');
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
    expect(managerOnly).toHaveLength(1);
    expect(managerOnly[0]?.seq).toBe(2);

    const tailOne = await readMissionLogs(rootDir, {
      afterSeq: 0,
      tail: 1,
    });
    expect(tailOne).toHaveLength(1);
    expect(tailOne[0]?.seq).toBe(3);
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

    const noOpMessage = await applyApprovalDecision(rootDir, 'reject');
    expect(noOpMessage).toContain('No-op');

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
    expect(status.missionState).toBe('unknown');
    expect(status.progressLabel).toBe('0/0 (0%)');
  });

  it('writes approval transition metadata to TASK.json', async () => {
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
    const raw = JSON.parse(readFileSync(missionPath, 'utf-8')) as { approvalMethod?: string; approvedAt?: string };
    expect(raw.approvalMethod).toBe('interactive');
    expect(typeof raw.approvedAt).toBe('string');
  });
});
