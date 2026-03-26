import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { AppServerEngine } from '../engines/app-server.js';
import { ClaudeEngine } from '../engines/claude.js';
import type { Engine, EngineOptions } from '../engines/base.js';
import { EventLog, type MissionEvent } from '../state/events.js';
import { isClaudeFamily, resolveModelEngine, resolveRuntimeModel } from '../models/registry.js';
import { applyConfiguredCommit, assertCommitWorkspaceClean, isCommitEnabled } from './commit.js';
import { buildIterationHandoff, resolveHandoffFingerprint, writeIterationHandoff } from './handoff.js';
import { generateFinalReport, resolveReportPath, writeFinalReport } from './report.js';
import { renderPromptWithSections, type PromptSection } from './prompt-sections.js';
import {
  describeWorkflowTransition,
  normalizeObservation,
  type Decision,
  type EvaluationContext,
  type FinalReport,
  type RecipeContextBase,
  type RecipeDefinition,
  type RecipeLog,
  type RecipeRunConfig,
  type ResolvedQuestion,
  type RunnerState,
  type RuntimeEngine,
  type RuntimeTraceEntry,
  type WorkflowPhaseDefinition,
  type WorkflowTransition,
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

export interface RunRouteOptions {
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

function resolveRunCwd(baseCwd: string, runCwd?: string): string {
  if (!runCwd) {
    return resolve(baseCwd);
  }
  if (isAbsolute(runCwd)) {
    return runCwd;
  }
  return resolve(baseCwd, runCwd);
}

function mergeRunConfig(baseRun: RecipeRunConfig, override?: Partial<RecipeRunConfig>): RecipeRunConfig {
  return {
    ...baseRun,
    ...override,
    engine: override?.engine ?? baseRun.engine,
  };
}

function buildEngineOptions(input: {
  runConfig: RecipeRunConfig;
  cwd: string;
  onStream?: (chunk: string) => void;
  onCommandOutput?: (chunk: string) => void;
  onEvent?: (method: string, params: unknown) => void;
}): EngineOptions & {
  onStream?: (chunk: string) => void;
  onCommandOutput?: (chunk: string) => void;
  onEvent?: (method: string, params: unknown) => void;
  suppressTerminalOutput: boolean;
} {
  const model = input.runConfig.model;
  const engineType = typeof input.runConfig.engine === 'string'
    ? input.runConfig.engine
    : resolveModelEngine(model);
  const isClaude = engineType === 'claude' || (engineType === 'auto' && isClaudeFamily(model));

  const options: EngineOptions & {
    onStream?: (chunk: string) => void;
    onCommandOutput?: (chunk: string) => void;
    onEvent?: (method: string, params: unknown) => void;
    suppressTerminalOutput: boolean;
  } = {
    cwd: input.cwd,
    timeout: input.runConfig.timeoutMs,
    suppressTerminalOutput: true,
    onStream: input.onStream,
    onCommandOutput: input.onCommandOutput,
    onEvent: input.onEvent,
  };

  if (model) {
    options.model = resolveRuntimeModel(model);
  }
  if (input.runConfig.effort) {
    if (isClaude) {
      options.effort = input.runConfig.effort as EngineOptions['effort'];
    } else {
      options.reasoningEffort = input.runConfig.effort as EngineOptions['reasoningEffort'];
    }
  }

  return options;
}

function serializeSections(sections: PromptSection[]): Record<string, unknown> {
  return {
    count: sections.length,
    titles: sections.map((section) => section.title),
  };
}

function truncatePromptText(value: string, maxLength = 4_000): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  const omitted = trimmed.length - maxLength;
  return `${trimmed.slice(0, maxLength)}\n...(truncated ${omitted} chars)`;
}

function extractFailureChecks(data: unknown): Array<Record<string, unknown>> | undefined {
  const checks = isRecord(data) && isRecord(data.shell) && Array.isArray(data.shell.checks)
    ? data.shell.checks
    : isRecord(data) && isRecord(data.check) && Array.isArray(data.check.checks)
      ? data.check.checks
      : isRecord(data) && Array.isArray(data.checks)
      ? data.checks
      : undefined;
  if (!checks) {
    return undefined;
  }
  const normalized = checks.flatMap((check) => {
    if (!isRecord(check) || typeof check.command !== 'string') {
      return [];
    }
    return [{
      command: check.command,
      cwd: typeof check.cwd === 'string' ? check.cwd : undefined,
      exitCode: typeof check.exitCode === 'number' ? check.exitCode : undefined,
      timedOut: typeof check.timedOut === 'boolean' ? check.timedOut : undefined,
    }];
  });
  return normalized.length > 0 ? normalized : undefined;
}

function buildResolvedQuestionsSection(resolvedQuestions: ResolvedQuestion[]): PromptSection[] {
  if (resolvedQuestions.length === 0) {
    return [];
  }
  return [{
    title: 'Resolved Questions',
    content: JSON.stringify(resolvedQuestions, null, 2),
  }];
}

function buildLatestFailureSection(observation: RunnerState['lastObservation']): PromptSection[] {
  if (!observation || observation.ok || observation.status === 'pass') {
    return [];
  }

  const content: Record<string, unknown> = {
    status: observation.status,
    summary: observation.summary,
  };
  if (typeof observation.details === 'string' && observation.details.trim().length > 0) {
    content.details = truncatePromptText(observation.details);
  }
  const checks = extractFailureChecks(observation.data);
  if (checks) {
    content.checks = checks;
  }

  return [{
    title: 'Latest Failure',
    content: JSON.stringify(content, null, 2),
  }];
}

function buildWorkflowSection(state: RunnerState, phaseName: string): PromptSection[] {
  if (Object.keys(state.outputs).length === 0 && state.history.length === 0) {
    return [];
  }
  return [{
    title: 'Workflow State',
    content: JSON.stringify({
      currentPhase: phaseName,
      outputs: state.outputs,
      phaseCounts: state.phaseCounts,
      loopCounts: state.loopCounts ?? {},
      history: state.history,
    }, null, 2),
  }];
}

function applyDecisionStateUpdate(state: RunnerState, phaseName: string, decision: Decision): RunnerState {
  const existing = state.phaseStates[phaseName] ?? { attempts: 0, bestMetrics: {} };
  const nextPhaseState = {
    attempts: decision.stateUpdate?.attempts ?? existing.attempts,
    bestMetrics: decision.stateUpdate?.bestMetrics ?? existing.bestMetrics,
  };
  return {
    ...state,
    attempts: nextPhaseState.attempts,
    bestMetrics: nextPhaseState.bestMetrics,
    phaseStates: {
      ...state.phaseStates,
      [phaseName]: nextPhaseState,
    },
  };
}

function createRecipeContext(
  state: RunnerState,
  melosDir: string,
  recipe: RecipeDefinition,
  runConfig: RecipeRunConfig
): RecipeContextBase {
  return {
    cwd: state.cwd,
    melosDir,
    recipePath: state.recipePath,
    state,
    previousObservation: state.lastObservation,
    resolvedQuestions: state.resolvedQuestions ?? [],
    runConfig,
    workflow: state.currentPhase
      ? {
        phase: state.currentPhase,
        outputs: state.outputs,
        phaseCounts: state.phaseCounts,
        loopCounts: state.loopCounts ?? {},
        history: state.history,
      }
      : undefined,
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
  commitRange?: {
    baseRef: string;
    headRef: string;
  };
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
    commitRange: input.commitRange,
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
    workflow: {
      outputs: input.state.outputs,
      phaseCounts: input.state.phaseCounts,
      loopCounts: input.state.loopCounts ?? {},
      history: input.state.history,
    },
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

function pushTraceEntry(trace: RuntimeTraceEntry[], entry: RuntimeTraceEntry): void {
  trace.push(entry);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  return typeof source[key] === 'string' ? String(source[key]) : null;
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
  return renderPromptWithSections(
    [
      'You are resolving a blocking question for melos run.',
      'Return strict JSON only.',
      'Use this exact shape:',
      '{"resolved":true|false,"answer":"...","rationale":"..."}',
      'If the question cannot be answered from the available context, return {"resolved":false,...}.',
    ].join('\n'),
    [
      {
        title: 'Question',
        content: input.question,
      },
      {
        title: 'Latest Observation',
        content: JSON.stringify({
          summary: input.observationSummary,
          details: input.observationDetails,
        }, null, 2),
      },
      {
        title: 'Latest Assistant Output',
        content: input.assistantText.trim() || '(empty assistant output)',
      },
      ...(input.resolvedQuestions.length > 0
        ? [{
          title: 'Resolved Questions',
          content: JSON.stringify(input.resolvedQuestions, null, 2),
        }]
        : []),
    ]
  );
}

async function resolveAskWithAgent(input: {
  engine: Engine;
  runConfig: RecipeRunConfig;
  cwd: string;
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
      runConfig: input.runConfig,
      cwd: input.cwd,
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
  options: RunRouteOptions;
  runConfig: RecipeRunConfig;
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
      runConfig: input.runConfig,
      cwd: input.state.cwd,
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
      phase: input.state.currentPhase,
      phaseExecution: input.state.phaseExecution,
    },
  });
  const answer = await input.options.askUser({
    question: input.decision.question,
    state: input.state,
    recipe: input.options.recipe,
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
      phase: input.state.currentPhase,
      phaseExecution: input.state.phaseExecution,
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

function readHeadRef(cwd: string): string | undefined {
  try {
    const ref = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return ref.length > 0 ? ref : undefined;
  } catch {
    return undefined;
  }
}

function buildFinalReportCommitRange(range: {
  baseRef?: string;
  headRef?: string;
} | null): { baseRef: string; headRef: string } | undefined {
  if (!range?.baseRef || !range.headRef || range.baseRef === range.headRef) {
    return undefined;
  }
  return {
    baseRef: range.baseRef,
    headRef: range.headRef,
  };
}

function readWorkflowProduce(input: {
  phaseName: string;
  phase: WorkflowPhaseDefinition;
  assistantText: string;
  cwd: string;
}): { ok: true; value: unknown } | { ok: false; message: string } {
  if (!input.phase.produce) {
    return { ok: true, value: undefined };
  }

  if (input.phase.produce.from === 'assistant-json') {
    try {
      return {
        ok: true,
        value: JSON.parse(input.assistantText),
      };
    } catch (error) {
      return {
        ok: false,
        message: `phase "${input.phaseName}" assistant-json output is invalid: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const filePath = input.phase.produce.from.file;
  const resolvedPath = isAbsolute(filePath) ? filePath : resolve(input.cwd, filePath);
  try {
    return {
      ok: true,
      value: JSON.parse(readFileSync(resolvedPath, 'utf-8')),
    };
  } catch (error) {
    return {
      ok: false,
      message: `phase "${input.phaseName}" file produce is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function actionDecisionFromTransition(transition: WorkflowTransition, summary: string): Decision {
  if (transition === 'stop') {
    return {
      kind: 'stop',
      success: true,
      summary,
    };
  }
  return {
    kind: 'continue',
    success: true,
    summary,
  };
}

function isLlmEvaluatorPayload(data: unknown): boolean {
  return isRecord(data) && typeof data.engine === 'string';
}

function isLlmEvaluatorErrorObservation(observation: ReturnType<typeof normalizeObservation>): boolean {
  if (observation.status !== 'error') {
    return false;
  }
  return isLlmEvaluatorPayload(observation.data)
    || (isRecord(observation.data) && isLlmEvaluatorPayload(observation.data.llm))
    || (isRecord(observation.data) && isLlmEvaluatorPayload(observation.data.pass));
}

function coerceDecisionForObservationError(
  decision: Decision,
  observation: ReturnType<typeof normalizeObservation>
): Decision {
  if (!isLlmEvaluatorErrorObservation(observation)) {
    return decision;
  }
  if (decision.kind === 'stop' && decision.success === false) {
    return decision;
  }
  return {
    kind: 'stop',
    success: false,
    summary: decision.summary ?? observation.summary,
    reason: decision.reason ?? observation.summary,
  };
}

function resolvePhaseTransition(input: {
  phaseName: string;
  phase: WorkflowPhaseDefinition;
  observation: ReturnType<typeof normalizeObservation>;
  decision: Decision;
}): WorkflowTransition {
  if (!input.phase.evaluate) {
    if (!input.phase.next) {
      throw new Error(`workflow phase "${input.phaseName}" requires next when no evaluators are configured`);
    }
    return input.phase.next;
  }

  if (!input.phase.on) {
    throw new Error(`workflow phase "${input.phaseName}" requires on when evaluators are configured`);
  }
  if (!input.phase.on.fail) {
    throw new Error(`workflow phase "${input.phaseName}" requires on.fail when evaluators are configured`);
  }

  if (input.decision.kind === 'ask') {
    if (!input.phase.on.ask) {
      throw new Error(`workflow phase "${input.phaseName}" requires on.ask when ask is returned`);
    }
    return input.phase.on.ask;
  }
  if (input.decision.kind === 'stop' && (input.decision.success === false || input.observation.ok === false)) {
    return 'stop';
  }
  if (input.decision.kind === 'rollback') {
    if (!input.phase.on.rollback) {
      throw new Error(`workflow phase "${input.phaseName}" requires on.rollback when rollback is returned`);
    }
    return input.phase.on.rollback;
  }
  if (input.decision.kind === 'continue') {
    return input.phase.on.fail;
  }
  return (input.decision.success ?? input.observation.ok) ? input.phase.on.pass : input.phase.on.fail;
}

export async function runRoute(options: RunRouteOptions): Promise<ExecRunSummary> {
  const baseCwd = resolve(options.cwd ?? process.cwd());
  const melosDir = options.melosDir;
  mkdirSync(melosDir, { recursive: true });

  const recipe = options.recipe;
  const logger = recipe.log ?? eventLog({ melosDir });
  const startedAt = new Date().toISOString();
  const maxIterations = Math.max(1, recipe.limits?.maxIterations ?? 10);
  const deadline = recipe.limits?.timeoutMs
    ? Date.now() + recipe.limits.timeoutMs
    : null;
  const handoffFingerprint = resolveHandoffFingerprint({
    recipePath: options.recipePath
      ? resolve(options.cwd ?? process.cwd(), options.recipePath)
      : undefined,
    prompt: JSON.stringify({
      start: recipe.workflow.start,
      phases: Object.keys(recipe.workflow.phases),
    }),
  }) ?? 'unknown';

  let state: RunnerState = {
    iteration: 0,
    phaseExecution: 0,
    startedAt,
    lastObservation: null,
    bestMetrics: {},
    checkpointRef: undefined,
    cwd: resolveRunCwd(baseCwd, recipe.run.cwd),
    recipePath: options.recipePath,
    attempts: 0,
    resolvedQuestions: [],
    lastAssistantText: undefined,
    lastTrace: [],
    engineThreadId: undefined,
    lastHandoffPath: undefined,
    handoffFingerprint,
    currentPhase: recipe.workflow.start,
    phaseCounts: {},
    loopCounts: {},
    outputs: {},
    history: [],
    lastTransition: undefined,
    phaseStates: {},
  };

  const engines = new Set<Engine>();
  const reportCommitRange = isCommitEnabled(recipe.commit)
    ? {
      baseRef: readHeadRef(state.cwd),
      headRef: undefined as string | undefined,
    }
    : null;

  try {
    if (isCommitEnabled(recipe.commit)) {
      try {
        assertCommitWorkspaceClean(state.cwd);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const summary = finalizeSummary({
          status: 'failed',
          success: false,
          decision: 'failed',
          iterations: 0,
          cwd: state.cwd,
          recipePath: options.recipePath,
          startedAt,
          summary: 'auto-commit requires a clean git worktree',
          reason,
        });
        const summarized = await attachFinalReport({
          summary,
          recipe,
          cwd: state.cwd,
          baseCwd,
          melosDir,
          recipePath: options.recipePath,
          commitRange: buildFinalReportCommitRange(reportCommitRange),
          iteration: 0,
          logger,
          state,
          reason,
        });
        logger.emit({
          type: 'run_failed',
          iteration: 0,
          agent: 'system',
          payload: summarized as unknown as Record<string, unknown>,
        });
        return summarized;
      }
    }

    for (let phaseExecution = 1; phaseExecution <= maxIterations; phaseExecution += 1) {
      if (deadline !== null && Date.now() > deadline) {
        const summary = finalizeSummary({
          status: 'failed',
          success: false,
          decision: 'failed',
          iterations: phaseExecution - 1,
          cwd: state.cwd,
          recipePath: options.recipePath,
          startedAt,
          summary: 'exec timed out',
        });
        const summarized = await attachFinalReport({
          summary,
          recipe,
          cwd: state.cwd,
          baseCwd,
          melosDir,
          recipePath: options.recipePath,
          commitRange: buildFinalReportCommitRange(reportCommitRange),
          iteration: phaseExecution - 1,
          logger,
          state,
        });
        logger.emit({
          type: 'run_failed',
          iteration: phaseExecution - 1,
          agent: 'system',
          payload: summarized as unknown as Record<string, unknown>,
        });
        return summarized;
      }

      const phaseName = state.currentPhase ?? recipe.workflow.start;
      const phase = recipe.workflow.phases[phaseName];
      if (!phase) {
        const summary = finalizeSummary({
          status: 'failed',
          success: false,
          decision: 'failed',
          iterations: phaseExecution - 1,
          cwd: state.cwd,
          recipePath: options.recipePath,
          startedAt,
          summary: `unknown phase "${phaseName}"`,
        });
        return attachFinalReport({
          summary,
          recipe,
          cwd: state.cwd,
          baseCwd,
          melosDir,
          recipePath: options.recipePath,
          commitRange: buildFinalReportCommitRange(reportCommitRange),
          iteration: phaseExecution - 1,
          logger,
          state,
        });
      }

      const mergedRun = mergeRunConfig(recipe.run, phase.run);
      const executionCwd = resolveRunCwd(baseCwd, mergedRun.cwd);
      const phaseState = state.phaseStates[phaseName] ?? { attempts: 0, bestMetrics: {} };
      const loopName = phase.loop?.name;
      const loopIteration = loopName ? ((state.loopCounts ?? {})[loopName] ?? 0) + 1 : undefined;
      state = {
        ...state,
        iteration: phaseExecution,
        phaseExecution,
        currentPhase: phaseName,
        cwd: executionCwd,
        attempts: phaseState.attempts,
        bestMetrics: phaseState.bestMetrics,
        phaseCounts: {
          ...state.phaseCounts,
          [phaseName]: (state.phaseCounts[phaseName] ?? 0) + 1,
        },
        loopCounts: loopName
          ? {
            ...(state.loopCounts ?? {}),
            [loopName]: loopIteration!,
          }
          : state.loopCounts ?? {},
      };
      logger.emit({
        type: 'iteration_started',
        iteration: phaseExecution,
        agent: 'system',
        payload: {
          recipePath: options.recipePath,
          phase: phaseName,
          phaseExecution,
          loop: loopName,
          loopIteration,
        },
      });

      const baseContext = createRecipeContext(state, melosDir, recipe, mergedRun);
      if (recipe.checkpoint) {
        const checkpointRef = await recipe.checkpoint.create(baseContext);
        state = { ...state, checkpointRef };
        if (checkpointRef) {
          logger.emit({
            type: 'checkpoint_created',
            iteration: phaseExecution,
            agent: 'system',
            payload: { ref: checkpointRef, phase: phaseName, phaseExecution, loop: loopName, loopIteration },
          });
        }
      }

      const sections: PromptSection[] = [
        ...buildLatestFailureSection(state.lastObservation),
        ...buildWorkflowSection(state, phaseName),
        ...buildResolvedQuestionsSection(state.resolvedQuestions ?? []),
      ];
      for (const provider of phase.context) {
        const provided = await provider(createRecipeContext(state, melosDir, recipe, mergedRun));
        if (!provided) {
          continue;
        }
        if (Array.isArray(provided)) {
          sections.push(...provided.filter((section) => section.content.trim().length > 0));
          continue;
        }
        if (provided.content.trim().length > 0) {
          sections.push(provided);
        }
      }

      const promptText = typeof phase.task === 'function'
        ? await phase.task(createRecipeContext(state, melosDir, recipe, mergedRun))
        : phase.task;
      const renderedPrompt = renderPromptWithSections(promptText, sections);
      logger.emit({
        type: 'context_built',
        iteration: phaseExecution,
        agent: 'system',
        payload: {
          ...serializeSections(sections),
          phase: phaseName,
          phaseExecution,
          loop: loopName,
          loopIteration,
        },
      });

      const trace: RuntimeTraceEntry[] = [];
      const traceCallbacks = captureEngineTrace(trace);
      const engine = createRuntimeEngine(mergedRun.engine, mergedRun.model);
      engines.add(engine);
      const engineResult = await engine.execute(
        renderedPrompt,
        buildEngineOptions({
          runConfig: mergedRun,
          cwd: executionCwd,
          ...traceCallbacks,
        })
      );
      state = {
        ...state,
        lastAssistantText: engineResult.output,
        lastTrace: trace,
      };
      logger.emit({
        type: 'engine_finished',
        iteration: phaseExecution,
        agent: 'system',
        payload: {
          success: engineResult.success,
          exitCode: engineResult.exitCode,
          outputLength: engineResult.output.length,
          error: engineResult.error,
          phase: phaseName,
          phaseExecution,
          loop: loopName,
          loopIteration,
        },
      });

      if (!engineResult.success) {
        const summary = finalizeSummary({
          status: 'failed',
          success: false,
          decision: 'failed',
          iterations: phaseExecution,
          cwd: executionCwd,
          recipePath: options.recipePath,
          startedAt,
          summary: engineResult.error ?? 'engine execution failed',
          output: engineResult.output,
        });
        const summarized = await attachFinalReport({
          summary,
          recipe,
          cwd: executionCwd,
          baseCwd,
          melosDir,
          recipePath: options.recipePath,
          commitRange: buildFinalReportCommitRange(reportCommitRange),
          iteration: phaseExecution,
          logger,
          state,
          output: engineResult.output,
          trace,
        });
        logger.emit({
          type: 'run_failed',
          iteration: phaseExecution,
          agent: 'system',
          payload: summarized as unknown as Record<string, unknown>,
        });
        return summarized;
      }

      const produced = readWorkflowProduce({
        phaseName,
        phase,
        assistantText: engineResult.output,
        cwd: executionCwd,
      });
      if (!produced.ok) {
        const summary = finalizeSummary({
          status: 'failed',
          success: false,
          decision: 'failed',
          iterations: phaseExecution,
          cwd: executionCwd,
          recipePath: options.recipePath,
          startedAt,
          summary: produced.message,
          output: engineResult.output,
        });
        const summarized = await attachFinalReport({
          summary,
          recipe,
          cwd: executionCwd,
          baseCwd,
          melosDir,
          recipePath: options.recipePath,
          commitRange: buildFinalReportCommitRange(reportCommitRange),
          iteration: phaseExecution,
          logger,
          state,
          output: engineResult.output,
          trace,
        });
        logger.emit({
          type: 'run_failed',
          iteration: phaseExecution,
          agent: 'system',
          payload: summarized as unknown as Record<string, unknown>,
        });
        return summarized;
      }
      if (produced.value !== undefined) {
        state = {
          ...state,
          outputs: {
            ...state.outputs,
            [phaseName]: produced.value,
          },
        };
      }

      const evaluationContext: EvaluationContext = {
        ...createRecipeContext(state, melosDir, recipe, mergedRun),
        assistantText: engineResult.output,
        engineResult,
      };

      let observation = normalizeObservation({
        ok: true,
        status: 'pass',
        summary: promptText.trim() || phaseName,
        output: engineResult.output,
      });
      let decision: Decision = actionDecisionFromTransition(phase.next ?? 'stop', observation.summary);

      if (phase.evaluate && phase.policy) {
        observation = normalizeObservation(await phase.evaluate(evaluationContext));
        logger.emit({
          type: 'evaluation_finished',
          iteration: phaseExecution,
          agent: 'system',
          payload: {
            ok: observation.ok,
            status: observation.status,
            summary: observation.summary,
            metrics: observation.metrics,
            phase: phaseName,
            phaseExecution,
            loop: loopName,
            loopIteration,
          },
        });

        decision = await phase.policy({
          ...evaluationContext,
          observation,
          recipe,
        });
        decision = coerceDecisionForObservationError(decision, observation);
      }

      logger.emit({
        type: 'decision_made',
        iteration: phaseExecution,
        agent: 'system',
        payload: {
          kind: decision.kind,
          summary: decision.summary,
          reason: decision.reason,
          success: decision.success,
          question: 'question' in decision ? decision.question : undefined,
          phase: phaseName,
          phaseExecution,
          loop: loopName,
          loopIteration,
        },
      });

      state = applyDecisionStateUpdate({
        ...state,
        lastObservation: observation,
      }, phaseName, decision);

      let resolvedQuestion: ResolvedQuestion | null = null;
      let askFailureReason: string | undefined;
      if (decision.kind === 'ask') {
        const askOutcome = await resolveAskDecision({
          options,
          runConfig: mergedRun,
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

      const handoffPath = writeIterationHandoff(melosDir, handoffFingerprint, buildIterationHandoff({
        iteration: phaseExecution,
        timestamp: new Date().toISOString(),
        cwd: executionCwd,
        checkpointRef: state.checkpointRef,
        promptSummary: promptText.trim() || phaseName,
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
            baseContext: createRecipeContext(state, melosDir, recipe, mergedRun),
            decision,
            observation,
            assistantText: engineResult.output,
          });
          if (committed) {
            if (reportCommitRange) {
              reportCommitRange.headRef = committed.ref;
            }
            logger.emit({
              type: 'commit_created',
              iteration: phaseExecution,
              agent: 'system',
              payload: {
                ref: committed.ref,
                message: committed.message,
                changedFiles: committed.changedFiles,
                when: recipe.commit.when ?? 'never',
                phase: phaseName,
                phaseExecution,
                loop: loopName,
                loopIteration,
              },
            });
          }
        } catch (error) {
          const summary = finalizeSummary({
            status: 'failed',
            success: false,
            decision: 'failed',
            iterations: phaseExecution,
            cwd: executionCwd,
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
            cwd: executionCwd,
            baseCwd,
            melosDir,
            recipePath: options.recipePath,
            commitRange: buildFinalReportCommitRange(reportCommitRange),
            iteration: phaseExecution,
            logger,
            state,
            reason: error instanceof Error ? error.message : String(error),
            output: engineResult.output,
            observation,
            trace,
          });
          logger.emit({
            type: 'run_failed',
            iteration: phaseExecution,
            agent: 'system',
            payload: summarized as unknown as Record<string, unknown>,
          });
          return summarized;
        }
      }

      if (decision.kind === 'ask' && !resolvedQuestion) {
        const summary = finalizeSummary({
          status: 'failed',
          success: false,
          decision: 'failed',
          iterations: phaseExecution,
          cwd: executionCwd,
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
          cwd: executionCwd,
          baseCwd,
          melosDir,
          recipePath: options.recipePath,
          commitRange: buildFinalReportCommitRange(reportCommitRange),
          iteration: phaseExecution,
          logger,
          state,
          reason: decision.reason ?? askFailureReason,
          output: engineResult.output,
          observation,
          trace,
        });
        logger.emit({
          type: 'run_failed',
          iteration: phaseExecution,
          agent: 'system',
          payload: summarized as unknown as Record<string, unknown>,
        });
        return summarized;
      }

      let transition: WorkflowTransition;
      try {
        transition = resolvePhaseTransition({
          phaseName,
          phase,
          observation,
          decision,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const summary = finalizeSummary({
          status: 'failed',
          success: false,
          decision: 'failed',
          iterations: phaseExecution,
          cwd: executionCwd,
          recipePath: options.recipePath,
          startedAt,
          summary: reason,
          output: engineResult.output,
          observation,
        });
        const summarized = await attachFinalReport({
          summary,
          recipe,
          cwd: executionCwd,
          baseCwd,
          melosDir,
          recipePath: options.recipePath,
          commitRange: buildFinalReportCommitRange(reportCommitRange),
          iteration: phaseExecution,
          logger,
          state,
          reason,
          output: engineResult.output,
          observation,
          trace,
        });
        logger.emit({
          type: 'run_failed',
          iteration: phaseExecution,
          agent: 'system',
          payload: summarized as unknown as Record<string, unknown>,
        });
        return summarized;
      }

      if (decision.kind === 'rollback') {
        if (!recipe.checkpoint || !state.checkpointRef) {
          const summary = finalizeSummary({
            status: 'failed',
            success: false,
            decision: 'failed',
            iterations: phaseExecution,
            cwd: executionCwd,
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
            cwd: executionCwd,
            baseCwd,
            melosDir,
            recipePath: options.recipePath,
            commitRange: buildFinalReportCommitRange(reportCommitRange),
            iteration: phaseExecution,
            logger,
            state,
            reason: decision.reason,
            output: engineResult.output,
            observation,
            trace,
          });
          logger.emit({
            type: 'run_failed',
            iteration: phaseExecution,
            agent: 'system',
            payload: summarized as unknown as Record<string, unknown>,
          });
          return summarized;
        }

        await recipe.checkpoint.rollback(createRecipeContext(state, melosDir, recipe, mergedRun), state.checkpointRef);
        logger.emit({
          type: 'rollback_applied',
          iteration: phaseExecution,
          agent: 'system',
          payload: {
            ref: state.checkpointRef,
            reason: decision.reason ?? decision.summary ?? observation.summary,
            phase: phaseName,
            phaseExecution,
            loop: loopName,
            loopIteration,
          },
        });
      }

      const transitionLabel = describeWorkflowTransition(transition);
      const nextPhase = transition === 'repeat'
        ? phaseName
        : transition === 'stop'
          ? undefined
          : transition.goto;
      state = {
        ...state,
        history: [
          ...state.history,
          {
            phase: phaseName,
            summary: decision.summary ?? observation.summary,
            decision: transitionLabel,
            loop: loopName,
            loopIteration,
          },
        ],
        lastTransition: {
          from: phaseName,
          to: nextPhase,
          decision: transitionLabel,
        },
      };
      logger.emit({
        type: 'phase_transitioned',
        iteration: phaseExecution,
        agent: 'system',
        payload: {
          from: phaseName,
          to: nextPhase,
          decisionKind: decision.kind,
          transition: transitionLabel,
          reason: decision.reason,
          phase: phaseName,
          phaseExecution,
          loop: loopName,
          loopIteration,
        },
      });

      if (transition === 'stop') {
        if (recipe.checkpoint && state.checkpointRef) {
          await recipe.checkpoint.keep?.(createRecipeContext(state, melosDir, recipe, mergedRun), state.checkpointRef);
        }
        const stopSuccess = decision.success ?? observation.ok;
        const summary = finalizeSummary({
          status: stopSuccess ? 'completed' : 'failed',
          success: stopSuccess,
          decision: decision.kind,
          iterations: phaseExecution,
          cwd: executionCwd,
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
          cwd: executionCwd,
          baseCwd,
          melosDir,
          recipePath: options.recipePath,
          commitRange: buildFinalReportCommitRange(reportCommitRange),
          iteration: phaseExecution,
          logger,
          state,
          reason: decision.reason,
          output: observation.output ?? engineResult.output,
          observation,
          trace,
        });
        logger.emit({
          type: summarized.success ? 'run_completed' : 'run_failed',
          iteration: phaseExecution,
          agent: 'system',
          payload: summarized as unknown as Record<string, unknown>,
        });
        return summarized;
      }

      state = {
        ...state,
        currentPhase: nextPhase ?? phaseName,
      };
    }

    const summary = finalizeSummary({
      status: 'failed',
      success: false,
      decision: 'failed',
      iterations: maxIterations,
      cwd: state.cwd,
      recipePath: options.recipePath,
      startedAt,
      summary: `max iterations reached (${maxIterations})`,
      observation: state.lastObservation ?? undefined,
    });
    const summarized = await attachFinalReport({
      summary,
      recipe,
      cwd: state.cwd,
      baseCwd,
      melosDir,
      recipePath: options.recipePath,
      commitRange: buildFinalReportCommitRange(reportCommitRange),
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
    for (const engine of engines) {
      if ('shutdown' in engine && typeof engine.shutdown === 'function') {
        await engine.shutdown();
      }
    }
  }
}
