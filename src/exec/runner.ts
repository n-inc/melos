import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { AppServerEngine } from '../engines/app-server.js';
import { ClaudeEngine } from '../engines/claude.js';
import type { Engine, EngineOptions } from '../engines/base.js';
import { EventLog, type MissionEvent } from '../state/events.js';
import { isClaudeFamily, resolveModelEngine, resolveRuntimeModel } from '../models/registry.js';
import { applyConfiguredCommit } from './commit.js';
import { buildIterationHandoff, resolveHandoffFingerprint, selectHandoffHistorySection, writeIterationHandoff } from './handoff.js';
import { generateFinalReport, resolveReportPath, writeFinalReport } from './report.js';
import {
  defaultPromptRenderer,
  type FinalReport,
  normalizeObservation,
  type ContextSection,
  type Decision,
  type EvaluationContext,
  type RecipeContextBase,
  type RecipeDefinition,
  type RecipeLog,
  type ResolvedQuestion,
  type RunnerState,
  type RuntimeTraceEntry,
  type RuntimeEngine,
} from './recipe.js';

export interface ExecRunSummary {
  status: 'completed' | 'asked' | 'failed';
  success: boolean;
  iterations: number;
  decision: Decision['kind'] | 'failed';
  summary: string;
  reason?: string;
  question?: string;
  output?: string;
  report?: FinalReport;
  reportPath?: string;
  reportModel?: string;
  reportDegraded?: boolean;
  reportWarning?: string;
  reportStdout?: boolean;
  cwd: string;
  recipePath?: string;
  startedAt: string;
  finishedAt: string;
  observation?: ReturnType<typeof normalizeObservation>;
}

export interface RunRecipeOptions {
  recipe: RecipeDefinition;
  cwd?: string;
  melosDir: string;
  recipePath?: string;
  askMode?: 'agent-first' | 'never-user' | 'always-user';
  askUser?: (input: {
    question: string;
    state: RunnerState;
    recipe: RecipeDefinition;
  }) => Promise<string | null>;
}

export type RunRouteOptions = RunRecipeOptions;

export function eventLog(options: {
  melosDir: string;
  onEvent?: (event: MissionEvent) => void;
  fileName?: string;
}): RecipeLog {
  mkdirSync(options.melosDir, { recursive: true });
  const log = new EventLog({
    melosDir: options.melosDir,
    fileName: options.fileName,
  });
  return {
    emit(params) {
      const event = log.emit(params);
      options.onEvent?.(event);
      return event;
    },
  };
}

function createRuntimeEngine(engine: RuntimeEngine, model?: string): Engine {
  if (typeof engine !== 'string') {
    return engine;
  }

  if (engine === 'claude') {
    return new ClaudeEngine();
  }
  if (engine === 'codex') {
    return new AppServerEngine();
  }

  return resolveModelEngine(model) === 'claude'
    ? new ClaudeEngine()
    : new AppServerEngine();
}

function resolveExecutionCwd(options: RunRecipeOptions): string {
  const baseCwd = resolve(options.cwd ?? process.cwd());
  const recipeRunCwd = options.recipe.run.cwd;
  if (!recipeRunCwd) {
    return baseCwd;
  }
  if (recipeRunCwd.startsWith('/')) {
    return recipeRunCwd;
  }
  return resolve(baseCwd, recipeRunCwd);
}

