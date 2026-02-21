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

  it('parses task dispatch from fenced JSON', () => {
    const output = [
      'some logs',
      '```json',
      '{',
      '  "taskId": "6",',
      '  "reason": "do task"',
      '}',
      '```',
    ].join('\n');

    const decision = parseDecision(output);
    expect(decision.type).toBe('dispatch_task');
    if (decision.type === 'dispatch_task') {
      expect(decision.taskId).toBe('6');
    }
  });

  it('parses task dispatch briefing from fenced JSON', () => {
    const output = [
      '```json',
      '{',
      '  "taskId": "task-1",',
      '  "briefing": "## Retry\\nFocus on session edge cases"',
      '}',
      '```',
    ].join('\n');

    const decision = parseDecision(output);
    expect(decision.type).toBe('dispatch_task');
    if (decision.type === 'dispatch_task') {
      expect(decision.taskId).toBe('task-1');
      expect(decision.briefing).toContain('Retry');
    }
  });

  it('parses task dispatch from raw JSON with logs', () => {
    const output = [
      'thinking',
      '**Analyzing issue**',
      'exec',
      'some command output...',
      '{',
      '  "taskId": "6",',
      '  "reason": "fix parser {robust}"',
      '}',
      'tokens used',
      '12345',
    ].join('\n');

    const decision = parseDecision(output);
    expect(decision.type).toBe('dispatch_task');
    if (decision.type === 'dispatch_task') {
      expect(decision.taskId).toBe('6');
    }
  });

  it('uses the last valid task dispatch when multiple JSON blocks exist', () => {
    const output = [
      '```json',
      '{',
      '  "taskId": "old-task",',
      '  "reason": "old"',
      '}',
      '```',
      'intermediate logs',
      '{',
      '  "taskId": "new-task",',
      '  "reason": "new"',
      '}',
    ].join('\n');

    const decision = parseDecision(output);
    expect(decision.type).toBe('dispatch_task');
    if (decision.type === 'dispatch_task') {
      expect(decision.taskId).toBe('new-task');
    }
  });

  it('parses TASK_DISPATCH fixed text format', () => {
    const output = [
      'progress logs...',
      'TASK_DISPATCH',
      'task-42',
    ].join('\n');

    const decision = parseDecision(output);
    expect(decision.type).toBe('dispatch_task');
    if (decision.type === 'dispatch_task') {
      expect(decision.taskId).toBe('task-42');
    }
  });

  it('parses TASK_DISPATCH keyed fallback format', () => {
    const output = [
      'TASK_DISPATCH',
      'taskId: task-99',
    ].join('\n');

    const decision = parseDecision(output);
    expect(decision.type).toBe('dispatch_task');
    if (decision.type === 'dispatch_task') {
      expect(decision.taskId).toBe('task-99');
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

describe('ManagerAgent.buildPrompt', () => {
  it('injects tasks and maxIterations into manager prompt', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: `${process.cwd()}/prompts`,
    });

    const prompt = await (
      agent as unknown as {
        buildPrompt: (input: {
          iteration: number;
          maxIterations: number;
          tasks: Array<{ id: string; description: string; passes: boolean }> | null;
          prd: string | null;
          progress: string | null;
          lastWorkReport: null;
          pendingEscalation: null;
        }) => Promise<string>;
      }
    ).buildPrompt({
      iteration: 3,
      maxIterations: 42,
      tasks: [{ id: 'task-1', description: 'demo', passes: false }],
      prd: null,
      progress: null,
      lastWorkReport: null,
      pendingEscalation: null,
    });

    expect(prompt).toContain('Iteration 3 / 42');
    expect(prompt).toContain('"id": "task-1"');
    expect(prompt).not.toContain('{TASK_JSON}');
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
    let codexExecuteCount = 0;
    let claudeExecuteCount = 0;
    (agent as unknown as { codexEngine: { execute: (prompt: string, options?: unknown) => Promise<{ success: boolean; output: string; exitCode: number }> } }).codexEngine = {
      execute: async () => {
        codexExecuteCount++;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };
    (agent as unknown as { claudeEngine: { execute: (prompt: string, options?: unknown) => Promise<{ success: boolean; output: string; exitCode: number }> } }).claudeEngine = {
      execute: async () => {
        claudeExecuteCount++;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };

    await executeWithConfiguredEngine(agent);

    expect(codexExecuteCount).toBe(1);
    expect(claudeExecuteCount).toBe(0);
  });

  it('uses Claude when model is claude family', async () => {
    const agent = createAgent('sonnet');
    let codexExecuteCount = 0;
    let claudeExecuteCount = 0;
    (agent as unknown as { codexEngine: { execute: (prompt: string, options?: unknown) => Promise<{ success: boolean; output: string; exitCode: number }> } }).codexEngine = {
      execute: async () => {
        codexExecuteCount++;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };
    (agent as unknown as { claudeEngine: { execute: (prompt: string, options?: unknown) => Promise<{ success: boolean; output: string; exitCode: number }> } }).claudeEngine = {
      execute: async () => {
        claudeExecuteCount++;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };

    await executeWithConfiguredEngine(agent);

    expect(claudeExecuteCount).toBe(1);
    expect(codexExecuteCount).toBe(0);
  });

  it('uses Codex when model includes codex', async () => {
    const agent = createAgent('gpt-5.3-codex');
    let codexExecuteCount = 0;
    let claudeExecuteCount = 0;
    (agent as unknown as { codexEngine: { execute: (prompt: string, options?: unknown) => Promise<{ success: boolean; output: string; exitCode: number }> } }).codexEngine = {
      execute: async () => {
        codexExecuteCount++;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };
    (agent as unknown as { claudeEngine: { execute: (prompt: string, options?: unknown) => Promise<{ success: boolean; output: string; exitCode: number }> } }).claudeEngine = {
      execute: async () => {
        claudeExecuteCount++;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };

    await executeWithConfiguredEngine(agent);

    expect(codexExecuteCount).toBe(1);
    expect(claudeExecuteCount).toBe(0);
  });
});
