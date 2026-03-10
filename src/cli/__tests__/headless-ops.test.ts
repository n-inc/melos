import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { jest } from '@jest/globals';

import {
  applyApprovalDecision,
  readMissionLogs,
  readMissionStatus,
  resolveGitStrategy,
} from '../../cli.js';
import { createMissionPlan, loadMissionPlan, saveMissionPlan } from '../../state/mission.js';
import { saveRuntime } from '../../state/runtime.js';
import { saveSnapshot } from '../../state/snapshot.js';
import { formatLogStreamLines } from '../../ui/log-stream.js';

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
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'manual-qa',
                description: 'Check browser flow',
                type: 'manual',
                passed: false,
                failureCount: 1,
                lastFailure: 'manual validation was not reported by the worker',
              },
            ],
          },
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
          gitStrategy: {
            config: {
              missionId: 'persona-lp',
              baseBranch: 'main',
              autoPush: false,
              preMergeValidation: true,
              validationCommands: ['npm test'],
              pullRequestEnabled: true,
            },
            activeBranch: 'feature/persona-lp',
            pullRequest: {
              number: 12,
              url: 'https://github.com/example/repo/pull/12',
              title: 'feat: persona lp',
              baseBranch: 'main',
              headBranch: 'feature/persona-lp',
              draft: false,
              action: 'updated',
              updatedAt: '2026-03-03T00:00:01.000Z',
            },
            handledFeedbackIds: ['PRRC_1'],
            lastExternalActivityAt: '2026-03-03T00:05:00.000Z',
            quietUntil: '2026-03-03T00:35:00.000Z',
          },
          warnings: [
            {
              timestamp: '2026-03-03T00:00:00.500Z',
              iteration: 1,
              source: 'worker',
              featureId: 'm1-f2',
              message: 'manual verification is still required',
            },
          ],
          validationEvidence: {},
          latestValidationReport: {
            milestoneId: 'm1',
            timestamp: '2026-03-03T00:00:00.750Z',
            passed: false,
            attempt: 2,
            results: [
              {
                checkId: 'manual-qa',
                passed: false,
                warning: 'manual verification is still required',
                failure: {
                  summary: 'manual validation was not reported by the worker',
                  affectedFiles: [],
                  errorMessages: ['Check browser flow'],
                },
              },
            ],
          },
          featureRetries: [
            {
              milestoneId: 'm1',
              featureId: 'm1-f2',
              nextAttempt: 2,
              dueAt: '2026-03-03T00:00:10.000Z',
              lastStatus: 'FAILED',
              reason: 'manual verification is still required',
            },
          ],
        },
      },
    });

    const status = await readMissionStatus(rootDir);
    expect(status.schemaVersion).toBe(1);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(43210);
    expect(status.initialized).toBe(true);
    expect(status.mission.state).toBe('running');
    expect(status.mission.progress.label).toBe('1/3 (33%)');
    expect(status.lastEvent?.seq).toBe(11);
    expect(status.lastEvent?.type).toBe('manager_decision');
    expect(status.cursor.nextSeq).toBe(12);
    expect(status.validation).toEqual({
      milestoneId: 'm1',
      attempt: 2,
      passed: false,
      failedCheckCount: 1,
      warningCount: 1,
    });
    expect(status.qa).toEqual({
      summaries: [
        {
          milestoneId: 'm1',
          total: 1,
          passed: 0,
          failed: 1,
          pending: 0,
        },
      ],
    });
    expect(status.retry).toEqual({
      queued: [
        {
          milestoneId: 'm1',
          featureId: 'm1-f2',
          nextAttempt: 2,
          dueAt: '2026-03-03T00:00:10.000Z',
          reason: 'manual verification is still required',
        },
      ],
    });
    expect(status.git).toEqual({
      activeBranch: 'feature/persona-lp',
      pullRequest: {
        number: 12,
        url: 'https://github.com/example/repo/pull/12',
        title: 'feat: persona lp',
        baseBranch: 'main',
        headBranch: 'feature/persona-lp',
        draft: false,
        action: 'updated',
        updatedAt: '2026-03-03T00:00:01.000Z',
      },
      quietUntil: '2026-03-03T00:35:00.000Z',
      lastExternalActivityAt: '2026-03-03T00:05:00.000Z',
    });
    expect(status.warnings).toContain('[worker] m1-f2: manual verification is still required');
  });

  it('defaults git validation commands to empty when config does not specify them', () => {
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(rootDir);

    const strategy = resolveGitStrategy(
      {},
      {
        git: {
          enabled: true,
        },
      }
    );

    expect(strategy?.validationCommands).toEqual([]);
    cwdSpy.mockRestore();
  });

  it('does not surface stale warning events when runtime warnings are already cleared', async () => {
    const missionPath = join(rootDir, 'TASK.json');
    const mission = createMissionPlan({
      missionId: 'stale-warning',
      goal: 'Ignore historical warning events in status',
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
            { id: 'm1-f1', description: 'f1', status: 'in_progress', attempts: 1 },
          ],
        },
      ],
    });
    await saveMissionPlan(missionPath, mission);

    await saveSnapshot(join(rootDir, '.melos'), {
      state: {
        kernel: {
          missionPlan: mission,
          warnings: [],
          logEntries: [],
          validationsByMilestone: {},
          evidenceByCheckId: {},
          featureRetries: [],
          gitStrategy: null,
          latestValidationReport: null,
          latestReviewReport: null,
          modelStatesByFeature: {},
          pendingSteers: [],
        },
      },
    });

    writeFileSync(
      join(rootDir, '.melos', 'events.jsonl'),
      `${JSON.stringify({
        seq: 1,
        type: 'warning_emitted',
        timestamp: '2026-03-03T00:00:01.000Z',
        iteration: 1,
        agent: 'worker',
        payload: {
          source: 'worker',
          milestoneId: 'm1',
          featureId: 'm1-f1',
          message: 'historical warning',
        },
      })}\n`,
      'utf-8'
    );

    const status = await readMissionStatus(rootDir);
    expect(status.warnings).not.toContain('[worker] m1-f1: historical warning');
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

  it('preserves multiline log details for human-readable log streams', async () => {
    const eventsPath = join(rootDir, '.melos', 'events.jsonl');
    writeFileSync(
      eventsPath,
      `${JSON.stringify({
        seq: 7,
        type: 'manager_decision',
        timestamp: '2026-03-03T00:00:07.000Z',
        iteration: 0,
        agent: 'manager',
        payload: {
          message: [
            '[WRITE] src/auth.ts (+1 -1)',
            '@@ -10,3 +10,3 @@',
            ' export function auth() {',
            '-  return oldMode;',
            '+  return newMode;',
            ' }',
          ].join('\n'),
        },
      })}\n`,
      'utf-8'
    );

    const logs = await readMissionLogs(rootDir, {
      afterSeq: 0,
      actor: 'all',
    });

    expect(logs.entries).toHaveLength(1);
    expect(logs.entries[0]).toMatchObject({
      seq: 7,
      actor: 'manager',
      kind: 'WRITE',
      message: 'src/auth.ts (+1 -1)',
    });
    expect(logs.entries[0]?.detailLines).toEqual([
      '@@ -10,3 +10,3 @@',
      ' export function auth() {',
      '-  return oldMode;',
      '+  return newMode;',
      ' }',
    ]);
  });

  it('renders warning events as WARN logs', async () => {
    const eventsPath = join(rootDir, '.melos', 'events.jsonl');
    writeFileSync(
      eventsPath,
      `${JSON.stringify({
        seq: 9,
        type: 'warning_emitted',
        timestamp: '2026-03-03T00:00:09.000Z',
        iteration: 1,
        agent: 'worker',
        payload: {
          source: 'validation',
          milestoneId: 'm1',
          checkId: 'manual-qa',
          message: 'manual verification was not reported by the worker',
        },
      })}\n`,
      'utf-8'
    );

    const logs = await readMissionLogs(rootDir, {
      afterSeq: 0,
      actor: 'all',
    });

    expect(logs.entries).toHaveLength(1);
    expect(logs.entries[0]).toMatchObject({
      seq: 9,
      actor: 'validator',
      kind: 'WARN',
      message: '[validation] m1/manual-qa: manual verification was not reported by the worker',
      eventType: 'warning_emitted',
    });
  });

  it('formats plain logs with exploration summaries without changing JSON entries', async () => {
    const eventsPath = join(rootDir, '.melos', 'events.jsonl');
    writeFileSync(
      eventsPath,
      [
        {
          seq: 1,
          type: 'manager_decision',
          timestamp: '2026-03-03T00:00:01.000Z',
          iteration: 0,
          agent: 'manager',
          payload: { message: '[READ] /repo/AGENTS.md (120 lines)' },
        },
        {
          seq: 2,
          type: 'manager_decision',
          timestamp: '2026-03-03T00:00:02.000Z',
          iteration: 0,
          agent: 'manager',
          payload: { message: '[BASH] rg -n "studentPageContent|students\\.lp\\.e2e|\\[\\.\\.\\.slug\\]" src tests pages' },
        },
        {
          seq: 3,
          type: 'manager_decision',
          timestamp: '2026-03-03T00:00:03.000Z',
          iteration: 0,
          agent: 'manager',
          payload: {
            message: [
              '[INFO] 120: studentPageContent.ts',
              '188: students.lp.e2e.ts',
              '201: [...slug].tsx',
            ].join('\n'),
          },
        },
        {
          seq: 4,
          type: 'manager_decision',
          timestamp: '2026-03-03T00:00:04.500Z',
          iteration: 0,
          agent: 'manager',
          payload: { message: '[DONE] exit=0 52ms' },
        },
        {
          seq: 5,
          type: 'manager_decision',
          timestamp: '2026-03-03T00:00:05.000Z',
          iteration: 0,
          agent: 'manager',
          payload: { message: '[INFO] verbose tool output omitted (3797 chars)' },
        },
        {
          seq: 6,
          type: 'command_executed',
          timestamp: '2026-03-03T00:00:06.000Z',
          iteration: 1,
          agent: 'system',
          payload: { command: 'npm test', exitCode: 0 },
        },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf-8'
    );

    const logs = await readMissionLogs(rootDir, {
      afterSeq: 0,
      actor: 'all',
    });
    const plainLines = formatLogStreamLines(logs.entries, {
      useColor: false,
      showSeq: true,
      showActor: true,
      summarizeExploration: true,
    });

    expect(logs.entries).toHaveLength(6);
    expect(plainLines).toContain('#0001 00:00:01 MANAGER    [EXPLORED] 1 file, 3 searches, 1 omitted output');
    expect(plainLines).toContain('  │ Read: AGENTS.md');
    expect(plainLines).toContain('  │ Search: studentPageContent, students.lp.e2e, [...slug]');
    expect(plainLines).not.toContain('exit=0 52ms');
    expect(plainLines).toContain('#0006 00:00:06 WORKER     [BASH] npm test');
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
    expect(status.schemaVersion).toBe(1);
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
