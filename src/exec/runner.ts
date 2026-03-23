import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { AppServerEngine } from '../engines/app-server.js';
import { ClaudeEngine } from '../engines/claude.js';
import type { Engine, EngineOptions } from '../engines/base.js';
import { EventLog, type MissionEvent } from '../state/events.js';
import { isClaudeFamily, resolveModelEngine, resolveRuntimeModel } from '../models/registry.js';
import {
  defaultPromptRenderer,
  normalizeObservation,
  type ContextSection,
  type Decision,
  type EvaluationContext,
  type RecipeContextBase,
  type RecipeDefinition,
  type RecipeLog,
  type RunnerState,
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

function resolveExecutionCwd(options: RunRecipeOptions): string {
  const baseCwd = resolve(options.cwd ?? process.cwd());
  const recipeRunCwd = options.recipe.run.cwd;
  if (!recipeRunCwd) {
    return baseCwd;
  }
  if (recipeRunCwd.startsWith('/')) {
    return recipeRunCwd;
  }
  if (options.recipePath) {
    return resolve(dirname(options.recipePath), recipeRunCwd);
  }
  return resolve(baseCwd, recipeRunCwd);
}

function buildEngineOptions(recipe: RecipeDefinition, cwd: string): EngineOptions & {
  onStream?: (chunk: string) => void;
  suppressTerminalOutput: boolean;
} {
  const model = recipe.run.model;
  const timeout = recipe.run.timeoutMs;
  const engineType = typeof recipe.run.engine === 'string'
    ? recipe.run.engine
    : resolveModelEngine(model);
  const isClaude = engineType === 'claude' || (engineType === 'auto' && isClaudeFamily(model));

  const options: EngineOptions & {
    onStream?: (chunk: string) => void;
    suppressTerminalOutput: boolean;
  } = {
    cwd,
    timeout,
    suppressTerminalOutput: true,
  };

  if (model) {
    options.model = resolveRuntimeModel(model);
  }

  if (recipe.run.effort) {
    if (isClaude) {
      options.effort = recipe.run.effort as EngineOptions['effort'];
    } else {
      options.reasoningEffort = recipe.run.effort as EngineOptions['reasoningEffort'];
    }
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

function createRecipeContext(state: RunnerState, melosDir: string): RecipeContextBase {
  return {
    cwd: state.cwd,
    melosDir,
    recipePath: state.recipePath,
    state,
    previousObservation: state.lastObservation,
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

export async function runRecipe(options: RunRecipeOptions): Promise<ExecRunSummary> {
  const cwd = resolveExecutionCwd(options);
  mkdirSync(options.melosDir, { recursive: true });

  const recipe = options.recipe;
  const logger = recipe.log ?? eventLog({ melosDir: options.melosDir });
  const startedAt = new Date().toISOString();
  const maxIterations = Math.max(1, recipe.limits?.maxIterations ?? 10);
  const deadline = recipe.limits?.timeoutMs
    ? Date.now() + recipe.limits.timeoutMs
    : null;

  let state: RunnerState = {
    iteration: 0,
    startedAt,
    lastObservation: null,
    bestMetrics: {},
    checkpointRef: undefined,
    cwd,
    recipePath: options.recipePath,
    attempts: 0,
  };

  let engine: Engine | null = null;
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
        logger.emit({
          type: 'exec_failed',
          iteration: iteration - 1,
          agent: 'system',
          payload: summary as unknown as Record<string, unknown>,
        });
        return summary;
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

      const baseContext = createRecipeContext(state, options.melosDir);
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

      const contextSections: ContextSection[] = [];
      for (const provider of recipe.context) {
        const provided = await provider(createRecipeContext(state, options.melosDir));
        if (!provided) {
          continue;
        }
        if (Array.isArray(provided)) {
          contextSections.push(...provided.filter((section) => section.content.trim().length > 0));
          continue;
        }
        if (provided.content.trim().length > 0) {
          contextSections.push(provided);
        }
      }
      logger.emit({
        type: 'context_built',
        iteration,
        agent: 'system',
        payload: serializeSections(contextSections),
      });

      const promptText = typeof recipe.prompt === 'function'
        ? await recipe.prompt({
          ...createRecipeContext(state, options.melosDir),
          contextSections,
        })
        : recipe.prompt;
      const renderedPrompt = defaultPromptRenderer(promptText, contextSections);

      engine = createRuntimeEngine(recipe.run.engine, recipe.run.model);
      const engineResult = await engine.execute(renderedPrompt, buildEngineOptions(recipe, cwd));
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
        logger.emit({
          type: 'exec_failed',
          iteration,
          agent: 'system',
          payload: summary as unknown as Record<string, unknown>,
        });
        return summary;
      }

      const evaluationContext: EvaluationContext = {
        ...createRecipeContext(state, options.melosDir),
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
          logger.emit({
            type: 'exec_failed',
            iteration,
            agent: 'system',
            payload: summary as unknown as Record<string, unknown>,
          });
          return summary;
        }

        await recipe.checkpoint.rollback(createRecipeContext(state, options.melosDir), state.checkpointRef);
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
        const summary = finalizeSummary({
          status: 'asked',
          success: false,
          decision: 'ask',
          iterations: iteration,
          cwd,
          recipePath: options.recipePath,
          startedAt,
          summary: decision.summary ?? observation.summary,
          reason: decision.reason,
          question: decision.question,
          output: engineResult.output,
          observation,
        });
        logger.emit({
          type: 'exec_asked',
          iteration,
          agent: 'system',
          payload: summary as unknown as Record<string, unknown>,
        });
        return summary;
      }

      if (decision.kind === 'stop') {
        if (recipe.checkpoint && state.checkpointRef) {
          await recipe.checkpoint.keep?.(createRecipeContext(state, options.melosDir), state.checkpointRef);
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
        logger.emit({
          type: summary.success ? 'exec_completed' : 'exec_failed',
          iteration,
          agent: 'system',
          payload: summary as unknown as Record<string, unknown>,
        });
        return summary;
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
    logger.emit({
      type: 'exec_failed',
      iteration: maxIterations,
      agent: 'system',
      payload: summary as unknown as Record<string, unknown>,
    });
    return summary;
  } finally {
    if (engine && 'shutdown' in engine && typeof engine.shutdown === 'function') {
      await engine.shutdown();
    }
  }
}
