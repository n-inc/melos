import { mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkOrder,
  saveWorkOrder,
  loadWorkOrder,
  type WorkOrder,
} from '../work-order.js';

describe('work-order.ts', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `melos-work-order-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('createWorkOrder', () => {
    it('creates a WorkOrder with required fields', () => {
      const workOrder = createWorkOrder({
        iteration: 1,
        taskId: 'task-1',
        description: 'Implement feature X',
        instructions: ['Step 1', 'Step 2'],
        successCriteria: ['Tests pass', 'Lint passes'],
      });

      expect(workOrder.iteration).toBe(1);
      expect(workOrder.taskId).toBe('task-1');
      expect(workOrder.description).toBe('Implement feature X');
      expect(workOrder.instructions).toEqual(['Step 1', 'Step 2']);
      expect(workOrder.successCriteria).toEqual(['Tests pass', 'Lint passes']);
      expect(workOrder.context).toEqual({
        relatedFiles: [],
        patterns: null,
        gotchas: null,
      });
      expect(workOrder.createdAt).toBeDefined();
    });

    it('creates a WorkOrder with optional context', () => {
      const workOrder = createWorkOrder({
        iteration: 2,
        taskId: 'task-2',
        description: 'Fix bug Y',
        instructions: ['Fix the bug'],
        successCriteria: ['Bug is fixed'],
        context: {
          relatedFiles: ['src/file.ts'],
          patterns: 'Use existing pattern',
          gotchas: 'Watch out for edge case',
        },
      });

      expect(workOrder.context.relatedFiles).toEqual(['src/file.ts']);
      expect(workOrder.context.patterns).toBe('Use existing pattern');
      expect(workOrder.context.gotchas).toBe('Watch out for edge case');
    });

    it('creates a WorkOrder with constraints', () => {
      const workOrder = createWorkOrder({
        iteration: 3,
        taskId: 'task-3',
        description: 'Add tests',
        instructions: ['Write tests'],
        successCriteria: ['Coverage > 80%'],
        constraints: {
          mustRunTests: true,
          mustPassLint: true,
          mustPassTypecheck: true,
          maxFiles: 5,
        },
      });

      expect(workOrder.constraints?.mustRunTests).toBe(true);
      expect(workOrder.constraints?.mustPassLint).toBe(true);
      expect(workOrder.constraints?.mustPassTypecheck).toBe(true);
      expect(workOrder.constraints?.maxFiles).toBe(5);
    });
  });

  describe('saveWorkOrder and loadWorkOrder', () => {
    it('saves and loads a WorkOrder', async () => {
      const workOrder = createWorkOrder({
        iteration: 1,
        taskId: 'task-1',
        description: 'Test task',
        instructions: ['Do something'],
        successCriteria: ['It works'],
      });

      await saveWorkOrder(testDir, workOrder);

      const loaded = await loadWorkOrder(testDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.taskId).toBe('task-1');
      expect(loaded!.description).toBe('Test task');
    });

    it('returns null when no WorkOrder exists', async () => {
      const loaded = await loadWorkOrder(testDir);
      expect(loaded).toBeNull();
    });

    it('saves WorkOrder as JSON file', async () => {
      const workOrder = createWorkOrder({
        iteration: 1,
        taskId: 'task-1',
        description: 'Test',
        instructions: [],
        successCriteria: [],
      });

      await saveWorkOrder(testDir, workOrder);

      const filePath = join(testDir, 'WORK_ORDER.json');
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.taskId).toBe('task-1');
    });
  });
});
