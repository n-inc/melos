import { llmEvaluate, metricExtractor, shellChecks } from './evaluators.js';
import { askDecision, continueDecision, rollbackDecision, stopDecision } from './policies.js';
import { normalizeObservation } from './recipe.js';
import type {
  Evaluator,
  Observation,
  Policy,
  RecipeConfig,
  RecipeDefinition,
  ThresholdCondition,
  WorkflowPhaseConfig,
  WorkflowPhaseDefinition,
} from './recipe.js';

function normalizeThresholds(until?: ThresholdCondition | ThresholdCondition[]): ThresholdCondition[] {
  if (!until) {
    return [];
  }
  return Array.isArray(until) ? until : [until];
}

function evaluateThresholds(metrics: Record<string, number>, thresholds: ThresholdCondition[]): boolean {
  return thresholds.every((threshold) => {
    const current = metrics[threshold.metric];
    if (!Number.isFinite(current)) {
      return false;
    }
    if (typeof threshold.above === 'number' && !(current > threshold.above)) {
      return false;
    }
    if (typeof threshold.atLeast === 'number' && !(current >= threshold.atLeast)) {
      return false;
    }
    if (typeof threshold.below === 'number' && !(current < threshold.below)) {
      return false;
    }
    if (typeof threshold.atMost === 'number' && !(current <= threshold.atMost)) {
      return false;
    }
    return true;
  });
}

function metricDelta(goal: 'maximize' | 'minimize', current: number, previous: number): number {
  return goal === 'minimize' ? previous - current : current - previous;
}

function extractBlockingQuestion(text: string): string | null {
  return text.match(/^QUESTION:\s*(.+)$/m)?.[1]?.trim() ?? null;
}

function mergeData(parts: Array<{ key: string; value: unknown }>): unknown {
  const entries = parts.filter((part) => part.value !== undefined);
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries.map((part) => [part.key, part.value]));
}

function joinSummary(parts: Array<{ key: string; observation: Observation | null }>, fallback: string): string {
  const summaries = parts
    .flatMap((part) => part.observation ? [`${part.key}: ${part.observation.summary}`] : []);
  return summaries.length > 0 ? summaries.join(' | ') : fallback;
}

function joinDetails(parts: Array<{ key: string; observation: Observation | null }>): string | undefined {
  const details = parts.flatMap((part) => {
    const value = part.observation?.details?.trim();
    if (!value) {
      return [];
    }
    return [`${part.key}: ${value}`];
  });
  return details.length > 0 ? details.join('\n\n') : undefined;
}

function mergeStatus(observations: Observation[]): Observation['status'] {
  if (observations.some((observation) => observation.status === 'error')) {
    return 'error';
  }
  return observations.every((observation) => observation.ok) ? 'pass' : 'fail';
}

function buildDeclarativeEvaluator(config: WorkflowPhaseConfig): Evaluator {
  const checkEvaluator = config.check && config.check.length > 0
    ? shellChecks(config.check)
    : null;
  const measureEvaluator = config.measure
    ? metricExtractor(config.measure)
    : null;
  const passEvaluator = config.pass && config.pass.length > 0
    ? llmEvaluate({ criteria: config.pass })
    : null;

  return async (ctx) => {
    const question = extractBlockingQuestion(ctx.assistantText);
    if (question) {
      return normalizeObservation({
        ok: false,
        status: 'fail',
        summary: 'clarification required',
        question,
      });
    }

    const checkObservation = checkEvaluator
      ? normalizeObservation(await checkEvaluator(ctx))
      : null;
    const measureObservation = measureEvaluator
      ? normalizeObservation(await measureEvaluator(ctx))
      : null;
    const passObservation = passEvaluator
      ? normalizeObservation(await passEvaluator(ctx))
      : null;
    const observations = [checkObservation, measureObservation, passObservation]
      .filter((observation): observation is Observation => observation !== null);
    const combinedStatus = mergeStatus(observations);
    const combinedOk = observations.every((observation) => observation.ok);
    const fallbackSummary = ctx.assistantText.trim() || 'task executed';

    return normalizeObservation({
      ok: combinedOk,
      status: combinedStatus,
      summary: joinSummary([
        { key: 'check', observation: checkObservation },
        { key: 'measure', observation: measureObservation },
        { key: 'pass', observation: passObservation },
      ], fallbackSummary),
      details: joinDetails([
        { key: 'check', observation: checkObservation },
        { key: 'measure', observation: measureObservation },
        { key: 'pass', observation: passObservation },
      ]),
      metrics: measureObservation?.metrics ?? {},
      output: ctx.assistantText,
      data: mergeData([
        { key: 'check', value: checkObservation?.data },
        { key: 'measure', value: measureObservation?.data },
        { key: 'pass', value: passObservation?.data },
      ]),
    });
  };
}