function buildEngineOptions(input: {
  recipe: RecipeDefinition;
  cwd: string;
  state: RunnerState;
  onStream?: (chunk: string) => void;
  onCommandOutput?: (chunk: string) => void;
  onEvent?: (method: string, params: unknown) => void;
}): EngineOptions & {
  onStream?: (chunk: string) => void;
  onCommandOutput?: (chunk: string) => void;
  onEvent?: (method: string, params: unknown) => void;
  suppressTerminalOutput: boolean;
  threadId?: string;
} {
  const model = input.recipe.run.model;
  const timeout = input.recipe.run.timeoutMs;
  const engineType = typeof input.recipe.run.engine === 'string'
    ? input.recipe.run.engine
    : resolveModelEngine(model);
  const isClaude = engineType === 'claude' || (engineType === 'auto' && isClaudeFamily(model));

  const options: EngineOptions & {
    onStream?: (chunk: string) => void;
    onCommandOutput?: (chunk: string) => void;
    onEvent?: (method: string, params: unknown) => void;
    suppressTerminalOutput: boolean;
    threadId?: string;
  } = {
    cwd: input.cwd,
    timeout,
    suppressTerminalOutput: true,
    onStream: input.onStream,
    onCommandOutput: input.onCommandOutput,
    onEvent: input.onEvent,
  };

  if (model) {
    options.model = resolveRuntimeModel(model);
  }

  if (input.recipe.run.effort) {
    if (isClaude) {
      options.effort = input.recipe.run.effort as EngineOptions['effort'];
    } else {
      options.reasoningEffort = input.recipe.run.effort as EngineOptions['reasoningEffort'];
    }
  }

  if (!isClaude && input.state.engineThreadId) {
    options.threadId = input.state.engineThreadId;
  }

  return options;
}

function serializeSections(sections: ContextSection[]): Record<string, unknown> {
  return {
    count: sections.length,
    titles: sections.map((section) => section.title),
  };
}

function applyDecisionStateUpdate(state: RunnerState, decision: Decision): RunnerState {
  if (!decision.stateUpdate) {
    return state;
  }
  return {
    ...state,
    attempts: decision.stateUpdate.attempts ?? state.attempts,
    bestMetrics: decision.stateUpdate.bestMetrics ?? state.bestMetrics,
  };
}

function createRecipeContext(
  state: RunnerState,
  melosDir: string,
  recipe: RecipeDefinition
): RecipeContextBase {
  return {
    cwd: state.cwd,
    melosDir,
    recipePath: state.recipePath,
    state,
    previousObservation: state.lastObservation,
    resolvedQuestions: state.resolvedQuestions ?? [],
    runConfig: recipe.run,
  };
}

function finalizeSummary(params: {
  status: ExecRunSummary['status'];
  success: boolean;
  decision: ExecRunSummary['decision'];
  iterations: number;
  cwd: string;
  recipePath?: string;
  startedAt: string;
  summary: string;
  reason?: string;
  question?: string;
  output?: string;
  observation?: ReturnType<typeof normalizeObservation>;
}): ExecRunSummary {
  return {
    ...params,
    finishedAt: new Date().toISOString(),
  };
}

async function attachFinalReport(input: {
  summary: ExecRunSummary;
  recipe: RecipeDefinition;
  cwd: string;
  baseCwd: string;
  melosDir: string;
  recipePath?: string;
  iteration: number;
  logger: RecipeLog;
  state: RunnerState;
  reason?: string;
  output?: string;
  observation?: ReturnType<typeof normalizeObservation>;
  trace?: RuntimeTraceEntry[];
}): Promise<ExecRunSummary> {
  if (!input.recipe.report) {
    return input.summary;
  }

  const report = await generateFinalReport({
    recipe: input.recipe,
    cwd: input.cwd,
    melosDir: input.melosDir,
    recipePath: input.recipePath,
    handoffFingerprint: input.state.handoffFingerprint,
    lastHandoffPath: input.state.lastHandoffPath,
    iterations: input.summary.iterations,
    success: input.summary.success,
    decision: input.summary.decision,
    summary: input.summary.summary,
    reason: input.reason ?? input.summary.reason,
    output: input.output ?? input.summary.output,
    observation: input.observation ?? input.summary.observation,
    resolvedQuestions: input.state.resolvedQuestions,
    trace: input.trace ?? input.state.lastTrace,
  });
  const reportPath = resolveReportPath(input.baseCwd, input.recipe.report);
  let persistedReportPath: string | undefined = reportPath;
  let writeWarning: string | undefined;
  try {
    writeFinalReport(reportPath, report.report);
  } catch (error) {
    persistedReportPath = undefined;
    const message = error instanceof Error ? error.message : String(error);
    writeWarning = `failed to write final report: ${message}`;
  }
  const degraded = report.degraded || Boolean(writeWarning);
  input.logger.emit({
    type: 'report_generated',
    iteration: input.iteration,
    agent: 'system',
    payload: {
      path: reportPath,
      summary: report.report.summary,
      degraded,
      model: report.model,
      error: writeWarning ?? report.error,
    },
  });
  return {
    ...input.summary,
    report: report.report,
    reportPath: persistedReportPath,
    reportModel: report.model,
    reportDegraded: degraded,
    reportWarning: writeWarning ?? report.error,
    reportStdout: input.recipe.report?.stdout !== false,
  };
}

