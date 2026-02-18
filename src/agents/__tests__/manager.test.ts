import { jest } from '@jest/globals';
import type { ManagerDecision } from '../types.js';
import { ManagerAgent } from '../manager.js';

describe('ManagerAgent.parseDecision', () => {
  const parseDecision = (output: string): ManagerDecision => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: `${process.cwd()}/prompts`,
    });

    return (
      agent as unknown as {
        parseDecision: (input: string) => ManagerDecision;
      }
    ).parseDecision(output);
  };

  it('parses WORK_ORDER from fenced JSON', () => {
    const output = [
      'some logs',
      '```json',
      '{',
      '  "iteration": 7,',
      '  "taskId": "6",',
      '  "description": "do task",',
      '  "instructions": ["step-1"]',
      '}',
      '```',
    ].join('\n');

    const decision = parseDecision(output);
    expect(decision.type).toBe('dispatch_task');
    if (decision.type === 'dispatch_task') {
      expect(decision.workOrder.taskId).toBe('6');
      expect(decision.workOrder.description).toBe('do task');
    }
  });

  it('parses WORK_ORDER from raw JSON with logs', () => {
    const output = [
      'thinking',
      '**Analyzing issue**',
      'exec',
      'some command output...',
      '{',
      '  "iteration": 7,',
      '  "taskId": "6",',
      '  "description": "fix parser {robust}",',
      '  "instructions": [',
      '    "wire parser",',
      '    "add tests"',
      '  ]',
      '}',
      'tokens used',
      '12345',
    ].join('\n');

    const decision = parseDecision(output);
    expect(decision.type).toBe('dispatch_task');
    if (decision.type === 'dispatch_task') {
      expect(decision.workOrder.taskId).toBe('6');
      expect(decision.workOrder.description).toBe('fix parser {robust}');
    }
  });

  it('uses the last valid WORK_ORDER when multiple JSON blocks exist', () => {
    const output = [
      '```json',
      '{',
      '  "iteration": 7,',
      '  "taskId": "old-task",',
      '  "description": "old",',
      '  "instructions": ["old-step"]',
      '}',
      '```',
      'intermediate logs',
      '{',
      '  "iteration": 7,',
      '  "taskId": "new-task",',
      '  "description": "new",',
      '  "instructions": ["new-step"]',
      '}',
    ].join('\n');

    const decision = parseDecision(output);
    expect(decision.type).toBe('dispatch_task');
    if (decision.type === 'dispatch_task') {
      expect(decision.workOrder.taskId).toBe('new-task');
      expect(decision.workOrder.description).toBe('new');
    }
  });

  it('parses ESCALATION from raw JSON', () => {
    const output = [
      'assistant output',
      '{',
      '  "id": "esc-123",',
      '  "type": "QUESTION",',
      '  "context": "task-6",',
      '  "question": "Which option should we use?"',
      '}',
    ].join('\n');

    const decision = parseDecision(output);
    expect(decision.type).toBe('escalate');
    if (decision.type === 'escalate') {
      expect(decision.escalation.type).toBe('QUESTION');
      expect(decision.escalation.question).toBe('Which option should we use?');
    }
  });

  it('returns error when no decision can be parsed', () => {
    const decision = parseDecision('thinking\nno JSON decision here');
    expect(decision.type).toBe('error');
    if (decision.type === 'error') {
      expect(decision.message).toBe('Could not parse Manager decision from output');
    }
  });
});

describe('ManagerAgent engine selection', () => {
  const createAgent = (model?: string): ManagerAgent => {
    return new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: `${process.cwd()}/prompts`,
      model,
    });
  };

  const executeWithConfiguredEngine = async (
    agent: ManagerAgent,
    modelEffort: 'low' | 'medium' | 'high' | 'max' = 'high'
  ) => {
    return (
      agent as unknown as {
        executeWithConfiguredEngine: (
          prompt: string,
          effort: 'low' | 'medium' | 'high' | 'max'
        ) => Promise<{
          success: boolean;
          output: string;
          exitCode: number;
        }>;
      }
    ).executeWithConfiguredEngine('test prompt', modelEffort);
  };

  it('uses Codex when model is not specified', async () => {
    const agent = createAgent();
    const codexExecute = jest
      .spyOn((agent as unknown as { codexEngine: { execute: (...args: unknown[]) => unknown } }).codexEngine, 'execute')
      .mockResolvedValue({ success: true, output: 'ok', exitCode: 0 });
    const claudeExecute = jest
      .spyOn((agent as unknown as { claudeEngine: { execute: (...args: unknown[]) => unknown } }).claudeEngine, 'execute')
      .mockResolvedValue({ success: true, output: 'ok', exitCode: 0 });

    await executeWithConfiguredEngine(agent);

    expect(codexExecute).toHaveBeenCalledTimes(1);
    expect(claudeExecute).not.toHaveBeenCalled();
  });

  it('uses Claude when model is claude family', async () => {
    const agent = createAgent('sonnet');
    const codexExecute = jest
      .spyOn((agent as unknown as { codexEngine: { execute: (...args: unknown[]) => unknown } }).codexEngine, 'execute')
      .mockResolvedValue({ success: true, output: 'ok', exitCode: 0 });
    const claudeExecute = jest
      .spyOn((agent as unknown as { claudeEngine: { execute: (...args: unknown[]) => unknown } }).claudeEngine, 'execute')
      .mockResolvedValue({ success: true, output: 'ok', exitCode: 0 });

    await executeWithConfiguredEngine(agent);

    expect(claudeExecute).toHaveBeenCalledTimes(1);
    expect(codexExecute).not.toHaveBeenCalled();
  });

  it('uses Codex when model includes codex', async () => {
    const agent = createAgent('gpt-5.3-codex');
    const codexExecute = jest
      .spyOn((agent as unknown as { codexEngine: { execute: (...args: unknown[]) => unknown } }).codexEngine, 'execute')
      .mockResolvedValue({ success: true, output: 'ok', exitCode: 0 });
    const claudeExecute = jest
      .spyOn((agent as unknown as { claudeEngine: { execute: (...args: unknown[]) => unknown } }).claudeEngine, 'execute')
      .mockResolvedValue({ success: true, output: 'ok', exitCode: 0 });

    await executeWithConfiguredEngine(agent);

    expect(codexExecute).toHaveBeenCalledTimes(1);
    expect(claudeExecute).not.toHaveBeenCalled();
  });
});
