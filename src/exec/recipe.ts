import type { Engine, EngineOptions, EngineResult } from '../engines/base.js';
import type { MissionEvent, MissionEventBase, MissionEventType } from '../state/events.js';
import type { PromptSection } from './prompt-sections.js';
import type { CommandExecutionResult, MetricExtraction, ShellCommandSpec } from './evaluators.js';

import { compileRecipeConfig } from './compiler.js';

export type MaybePromise<T> = T | Promise<T>;

export interface Observation {
  ok: boolean;
  status: 'pass' | 'fail' | 'error';
  summary: string;
  details?: string;
  metrics: Record<string, number>;
  question?: string;
  output?: string;
  data?: unknown;
}

export type ObservationInput = string | Partial<Observation>;

export interface ResolvedQuestion {
  iteration: number;
  question: string;
  answer: string;
  source: 'agent' | 'user';
  rationale?: string;
}

export type RuntimeTraceEntry =
  | {
    kind: 'agent_message';
    timestamp: string;
    text: string;
  }
  | {
    kind: 'command_output';
    timestamp: string;
    text: string;
  }
  | {
    kind: 'command';
    timestamp: string;
    command: string;
    cwd?: string;
    reason?: string;
    source: 'app-server' | 'claude';
  }
  | {
    kind: 'file_change';
    timestamp: string;
    path?: string;
    source: 'app-server' | 'claude';
    data?: unknown;
  }
  | {
    kind: 'tool_result';
    timestamp: string;
    text: string;
    source: 'claude';
    isError?: boolean;
    exitCode?: number;
    durationMs?: number;
  }
  | {
    kind: 'engine_event';
    timestamp: string;
    method: string;
    data?: unknown;
  };

export interface WorkflowHistoryEntry {
  phase: string;
  summary: string;
  decision: string;
  loop?: string;
  loopIteration?: number;
}

export interface WorkflowTransitionState {
  from: string;
  to?: string;
  decision: string;
}

export interface WorkflowPhaseState {
  attempts: number;
  bestMetrics: Record<string, number>;
}

export interface RunnerState {
  iteration: number;
  phaseExecution: number;
  startedAt: string;
  lastObservation: Observation | null;
  bestMetrics: Record<string, number>;
  checkpointRef?: string;
  cwd: string;
  recipePath?: string;
  attempts: number;
  resolvedQuestions?: ResolvedQuestion[];
  lastAssistantText?: string;
  lastTrace?: RuntimeTraceEntry[];
  engineThreadId?: string;
  lastHandoffPath?: string;
  handoffFingerprint?: string;
  currentPhase?: string;
  phaseCounts: Record<string, number>;
  loopCounts?: Record<string, number>;
  outputs: Record<string, unknown>;
  history: WorkflowHistoryEntry[];
  lastTransition?: WorkflowTransitionState;
  phaseStates: Record<string, WorkflowPhaseState>;
}

export interface WorkflowContextSnapshot {
  phase: string;
  outputs: Record<string, unknown>;
  phaseCounts: Record<string, number>;
  loopCounts?: Record<string, number>;
  history: WorkflowHistoryEntry[];
}

export interface RecipeContextBase {
  cwd: string;
  melosDir: string;
  recipePath?: string;
  state: RunnerState;
  previousObservation: Observation | null;
  resolvedQuestions?: ResolvedQuestion[];
  runConfig?: RecipeRunConfig;
  workflow?: WorkflowContextSnapshot;
}

export type PromptContext = RecipeContextBase;

export interface EvaluationContext extends RecipeContextBase {
  assistantText: string;
  engineResult: EngineResult;
}

export interface PolicyContext extends EvaluationContext {
  observation: Observation;
  recipe: RecipeDefinition;
}

export type ContextProvider = (
  ctx: RecipeContextBase
) => MaybePromise<PromptSection | PromptSection[] | null | undefined>;

export type Evaluator = (ctx: EvaluationContext) => MaybePromise<ObservationInput>;

export interface DecisionStateUpdate {
  attempts?: number;
  bestMetrics?: Record<string, number>;
}

