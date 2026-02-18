import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadTasks,
  saveTasks,
  taskFileExists,
  updateTaskStatus,
  updateCheckStatus,
  updateCheckWithEvidence,
  syncAutoChecksFromVerification,
  getPendingTasks,
  getNextTask,
  isAllTasksCompleted,
  isAllChecksPassed,
  hasValidEvidence,
  createMissingReviewTasks,
  addTasks,
  VALID_CHECK_TYPES,
  type TaskList,
  type TaskEntry,
  type CheckItem,
} from '../task.js';

describe('task.ts', () => {
  let testDir: string;
  let taskPath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `melos-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    taskPath = join(testDir, 'TASK.json');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('taskFileExists', () => {
    it('returns false when file does not exist', () => {
      expect(taskFileExists(taskPath)).toBe(false);
    });

    it('returns true when file exists', async () => {
      await writeFile(taskPath, '[]');
      expect(taskFileExists(taskPath)).toBe(true);
    });
  });

  describe('loadTasks', () => {
    it('throws error when file does not exist', async () => {
      await expect(loadTasks(taskPath)).rejects.toThrow('TASK.json not found');
    });

    it('throws error when content is not an array', async () => {
      await writeFile(taskPath, '{}');
      await expect(loadTasks(taskPath)).rejects.toThrow(
        'TASK.json must be an array'
      );
    });

    it('throws error when task is missing required fields', async () => {
      await writeFile(taskPath, '[{"id": "1"}]');
      await expect(loadTasks(taskPath)).rejects.toThrow(
        'Task.description must be a string'
      );
    });

    it('loads valid tasks correctly', async () => {
      const tasks: TaskList = [
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
      await writeFile(taskPath, JSON.stringify(tasks));

      const loaded = await loadTasks(taskPath);
      expect(loaded).toEqual(tasks);
    });
  });

  describe('saveTasks', () => {
    it('saves tasks as formatted JSON', async () => {
      const tasks: TaskList = [
        {
          id: '1',
          description: 'Task 1',
          passes: false,
        },
      ];

      await saveTasks(taskPath, tasks);
      const loaded = await loadTasks(taskPath);
      expect(loaded).toEqual(tasks);
    });
  });

  describe('updateTaskStatus', () => {
    it('updates task passes status', async () => {
      const tasks: TaskList = [
        {
          id: '1',
          description: 'Task 1',
          passes: false,
        },
      ];
      await saveTasks(taskPath, tasks);

      const updated = await updateTaskStatus(taskPath, '1', true);
      expect(updated[0].passes).toBe(true);
    });

    it('throws error when task not found', async () => {
      const tasks: TaskList = [
        {
          id: '1',
          description: 'Task 1',
          passes: false,
        },
      ];
      await saveTasks(taskPath, tasks);

      await expect(updateTaskStatus(taskPath, '999', true)).rejects.toThrow(
        'Task not found: 999'
      );
    });
  });

  describe('getPendingTasks', () => {
    it('returns only tasks with passes: false', () => {
      const tasks: TaskList = [
        { id: '1', description: 'Task 1', passes: true },
        { id: '2', description: 'Task 2', passes: false },
        { id: '3', description: 'Task 3', passes: false },
      ];

      const pending = getPendingTasks(tasks);
      expect(pending).toHaveLength(2);
      expect(pending.map((t) => t.id)).toEqual(['2', '3']);
    });

    it('preserves original order', () => {
      const tasks: TaskList = [
        { id: '1', description: 'First task', passes: false },
        { id: '2', description: 'Second task', passes: false },
        { id: '3', description: 'Third task', passes: false },
      ];

      const pending = getPendingTasks(tasks);
      expect(pending.map((t) => t.id)).toEqual(['1', '2', '3']);
    });
  });

  describe('getNextTask', () => {
    it('returns undefined when all tasks completed', () => {
      const tasks: TaskList = [
        { id: '1', description: 'Task 1', passes: true },
      ];

      expect(getNextTask(tasks)).toBeUndefined();
    });

    it('returns first pending task', () => {
      const tasks: TaskList = [
        { id: '1', description: 'First task', passes: false },
        { id: '2', description: 'Second task', passes: false },
      ];

      const next = getNextTask(tasks);
      expect(next?.id).toBe('1');
    });
  });

  describe('isAllTasksCompleted', () => {
    it('returns true when all tasks pass', () => {
      const tasks: TaskList = [
        { id: '1', description: 'Task 1', passes: true },
        { id: '2', description: 'Task 2', passes: true },
      ];

      expect(isAllTasksCompleted(tasks)).toBe(true);
    });

    it('returns false when any task fails', () => {
      const tasks: TaskList = [
        { id: '1', description: 'Task 1', passes: true },
        { id: '2', description: 'Task 2', passes: false },
      ];

      expect(isAllTasksCompleted(tasks)).toBe(false);
    });
  });

  describe('addTasks', () => {
    it('adds new tasks to existing tasks', async () => {
      const initial: TaskList = [
        { id: '1', description: 'Task 1', passes: true },
      ];
      await saveTasks(taskPath, initial);

      const newTasks: TaskEntry[] = [
        {
          id: 'review-1',
          description: '[P1] test: finding',
          passes: false,
        },
      ];

      const updated = await addTasks(taskPath, newTasks);
      expect(updated).toHaveLength(2);
      expect(updated[1].id).toBe('review-1');
    });
  });

  describe('checks with type field', () => {
    it('loads tasks with checks correctly', async () => {
      const tasks: TaskList = [
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
      await writeFile(taskPath, JSON.stringify(tasks));

      const loaded = await loadTasks(taskPath);
      expect(loaded[0].checks).toHaveLength(2);
      expect(loaded[0].checks![0].text).toBe('Test passes');
      expect(loaded[0].checks![0].type).toBe('auto:jest');
      expect(loaded[0].checks![0].passed).toBe(false);
      expect(loaded[0].checks![1].type).toBe('browser');
      expect(loaded[0].checks![1].passed).toBe(true);
    });

    it('validates checks structure', async () => {
      // Invalid: checks item missing text
      await writeFile(taskPath, JSON.stringify([
        {
          id: '1',
          description: 'Task',
          checks: [{ type: 'manual', passed: false }],
          passes: false,
        },
      ]));
      await expect(loadTasks(taskPath)).rejects.toThrow(
        'Task.checks[0].text must be a string'
      );

      // Missing type: should normalize to manual
      await writeFile(taskPath, JSON.stringify([
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'test', passed: false }],
          passes: false,
        },
      ]));
      const missingTypeLoaded = await loadTasks(taskPath);
      expect(missingTypeLoaded[0].checks![0].type).toBe('manual');

      // Unknown type: should normalize to manual
      await writeFile(taskPath, JSON.stringify([
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'test', type: 'invalid', passed: false }],
          passes: false,
        },
      ]));
      const invalidTypeLoaded = await loadTasks(taskPath);
      expect(invalidTypeLoaded[0].checks![0].type).toBe('manual');

      // Invalid: checks item missing passed
      await writeFile(taskPath, JSON.stringify([
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'test', type: 'manual' }],
          passes: false,
        },
      ]));
      await expect(loadTasks(taskPath)).rejects.toThrow(
        'Task.checks[0].passed must be a boolean'
      );
    });

    it('validates all check types', () => {
      expect(VALID_CHECK_TYPES).toContain('auto:jest');
      expect(VALID_CHECK_TYPES).toContain('auto:rspec');
      expect(VALID_CHECK_TYPES).toContain('auto:lint');
      expect(VALID_CHECK_TYPES).toContain('auto:typecheck');
      expect(VALID_CHECK_TYPES).toContain('browser');
      expect(VALID_CHECK_TYPES).toContain('manual');
    });

    it('accepts evidence fields for browser checks', async () => {
      const tasks: TaskList = [
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
      await writeFile(taskPath, JSON.stringify(tasks));

      const loaded = await loadTasks(taskPath);
      expect(loaded[0].checks![0].screenshot).toBe('https://r2.example.com/screenshot.png');
    });

    it('accepts video evidence field', async () => {
      const tasks: TaskList = [
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
      await writeFile(taskPath, JSON.stringify(tasks));

      const loaded = await loadTasks(taskPath);
      expect(loaded[0].checks![0].video).toBe('https://r2.example.com/flow.mp4');
    });

    it('rejects non-string evidence fields', async () => {
      await writeFile(taskPath, JSON.stringify([
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'test', type: 'browser', passed: false, screenshot: 123 }],
          passes: false,
        },
      ]));
      await expect(loadTasks(taskPath)).rejects.toThrow(
        'Task.checks[0].screenshot must be a string if present'
      );
    });
  });

  describe('review task fields', () => {
    it('accepts valid review task with reviewType and reviewGeneration', async () => {
      const tasks: TaskList = [
        {
          id: 'review-product-g1',
          description: 'product review',
          passes: false,
          reviewType: 'product',
          reviewGeneration: 1,
        },
      ];
      await writeFile(taskPath, JSON.stringify(tasks));

      const loaded = await loadTasks(taskPath);
      expect(loaded[0].reviewType).toBe('product');
      expect(loaded[0].reviewGeneration).toBe(1);
    });

    it('falls back to normal task when reviewType is invalid', async () => {
      await writeFile(taskPath, JSON.stringify([
        {
          id: 'review-1',
          description: 'invalid review',
          passes: false,
          reviewType: 'invalid',
          reviewGeneration: 1,
        },
      ]));
      const loaded = await loadTasks(taskPath);
      expect(loaded[0].reviewType).toBeUndefined();
      expect(loaded[0].reviewGeneration).toBeUndefined();
    });

    it('drops reviewGeneration without reviewType', async () => {
      await writeFile(taskPath, JSON.stringify([
        {
          id: 'review-1',
          description: 'invalid review',
          passes: false,
          reviewGeneration: 1,
        },
      ]));
      const loaded = await loadTasks(taskPath);
      expect(loaded[0].reviewType).toBeUndefined();
      expect(loaded[0].reviewGeneration).toBeUndefined();
    });

    it('drops reviewType without reviewGeneration when id cannot infer generation', async () => {
      await writeFile(taskPath, JSON.stringify([
        {
          id: 'review-1',
          description: 'invalid review',
          passes: false,
          reviewType: 'code',
        },
      ]));
      const loaded = await loadTasks(taskPath);
      expect(loaded[0].reviewType).toBeUndefined();
      expect(loaded[0].reviewGeneration).toBeUndefined();
    });

    it('infers reviewGeneration from id when reviewType exists', async () => {
      await writeFile(taskPath, JSON.stringify([
        {
          id: 'review-product-g9',
          description: 'product review',
          passes: false,
          reviewType: 'product',
        },
      ]));
      const loaded = await loadTasks(taskPath);
      expect(loaded[0].reviewType).toBe('product');
      expect(loaded[0].reviewGeneration).toBe(9);
    });
  });

  describe('createMissingReviewTasks', () => {
    it('creates product/code review tasks when implementation tasks are all done', () => {
      const tasks: TaskList = [
        { id: '1', description: 'impl 1', passes: true },
        { id: '2', description: 'impl 2', passes: true },
      ];

      const result = createMissingReviewTasks(tasks);
      expect(result).toHaveLength(2);
      expect(result.map((t) => t.reviewType)).toEqual(['product', 'code']);
      expect(result.map((t) => t.reviewGeneration)).toEqual([2, 2]);
      expect(result.every((t) => t.passes === false)).toBe(true);
    });

    it('returns empty when implementation tasks are not all done', () => {
      const tasks: TaskList = [
        { id: '1', description: 'impl 1', passes: true },
        { id: '2', description: 'impl 2', passes: false },
      ];

      expect(createMissingReviewTasks(tasks)).toEqual([]);
    });

    it('returns empty when current generation already has both review tasks', () => {
      const tasks: TaskList = [
        { id: '1', description: 'impl 1', passes: true },
        { id: '2', description: 'impl 2', passes: true },
        {
          id: 'review-product-g2',
          description: 'product review',
          passes: true,
          reviewType: 'product',
          reviewGeneration: 2,
        },
        {
          id: 'review-code-g2',
          description: 'code review',
          passes: false,
          reviewType: 'code',
          reviewGeneration: 2,
        },
      ];

      expect(createMissingReviewTasks(tasks)).toEqual([]);
    });

    it('creates only missing review type for current generation', () => {
      const tasks: TaskList = [
        { id: '1', description: 'impl 1', passes: true },
        {
          id: 'review-product-g1',
          description: 'product review',
          passes: true,
          reviewType: 'product',
          reviewGeneration: 1,
        },
      ];

      const result = createMissingReviewTasks(tasks);
      expect(result).toHaveLength(1);
      expect(result[0].reviewType).toBe('code');
      expect(result[0].reviewGeneration).toBe(1);
    });

    it('triggers next generation review when follow-up implementation tasks are added and done', () => {
      const tasks: TaskList = [
        { id: '1', description: 'impl 1', passes: true },
        {
          id: 'review-product-g1',
          description: 'product review',
          passes: true,
          reviewType: 'product',
          reviewGeneration: 1,
        },
        {
          id: 'review-code-g1',
          description: 'code review',
          passes: true,
          reviewType: 'code',
          reviewGeneration: 1,
        },
        { id: '1-followup-1', description: 'follow-up impl', passes: true },
      ];

      const result = createMissingReviewTasks(tasks);
      expect(result).toHaveLength(2);
      expect(result.map((t) => t.reviewGeneration)).toEqual([2, 2]);
    });
  });

  describe('updateCheckStatus', () => {
    it('updates specific check passed status', async () => {
      const tasks: TaskList = [
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
      await saveTasks(taskPath, tasks);

      const updated = await updateCheckStatus(taskPath, '1', 0, true);
      expect(updated[0].checks![0].passed).toBe(true);
      expect(updated[0].checks![1].passed).toBe(false);
    });

    it('throws error when task not found', async () => {
      const tasks: TaskList = [
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'check', type: 'manual', passed: false }],
          passes: false,
        },
      ];
      await saveTasks(taskPath, tasks);

      await expect(updateCheckStatus(taskPath, '999', 0, true)).rejects.toThrow(
        'Task not found: 999'
      );
    });

    it('throws error when task has no checks', async () => {
      const tasks: TaskList = [
        {
          id: '1',
          description: 'Task',
          passes: false,
        },
      ];
      await saveTasks(taskPath, tasks);

      await expect(updateCheckStatus(taskPath, '1', 0, true)).rejects.toThrow(
        'Task 1 has no checks'
      );
    });

    it('throws error when check index out of range', async () => {
      const tasks: TaskList = [
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'check', type: 'manual', passed: false }],
          passes: false,
        },
      ];
      await saveTasks(taskPath, tasks);

      await expect(updateCheckStatus(taskPath, '1', 5, true)).rejects.toThrow(
        'Check index 5 out of range for task 1'
      );
    });
  });

  describe('isAllChecksPassed', () => {
    it('returns true when all checks passed', () => {
      const task: TaskEntry = {
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
      const task: TaskEntry = {
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
      const task: TaskEntry = {
        id: '1',
        description: 'Task',
        passes: false,
      };

      expect(isAllChecksPassed(task)).toBe(true);
    });

    it('returns true when checks array is empty', () => {
      const task: TaskEntry = {
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
      const tasks: TaskList = [
        {
          id: '1',
          description: 'Task',
          checks: [
            { text: 'UI check', type: 'browser', passed: false, screenshot: '' },
          ],
          passes: false,
        },
      ];
      await saveTasks(taskPath, tasks);

      const updated = await updateCheckWithEvidence(taskPath, '1', 0, {
        screenshot: 'https://r2.example.com/screenshot.png',
      });
      expect(updated[0].checks![0].screenshot).toBe('https://r2.example.com/screenshot.png');
      expect(updated[0].checks![0].passed).toBe(true);
    });

    it('updates check with video evidence', async () => {
      const tasks: TaskList = [
        {
          id: '1',
          description: 'Task',
          checks: [
            { text: 'Flow check', type: 'browser', passed: false, video: '' },
          ],
          passes: false,
        },
      ];
      await saveTasks(taskPath, tasks);

      const updated = await updateCheckWithEvidence(taskPath, '1', 0, {
        video: 'https://r2.example.com/flow.mp4',
      });
      expect(updated[0].checks![0].video).toBe('https://r2.example.com/flow.mp4');
      expect(updated[0].checks![0].passed).toBe(true);
    });

    it('throws error when task not found', async () => {
      const tasks: TaskList = [
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'check', type: 'browser', passed: false }],
          passes: false,
        },
      ];
      await saveTasks(taskPath, tasks);

      await expect(
        updateCheckWithEvidence(taskPath, '999', 0, { screenshot: 'url' })
      ).rejects.toThrow('Task not found: 999');
    });

    it('throws error when check index out of range', async () => {
      const tasks: TaskList = [
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'check', type: 'browser', passed: false }],
          passes: false,
        },
      ];
      await saveTasks(taskPath, tasks);

      await expect(
        updateCheckWithEvidence(taskPath, '1', 5, { screenshot: 'url' })
      ).rejects.toThrow('Check index 5 out of range for task 1');
    });
  });

  describe('syncAutoChecksFromVerification', () => {
    it('updates auto checks from verification and keeps manual/browser untouched', async () => {
      const tasks: TaskList = [
        {
          id: '1',
          description: 'Task',
          checks: [
            { text: 'Jest', type: 'auto:jest', passed: false },
            { text: 'RSpec', type: 'auto:rspec', passed: false },
            { text: 'Lint', type: 'auto:lint', passed: false },
            { text: 'Typecheck', type: 'auto:typecheck', passed: false },
            { text: 'Manual', type: 'manual', passed: false },
            { text: 'Browser', type: 'browser', passed: false },
          ],
          passes: false,
        },
      ];
      await saveTasks(taskPath, tasks);

      const updated = await syncAutoChecksFromVerification(taskPath, '1', {
        testsRun: true,
        testsFailed: 0,
        lintPassed: true,
        typecheckPassed: true,
      });

      expect(updated[0].checks![0].passed).toBe(true);
      expect(updated[0].checks![1].passed).toBe(true);
      expect(updated[0].checks![2].passed).toBe(true);
      expect(updated[0].checks![3].passed).toBe(true);
      expect(updated[0].checks![4].passed).toBe(false);
      expect(updated[0].checks![5].passed).toBe(false);
    });

    it('uses granular jest/rspec results when provided', async () => {
      const tasks: TaskList = [
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
      await saveTasks(taskPath, tasks);

      const updated = await syncAutoChecksFromVerification(taskPath, '1', {
        testsRun: true,
        testsFailed: 0,
        jestPassed: true,
        rspecPassed: false,
        lintPassed: true,
        typecheckPassed: true,
      });

      expect(updated[0].checks![0].passed).toBe(true);
      expect(updated[0].checks![1].passed).toBe(false);
    });

    it('treats missing counterpart as not-run when only one granular result is provided', async () => {
      const tasks: TaskList = [
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
      await saveTasks(taskPath, tasks);

      const updated = await syncAutoChecksFromVerification(taskPath, '1', {
        testsRun: true,
        testsFailed: 0,
        jestPassed: true,
        lintPassed: true,
        typecheckPassed: true,
      });

      expect(updated[0].checks![0].passed).toBe(true);
      expect(updated[0].checks![1].passed).toBe(false);
    });

    it('sets auto:jest/auto:rspec to false when tests are not run', async () => {
      const tasks: TaskList = [
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
      await saveTasks(taskPath, tasks);

      const updated = await syncAutoChecksFromVerification(taskPath, '1', {
        testsRun: false,
        testsFailed: 0,
        lintPassed: true,
        typecheckPassed: true,
      });

      expect(updated[0].checks![0].passed).toBe(false);
      expect(updated[0].checks![1].passed).toBe(false);
    });

    it('throws error when task not found', async () => {
      const tasks: TaskList = [
        {
          id: '1',
          description: 'Task',
          checks: [{ text: 'Jest', type: 'auto:jest', passed: false }],
          passes: false,
        },
      ];
      await saveTasks(taskPath, tasks);

      await expect(
        syncAutoChecksFromVerification(taskPath, '999', {
          testsRun: true,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        })
      ).rejects.toThrow('Task not found: 999');
    });
  });
});
