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
      iteration: 1,
      task: {
        id: 'task-1',
        description: 'normal implementation',
        passes: false,
      },
      codebasePatterns: 'pattern-a',
      prd: '# PRD\n- feature A',
    });

    expect(prompt).toContain('# PRD\n- feature A');
    expect(prompt).toContain('通常の実装タスク');
    expect(prompt).not.toContain('{PRD_CONTENT}');
    expect(prompt).not.toContain('{TASK_MODE_GUIDE}');
  });

  it('injects manager briefing into prompt', async () => {
    const prompt = await buildPrompt({
      iteration: 1,
      task: {
        id: 'task-briefing',
        description: 'retry task',
        passes: false,
      },
      codebasePatterns: null,
      prd: null,
      briefing: '## Retry Context\n- focus on auth refresh edge case',
    });

    expect(prompt).toContain('## Manager からのブリーフィング');
    expect(prompt).toContain('focus on auth refresh edge case');
    expect(prompt).not.toContain('{WORKER_BRIEFING}');
  });

  it('uses product review guide for review-product task ids', async () => {
    const prompt = await buildPrompt({
      iteration: 2,
      task: {
        id: 'review-product-g3',
        description: 'product review',
        passes: false,
        reviewType: 'product',
        reviewGeneration: 3,
      },
      codebasePatterns: null,
      prd: '# Product PRD',
    });

    expect(prompt).toContain('Product Review');
    expect(prompt).toContain('PRD.md と現在実装の整合性');
    expect(prompt).toContain('discoveredTasks');
  });

  it('uses code review guide for review-code task ids', async () => {
    const prompt = await buildPrompt({
      iteration: 2,
      task: {
        id: 'review-code-g3',
        description: 'code review',
        passes: false,
        reviewType: 'code',
        reviewGeneration: 3,
      },
      codebasePatterns: null,
      prd: '# Product PRD',
    });

    expect(prompt).toContain('Code Review');
    expect(prompt).toContain('Changed files中心');
    expect(prompt).toContain('P1/P2');
  });

  it('uses high as default reasoning effort when not configured', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: `${process.cwd()}/prompts`,
    });

    let capturedOptions: unknown;
    (agent as unknown as {
      engine: {
        execute: (
          prompt: string,
          options?: unknown
        ) => Promise<{ success: boolean; output: string; exitCode: number }>;
      };
    }).engine = {
      execute: async (_prompt: string, options?: unknown) => {
        capturedOptions = options;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };

    (agent as unknown as {
      saveExecutionLog: (
        iteration: number,
        taskId: string,
        output: string,
        error?: string
      ) => Promise<string>;
    }).saveExecutionLog = async () => '/tmp/worker-test.log';

    const input: WorkerInput = {
      iteration: 1,
      task: {
        id: 'task-2',
        description: 'default effort test',
        passes: false,
      },
      codebasePatterns: null,
      prd: null,
    };

    await agent.run(input);

    expect(
      (capturedOptions as { reasoningEffort?: string }).reasoningEffort
    ).toBe('high');
  });

  it('uses Claude engine when task.model is claude', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: `${process.cwd()}/prompts`,
      model: 'gpt-5.3-codex',
      claudeModel: 'sonnet',
      claudeEffort: 'high',
    });

    let codexExecuteCount = 0;
    let claudeExecuteCount = 0;
    let capturedClaudeOptions: unknown;

    (agent as unknown as {
      engine: {
        execute: (
          prompt: string,
          options?: unknown
        ) => Promise<{ success: boolean; output: string; exitCode: number }>;
      };
    }).engine = {
      execute: async () => {
        codexExecuteCount++;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };

    (agent as unknown as {
      claudeEngine: {
        execute: (
          prompt: string,
          options?: unknown
        ) => Promise<{ success: boolean; output: string; exitCode: number }>;
      };
    }).claudeEngine = {
      execute: async (_prompt: string, options?: unknown) => {
        claudeExecuteCount++;
        capturedClaudeOptions = options;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };

    (agent as unknown as {
      saveExecutionLog: (
        iteration: number,
        taskId: string,
        output: string,
        error?: string
      ) => Promise<string>;
    }).saveExecutionLog = async () => '/tmp/worker-test.log';

    const input: WorkerInput = {
      iteration: 1,
      task: {
        id: 'task-claude',
        description: 'run with claude',
        model: 'claude',
        passes: false,
      },
      codebasePatterns: null,
      prd: null,
    };

    await agent.run(input);

    expect(claudeExecuteCount).toBe(1);
    expect(codexExecuteCount).toBe(0);
    expect((capturedClaudeOptions as { model?: string }).model).toBe('sonnet');
  });

  it('falls back to opus when claude model is omitted or codex-like', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: `${process.cwd()}/prompts`,
      model: 'gpt-5.3-codex',
      claudeModel: 'gpt-5.3-codex',
      claudeEffort: 'high',
    });

    let capturedClaudeOptions: unknown;

    (agent as unknown as {
      engine: {
        execute: (
          prompt: string,
          options?: unknown
        ) => Promise<{ success: boolean; output: string; exitCode: number }>;
      };
    }).engine = {
      execute: async () => ({ success: true, output: 'ok', exitCode: 0 }),
    };

    (agent as unknown as {
      claudeEngine: {
        execute: (
          prompt: string,
          options?: unknown
        ) => Promise<{ success: boolean; output: string; exitCode: number }>;
      };
    }).claudeEngine = {
      execute: async (_prompt: string, options?: unknown) => {
        capturedClaudeOptions = options;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };

    (agent as unknown as {
      saveExecutionLog: (
        iteration: number,
        taskId: string,
        output: string,
        error?: string
      ) => Promise<string>;
    }).saveExecutionLog = async () => '/tmp/worker-test.log';

    await agent.run({
      iteration: 1,
      task: {
        id: 'task-claude-fallback',
        description: 'run with claude fallback',
        model: 'claude',
        passes: false,
      },
      codebasePatterns: null,
      prd: null,
    });

    expect((capturedClaudeOptions as { model?: string }).model).toBe('opus');
  });

  it('uses Codex engine when task.model is codex', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: `${process.cwd()}/prompts`,
      model: 'gpt-5.3-codex',
      reasoningEffort: 'high',
      claudeModel: 'sonnet',
    });

    let codexExecuteCount = 0;
    let claudeExecuteCount = 0;
    let capturedCodexOptions: unknown;

    (agent as unknown as {
      engine: {
        execute: (
          prompt: string,
          options?: unknown
        ) => Promise<{ success: boolean; output: string; exitCode: number }>;
      };
    }).engine = {
      execute: async (_prompt: string, options?: unknown) => {
        codexExecuteCount++;
        capturedCodexOptions = options;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };

    (agent as unknown as {
      claudeEngine: {
        execute: (
          prompt: string,
          options?: unknown
        ) => Promise<{ success: boolean; output: string; exitCode: number }>;
      };
    }).claudeEngine = {
      execute: async () => {
        claudeExecuteCount++;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };

    (agent as unknown as {
      saveExecutionLog: (
        iteration: number,
        taskId: string,
        output: string,
        error?: string
      ) => Promise<string>;
    }).saveExecutionLog = async () => '/tmp/worker-test.log';

    const input: WorkerInput = {
      iteration: 1,
      task: {
        id: 'task-codex',
        description: 'run with codex',
        model: 'codex',
        passes: false,
      },
      codebasePatterns: null,
      prd: null,
    };

    await agent.run(input);

    expect(codexExecuteCount).toBe(1);
    expect(claudeExecuteCount).toBe(0);
    expect(
      (capturedCodexOptions as { reasoningEffort?: string }).reasoningEffort
    ).toBe('high');
  });

  it('uses Codex engine even for frontend design tasks when model is omitted', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: `${process.cwd()}/prompts`,
      model: 'gpt-5.3-codex',
      claudeModel: 'sonnet',
      claudeEffort: 'high',
    });

    let codexExecuteCount = 0;
    let claudeExecuteCount = 0;

    (agent as unknown as {
      engine: {
        execute: (
          prompt: string,
          options?: unknown
        ) => Promise<{ success: boolean; output: string; exitCode: number }>;
      };
    }).engine = {
      execute: async () => {
        codexExecuteCount++;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };

    (agent as unknown as {
      claudeEngine: {
        execute: (
          prompt: string,
          options?: unknown
        ) => Promise<{ success: boolean; output: string; exitCode: number }>;
      };
    }).claudeEngine = {
      execute: async () => {
        claudeExecuteCount++;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };

    (agent as unknown as {
      saveExecutionLog: (
        iteration: number,
        taskId: string,
        output: string,
        error?: string
      ) => Promise<string>;
    }).saveExecutionLog = async () => '/tmp/worker-test.log';

    await agent.run({
      iteration: 1,
      task: {
        id: 'task-ui-design',
        description: 'フロントエンドのUIデザインを実装し、CSSレイアウトを調整する',
        passes: false,
      },
      codebasePatterns: null,
      prd: null,
    });

    expect(codexExecuteCount).toBe(1);
    expect(claudeExecuteCount).toBe(0);
  });

  it('keeps Codex engine for non-frontend tasks when model is omitted', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: `${process.cwd()}/prompts`,
      model: 'gpt-5.3-codex',
      claudeModel: 'sonnet',
    });

    let codexExecuteCount = 0;
    let claudeExecuteCount = 0;

    (agent as unknown as {
      engine: {
        execute: (
          prompt: string,
          options?: unknown
        ) => Promise<{ success: boolean; output: string; exitCode: number }>;
      };
    }).engine = {
      execute: async () => {
        codexExecuteCount++;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };

    (agent as unknown as {
      claudeEngine: {
        execute: (
          prompt: string,
          options?: unknown
        ) => Promise<{ success: boolean; output: string; exitCode: number }>;
      };
    }).claudeEngine = {
      execute: async () => {
        claudeExecuteCount++;
        return { success: true, output: 'ok', exitCode: 0 };
      },
    };

    (agent as unknown as {
      saveExecutionLog: (
        iteration: number,
        taskId: string,
        output: string,
        error?: string
      ) => Promise<string>;
    }).saveExecutionLog = async () => '/tmp/worker-test.log';

    await agent.run({
      iteration: 1,
      task: {
        id: 'task-backend-api',
        description: 'バックエンドAPIの認可ロジックを修正する',
        passes: false,
      },
      codebasePatterns: null,
      prd: null,
    });

    expect(codexExecuteCount).toBe(1);
    expect(claudeExecuteCount).toBe(0);
  });

  describe('parseWorkReport', () => {
    const parseWorkReport = (output: string) => {
      const agent = new WorkerAgent({
        cwd: process.cwd(),
        promptsDir: `${process.cwd()}/prompts`,
      });

      return (
        agent as unknown as {
          parseWorkReport: (
            iteration: number,
            task: { id: string; checks?: Array<{ text: string }> },
            output: string,
            engineSuccess: boolean
          ) => {
            keyDecisions?: Array<{ decision: string; rationale: string }>;
            criticalFiles?: Array<{ path: string; context: string }>;
            nextSteps?: string[];
            status: string;
          };
        }
      ).parseWorkReport(1, { id: 'task-1', checks: [] }, output, true);
    };

    it('parses keyDecisions / criticalFiles / nextSteps from WORK_REPORT JSON', () => {
      const output = [
        '```json',
        '{',
        '  "status": "PARTIAL",',
        '  "summary": "partial",',
        '  "keyDecisions": [',
        '    { "decision": "Use session", "rationale": "Align with existing architecture" }',
        '  ],',
        '  "criticalFiles": [',
        '    { "path": "src/auth/session.ts", "context": "Core refresh flow" }',
        '  ],',
        '  "nextSteps": [',
        '    "Add edge-case tests"',
        '  ]',
        '}',
        '```',
      ].join('\n');

      const report = parseWorkReport(output);
      expect(report.status).toBe('PARTIAL');
      expect(report.keyDecisions?.[0].decision).toBe('Use session');
      expect(report.criticalFiles?.[0].path).toBe('src/auth/session.ts');
      expect(report.nextSteps).toEqual(['Add edge-case tests']);
    });

    it('keeps backward compatibility when new handoff fields are absent', () => {
      const output = [
        '```json',
        '{',
        '  "status": "SUCCESS",',
        '  "summary": "done"',
        '}',
        '```',
      ].join('\n');

      const report = parseWorkReport(output);
      expect(report.status).toBe('SUCCESS');
      expect(report.keyDecisions).toBeUndefined();
      expect(report.criticalFiles).toBeUndefined();
      expect(report.nextSteps).toBeUndefined();
    });
  });
});