interface DecisionBase {
  summary?: string;
  reason?: string;
  success?: boolean;
  stateUpdate?: DecisionStateUpdate;
}

export type Decision =
  | ({ kind: 'continue' } & DecisionBase)
  | ({ kind: 'stop' } & DecisionBase)
  | ({ kind: 'rollback' } & DecisionBase)
  | ({ kind: 'ask'; question: string } & DecisionBase);

export type Policy = (ctx: PolicyContext) => MaybePromise<Decision>;

export type RuntimeEngine = Engine | 'codex' | 'claude' | 'auto';

export interface RecipeRunConfig {
  engine: RuntimeEngine;
  model?: string;
  effort?: EngineOptions['effort'] | EngineOptions['reasoningEffort'];
  cwd?: string;
  timeoutMs?: number;
}

export interface RecipeLimits {
  maxIterations?: number;
  timeoutMs?: number;
  patience?: number;
}

export interface RecipeReportConfig {
  format?: 'json';
  path?: string;
  stdout?: boolean;
}

export interface CommitConfig {
  when?: 'never' | 'stop' | 'accepted-iteration';
  message?: string | ((ctx: {
    cwd: string;
    melosDir: string;
    recipePath?: string;
    state: RunnerState;
    previousObservation: Observation | null;
    resolvedQuestions?: ResolvedQuestion[];
    runConfig?: RecipeRunConfig;
    decision: Decision;
    observation: Observation;
    assistantText: string;
    changedFiles: string[];
  }) => MaybePromise<string>);
}

export interface FinalReportCheckEvidence {
  command: string;
  cwd?: string;
  exitCode: number;
  ok: boolean;
  timedOut?: boolean;
}

export interface FinalReportPassEvidence {
  criterion: string;
  verdict: 'yes' | 'no';
  rationale?: string;
}

export interface FinalReportWorkflowEvidence {
  outputs: Record<string, unknown>;
  phaseCounts?: Record<string, number>;
  loopCounts?: Record<string, number>;
  history?: WorkflowHistoryEntry[];
}

export interface FinalReportEvidence {
  checks?: FinalReportCheckEvidence[];
  metrics?: Record<string, number>;
  pass?: FinalReportPassEvidence[];
  workflow?: FinalReportWorkflowEvidence;
}

export interface FinalReport {
  summary: string;
  changes: string[];
  rationale: string[];
  finalState: string;
  remainingIssues: string[];
  userConfirmationNeeded: string[];
  evidence?: FinalReportEvidence;
}

export interface CheckpointController {
  create(ctx: RecipeContextBase): MaybePromise<string | undefined>;
  rollback(ctx: RecipeContextBase, ref: string): MaybePromise<void>;
  keep?(ctx: RecipeContextBase, ref: string): MaybePromise<void>;
}

export interface RecipeLog {
  emit(params: {
    type: MissionEventType;
    iteration: number;
    agent?: MissionEventBase['agent'];
    payload?: Record<string, unknown>;
    timestamp?: string;
  }): MissionEvent;
}

export interface ThresholdCondition {
  metric: string;
  above?: number;
  atLeast?: number;
  below?: number;
  atMost?: number;
}

export interface PlateauCondition {
  metric: string;
  goal?: 'maximize' | 'minimize';
  patience?: number;
  minImprovement?: number;
  rollbackOnRegression?: boolean;
}

export interface MeasureConfig {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  extract?: (input: {
    result: CommandExecutionResult;
    parsedJson?: unknown;
  }) => MetricExtraction | Record<string, number> | number | Promise<MetricExtraction | Record<string, number> | number>;
}

export type WorkflowTransition = 'repeat' | 'stop' | { goto: string };

export interface AssistantJsonProduceConfig {
  from: 'assistant-json';
}

export interface FileProduceConfig {
  from: { file: string };
}

export type WorkflowProduceConfig = AssistantJsonProduceConfig | FileProduceConfig;

export interface WorkflowPhaseOnConfig {
  pass: WorkflowTransition;
  fail?: WorkflowTransition;
  ask?: WorkflowTransition;
  rollback?: WorkflowTransition;
}

export interface WorkflowLoopDefinition {
  name: string;
}

