import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerResult } from '../agents/types.js';
import { Orchestrator } from '../orchestrator.js';
import { loadSession } from '../state/session.js';

describe('Orchestrator briefing integration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `melos-orchestrator-briefing-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('passes manager briefing to worker execution on dispatch', async () => {
    const orchestrator = new Orchestrator({
      cwd: testDir,
      maxIterations: 5,
      prdFile: join(testDir, 'PRD.md'),
      taskFile: join(testDir, 'TASK.json'),
      progressFile: join(testDir, 'PROGRESS.md'),
      melosDir: join(testDir, '.melos'),
    });

    let capturedBriefing: string | undefined;

    (orchestrator as unknown as {
      manager: {
        run: () => Promise<{ type: 'dispatch_task'; taskId: string; briefing?: string }>;
      };
    }).manager = {
      run: async () => ({
        type: 'dispatch_task',
        taskId: 'task-1',
        briefing: '## リトライコンテキスト\n\n前回失敗したテストを修正する',
      }),
    };

    const workerResult: WorkerResult = {
      type: 'partial',
      report: {
        iteration: 2,
        taskId: 'task-1',
        status: 'PARTIAL',
        summary: 'テストケース追加が未完了',
        filesChanged: [],
        verification: {
          testsRun: true,
          testsPassed: 3,
          testsFailed: 1,
          lintPassed: true,
          typecheckPassed: true,
        },
        successCriteriaResults: [],
        issues: [],
        discoveredTasks: [],
        learnings: [],
        nextSteps: ['token expiry のエッジケーステストを追加'],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    };

    (orchestrator as unknown as {
      runWorker: (task: { id: string; description: string }, briefing?: string) => Promise<WorkerResult>;
    }).runWorker = async (_task, briefing) => {
      capturedBriefing = briefing;
      return workerResult;
    };

    (orchestrator as unknown as {
      state: {
        iteration: number;
        tasks: Array<{ id: string; description: string; passes: boolean }>;
        prd: string | null;
        progress: string | null;
        lastWorkReport: null;
        pendingEscalation: null;
        currentTaskId: string | null;
        pendingSteers: string[];
      };
    }).state = {
      iteration: 2,
      tasks: [{ id: 'task-1', description: 'Retry auth refresh tests', passes: false }],
      prd: null,
      progress: null,
      lastWorkReport: null,
      pendingEscalation: null,
      currentTaskId: null,
      pendingSteers: [],
    };

    const result = await (
      orchestrator as unknown as {
        runIteration: () => Promise<{ reason: string }>;
      }
    ).runIteration();

    expect(result.reason).toBe('continue');
    expect(capturedBriefing).toContain('リトライコンテキスト');
  });

  it('prioritizes resumed task before manager decision', async () => {
    const orchestrator = new Orchestrator({
      cwd: testDir,
      maxIterations: 3,
      prdFile: join(testDir, 'PRD.md'),
      taskFile: join(testDir, 'TASK.json'),
      progressFile: join(testDir, 'PROGRESS.md'),
      melosDir: join(testDir, '.melos'),
      resumeSession: {
        threadId: 'thr_resume',
        currentTaskId: 'task-1',
        iteration: 2,
        interruptedAt: '2026-02-22T00:00:00.000Z',
        model: 'gpt-5.3-codex',
      },
    });

    let runWorkerCount = 0;
    (orchestrator as unknown as {
      runWorker: (task: { id: string; description: string }) => Promise<WorkerResult>;
    }).runWorker = async (task) => {
      runWorkerCount++;
      return {
        type: 'success',
        report: {
          iteration: 2,
          taskId: task.id,
          status: 'SUCCESS',
          summary: 'resumed',
          filesChanged: [],
          verification: {
            testsRun: false,
            testsPassed: 0,
            testsFailed: 0,
            lintPassed: false,
            typecheckPassed: false,
          },
          successCriteriaResults: [],
          issues: [],
          discoveredTasks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
    };

    (orchestrator as unknown as {
      manager: {
        run: () => Promise<{ type: 'dispatch_task'; taskId: string }>;
      };
    }).manager = {
      run: async () => {
        throw new Error('manager should not run before resume task');
      },
    };

    (orchestrator as unknown as {
      state: {
        iteration: number;
        tasks: Array<{ id: string; description: string; passes: boolean }>;
        prd: string | null;
        progress: string | null;
        lastWorkReport: null;
        pendingEscalation: null;
        currentTaskId: string | null;
        pendingSteers: string[];
      };
    }).state = {
      iteration: 2,
      tasks: [{ id: 'task-1', description: 'resume target', passes: false }],
      prd: null,
      progress: null,
      lastWorkReport: null,
      pendingEscalation: null,
      currentTaskId: null,
      pendingSteers: [],
    };

    const result = await (
      orchestrator as unknown as {
        runIteration: () => Promise<{ reason: string }>;
      }
    ).runIteration();

    expect(result.reason).toBe('continue');
    expect(runWorkerCount).toBe(1);
  });

  it('skips worker on resume when dry-run is enabled', async () => {
    const orchestrator = new Orchestrator({
      cwd: testDir,
      maxIterations: 3,
      prdFile: join(testDir, 'PRD.md'),
      taskFile: join(testDir, 'TASK.json'),
      progressFile: join(testDir, 'PROGRESS.md'),
      melosDir: join(testDir, '.melos'),
      dryRun: true,
      resumeSession: {
        threadId: 'thr_resume',
        currentTaskId: 'task-1',
        iteration: 2,
        interruptedAt: '2026-02-22T00:00:00.000Z',
        model: 'gpt-5.3-codex',
      },
    });

    let runWorkerCount = 0;
    (orchestrator as unknown as {
      runWorker: (task: { id: string; description: string }) => Promise<WorkerResult>;
    }).runWorker = async (task) => {
      runWorkerCount++;
      return {
        type: 'success',
        report: {
          iteration: 2,
          taskId: task.id,
          status: 'SUCCESS',
          summary: 'resumed',
          filesChanged: [],
          verification: {
            testsRun: false,
            testsPassed: 0,
            testsFailed: 0,
            lintPassed: false,
            typecheckPassed: false,
          },
          successCriteriaResults: [],
          issues: [],
          discoveredTasks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
    };

    (orchestrator as unknown as {
      state: {
        iteration: number;
        tasks: Array<{ id: string; description: string; passes: boolean }>;
        prd: string | null;
        progress: string | null;
        lastWorkReport: null;
        pendingEscalation: null;
        currentTaskId: string | null;
        pendingSteers: string[];
      };
    }).state = {
      iteration: 2,
      tasks: [{ id: 'task-1', description: 'resume target', passes: false }],
      prd: null,
      progress: null,
      lastWorkReport: null,
      pendingEscalation: null,
      currentTaskId: null,
      pendingSteers: [],
    };

    const result = await (
      orchestrator as unknown as {
        runIteration: () => Promise<{ reason: string }>;
      }
    ).runIteration();

    expect(result.reason).toBe('continue');
    expect(runWorkerCount).toBe(0);
  });

  it('queues steer when active engine is unsupported and forwards it to manager codex', async () => {
    const orchestrator = new Orchestrator({
      cwd: testDir,
      maxIterations: 3,
      prdFile: join(testDir, 'PRD.md'),
      taskFile: join(testDir, 'TASK.json'),
      progressFile: join(testDir, 'PROGRESS.md'),
      melosDir: join(testDir, '.melos'),
    });

    (orchestrator as unknown as {
      worker: { steer: () => Promise<'unsupported'> };
      activeAgent: 'worker';
    }).worker = {
      steer: async () => 'unsupported',
    };
    (orchestrator as unknown as { activeAgent: 'worker' | null }).activeAgent = 'worker';

    const steerResult = await orchestrator.steer('  keep integration tests green  ');
    expect(steerResult).toEqual({
      status: 'queued',
      queuedCount: 1,
      target: 'manager-codex',
    });

    let capturedDeferredSteers: string[] | undefined;
    (orchestrator as unknown as {
      manager: {
        run: (input: { deferredSteers?: string[] }) => Promise<{ type: 'review_complete'; approved: boolean }>;
      };
      activeAgent: 'manager' | 'worker' | null;
    }).manager = {
      run: async (input) => {
        capturedDeferredSteers = input.deferredSteers;
        return { type: 'review_complete', approved: true };
      },
    };
    (orchestrator as unknown as { activeAgent: 'manager' | 'worker' | null }).activeAgent = null;

    const result = await (
      orchestrator as unknown as {
        runIteration: () => Promise<{ reason: string }>;
      }
    ).runIteration();

    expect(result.reason).toBe('continue');
    expect(capturedDeferredSteers).toEqual(['keep integration tests green']);
    expect(
      (orchestrator as unknown as { state: { pendingSteers: string[] } }).state.pendingSteers
    ).toEqual([]);
  });

  it('keeps queued steer when manager is configured with claude', async () => {
    const orchestrator = new Orchestrator({
      cwd: testDir,
      maxIterations: 3,
      prdFile: join(testDir, 'PRD.md'),
      taskFile: join(testDir, 'TASK.json'),
      progressFile: join(testDir, 'PROGRESS.md'),
      melosDir: join(testDir, '.melos'),
      managerModel: 'sonnet',
    });

    (orchestrator as unknown as {
      worker: { steer: () => Promise<'unsupported'> };
      activeAgent: 'worker';
    }).worker = {
      steer: async () => 'unsupported',
    };
    (orchestrator as unknown as { activeAgent: 'worker' | null }).activeAgent = 'worker';
    await orchestrator.steer('remember to split large commits');
    (orchestrator as unknown as { activeAgent: 'manager' | 'worker' | null }).activeAgent = null;

    let capturedDeferredSteers: string[] | undefined;
    (orchestrator as unknown as {
      manager: {
        run: (input: { deferredSteers?: string[] }) => Promise<{ type: 'review_complete'; approved: boolean }>;
      };
    }).manager = {
      run: async (input) => {
        capturedDeferredSteers = input.deferredSteers;
        return { type: 'review_complete', approved: true };
      },
    };

    const result = await (
      orchestrator as unknown as {
        runIteration: () => Promise<{ reason: string }>;
      }
    ).runIteration();

    expect(result.reason).toBe('continue');
    expect(capturedDeferredSteers).toBeUndefined();
    expect(
      (orchestrator as unknown as { state: { pendingSteers: string[] } }).state.pendingSteers
    ).toEqual(['remember to split large commits']);
  });

  it('saves pending steers to SESSION.json even when no task is running', async () => {
    const melosDir = join(testDir, '.melos');
    const orchestrator = new Orchestrator({
      cwd: testDir,
      maxIterations: 3,
      prdFile: join(testDir, 'PRD.md'),
      taskFile: join(testDir, 'TASK.json'),
      progressFile: join(testDir, 'PROGRESS.md'),
      melosDir,
    });

    (orchestrator as unknown as {
      state: {
        iteration: number;
        tasks: null;
        prd: null;
        progress: null;
        lastWorkReport: null;
        pendingEscalation: null;
        currentTaskId: string | null;
        pendingSteers: string[];
      };
    }).state = {
      iteration: 4,
      tasks: null,
      prd: null,
      progress: null,
      lastWorkReport: null,
      pendingEscalation: null,
      currentTaskId: null,
      pendingSteers: ['review retry strategy'],
    };

    await expect(orchestrator.saveSession()).resolves.toBe(true);
    await expect(loadSession(melosDir)).resolves.toMatchObject({
      iteration: 4,
      pendingSteers: ['review retry strategy'],
    });
  });
});
