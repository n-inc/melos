import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPlan,
  savePlan,
  planExists,
  updateTaskStatus,
  getPendingTasks,
  getNextTask,
  isAllTasksCompleted,
  addTasks,
  type Plan,
  type PlanTask,
} from '../plan.js';

describe('plan.ts', () => {
  let testDir: string;
  let planPath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `marathon-test-${Date.now()}`);
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
          stepsToVerify: ['step 1', 'step 2'],
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
});