export interface ValidateMetricsConfig extends MeasureConfig {
  thresholds?: ThresholdCondition | ThresholdCondition[];
  plateau?: PlateauCondition;
}

export interface WorkflowValidateConfig {
  shell?: Array<string | ShellCommandSpec>;
  llm?: string[];
  metrics?: ValidateMetricsConfig;
}

export interface WorkflowPhaseDefinition {
  task: string | ((ctx: PromptContext) => MaybePromise<string>);
  context: ContextProvider[];
  run?: Partial<RecipeRunConfig>;
  evaluate?: Evaluator;
  policy?: Policy;
  produce?: WorkflowProduceConfig;
  next?: WorkflowTransition;
  on?: WorkflowPhaseOnConfig;
  loop?: WorkflowLoopDefinition;
}

export interface WorkflowDefinition {
  start: string;
  phases: Record<string, WorkflowPhaseDefinition>;
}

export interface RecipeDefinition {
  apiVersion: 2;
  run: RecipeRunConfig;
  workflow: WorkflowDefinition;
  limits?: RecipeLimits;
  report?: RecipeReportConfig;
  commit?: CommitConfig;
  checkpoint?: CheckpointController;
  log?: RecipeLog;
}

export interface WorkflowPhaseConfig {
  task: string | ((ctx: PromptContext) => MaybePromise<string>);
  context?: ContextProvider[];
  run?: Partial<RecipeRunConfig>;
  validate?: WorkflowValidateConfig;
  produce?: WorkflowProduceConfig;
  on?: WorkflowPhaseOnConfig;
}

export interface RecipeConfig {
  run: RecipeRunConfig;
  workflow: {
    start: string;
    phases: Record<string, WorkflowPhaseConfig>;
  };
  limit?: number;
  report?: RecipeReportConfig;
  commit?: CommitConfig;
  checkpoint?: CheckpointController;
  log?: RecipeLog;
}

export type RouteConfig = RecipeConfig;

const DEFAULT_FINAL_REPORT_PATH = '.melos/final-report.json';

export type RuntimeRecipeInput =
  & Omit<RecipeDefinition, 'apiVersion' | 'report' | 'workflow'>
  & {
    workflow: {
      start: string;
      phases: Record<string, Omit<WorkflowPhaseDefinition, 'context'> & { context?: ContextProvider[] }>;
    };
    report?: RecipeReportConfig;
  };

export type RouteInput = RecipeConfig | RuntimeRecipeInput;

function normalizeReportConfig(report?: RecipeReportConfig): RecipeReportConfig {
  return {
    ...report,
    path: report?.path?.trim() || DEFAULT_FINAL_REPORT_PATH,
    stdout: report?.stdout ?? true,
  };
}

function transitionLabel(transition: WorkflowTransition): string {
  if (transition === 'repeat' || transition === 'stop') {
    return transition;
  }
  return `goto:${transition.goto}`;
}

function validateTransition(
  transition: WorkflowTransition,
  phaseNames: Set<string>,
  phaseName: string,
  label: string
): void {
  if (transition === 'repeat' || transition === 'stop') {
    return;
  }
  if (!transition || typeof transition.goto !== 'string' || transition.goto.trim().length === 0) {
    throw new Error(`workflow phase "${phaseName}" has invalid ${label} transition`);
  }
  if (!phaseNames.has(transition.goto)) {
    throw new Error(`workflow phase "${phaseName}" ${label} references unknown phase "${transition.goto}"`);
  }
}

