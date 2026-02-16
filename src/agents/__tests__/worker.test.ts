import { createWorkOrder } from '../../state/work-order.js';
import type { WorkerInput } from '../types.js';
import { WorkerAgent } from '../worker.js';

describe('WorkerAgent', () => {
  const buildPrompt = async (input: WorkerInput): Promise<string> => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: `${process.cwd()}/prompts`,
    });

    return (
      agent as unknown as { buildPrompt: (payload: WorkerInput) => Promise<string> }
    ).buildPrompt(input);
  };

  it('injects PRD content into prompt', async () => {
    const prompt = await buildPrompt({
      workOrder: createWorkOrder({
        iteration: 1,
        taskId: 'task-1',
        description: 'normal implementation',
        instructions: ['do implementation'],
        successCriteria: ['all tests pass'],
      }),
      codebasePatterns: 'pattern-a',
      prd: '# PRD\n- feature A',
    });

    expect(prompt).toContain('# PRD\n- feature A');
    expect(prompt).toContain('通常の実装タスク');
    expect(prompt).not.toContain('{PRD_CONTENT}');
    expect(prompt).not.toContain('{TASK_MODE_GUIDE}');
  });

  it('uses product review guide for review-product task ids', async () => {
    const prompt = await buildPrompt({
      workOrder: createWorkOrder({
        iteration: 2,
        taskId: 'review-product-g3',
        description: 'product review',
        instructions: ['run review'],
        successCriteria: ['review completed'],
      }),
      codebasePatterns: null,
      prd: '# Product PRD',
    });

    expect(prompt).toContain('Product Review');
    expect(prompt).toContain('PRD.md と現在実装の整合性');
    expect(prompt).toContain('discoveredTasks');
  });

  it('uses code review guide for review-code task ids', async () => {
    const prompt = await buildPrompt({
      workOrder: createWorkOrder({
        iteration: 2,
        taskId: 'review-code-g3',
        description: 'code review',
        instructions: ['run review'],
        successCriteria: ['review completed'],
      }),
      codebasePatterns: null,
      prd: '# Product PRD',
    });

    expect(prompt).toContain('Code Review');
    expect(prompt).toContain('Changed files中心');
    expect(prompt).toContain('P1/P2');
  });
});