function buildResolvedQuestionsSection(resolvedQuestions: ResolvedQuestion[]): ContextSection[] {
  if (resolvedQuestions.length === 0) {
    return [];
  }
  return [{
    title: 'resolved questions',
    content: JSON.stringify(resolvedQuestions, null, 2),
  }];
}

function pushTraceEntry(trace: RuntimeTraceEntry[], entry: RuntimeTraceEntry): void {
  trace.push(entry);
}

function captureEngineTrace(trace: RuntimeTraceEntry[]): {
  onStream: (chunk: string) => void;
  onCommandOutput: (chunk: string) => void;
  onEvent: (method: string, params: unknown) => void;
} {
  return {
    onStream: (chunk) => {
      if (chunk.trim().length === 0) {
        return;
      }
      pushTraceEntry(trace, {
        kind: 'agent_message',
        timestamp: new Date().toISOString(),
        text: chunk,
      });
    },
    onCommandOutput: (chunk) => {
      if (chunk.trim().length === 0) {
        return;
      }
      pushTraceEntry(trace, {
        kind: 'command_output',
        timestamp: new Date().toISOString(),
        text: chunk,
      });
    },
    onEvent: (method, params) => {
      const timestamp = new Date().toISOString();
      if (method === 'item/commandExecution/requestApproval' && isRecord(params)) {
        const command = readString(params, 'command');
        if (command) {
          pushTraceEntry(trace, {
            kind: 'command',
            timestamp,
            command,
            cwd: readString(params, 'cwd') ?? undefined,
            reason: readString(params, 'reason') ?? undefined,
            source: 'app-server',
          });
          return;
        }
      }
      if (method === 'item/fileChange/requestApproval' && isRecord(params)) {
        pushTraceEntry(trace, {
          kind: 'file_change',
          timestamp,
          path: readString(params, 'path') ?? undefined,
          source: 'app-server',
          data: params,
        });
        return;
      }
      if (method === 'claude/tool_use' && isRecord(params)) {
        const name = readString(params, 'name');
        const input = isRecord(params.input) ? params.input : null;
        if (name === 'Bash') {
          const command = input ? readString(input, 'command') : null;
          if (command) {
            pushTraceEntry(trace, {
              kind: 'command',
              timestamp,
              command,
              cwd: input ? readString(input, 'cwd') ?? undefined : undefined,
              source: 'claude',
            });
            return;
          }
        }
        if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
          pushTraceEntry(trace, {
            kind: 'file_change',
            timestamp,
            path: input ? readString(input, 'file_path') ?? undefined : undefined,
            source: 'claude',
            data: params,
          });
          return;
        }
      }
      if (method === 'claude/tool_result' && isRecord(params)) {
        pushTraceEntry(trace, {
          kind: 'tool_result',
          timestamp,
          text: readString(params, 'content') ?? '',
          source: 'claude',
          isError: typeof params.is_error === 'boolean' ? params.is_error : undefined,
          exitCode: typeof params.exit_code === 'number' ? params.exit_code : undefined,
          durationMs: typeof params.duration_ms === 'number' ? params.duration_ms : undefined,
        });
        return;
      }

      pushTraceEntry(trace, {
        kind: 'engine_event',
        timestamp,
        method,
        data: params,
      });
    },
  };
}