function buildLoopPolicy(config: WorkflowPhaseConfig): Policy {
  const thresholds = normalizeThresholds(config.until);
  const plateau = config.plateau;

  return ({ observation, state, recipe }) => {
    if (observation.question) {
      return askDecision(observation.question, { summary: observation.summary });
    }

    const thresholdsMet = thresholds.length === 0 || evaluateThresholds(observation.metrics, thresholds);
    const basePassed = observation.ok;

    if (thresholdsMet && basePassed) {
      return stopDecision({
        success: true,
        summary: observation.summary,
      });
    }

    if (!plateau) {
      return continueDecision({
        summary: observation.summary,
      });
    }

    const current = observation.metrics[plateau.metric];
    if (!Number.isFinite(current)) {
      return stopDecision({
        success: false,
        summary: `metric "${plateau.metric}" is missing`,
      });
    }

    const previousBest = state.bestMetrics[plateau.metric];
    const goal = plateau.goal ?? 'maximize';
    const minImprovement = plateau.minImprovement ?? 0;
    const patience = plateau.patience ?? recipe.limits?.patience ?? 1;

    if (!Number.isFinite(previousBest) || metricDelta(goal, current, previousBest) > minImprovement) {
      return continueDecision({
        summary: observation.summary,
        stateUpdate: {
          attempts: 0,
          bestMetrics: { ...state.bestMetrics, [plateau.metric]: current },
        },
      });
    }

    const attempts = state.attempts + 1;
    const delta = metricDelta(goal, current, previousBest);
    if (delta < 0 && plateau.rollbackOnRegression !== false) {
      return rollbackDecision({
        summary: observation.summary,
        reason: `metric "${plateau.metric}" regressed from ${previousBest} to ${current}`,
        stateUpdate: { attempts },
      });
    }

    if (attempts >= patience) {
      return stopDecision({
        success: thresholds.length === 0 ? basePassed : basePassed && thresholdsMet,
        summary: observation.summary,
        reason: `metric "${plateau.metric}" plateaued after ${attempts} attempts`,
        stateUpdate: { attempts },
      });
    }

    return continueDecision({
      summary: observation.summary,
      reason: `metric "${plateau.metric}" did not improve`,
      stateUpdate: { attempts },
    });
  };
}

function hasEvaluatorConfig(config: WorkflowPhaseConfig): boolean {
  return Boolean(
    (config.check && config.check.length > 0)
    || (config.pass && config.pass.length > 0)
    || config.measure
    || config.until
    || config.plateau
  );
}

function compilePhaseConfig(phaseName: string, config: WorkflowPhaseConfig): WorkflowPhaseDefinition {
  if (typeof config.task !== 'string' && typeof config.task !== 'function') {
    throw new Error(`workflow phase "${phaseName}" task is required`);
  }

  const hasEvaluator = hasEvaluatorConfig(config);
  if (hasEvaluator) {
    if (!config.on) {
      throw new Error(`workflow phase "${phaseName}" requires on when evaluators are configured`);
    }
    if (config.on.fail === 'repeat') {
      throw new Error(
        `workflow phase "${phaseName}" cannot use on.fail: "repeat"; send failures to an action phase with { goto: "..." } instead`
      );
    }
    if ((config.until || config.plateau) && !config.measure) {
      throw new Error(`workflow phase "${phaseName}" requires measure when using until or plateau`);
    }
    return {
      task: config.task,
      context: config.context ?? [],
      run: config.run,
      produce: config.produce,
      on: config.on,
      evaluate: buildDeclarativeEvaluator(config),
      policy: buildLoopPolicy(config),
    };
  }

  if (!config.next) {
    throw new Error(`workflow phase "${phaseName}" requires next when no evaluators are configured`);
  }

  return {
    task: config.task,
    context: config.context ?? [],
    run: config.run,
    produce: config.produce,
    next: config.next,
  };
}

export function compileRecipeConfig(config: RecipeConfig): Omit<RecipeDefinition, 'apiVersion'> {
  if (typeof config !== 'object' || config === null) {
    throw new Error('route config must be an object');
  }
  if (Object.prototype.hasOwnProperty.call(config, 'task')) {
    throw new Error('legacy route task has been removed; use route.workflow.phases');
  }
  if ('prompt' in config || 'evaluate' in config || 'policy' in config || 'limits' in config) {
    throw new Error('legacy runtime route shape is no longer supported; use createRoute({ workflow, ... })');
  }
  if (!config.run) {
    throw new Error('route.run is required');
  }
  if (!config.workflow || typeof config.workflow !== 'object') {
    throw new Error('route.workflow is required');
  }

  const phases = Object.fromEntries(
    Object.entries(config.workflow.phases ?? {}).map(([phaseName, phaseConfig]) => [
      phaseName,
      compilePhaseConfig(phaseName, phaseConfig),
    ])
  );

  return {
    run: config.run,
    workflow: {
      start: config.workflow.start,
      phases,
    },
    limits: {
      maxIterations: config.limit,
    },
    report: config.report,
    commit: config.commit,
    checkpoint: config.checkpoint,
    log: config.log,
  };
}
