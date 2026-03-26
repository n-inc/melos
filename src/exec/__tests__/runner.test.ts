import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import { AppServerEngine } from '../../engines/app-server.js';
import { ClaudeEngine } from '../../engines/claude.js';
import { Engine, type EngineOptions, type EngineResult } from '../../engines/base.js';
import type { MissionEvent } from '../../state/events.js';
import { continueUntilPass } from '../policies.js';
import { createRoute } from '../recipe.js';
import { runRoute, eventLog } from '../runner.js';

class ScriptedEngine extends Engine {
  readonly name = 'scripted';

  private index = 0;

  readonly prompts: string[] = [];
  readonly optionsList: Array<EngineOptions | undefined> = [];

  constructor(private readonly steps: Array<(options: EngineOptions | undefined, prompt: string) => Promise<EngineResult> | EngineResult>) {
    super();
  }

  async execute(prompt: string, options?: EngineOptions): Promise<EngineResult> {
    const step = this.steps[this.index] ?? this.steps[this.steps.length - 1];
    this.index += 1;
    this.prompts.push(prompt);
    this.optionsList.push(options);
    return step(options, prompt);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function createGitRepo(prefix: string): string {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  execSync('git init', { cwd, stdio: 'ignore' });
  execSync('git config user.email "melos-test@example.com"', { cwd, stdio: 'ignore' });
  execSync('git config user.name "Melos Test"', { cwd, stdio: 'ignore' });
  return cwd;
}

describe('exec runner', () => {
  beforeEach(() => {
    jest.spyOn(ClaudeEngine.prototype, 'execute').mockResolvedValue({
      success: true,
      output: JSON.stringify({
        summary: 'Generated final report.',
        changes: [],
        rationale: ['Used the default test report.'],
        finalState: 'Run completed.',
        remainingIssues: [],
        userConfirmationNeeded: [],
      }),
      exitCode: 0,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs a minimal workflow and exposes prior outputs to later phases', async () => {
    const cwd = createGitRepo('melos-exec-workflow-happy-');
    const engine = new ScriptedEngine([
      async () => ({
        success: true,
        output: JSON.stringify({
          sources: ['https://example.com/a', 'https://example.com/b'],
        }),
        exitCode: 0,
      }),
      async () => ({
        success: true,
        output: 'draft written',
        exitCode: 0,
      }),
    ]);

    const summary = await runRoute({
      recipe: createRoute({
        run: { engine, cwd },
        workflow: {
          start: 'research',
          phases: {
            research: {
              task: 'Research the topic and return JSON.',
              produce: { from: 'assistant-json' },
              next: { goto: 'write' },
            },
            write: {
              task: ({ state }) => `Write the article.\nSources count: ${((state.outputs.research as { sources?: string[] } | undefined)?.sources ?? []).length}`,
              next: 'stop',
            },
          },
        },
      }),
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(2);
    expect(engine.prompts[1]).toContain('Sources count: 2');
    expect(summary.report?.evidence?.workflow?.outputs).toEqual({
      research: {
        _keys: ['sources'],
        _size: Buffer.byteLength(JSON.stringify({
          sources: ['https://example.com/a', 'https://example.com/b'],
        }), 'utf8'),
      },
    });
  });

  it('supports a review-fix-review workflow with file produce and transitions', async () => {
    const cwd = createGitRepo('melos-exec-review-fix-');
    mkdirSync(join(cwd, '.melos'), { recursive: true });
    const events: MissionEvent[] = [];
    const engine = new ScriptedEngine([
      async (options) => {
        writeFileSync(join(String(options?.cwd), '.melos', 'review-result.json'), JSON.stringify({
          summary: 'one blocking finding remains',
          blockingCount: 1,
        }), 'utf-8');
        return { success: true, output: 'found one blocking finding', exitCode: 0 };
      },
      async (options) => {
        writeFileSync(join(String(options?.cwd), 'fixed.txt'), 'fixed\n', 'utf-8');
        return { success: true, output: 'fixed the issue', exitCode: 0 };
      },
      async (options) => {
        writeFileSync(join(String(options?.cwd), '.melos', 'review-result.json'), JSON.stringify({
          summary: 'no blocking findings remain',
          blockingCount: 0,
        }), 'utf-8');
        return { success: true, output: 'review is clean', exitCode: 0 };
      },
    ]);

    const summary = await runRoute({
      recipe: createRoute({
        run: { engine, cwd },
        workflow: {
          start: 'review',
          phases: {
            review: {
              task: 'Review the current work and write review-result.json.',
              produce: { from: { file: '.melos/review-result.json' } },
              measure: {
                command: `node -e "process.stdout.write(require('fs').readFileSync('.melos/review-result.json', 'utf8'))"`,
              },
              until: { metric: 'blockingCount', below: 1 },
              on: {
                pass: 'stop',
                fail: { goto: 'fix' },
              },
            },
            fix: {
              task: 'Fix valid findings from review-result.json.',
              next: { goto: 'review' },
            },
          },
        },
        log: eventLog({
          melosDir: join(cwd, '.melos'),
          onEvent: (event) => {
            events.push(event);
          },
        }),
      }),
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(3);
    expect(existsSync(join(cwd, 'fixed.txt'))).toBe(true);
    expect(summary.report?.evidence?.workflow?.outputs.review).toEqual({
      _keys: ['summary', 'blockingCount'],
      _size: Buffer.byteLength(JSON.stringify({
        summary: 'no blocking findings remain',
        blockingCount: 0,
      }), 'utf8'),
    });
    expect(events.some((event) => event.type === 'phase_transitioned' && event.payload.from === 'review' && event.payload.to === 'fix')).toBe(true);
  });

  it('supports a longer blog workflow with review loops', async () => {
    const cwd = createGitRepo('melos-exec-blog-workflow-');
    const engine = new ScriptedEngine([
      async () => ({
        success: true,
        output: JSON.stringify({
          notes: ['point-a', 'point-b'],
        }),
        exitCode: 0,
      }),
      async () => ({ success: true, output: 'first draft', exitCode: 0 }),
      async () => ({ success: true, output: 'proofread pass one', exitCode: 0 }),
      async () => ({ success: true, output: 'revised draft', exitCode: 0 }),
      async () => ({ success: true, output: 'proofread pass two', exitCode: 0 }),
      async () => ({ success: true, output: 'fact checked', exitCode: 0 }),
      async () => ({ success: true, output: 'ready for publish', exitCode: 0 }),
    ]);

    const evaluateSpy = jest.spyOn(AppServerEngine.prototype, 'execute')
      .mockResolvedValueOnce({
        success: true,
        output: JSON.stringify({
          criteria: [
            { criterion: 'Draft is polished', verdict: 'no', rationale: 'Needs another revision.' },
          ],
        }),
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        success: true,
        output: JSON.stringify({
          criteria: [
            { criterion: 'Draft is polished', verdict: 'yes', rationale: 'Proofread changes are reflected.' },
          ],
        }),
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        success: true,
        output: JSON.stringify({
          criteria: [
            { criterion: 'Facts are accurate', verdict: 'yes', rationale: 'The cited facts are consistent.' },
          ],
        }),
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        success: true,
        output: JSON.stringify({
          criteria: [
            { criterion: 'Ready to publish', verdict: 'yes', rationale: 'The article is ready.' },
          ],
        }),
        exitCode: 0,
      });
    const shutdownSpy = jest.spyOn(AppServerEngine.prototype, 'shutdown').mockResolvedValue();

    const summary = await runRoute({
      recipe: createRoute({
        run: { engine, cwd, model: 'codex-latest' },
        workflow: {
          start: 'research',
          phases: {
            research: {
              task: 'Research the topic and return JSON.',
              produce: { from: 'assistant-json' },
              next: { goto: 'write' },
            },
            write: {
              task: ({ state }) => `Write the article using ${(state.outputs.research as { notes?: string[] } | undefined)?.notes?.length ?? 0} notes.`,
              next: { goto: 'proofread' },
            },
            proofread: {
              task: 'Proofread the article.',
              pass: ['Draft is polished'],
              on: {
                pass: { goto: 'factcheck' },
                fail: { goto: 'write' },
              },
            },
            factcheck: {
              task: 'Fact-check the article.',
              pass: ['Facts are accurate'],
              on: {
                pass: { goto: 'review' },
                fail: { goto: 'write' },
              },
            },
            review: {
              task: 'Review the final article.',
              pass: ['Ready to publish'],
              on: {
                pass: 'stop',
                fail: { goto: 'write' },
              },
            },
          },
        },
      }),
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(7);
    expect(summary.report?.evidence?.workflow?.history).toEqual([
      { phase: 'research', summary: 'Research the topic and return JSON.', decision: 'goto:write' },
      { phase: 'write', summary: 'Write the article using 2 notes.', decision: 'goto:proofread' },
      { phase: 'proofread', summary: 'pass: llm evaluation failed', decision: 'goto:write' },
      { phase: 'write', summary: 'Write the article using 2 notes.', decision: 'goto:proofread' },
      { phase: 'proofread', summary: 'pass: llm evaluation passed', decision: 'goto:factcheck' },
      { phase: 'factcheck', summary: 'pass: llm evaluation passed', decision: 'goto:review' },
      { phase: 'review', summary: 'pass: llm evaluation passed', decision: 'stop' },
    ]);

    evaluateSpy.mockRestore();
    shutdownSpy.mockRestore();
  });

  it('fails when assistant-json output is invalid', async () => {
    const cwd = createGitRepo('melos-exec-invalid-assistant-json-');
    const engine = new ScriptedEngine([
      async () => ({
        success: true,
        output: '{not valid json',
        exitCode: 0,
      }),
    ]);

    const summary = await runRoute({
      recipe: createRoute({
        run: { engine, cwd },
        workflow: {
          start: 'research',
          phases: {
            research: {
              task: 'Research the topic and return JSON.',
              produce: { from: 'assistant-json' },
              next: 'stop',
            },
          },
        },
      }),
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(false);
    expect(summary.iterations).toBe(1);
    expect(summary.summary).toMatch(/assistant-json/i);
  });

  it('applies per-phase run overrides and keeps every phase execution on a fresh thread', async () => {
    const cwd = createGitRepo('melos-exec-phase-overrides-');
    mkdirSync(join(cwd, 'research'), { recursive: true });
    const engine = new ScriptedEngine([
      async () => ({ success: true, output: 'research done', exitCode: 0 }),
      async () => ({ success: true, output: 'write done', exitCode: 0 }),
    ]);

    const summary = await runRoute({
      recipe: createRoute({
        run: { engine, cwd, model: 'codex-latest' },
        workflow: {
          start: 'research',
          phases: {
            research: {
              task: 'Research the topic.',
              run: { cwd: 'research', model: 'phase-model' },
              next: { goto: 'write' },
            },
            write: {
              task: 'Write the article.',
              next: 'stop',
            },
          },
        },
      }),
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(engine.optionsList[0]?.cwd).toBe(join(cwd, 'research'));
    expect(engine.optionsList[1]?.cwd).toBe(cwd);
    expect((engine.optionsList[0] as Record<string, unknown>).threadId).toBeUndefined();
    expect((engine.optionsList[1] as Record<string, unknown>).threadId).toBeUndefined();
  });

  it('persists workflow events to the event log', async () => {
    const cwd = createGitRepo('melos-exec-events-');
    const engine = new ScriptedEngine([
      async () => ({ success: true, output: 'research done', exitCode: 0 }),
      async () => ({ success: true, output: 'write done', exitCode: 0 }),
    ]);

    await runRoute({
      recipe: createRoute({
        run: { engine, cwd },
        workflow: {
          start: 'research',
          phases: {
            research: {
              task: 'Research the topic.',
              next: { goto: 'write' },
            },
            write: {
              task: 'Write the article.',
              next: 'stop',
            },
          },
        },
        log: eventLog({ melosDir: join(cwd, '.melos') }),
      }),
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    const lines = readFileSync(join(cwd, '.melos', 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as MissionEvent);

    expect(lines.some((event) => event.type === 'phase_transitioned')).toBe(true);
    expect(lines.filter((event) => event.type === 'engine_finished').map((event) => event.payload.phase)).toEqual(['research', 'write']);
  });

  it('stops with failure when a policy returns stop(false) instead of following on.fail', async () => {
    const cwd = createGitRepo('melos-exec-stop-failure-');
    const engine = new ScriptedEngine([
      async () => ({ success: true, output: 'review attempt one', exitCode: 0 }),
      async () => ({ success: true, output: 'fix should not run', exitCode: 0 }),
    ]);

    const summary = await runRoute({
      recipe: createRoute({
        run: { engine, cwd, model: 'codex-latest' },
        limits: { maxIterations: 1 },
        workflow: {
          start: 'review',
          phases: {
            review: {
              task: 'Review the final article.',
              evaluate: async () => ({
                ok: false,
                status: 'fail',
                summary: 'blocking issue remains',
                metrics: {},
              }),
              policy: async () => ({
                kind: 'stop',
                success: false,
                summary: 'stop with failure',
                reason: 'do not continue',
              }),
              on: {
                pass: 'stop',
                fail: { goto: 'fix' },
              },
            },
            fix: {
              task: 'Fix the article.',
              next: 'stop',
            },
          },
        },
      }),
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(false);
    expect(summary.iterations).toBe(1);
    expect(engine.prompts).toHaveLength(1);
  });

  it('includes the latest failure details in the next phase prompt after a shell check failure', async () => {
    const cwd = createGitRepo('melos-exec-latest-failure-');
    const engine = new ScriptedEngine([
      async () => ({ success: true, output: 'validate attempt', exitCode: 0 }),
      async () => ({ success: true, output: 'fix attempt', exitCode: 0 }),
    ]);

    const summary = await runRoute({
      recipe: createRoute({
        run: { engine, cwd },
        workflow: {
          start: 'validate',
          phases: {
            validate: {
              task: 'Validate the current state.',
              check: ['node -e "console.error(\'type boom\'); process.exit(1)"'],
              on: {
                pass: 'stop',
                fail: { goto: 'fix' },
              },
            },
            fix: {
              task: 'Fix the latest validation failure.',
              next: 'stop',
            },
          },
        },
      }),
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(2);
    expect(engine.prompts[1]).toContain('Latest Failure');
    expect(engine.prompts[1]).toContain('type boom');
  });

  it('stops after an llm evaluation error retry instead of following on.fail', async () => {
    const cwd = createGitRepo('melos-exec-llm-eval-error-stop-');
    const engine = new ScriptedEngine([
      async () => ({ success: true, output: 'review attempt one', exitCode: 0 }),
      async () => ({ success: true, output: 'fix should not run', exitCode: 0 }),
    ]);
    const evaluateSpy = jest.spyOn(AppServerEngine.prototype, 'execute')
      .mockResolvedValue({
        success: true,
        output: 'not-json',
        exitCode: 0,
      });

    const summary = await runRoute({
      recipe: createRoute({
        run: { engine, cwd, model: 'codex-latest' },
        workflow: {
          start: 'review',
          phases: {
            review: {
              task: 'Review the final article.',
              pass: ['Ready to publish'],
              on: {
                pass: 'stop',
                fail: { goto: 'fix' },
              },
            },
            fix: {
              task: 'Fix the article.',
              next: 'stop',
            },
          },
        },
      }),
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(false);
    expect(summary.iterations).toBe(1);
    expect(summary.observation?.status).toBe('error');
    expect(engine.prompts).toHaveLength(1);
    expect(evaluateSpy).toHaveBeenCalledTimes(2);

    evaluateSpy.mockRestore();
  });

  it('repeats a phase after ask resolution and includes resolved answers in the next prompt', async () => {
    const cwd = createGitRepo('melos-exec-ask-repeat-');
    const engine = new ScriptedEngine([
      async () => ({ success: true, output: 'first attempt', exitCode: 0 }),
      async () => ({ success: true, output: 'second attempt', exitCode: 0 }),
    ]);

    const summary = await runRoute({
      recipe: createRoute({
        run: { engine, cwd },
        workflow: {
          start: 'draft',
          phases: {
            draft: {
              task: 'Write the draft.',
              evaluate: async ({ resolvedQuestions }) => ({
                ok: (resolvedQuestions ?? []).some((item) => item.question === 'What is the target audience?'),
                status: (resolvedQuestions ?? []).some((item) => item.question === 'What is the target audience?') ? 'pass' : 'fail',
                summary: 'waiting for audience',
                question: (resolvedQuestions ?? []).some((item) => item.question === 'What is the target audience?')
                  ? undefined
                  : 'What is the target audience?',
              }),
              policy: continueUntilPass(),
              on: {
                pass: 'stop',
                fail: 'stop',
                ask: 'repeat',
              },
            },
          },
        },
      }),
      cwd,
      melosDir: join(cwd, '.melos'),
      askMode: 'always-user',
      askUser: async ({ question }) => question === 'What is the target audience?' ? 'Busy engineers' : null,
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(2);
    expect(engine.prompts).toHaveLength(2);
    expect(engine.prompts[1]).toContain('"question": "What is the target audience?"');
    expect(engine.prompts[1]).toContain('"answer": "Busy engineers"');
  });

  it('applies rollback and then repeats from the restored checkpoint state', async () => {
    const cwd = createGitRepo('melos-exec-rollback-repeat-');
    const filePath = join(cwd, 'state.txt');
    writeFileSync(filePath, 'base\n', 'utf-8');
    const snapshots: string[] = [];
    const engine = new ScriptedEngine([
      async (options) => {
        writeFileSync(join(String(options?.cwd), 'state.txt'), 'broken\n', 'utf-8');
        return { success: true, output: 'broke state', exitCode: 0 };
      },
      async (options) => {
        const current = readFileSync(join(String(options?.cwd), 'state.txt'), 'utf-8');
        return { success: true, output: current.trim(), exitCode: 0 };
      },
      async (options) => {
        writeFileSync(join(String(options?.cwd), 'state.txt'), 'final\n', 'utf-8');
        return { success: true, output: 'final', exitCode: 0 };
      },
    ]);

    const summary = await runRoute({
      recipe: createRoute({
        run: { engine, cwd },
        workflow: {
          start: 'stabilize',
          phases: {
            stabilize: {
              task: 'Stabilize the state.',
              evaluate: async ({ assistantText }) => {
                if (assistantText === 'broke state') {
                  return {
                    ok: false,
                    status: 'fail',
                    summary: 'need rollback',
                    metrics: {},
                  };
                }
                if (assistantText === 'base') {
                  return {
                    ok: false,
                    status: 'fail',
                    summary: 'restored state confirmed',
                    metrics: {},
                  };
                }
                return {
                  ok: true,
                  status: 'pass',
                  summary: 'stabilized',
                  metrics: {},
                };
              },
              policy: async ({ assistantText }) => {
                if (assistantText === 'broke state') {
                  return {
                    kind: 'rollback',
                    summary: 'rollback required',
                    reason: 'state corrupted',
                  };
                }
                if (assistantText === 'base') {
                  return {
                    kind: 'continue',
                    summary: 'state restored',
                  };
                }
                return {
                  kind: 'stop',
                  success: true,
                  summary: 'done',
                };
              },
              on: {
                pass: 'stop',
                fail: { goto: 'stabilize' },
                rollback: 'repeat',
              },
            },
          },
        },
        checkpoint: {
          async create() {
            snapshots.push(readFileSync(filePath, 'utf-8'));
            return String(snapshots.length - 1);
          },
          async rollback(_, ref) {
            writeFileSync(filePath, snapshots[Number(ref)] ?? 'base\n', 'utf-8');
          },
        },
      }),
      cwd,
      melosDir: join(cwd, '.melos'),
    });

    expect(summary.success).toBe(true);
    expect(summary.iterations).toBe(3);
    expect(readFileSync(filePath, 'utf-8')).toBe('final\n');
    expect(engine.prompts).toHaveLength(3);
  });
});