function buildAskResolverPrompt(input: {
  question: string;
  observationSummary: string;
  observationDetails?: string;
  assistantText: string;
  resolvedQuestions: ResolvedQuestion[];
}): string {
  return defaultPromptRenderer(
    [
      'You are resolving a blocking question for melos run.',
      'Return strict JSON only.',
      'Use this exact shape:',
      '{"resolved":true|false,"answer":"...","rationale":"..."}',
      'If the question cannot be answered from the available context, return {"resolved":false,...}.',
    ].join('\n'),
    [
      {
        title: 'question',
        content: input.question,
      },
      {
        title: 'latest observation',
        content: JSON.stringify({
          summary: input.observationSummary,
          details: input.observationDetails,
        }, null, 2),
      },
      {
        title: 'latest assistant output',
        content: input.assistantText.trim() || '(empty assistant output)',
      },
      ...(input.resolvedQuestions.length > 0
        ? [{
          title: 'resolved questions',
          content: JSON.stringify(input.resolvedQuestions, null, 2),
        }]
        : []),
    ]
  );
}

async function resolveAskWithAgent(input: {
  engine: Engine;
  recipe: RecipeDefinition;
  cwd: string;
  melosDir: string;
  state: RunnerState;
  question: string;
  observationSummary: string;
  observationDetails?: string;
  assistantText: string;
  trace: RuntimeTraceEntry[];
}): Promise<ResolvedQuestion | null> {
  const traceCallbacks = captureEngineTrace(input.trace);
  const result = await input.engine.execute(
    buildAskResolverPrompt({
      question: input.question,
      observationSummary: input.observationSummary,
      observationDetails: input.observationDetails,
      assistantText: input.assistantText,
      resolvedQuestions: input.state.resolvedQuestions ?? [],
    }),
    buildEngineOptions({
      recipe: input.recipe,
      cwd: input.cwd,
      state: {
        ...input.state,
        // Keep the main execution thread isolated from the auxiliary ask resolver turn.
        engineThreadId: undefined,
      },
      ...traceCallbacks,
    })
  );
  if (!result.success) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.output) as {
      resolved?: boolean;
      answer?: string;
      rationale?: string;
    };
    if (parsed.resolved !== true || typeof parsed.answer !== 'string' || parsed.answer.trim().length === 0) {
      return null;
    }
    return {
      iteration: input.state.iteration,
      question: input.question,
      answer: parsed.answer.trim(),
      source: 'agent',
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale.trim() : undefined,
    };
  } catch {
    return null;
  }
}

async function resolveAskDecision(input: {
  options: RunRecipeOptions;
  recipe: RecipeDefinition;
  logger: RecipeLog;
  state: RunnerState;
  decision: Extract<Decision, { kind: 'ask' }>;
  engine: Engine;
  observation: ReturnType<typeof normalizeObservation>;
  assistantText: string;
  trace: RuntimeTraceEntry[];
}): Promise<{ resolvedQuestion: ResolvedQuestion | null; failureReason?: string }> {
  const askMode = input.options.askMode ?? 'agent-first';

  if (askMode !== 'always-user') {
    const resolvedQuestion = await resolveAskWithAgent({
      engine: input.engine,
      recipe: input.recipe,
      cwd: input.state.cwd,
      melosDir: input.options.melosDir,
      state: input.state,
      question: input.decision.question,
      observationSummary: input.observation.summary,
      observationDetails: input.observation.details,
      assistantText: input.assistantText,
      trace: input.trace,
    });
    if (resolvedQuestion) {
      return { resolvedQuestion };
    }
  }

  if (askMode === 'never-user') {
    return { resolvedQuestion: null, failureReason: `Could not resolve question: ${input.decision.question}` };
  }

  if (!input.options.askUser) {
    return { resolvedQuestion: null, failureReason: `Could not resolve question: ${input.decision.question}` };
  }

  input.logger.emit({
    type: 'run_asked',
    iteration: input.state.iteration,
    agent: 'system',
    payload: {
      question: input.decision.question,
      mode: askMode,
    },
  });
  const answer = await input.options.askUser({
    question: input.decision.question,
    state: input.state,
    recipe: input.recipe,
  });
  if (!answer || answer.trim().length === 0) {
    return { resolvedQuestion: null, failureReason: `Could not resolve question: ${input.decision.question}` };
  }
  input.logger.emit({
    type: 'user_answer',
    iteration: input.state.iteration,
    agent: 'system',
    payload: {
      question: input.decision.question,
      answer,
    },
  });
  return {
    resolvedQuestion: {
      iteration: input.state.iteration,
      question: input.decision.question,
      answer: answer.trim(),
      source: 'user',
    },
  };
}

