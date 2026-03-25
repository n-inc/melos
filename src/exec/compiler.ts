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

function mergeStatus(observations: Observation[]): Observation['status'] {
  if (observations.some((observation) => observation.status === 'error')) {
    return 'error';
  }
  return observations.every((observation) => observation.ok) ? 'pass' : 'fail';
}

function buildDeclarativeEvaluator(config: RecipeConfig): Evaluator {
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

function buildLoopPolicy(config: RecipeConfig): Policy {
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

function buildLimits(config: RecipeConfig): RecipeDefinition['limits'] {
  const hasLoopCondition = Boolean(
    (config.check && config.check.length > 0)
    || (config.pass && config.pass.length > 0)
    || config.until
    || config.plateau
  );
  if (!hasLoopCondition && config.limit === undefined) {
    return { maxIterations: 1 };
  }

  return {
    maxIterations: config.limit,
    patience: config.plateau?.patience,
  };
}

export function compileRecipeConfig(config: RecipeConfig): Omit<RecipeDefinition, 'apiVersion'> {
  if (typeof config !== 'object' || config === null) {
    throw new Error('route config must be an object');
  }
  if ('prompt' in config || 'evaluate' in config || 'policy' in config || 'limits' in config) {
    throw new Error('legacy runtime route shape is no longer supported; use createRoute({ task, ... })');
  }
  if (!config.run) {
    throw new Error('route.run is required');
  }
  if (typeof config.task !== 'string' && typeof config.task !== 'function') {
    throw new Error('route.task is required');
  }
  if ((config.until || config.plateau) && !config.measure) {
    throw new Error('route.measure is required when using until or plateau');
  }

  return {
    prompt: config.task,
    context: config.context ?? [],
    run: config.run,
    evaluate: buildDeclarativeEvaluator(config),
    policy: buildLoopPolicy(config),
    limits: buildLimits(config),
    report: config.report,
    checkpoint: config.checkpoint,
    log: config.log,
  };
}
