import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerResult } from '../agents/types.js';
import { Orchestrator } from '../orchestrator.js';

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
      };
    }).state = {
      iteration: 2,
      tasks: [{ id: 'task-1', description: 'Retry auth refresh tests', passes: false }],
      prd: null,
      progress: null,
      lastWorkReport: null,
      pendingEscalation: null,
    };

    const result = await (
      orchestrator as unknown as {
        runIteration: () => Promise<{ reason: string }>;
      }
    ).runIteration();

    expect(result.reason).toBe('continue');
    expect(capturedBriefing).toContain('リトライコンテキスト');
  });
});