function readActiveThreadId(engine: Engine): string | undefined {
  if ('getActiveThreadId' in engine && typeof engine.getActiveThreadId === 'function') {
    const threadId = engine.getActiveThreadId();
    return typeof threadId === 'string' && threadId.length > 0 ? threadId : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  return typeof source[key] === 'string' ? String(source[key]) : null;
}

export async function runRecipe(options: RunRecipeOptions): Promise<ExecRunSummary> {
  const baseCwd = resolve(options.cwd ?? process.cwd());
  const cwd = resolveExecutionCwd(options);
  mkdirSync(options.melosDir, { recursive: true });

  const recipe = options.recipe;
  const logger = recipe.log ?? eventLog({ melosDir: options.melosDir });
  const startedAt = new Date().toISOString();
  const maxIterations = Math.max(1, recipe.limits?.maxIterations ?? 10);
  const deadline = recipe.limits?.timeoutMs
    ? Date.now() + recipe.limits.timeoutMs
    : null;
  const handoffFingerprint = resolveHandoffFingerprint({
    recipePath: options.recipePath
      ? resolve(options.cwd ?? process.cwd(), options.recipePath)
      : undefined,
    prompt: typeof recipe.prompt === 'string' ? recipe.prompt : undefined,
    promptSource: typeof recipe.prompt === 'function' ? recipe.prompt.toString() : undefined,
  }) ?? 'unknown';

  let state: RunnerState = {
    iteration: 0,
    startedAt,
    lastObservation: null,
    bestMetrics: {},
    checkpointRef: undefined,
    cwd,
    recipePath: options.recipePath,
    attempts: 0,
    resolvedQuestions: [],
    lastAssistantText: undefined,
    lastTrace: [],
    engineThreadId: undefined,
    lastHandoffPath: undefined,
    handoffFingerprint,
  };

  const engine = createRuntimeEngine(recipe.run.engine, recipe.run.model);
  try {
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (deadline !== null && Date.now() > deadline) {
        const summary = finalizeSummary({
          status: 'failed',
          success: false,
          decision: 'failed',
          iterations: iteration - 1,
          cwd,
          recipePath: options.recipePath,
          startedAt,
          summary: 'exec timed out',
        });
        const summarized = await attachFinalReport({
          summary,
          recipe,
          cwd,
          baseCwd,
          melosDir: options.melosDir,
          recipePath: options.recipePath,
          iteration: iteration - 1,
          logger,
          state,
        });
        logger.emit({
          type: 'run_failed',
          iteration: iteration - 1,
          agent: 'system',
          payload: summarized as unknown as Record<string, unknown>,
        });
        return summarized;
      }

      state = { ...state, iteration };
      logger.emit({
        type: 'iteration_started',
        iteration,
        agent: 'system',
        payload: {
          recipePath: options.recipePath,
        },
      });

      const baseContext = createRecipeContext(state, options.melosDir, recipe);
      if (recipe.checkpoint) {
        const checkpointRef = await recipe.checkpoint.create(baseContext);
        state = { ...state, checkpointRef };
        if (checkpointRef) {
          logger.emit({
            type: 'checkpoint_created',
            iteration,
            agent: 'system',
            payload: { ref: checkpointRef },
          });
        }
      }

      const staticContextSections: ContextSection[] = [
        ...buildResolvedQuestionsSection(state.resolvedQuestions ?? []),
      ];
      for (const provider of recipe.context) {
        const provided = await provider(createRecipeContext(state, options.melosDir, recipe));
        if (!provided) {
          continue;
        }
        if (Array.isArray(provided)) {
          staticContextSections.push(...provided.filter((section) => section.content.trim().length > 0));
          continue;
        }
        if (provided.content.trim().length > 0) {
          staticContextSections.push(provided);
        }
      }
      const promptText = typeof recipe.prompt === 'function'
        ? await recipe.prompt({
          ...createRecipeContext(state, options.melosDir, recipe),
          contextSections: staticContextSections,
        })
        : recipe.prompt;
      const handoffDecision = selectHandoffHistorySection({
        melosDir: options.melosDir,
        fingerprint: handoffFingerprint,
        prompt: promptText,
        sections: staticContextSections,
      });
      const contextSections: ContextSection[] = handoffDecision.section
        ? [...staticContextSections, handoffDecision.section]
        : staticContextSections;
      logger.emit({
        type: 'context_built',
        iteration,
        agent: 'system',
        payload: {
          ...serializeSections(contextSections),
          handoffHistory: handoffDecision.mode === 'none'
            ? undefined
            : {
              mode: handoffDecision.mode,
              totalEntries: handoffDecision.totalEntries,
              includedEntries: handoffDecision.includedEntries,
              omittedEntries: handoffDecision.omittedEntries,
            },
        },
      });
      if (handoffDecision.mode === 'omitted') {
        logger.emit({
          type: 'warning_emitted',
          iteration,
          agent: 'system',
          payload: {
            warning: 'handoff history omitted due to prompt budget',
            kind: 'exec_handoff_budget',
            handoffFingerprint,
          },
        });
      }
      const renderedPrompt = defaultPromptRenderer(promptText, contextSections);

      const trace: RuntimeTraceEntry[] = [];
      const traceCallbacks = captureEngineTrace(trace);
      const engineResult = await engine.execute(
        renderedPrompt,
        buildEngineOptions({
          recipe,
          cwd,
          state,
          ...traceCallbacks,
        })
      );
      state = {
        ...state,
        engineThreadId: readActiveThreadId(engine) ?? state.engineThreadId,
        lastAssistantText: engineResult.output,
        lastTrace: trace,
      };
      logger.emit({
        type: 'engine_finished',
        iteration,
        agent: 'system',
        payload: {
          success: engineResult.success,
          exitCode: engineResult.exitCode,
          outputLength: engineResult.output.length,
          error: engineResult.error,
        },
      });

      if (!engineResult.success) {
        const summary = finalizeSummary({
          status: 'failed',
          success: false,
          decision: 'failed',
          iterations: iteration,
          cwd,
          recipePath: options.recipePath,
          startedAt,
          summary: engineResult.error ?? 'engine execution failed',
          output: engineResult.output,
        });
        const summarized = await attachFinalReport({
          summary,
          recipe,
          cwd,
          baseCwd,
          melosDir: options.melosDir,
          recipePath: options.recipePath,
          iteration,
          logger,
          state,
          output: engineResult.output,
          trace,
        });
        logger.emit({
          type: 'run_failed',
          iteration,
          agent: 'system',
          payload: summarized as unknown as Record<string, unknown>,
        });
        return summarized;
      }

      const evaluationContext: EvaluationContext = {
        ...createRecipeContext(state, options.melosDir, recipe),
        assistantText: engineResult.output,
        engineResult,
      };
      const observation = normalizeObservation(await recipe.evaluate(evaluationContext));
      logger.emit({
        type: 'evaluation_finished',
        iteration,
        agent: 'system',
        payload: {
          ok: observation.ok,
          status: observation.status,
          summary: observation.summary,
          metrics: observation.metrics,
        },
      });

      const decision = await recipe.policy({
        ...evaluationContext,
        observation,
        recipe,
      });
      logger.emit({
        type: 'decision_made',
        iteration,
        agent: 'system',
        payload: {
          kind: decision.kind,
          summary: decision.summary,
          reason: decision.reason,
          success: decision.success,
          question: 'question' in decision ? decision.question : undefined,
        },
      });

      state = applyDecisionStateUpdate({
        ...state,
        lastObservation: observation,
      }, decision);

      let resolvedQuestion: ResolvedQuestion | null = null;
      let askFailureReason: string | undefined;
      if (decision.kind === 'ask') {
        const askOutcome = await resolveAskDecision({
          options,
          recipe,
          logger,
          state,
          decision,
          engine,
          observation,
          assistantText: engineResult.output,
          trace,
        });
        resolvedQuestion = askOutcome.resolvedQuestion;
        askFailureReason = askOutcome.failureReason;
        if (resolvedQuestion) {
          state = {
            ...state,
            resolvedQuestions: [...(state.resolvedQuestions ?? []), resolvedQuestion],
          };
        }
      }

      const handoffPath = writeIterationHandoff(options.melosDir, handoffFingerprint, buildIterationHandoff({
        iteration,
        timestamp: new Date().toISOString(),
        cwd,
        checkpointRef: state.checkpointRef,
        promptSummary: typeof promptText === 'string' ? promptText.trim() : renderedPrompt.slice(0, 200),
        assistantText: engineResult.output,
        observation,
        decision,
        trace,
        resolvedQuestions: state.resolvedQuestions ?? [],
      }));
      state = {
        ...state,
        lastHandoffPath: handoffPath,
      };

      if (recipe.commit) {
        try {
          const committed = await applyConfiguredCommit({
            config: recipe.commit,
            baseContext: createRecipeContext(state, options.melosDir, recipe),
            decision,
            observation,
            assistantText: engineResult.output,
          });
          if (committed) {
            logger.emit({
              type: 'commit_created',
              iteration,
              agent: 'system',
              payload: {
                ref: committed.ref,
                message: committed.message,
                changedFiles: committed.changedFiles,
                when: recipe.commit.when ?? 'never',
              },
            });
          }
        } catch (error) {
          const summary = finalizeSummary({
            status: 'failed',
            success: false,
            decision: 'failed',
            iterations: iteration,
            cwd,
            recipePath: options.recipePath,
            startedAt,
            summary: 'failed to create git commit',
            reason: error instanceof Error ? error.message : String(error),
            output: engineResult.output,
            observation,
          });
          const summarized = await attachFinalReport({
            summary,
            recipe,
            cwd,
            baseCwd,
            melosDir: options.melosDir,
            recipePath: options.recipePath,
            iteration,
            logger,
            state,
            reason: error instanceof Error ? error.message : String(error),
            output: engineResult.output,
            observation,
            trace,
          });
          logger.emit({
            type: 'run_failed',
            iteration,
            agent: 'system',
            payload: summarized as unknown as Record<string, unknown>,
          });
          return summarized;
        }
      }

      if (decision.kind === 'rollback') {
        if (!recipe.checkpoint || !state.checkpointRef) {
          const summary = finalizeSummary({
            status: 'failed',
            success: false,
            decision: 'failed',
            iterations: iteration,
            cwd,
            recipePath: options.recipePath,
            startedAt,
            summary: 'rollback decision was returned without a checkpoint',
            reason: decision.reason,
            output: engineResult.output,
            observation,
          });
          const summarized = await attachFinalReport({
            summary,
            recipe,
            cwd,
            baseCwd,
            melosDir: options.melosDir,
            recipePath: options.recipePath,
            iteration,
            logger,
            state,
            reason: decision.reason,
            output: engineResult.output,
            observation,
            trace,
          });
          logger.emit({
            type: 'run_failed',
            iteration,
            agent: 'system',
            payload: summarized as unknown as Record<string, unknown>,
          });
          return summarized;
        }

        await recipe.checkpoint.rollback(createRecipeContext(state, options.melosDir, recipe), state.checkpointRef);
        logger.emit({
          type: 'rollback_applied',
          iteration,
          agent: 'system',
          payload: {
            ref: state.checkpointRef,
            reason: decision.reason ?? decision.summary ?? observation.summary,
          },
        });
        continue;
      }

      if (decision.kind === 'ask') {
        if (resolvedQuestion) {
          continue;
        }
        const summary = finalizeSummary({
          status: 'failed',
          success: false,
          decision: 'failed',
          iterations: iteration,
          cwd,
          recipePath: options.recipePath,
          startedAt,
          summary: askFailureReason ?? decision.summary ?? observation.summary,
          reason: decision.reason ?? askFailureReason,
          question: decision.question,
          output: engineResult.output,
          observation,
        });
        const summarized = await attachFinalReport({
          summary,
          recipe,
          cwd,
          baseCwd,
          melosDir: options.melosDir,
          recipePath: options.recipePath,
          iteration,
          logger,
          state,
          reason: decision.reason ?? askFailureReason,
          output: engineResult.output,
          observation,
          trace,
        });
        logger.emit({
          type: 'run_failed',
          iteration,
          agent: 'system',
          payload: summarized as unknown as Record<string, unknown>,
        });
        return summarized;
      }

      if (decision.kind === 'stop') {
        if (recipe.checkpoint && state.checkpointRef) {
          await recipe.checkpoint.keep?.(createRecipeContext(state, options.melosDir, recipe), state.checkpointRef);
        }
        const summary = finalizeSummary({
          status: 'completed',
          success: decision.success ?? observation.ok,
          decision: 'stop',
          iterations: iteration,
          cwd,
          recipePath: options.recipePath,
          startedAt,
          summary: decision.summary ?? observation.summary,
          reason: decision.reason,
          output: observation.output ?? engineResult.output,
          observation,
        });
        const summarized = await attachFinalReport({
          summary,
          recipe,
          cwd,
          baseCwd,
          melosDir: options.melosDir,
          recipePath: options.recipePath,
          iteration,
          logger,
          state,
          reason: decision.reason,
          output: observation.output ?? engineResult.output,
          observation,
          trace,
        });
        logger.emit({
          type: summarized.success ? 'run_completed' : 'run_failed',
          iteration,
          agent: 'system',
          payload: summarized as unknown as Record<string, unknown>,
        });
        return summarized;
      }
    }

    const summary = finalizeSummary({
      status: 'failed',
      success: false,
      decision: 'failed',
      iterations: maxIterations,
      cwd,
      recipePath: options.recipePath,
      startedAt,
      summary: `max iterations reached (${maxIterations})`,
      observation: state.lastObservation ?? undefined,
    });
    const summarized = await attachFinalReport({
      summary,
      recipe,
      cwd,
      baseCwd,
      melosDir: options.melosDir,
      recipePath: options.recipePath,
      iteration: maxIterations,
      logger,
      state,
      observation: state.lastObservation ?? undefined,
    });
    logger.emit({
      type: 'run_failed',
      iteration: maxIterations,
      agent: 'system',
      payload: summarized as unknown as Record<string, unknown>,
    });
    return summarized;
  } finally {
    if ('shutdown' in engine && typeof engine.shutdown === 'function') {
      await engine.shutdown();
    }
  }
}

export async function runRoute(options: RunRouteOptions): Promise<ExecRunSummary> {
  return runRecipe(options);
}