function normalizeWorkflow(workflow: RuntimeRecipeInput['workflow']): WorkflowDefinition {
  if (!workflow || typeof workflow !== 'object') {
    throw new Error('route.workflow is required');
  }
  const phases = workflow.phases;
  if (!phases || typeof phases !== 'object' || Array.isArray(phases) || Object.keys(phases).length === 0) {
    throw new Error('route.workflow.phases is required');
  }
  if (typeof workflow.start !== 'string' || workflow.start.trim().length === 0) {
    throw new Error('route.workflow.start is required');
  }

  const phaseNames = new Set(Object.keys(phases));
  if (!phaseNames.has(workflow.start)) {
    throw new Error(`route.workflow.start references unknown phase "${workflow.start}"`);
  }

  const normalizedPhases = Object.fromEntries(
    Object.entries(phases).map(([phaseName, phase]) => {
      const normalized: WorkflowPhaseDefinition = {
        ...phase,
        context: phase.context ?? [],
      };
      const hasEvaluator = Boolean(normalized.evaluate || normalized.policy);
      if (Boolean(normalized.evaluate) !== Boolean(normalized.policy)) {
        throw new Error(`workflow phase "${phaseName}" must define evaluate and policy together`);
      }
      if (hasEvaluator) {
        if (!normalized.on) {
          throw new Error(`workflow phase "${phaseName}" requires on when evaluators are configured`);
        }
        if (!normalized.on.fail) {
          throw new Error(`workflow phase "${phaseName}" requires on.fail when evaluators are configured`);
        }
        validateTransition(normalized.on.pass, phaseNames, phaseName, 'on.pass');
        validateTransition(normalized.on.fail, phaseNames, phaseName, 'on.fail');
        if (normalized.on.ask) {
          validateTransition(normalized.on.ask, phaseNames, phaseName, 'on.ask');
        }
        if (normalized.on.rollback) {
          validateTransition(normalized.on.rollback, phaseNames, phaseName, 'on.rollback');
        }
      } else {
        const passTransition = normalized.next ?? normalized.on?.pass;
        if (!passTransition) {
          throw new Error(`workflow phase "${phaseName}" requires on.pass when no validators are configured`);
        }
        validateTransition(passTransition, phaseNames, phaseName, 'on.pass');
        normalized.next = passTransition;
      }
      return [phaseName, normalized];
    })
  );

  return {
    start: workflow.start,
    phases: normalizedPhases,
  };
}

export function normalizeRuntimeRecipe(recipe: RuntimeRecipeInput): RecipeDefinition {
  if (Object.prototype.hasOwnProperty.call(recipe, 'task')) {
    throw new Error('legacy route task has been removed; use route.workflow.phases');
  }
  return {
    apiVersion: 2,
    ...recipe,
    workflow: normalizeWorkflow(recipe.workflow),
    report: normalizeReportConfig(recipe.report),
  };
}

function isRuntimeRouteInput(route: RouteInput): route is RuntimeRecipeInput {
  if (Object.prototype.hasOwnProperty.call(route, 'limits')) {
    return true;
  }

  return Object.values(route.workflow?.phases ?? {}).some((phase) => (
    typeof phase === 'object'
    && phase !== null
    && (
      Object.prototype.hasOwnProperty.call(phase, 'evaluate')
      || Object.prototype.hasOwnProperty.call(phase, 'policy')
    )
  ));
}

export function createRoute(route: RouteInput): RecipeDefinition {
  return isRuntimeRouteInput(route)
    ? normalizeRuntimeRecipe(route)
    : normalizeRuntimeRecipe(compileRecipeConfig(route));
}

export function describeWorkflowTransition(transition: WorkflowTransition): string {
  return transitionLabel(transition);
}

export function normalizeObservation(input: ObservationInput): Observation {
  if (typeof input === 'string') {
    return {
      ok: input.trim().length > 0,
      status: input.trim().length > 0 ? 'pass' : 'fail',
      summary: input.trim() || 'empty observation',
      metrics: {},
    };
  }

  const metrics: Record<string, number> = {};
  if (input.metrics && typeof input.metrics === 'object') {
    for (const [key, value] of Object.entries(input.metrics)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        metrics[key] = value;
      }
    }
  }

  const summary = typeof input.summary === 'string' && input.summary.trim().length > 0
    ? input.summary.trim()
    : typeof input.output === 'string' && input.output.trim().length > 0
      ? input.output.trim()
      : 'observation recorded';

  const status = input.status ?? (input.ok === false ? 'fail' : 'pass');
  return {
    ok: input.ok ?? status === 'pass',
    status,
    summary,
    details: typeof input.details === 'string' ? input.details : undefined,
    metrics,
    question: typeof input.question === 'string' ? input.question : undefined,
    output: typeof input.output === 'string' ? input.output : undefined,
    data: input.data,
  };
}
