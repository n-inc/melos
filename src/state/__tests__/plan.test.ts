import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPlan,
  savePlan,
  planExists,
  updateTaskStatus,
  updateCheckStatus,
  updateCheckWithEvidence,
  syncAutoChecksFromVerification,
  getPendingTasks,
  getNextTask,
  isAllTasksCompleted,
  isAllChecksPassed,
  hasValidEvidence,
  addTasks,
  VALID_CHECK_TYPES,
  type Plan,
  type PlanTask,
  type CheckItem,
} from '../plan.js';

describe('plan.ts', () => {
  let testDir: string;
  let planPath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `melos-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    planPath = join(testDir, 'PLAN.json');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('planExists', () => {
    it('returns false when file does not exist', () => {
      expect(planExists(planPath)).toBe(false);
    });

    it('returns true when file exists', async () => {
      await writeFile(planPath, '[]');
      expect(planExists(planPath)).toBe(true);
    });
  });

  describe('loadPlan', () => {
    it('throws error when file does not exist', async () => {
      await expect(loadPlan(planPath)).rejects.toThrow('PLAN.json not found');
    });

    it('throws error when content is not an array', async () => {
      await writeFile(planPath, '{}');
      await expect(loadPlan(planPath)).rejects.toThrow(
        'PLAN.json must be an array'
      );
    });

    it('throws error when task is missing required fields', async () => {
      await writeFile(planPath, '[{"id": "1"}]');
      await expect(loadPlan(planPath)).rejects.toThrow(
        'Task.description must be a string'
      );
    });

    it('loads valid plan correctly', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task 1',
          checks: [
            { text: 'step 1', type: 'manual', passed: false },
            { text: 'step 2', type: 'auto:jest', passed: false },
          ],
          passes: false,
        },
        {
          id: '2',
          description: 'Task 2',
          passes: true,
        },
      ];
      await writeFile(planPath, JSON.stringify(plan));

      const loaded = await loadPlan(planPath);
      expect(loaded).toEqual(plan);
    });
  });

  describe('savePlan', () => {
    it('saves plan as formatted JSON', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task 1',
          passes: false,
        },
      ];

      await savePlan(planPath, plan);
      const loaded = await loadPlan(planPath);
      expect(loaded).toEqual(plan);
    });
  });

  describe('updateTaskStatus', () => {
    it('updates task passes status', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task 1',
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      const updated = await updateTaskStatus(planPath, '1', true);
      expect(updated[0].passes).toBe(true);
    });

    it('throws error when task not found', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task 1',
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      await expect(updateTaskStatus(planPath, '999', true)).rejects.toThrow(
        'Task not found: 999'
      );
    });
  });

  describe('getPendingTasks', () => {
    it('returns only tasks with passes: false', () => {
      const plan: Plan = [
        { id: '1', description: 'Task 1', passes: true },
        { id: '2', description: 'Task 2', passes: false },
        { id: '3', description: 'Task 3', passes: false },
      ];

      const pending = getPendingTasks(plan);
      expect(pending).toHaveLength(2);
      expect(pending.map((t) => t.id)).toEqual(['2', '3']);
    });

    it('preserves original order', () => {
      const plan: Plan = [
        { id: '1', description: 'First task', passes: false },
        { id: '2', description: 'Second task', passes: false },
        { id: '3', description: 'Third task', passes: false },
      ];

      const pending = getPendingTasks(plan);
      expect(pending.map((t) => t.id)).toEqual(['1', '2', '3']);
    });
  });

  describe('getNextTask', () => {
    it('returns undefined when all tasks completed', () => {
      const plan: Plan = [
        { id: '1', description: 'Task 1', passes: true },
      ];

      expect(getNextTask(plan)).toBeUndefined();
    });

    it('returns first pending task', () => {
      const plan: Plan = [
        { id: '1', description: 'First task', passes: false },
        { id: '2', description: 'Second task', passes: false },
      ];

      const next = getNextTask(plan);
      expect(next?.id).toBe('1');
    });
  });

  describe('isAllTasksCompleted', () => {
    it('returns true when all tasks pass', () => {
      const plan: Plan = [
        { id: '1', description: 'Task 1', passes: true },
        { id: '2', description: 'Task 2', passes: true },
      ];

      expect(isAllTasksCompleted(plan)).toBe(true);
    });

    it('returns false when any task fails', () => {
      const plan: Plan = [
        { id: '1', description: 'Task 1', passes: true },
        { id: '2', description: 'Task 2', passes: false },
      ];

      expect(isAllTasksCompleted(plan)).toBe(false);
    });
  });

  describe('addTasks', () => {
    it('adds new tasks to existing plan', async () => {
      const initial: Plan = [
        { id: '1', description: 'Task 1', passes: true },
      ];
      await savePlan(planPath, initial);

      const newTasks: PlanTask[] = [
        {
          id: 'review-1',
          description: '[P1] test: finding',
          passes: false,
        },
      ];

      const updated = await addTasks(planPath, newTasks);
      expect(updated).toHaveLength(2);
      expect(updated[1].id).toBe('review-1');
    });
  });

  describe('checks with type field', () => {
    it('loads plan with checks correctly', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task with checks',
          checks: [
            { text: 'Test passes', type: 'auto:jest', passed: false },
            { text: 'UI displays correctly', type: 'browser', passed: true, screenshot: '' },
          ],
          passes: false,
        },
      ];
      await writeFile(planPath, JSON.stringify(plan));

      const loaded = await loadPlan(planPath);
      expect(loaded[0].checks).toHaveLength(2);
      expect(loaded[0].checks![0].text).toBe('Test passes');
      expect(loaded[0].checks![0].type).toBe('auto:jest');
      expect(loaded[0].checks![0].passed).toBe(false);
      expect(loaded[0].checks![1].type).toBe('browser');
      expect(loaded[0].checks![1].passed).toBe(true);
    });

    it('validates checks structure', async () => {
      // Invalid: checks item missing text
      await writeFile(planPath, JSON.stringify([
        {
          id: '1',
          description: 'Task',
          checks: [{ type: 'manual', passed: false }],
          passes: false,
        },
      ]));
      await expect(loadPlan(planPath)).rejects.toThrow(
        'Task.checks[0].text must be a string'
      );

      // Invalid: checks item missing type
      await writeFile(planPath, JSON.stringify([
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'test', passed: false }],
          passes: false,
        },
      ]));
      await expect(loadPlan(planPath)).rejects.toThrow(
        'Task.checks[0].type must be one of'
      );

      // Invalid: checks item invalid type
      await writeFile(planPath, JSON.stringify([
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'test', type: 'invalid', passed: false }],
          passes: false,
        },
      ]));
      await expect(loadPlan(planPath)).rejects.toThrow(
        'Task.checks[0].type must be one of'
      );

      // Invalid: checks item missing passed
      await writeFile(planPath, JSON.stringify([
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'test', type: 'manual' }],
          passes: false,
        },
      ]));
      await expect(loadPlan(planPath)).rejects.toThrow(
        'Task.checks[0].passed must be a boolean'
      );
    });

    it('validates all check types', () => {
      expect(VALID_CHECK_TYPES).toContain('auto:jest');
      expect(VALID_CHECK_TYPES).toContain('auto:rspec');
      expect(VALID_CHECK_TYPES).toContain('auto:typecheck');
      expect(VALID_CHECK_TYPES).toContain('browser');
      expect(VALID_CHECK_TYPES).toContain('manual');
    });

    it('accepts evidence fields for browser checks', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task with browser check',
          checks: [
            {
              text: 'UI check',
              type: 'browser',
              passed: true,
              screenshot: 'https://r2.example.com/screenshot.png',
            },
          ],
          passes: false,
        },
      ];
      await writeFile(planPath, JSON.stringify(plan));

      const loaded = await loadPlan(planPath);
      expect(loaded[0].checks![0].screenshot).toBe('https://r2.example.com/screenshot.png');
    });

    it('accepts video evidence field', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task with video check',
          checks: [
            {
              text: 'Flow check',
              type: 'browser',
              passed: true,
              video: 'https://r2.example.com/flow.mp4',
            },
          ],
          passes: false,
        },
      ];
      await writeFile(planPath, JSON.stringify(plan));

      const loaded = await loadPlan(planPath);
      expect(loaded[0].checks![0].video).toBe('https://r2.example.com/flow.mp4');
    });

    it('rejects non-string evidence fields', async () => {
      await writeFile(planPath, JSON.stringify([
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'test', type: 'browser', passed: false, screenshot: 123 }],
          passes: false,
        },
      ]));
      await expect(loadPlan(planPath)).rejects.toThrow(
        'Task.checks[0].screenshot must be a string if present'
      );
    });
  });

  describe('updateCheckStatus', () => {
    it('updates specific check passed status', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task',
          checks: [
            { text: 'check 1', type: 'manual', passed: false },
            { text: 'check 2', type: 'manual', passed: false },
          ],
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      const updated = await updateCheckStatus(planPath, '1', 0, true);
      expect(updated[0].checks![0].passed).toBe(true);
      expect(updated[0].checks![1].passed).toBe(false);
    });

    it('throws error when task not found', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'check', type: 'manual', passed: false }],
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      await expect(updateCheckStatus(planPath, '999', 0, true)).rejects.toThrow(
        'Task not found: 999'
      );
    });

    it('throws error when task has no checks', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task',
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      await expect(updateCheckStatus(planPath, '1', 0, true)).rejects.toThrow(
        'Task 1 has no checks'
      );
    });

    it('throws error when check index out of range', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'check', type: 'manual', passed: false }],
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      await expect(updateCheckStatus(planPath, '1', 5, true)).rejects.toThrow(
        'Check index 5 out of range for task 1'
      );
    });
  });

  describe('isAllChecksPassed', () => {
    it('returns true when all checks passed', () => {
      const task: PlanTask = {
        id: '1',
        description: 'Task',
        checks: [
          { text: 'check 1', type: 'manual', passed: true },
          { text: 'check 2', type: 'manual', passed: true },
        ],
        passes: false,
      };

      expect(isAllChecksPassed(task)).toBe(true);
    });

    it('returns false when any check not passed', () => {
      const task: PlanTask = {
        id: '1',
        description: 'Task',
        checks: [
          { text: 'check 1', type: 'manual', passed: true },
          { text: 'check 2', type: 'manual', passed: false },
        ],
        passes: false,
      };

      expect(isAllChecksPassed(task)).toBe(false);
    });

    it('returns true when no checks defined', () => {
      const task: PlanTask = {
        id: '1',
        description: 'Task',
        passes: false,
      };

      expect(isAllChecksPassed(task)).toBe(true);
    });

    it('returns true when checks array is empty', () => {
      const task: PlanTask = {
        id: '1',
        description: 'Task',
        checks: [],
        passes: false,
      };

      expect(isAllChecksPassed(task)).toBe(true);
    });
  });

  describe('hasValidEvidence', () => {
    it('returns true for non-browser checks', () => {
      const check: CheckItem = { text: 'test', type: 'manual', passed: false };
      expect(hasValidEvidence(check)).toBe(true);

      const jestCheck: CheckItem = { text: 'test', type: 'auto:jest', passed: false };
      expect(hasValidEvidence(jestCheck)).toBe(true);
    });

    it('returns false for browser check without evidence', () => {
      const check: CheckItem = { text: 'UI check', type: 'browser', passed: false };
      expect(hasValidEvidence(check)).toBe(false);
    });

    it('returns false for browser check with empty evidence', () => {
      const check: CheckItem = { text: 'UI check', type: 'browser', passed: false, screenshot: '' };
      expect(hasValidEvidence(check)).toBe(false);
    });

    it('returns true for browser check with screenshot', () => {
      const check: CheckItem = {
        text: 'UI check',
        type: 'browser',
        passed: true,
        screenshot: 'https://r2.example.com/screenshot.png',
      };
      expect(hasValidEvidence(check)).toBe(true);
    });

    it('returns true for browser check with video', () => {
      const check: CheckItem = {
        text: 'Flow check',
        type: 'browser',
        passed: true,
        video: 'https://r2.example.com/flow.mp4',
      };
      expect(hasValidEvidence(check)).toBe(true);
    });
  });

  describe('updateCheckWithEvidence', () => {
    it('updates check with screenshot evidence', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task',
          checks: [
            { text: 'UI check', type: 'browser', passed: false, screenshot: '' },
          ],
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      const updated = await updateCheckWithEvidence(planPath, '1', 0, {
        screenshot: 'https://r2.example.com/screenshot.png',
      });
      expect(updated[0].checks![0].screenshot).toBe('https://r2.example.com/screenshot.png');
      expect(updated[0].checks![0].passed).toBe(true);
    });

    it('updates check with video evidence', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task',
          checks: [
            { text: 'Flow check', type: 'browser', passed: false, video: '' },
          ],
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      const updated = await updateCheckWithEvidence(planPath, '1', 0, {
        video: 'https://r2.example.com/flow.mp4',
      });
      expect(updated[0].checks![0].video).toBe('https://r2.example.com/flow.mp4');
      expect(updated[0].checks![0].passed).toBe(true);
    });

    it('throws error when task not found', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'check', type: 'browser', passed: false }],
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      await expect(
        updateCheckWithEvidence(planPath, '999', 0, { screenshot: 'url' })
      ).rejects.toThrow('Task not found: 999');
    });

    it('throws error when check index out of range', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'check', type: 'browser', passed: false }],
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      await expect(
        updateCheckWithEvidence(planPath, '1', 5, { screenshot: 'url' })
      ).rejects.toThrow('Check index 5 out of range for task 1');
    });
  });

  describe('syncAutoChecksFromVerification', () => {
    it('updates auto checks from verification and keeps manual/browser untouched', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task',
          checks: [
            { text: 'Jest', type: 'auto:jest', passed: false },
            { text: 'RSpec', type: 'auto:rspec', passed: false },
            { text: 'Typecheck', type: 'auto:typecheck', passed: false },
            { text: 'Manual', type: 'manual', passed: false },
            { text: 'Browser', type: 'browser', passed: false },
          ],
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      const updated = await syncAutoChecksFromVerification(planPath, '1', {
        testsRun: true,
        testsFailed: 0,
        typecheckPassed: true,
      });

      expect(updated[0].checks![0].passed).toBe(true);
      expect(updated[0].checks![1].passed).toBe(true);
      expect(updated[0].checks![2].passed).toBe(true);
      expect(updated[0].checks![3].passed).toBe(false);
      expect(updated[0].checks![4].passed).toBe(false);
    });

    it('uses granular jest/rspec results when provided', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task',
          checks: [
            { text: 'Jest', type: 'auto:jest', passed: false },
            { text: 'RSpec', type: 'auto:rspec', passed: true },
          ],
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      const updated = await syncAutoChecksFromVerification(planPath, '1', {
        testsRun: true,
        testsFailed: 0,
        jestPassed: true,
        rspecPassed: false,
        typecheckPassed: true,
      });

      expect(updated[0].checks![0].passed).toBe(true);
      expect(updated[0].checks![1].passed).toBe(false);
    });

    it('treats missing counterpart as not-run when only one granular result is provided', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task',
          checks: [
            { text: 'Jest', type: 'auto:jest', passed: true },
            { text: 'RSpec', type: 'auto:rspec', passed: true },
          ],
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      const updated = await syncAutoChecksFromVerification(planPath, '1', {
        testsRun: true,
        testsFailed: 0,
        jestPassed: true,
        typecheckPassed: true,
      });

      expect(updated[0].checks![0].passed).toBe(true);
      expect(updated[0].checks![1].passed).toBe(false);
    });

    it('sets auto:jest/auto:rspec to false when tests are not run', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task',
          checks: [
            { text: 'Jest', type: 'auto:jest', passed: true },
            { text: 'RSpec', type: 'auto:rspec', passed: true },
          ],
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      const updated = await syncAutoChecksFromVerification(planPath, '1', {
        testsRun: false,
        testsFailed: 0,
        typecheckPassed: true,
      });

      expect(updated[0].checks![0].passed).toBe(false);
      expect(updated[0].checks![1].passed).toBe(false);
    });

    it('throws error when task not found', async () => {
      const plan: Plan = [
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'Jest', type: 'auto:jest', passed: false }],
          passes: false,
        },
      ];
      await savePlan(planPath, plan);

      await expect(
        syncAutoChecksFromVerification(planPath, '999', {
          testsRun: true,
          testsFailed: 0,
          typecheckPassed: true,
        })
      ).rejects.toThrow('Task not found: 999');
    });
  });
});
