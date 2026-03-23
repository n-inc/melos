import type { Decision, Policy, PolicyContext } from './recipe.js';

interface DecisionOptions {
  summary?: string;
  reason?: string;
  success?: boolean;
  stateUpdate?: Decision['stateUpdate'];
}

export function continueDecision(options: DecisionOptions = {}): Decision {
  return {
    kind: 'continue',
    ...options,
  };
}

export function stopDecision(options: DecisionOptions = {}): Decision {
  return {
    kind: 'stop',
    ...options,
  };
}

export function rollbackDecision(options: DecisionOptions = {}): Decision {
  return {
    kind: 'rollback',
    ...options,
  };
}

export function askDecision(question: string, options: Omit<DecisionOptions, 'success'> = {}): Decision {
  return {
    kind: 'ask',
    question,
    ...options,
  };
}

export function continueUntilPass(): Policy {
  return ({ observation }) => {
    if (observation.question) {
      return askDecision(observation.question, { summary: observation.summary });
    }
    if (observation.ok) {
      return stopDecision({
        success: true,
        summary: observation.summary,
      });
    }
    return continueDecision({
      summary: observation.summary,
    });
  };
}

export interface PlateauMetricOptions {
  goal?: 'maximize' | 'minimize';
  patience?: number;
  minImprovement?: number;
  rollbackOnRegression?: boolean;
}

function metricDelta(goal: 'maximize' | 'minimize', current: number, previous: number): number {
  return goal === 'minimize' ? previous - current : current - previous;
}

export function plateauMetric(metric: string, options: PlateauMetricOptions = {}): Policy {
  const goal = options.goal ?? 'maximize';
  const minImprovement = options.minImprovement ?? 0;

  return ({ observation, state, recipe }) => {
    const patience = options.patience ?? recipe.limits?.patience ?? 1;
    const current = observation.metrics[metric];

    if (!Number.isFinite(current)) {
      return stopDecision({
        success: false,
        summary: `metric "${metric}" is missing`,
      });
    }

    if (observation.ok) {
      return stopDecision({
        success: true,
        summary: observation.summary,
        stateUpdate: {
          attempts: 0,
          bestMetrics: { ...state.bestMetrics, [metric]: current },
        },
      });
    }

    const previousBest = state.bestMetrics[metric];
    if (!Number.isFinite(previousBest) || metricDelta(goal, current, previousBest) > minImprovement) {
      return continueDecision({
        summary: observation.summary,
        stateUpdate: {
          attempts: 0,
          bestMetrics: { ...state.bestMetrics, [metric]: current },
        },
      });
    }

    const attempts = state.attempts + 1;
    const delta = metricDelta(goal, current, previousBest);
    if (delta < 0 && options.rollbackOnRegression !== false) {
      return rollbackDecision({
        summary: observation.summary,
        reason: `metric "${metric}" regressed from ${previousBest} to ${current}`,
        stateUpdate: { attempts },
      });
    }

    if (attempts >= patience) {
      return stopDecision({
        success: observation.ok,
        summary: observation.summary,
        reason: `metric "${metric}" plateaued after ${attempts} attempts`,
        stateUpdate: { attempts },
      });
    }

    return continueDecision({
      summary: observation.summary,
      reason: `metric "${metric}" did not improve`,
      stateUpdate: { attempts },
    });
  };
}

export function customPolicy(
  policy: (ctx: PolicyContext) => Decision | Promise<Decision>
): Policy {
  return policy;
}
