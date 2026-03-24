import type { Engine, EngineOptions, EngineResult } from '../engines/base.js';
import type { MissionEvent, MissionEventBase, MissionEventType } from '../state/events.js';

export type MaybePromise<T> = T | Promise<T>;

export interface ContextSection {
  title: string;
  content: string;
}

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

export interface RunnerState {
  iteration: number;
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
}

export interface RecipeContextBase {
  cwd: string;
  melosDir: string;
  recipePath?: string;
  state: RunnerState;
  previousObservation: Observation | null;
  resolvedQuestions?: ResolvedQuestion[];
  runConfig?: RecipeRunConfig;
}

export interface PromptContext extends RecipeContextBase {
  contextSections: ContextSection[];
}

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
) => MaybePromise<ContextSection | ContextSection[] | null | undefined>;

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

export interface RecipeDefinition {
  prompt: string | ((ctx: PromptContext) => MaybePromise<string>);
  context: ContextProvider[];
  run: RecipeRunConfig;
  evaluate: Evaluator;
  policy: Policy;
  limits?: RecipeLimits;
  checkpoint?: CheckpointController;
  log?: RecipeLog;
}

export function createRecipe(recipe: RecipeDefinition): RecipeDefinition {
  return recipe;
}

export function defaultPromptRenderer(prompt: string, sections: ContextSection[]): string {
  const blocks: string[] = [];
  const trimmedPrompt = prompt.trim();
  if (trimmedPrompt.length > 0) {
    blocks.push(trimmedPrompt);
  }

  for (const section of sections) {
    const title = section.title.trim();
    const content = section.content.trim();
    if (title.length === 0 || content.length === 0) {
      continue;
    }
    blocks.push(`## ${title}\n${content}`);
  }

  return blocks.join('\n\n');
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
