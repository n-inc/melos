import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { llmEvaluate, metricExtractor, shellChecks } from './evaluators.js';
import { askDecision, continueDecision, rollbackDecision, stopDecision } from './policies.js';
import { normalizeObservation } from './recipe.js';
import type {
  ContextProvider,
  Evaluator,
  Observation,
  Policy,
  RecipeConfig,
  RecipeDefinition,
  SkillRef,
  ThresholdCondition,
  WorkflowValidateConfig,
  WorkflowPhaseConfig,
  WorkflowPhaseDefinition,
} from './recipe.js';

function normalizeThresholds(thresholds?: ThresholdCondition | ThresholdCondition[]): ThresholdCondition[] {
  if (!thresholds) {
    return [];
  }
  return Array.isArray(thresholds) ? thresholds : [thresholds];
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

function buildDeclarativeEvaluator(validate: WorkflowValidateConfig): Evaluator {
  const shellEvaluator = validate.shell && validate.shell.length > 0
    ? shellChecks(validate.shell)
    : null;
  const metricsEvaluator = validate.metrics
    ? metricExtractor(validate.metrics)
    : null;
  const llmEvaluator = validate.llm && validate.llm.length > 0
    ? llmEvaluate({ criteria: validate.llm })
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

    const shellObservation = shellEvaluator
      ? normalizeObservation(await shellEvaluator(ctx))
      : null;
    const metricsObservation = metricsEvaluator
      ? normalizeObservation(await metricsEvaluator(ctx))
      : null;
    const llmObservation = llmEvaluator
      ? normalizeObservation(await llmEvaluator(ctx))
      : null;
    const observations = [shellObservation, metricsObservation, llmObservation]
      .filter((observation): observation is Observation => observation !== null);
    const combinedStatus = mergeStatus(observations);
    const combinedOk = observations.every((observation) => observation.ok);
    const fallbackSummary = ctx.assistantText.trim() || 'task executed';

    return normalizeObservation({
      ok: combinedOk,
      status: combinedStatus,
      summary: joinSummary([
        { key: 'shell', observation: shellObservation },
        { key: 'metrics', observation: metricsObservation },
        { key: 'llm', observation: llmObservation },
      ], fallbackSummary),
      details: joinDetails([
        { key: 'shell', observation: shellObservation },
        { key: 'metrics', observation: metricsObservation },
        { key: 'llm', observation: llmObservation },
      ]),
      metrics: metricsObservation?.metrics ?? {},
      output: ctx.assistantText,
      data: mergeData([
        { key: 'shell', value: shellObservation?.data },
        { key: 'metrics', value: metricsObservation?.data },
        { key: 'llm', value: llmObservation?.data },
      ]),
    });
  };
}

function buildLoopPolicy(validate: WorkflowValidateConfig): Policy {
  const thresholds = normalizeThresholds(validate.metrics?.thresholds);
  const plateau = validate.metrics?.plateau;

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

export function skillContextProvider(
  ref: SkillRef,
  cwd: string,
  repos?: Record<string, string>,
): ContextProvider {
  return async () => {
    let skillPath: string;
    let name: string;

    if (typeof ref === 'string' && ref.startsWith('@')) {
      const slashIdx = ref.indexOf('/', 1);
      if (slashIdx === -1) {
        throw new Error(`Invalid skill ref "${ref}": expected @alias/skill-name`);
      }
      const alias = ref.slice(1, slashIdx);
      const skillName = ref.slice(slashIdx + 1);
      if (!alias) {
        throw new Error(`Invalid skill ref "${ref}": empty alias — expected @alias/skill-name`);
      }
      if (!skillName) {
        throw new Error(`Invalid skill ref "${ref}": empty skill name — expected @alias/skill-name`);
      }
      const repoPath = repos?.[alias];
      if (!repoPath) {
        throw new Error(
          `Unknown repo alias "${alias}" in skill ref "${ref}". `
          + `Declare it in route repos: { "${alias}": "../path" }`,
        );
      }
      skillPath = resolve(cwd, repoPath, '.claude/skills', skillName, 'SKILL.md');
      name = skillName;
    } else if (typeof ref === 'string') {
      skillPath = resolve(cwd, '.claude/skills', ref, 'SKILL.md');
      name = ref;
    } else {
      skillPath = resolve(cwd, ref.path);
      name = basename(ref.path, '.md');
    }

    const content = await readFile(skillPath, 'utf-8');
    const body = content.replace(/^---[\s\S]*?---\n*/, '');
    return { title: `Skill: ${name}`, content: body };
  };
}

function resolveSkillProviders(
  routeSkills: SkillRef[] | undefined,
  phaseSkills: SkillRef[] | undefined,
  cwd: string,
  repos?: Record<string, string>,
): ContextProvider[] {
  const merged = [...(routeSkills ?? []), ...(phaseSkills ?? [])];
  return merged.map((ref) => skillContextProvider(ref, cwd, repos));
}

function hasEvaluatorConfig(config: WorkflowPhaseConfig): boolean {
  return Boolean(config.validate);
}

function hasActiveValidateConfig(validate?: WorkflowValidateConfig): boolean {
  if (!validate) {
    return false;
  }
  return Boolean(
    (validate.shell && validate.shell.length > 0)
    || (validate.llm && validate.llm.length > 0)
    || validate.metrics
  );
}

function compilePhaseConfig(
  phaseName: string,
  config: WorkflowPhaseConfig,
  routeSkills?: SkillRef[],
  repos?: Record<string, string>,
): WorkflowPhaseDefinition {
  if (typeof config.task !== 'string' && typeof config.task !== 'function') {
    throw new Error(`workflow phase "${phaseName}" task is required`);
  }

  // Build skill context providers that resolve at runtime using ctx.cwd
  const hasSkills = (routeSkills && routeSkills.length > 0) || (config.skills && config.skills.length > 0);
  const skillProviders: ContextProvider[] = hasSkills
    ? [async (ctx) => {
        const providers = resolveSkillProviders(routeSkills, config.skills, ctx.cwd, repos);
        const results = await Promise.all(providers.map((p) => p(ctx)));
        return results.flat().filter((s): s is NonNullable<typeof s> => s != null);
      }]
    : [];
  const context = [...skillProviders, ...(config.context ?? [])];

  const legacyFields = ['check', 'pass', 'measure', 'until', 'plateau', 'next']
    .filter((field) => Object.prototype.hasOwnProperty.call(config as unknown as Record<string, unknown>, field));
  if (legacyFields.includes('next')) {
    throw new Error(`workflow phase "${phaseName}" next has been removed; use on.pass instead`);
  }
  if (legacyFields.length > 0) {
    throw new Error(`workflow phase "${phaseName}" must define validations under validate`);
  }
  if (!config.on?.pass) {
    throw new Error(`workflow phase "${phaseName}" requires on.pass`);
  }
  if (config.validate && !hasActiveValidateConfig(config.validate)) {
    throw new Error(`workflow phase "${phaseName}" validate must define at least one validator`);
  }

  const hasEvaluator = hasEvaluatorConfig(config);
  if (hasEvaluator) {
    if (!config.on.fail) {
      throw new Error(`workflow phase "${phaseName}" requires on.fail when validate is configured`);
    }
    if (config.validate?.metrics && typeof config.validate.metrics.command !== 'string') {
      throw new Error(`workflow phase "${phaseName}" validate.metrics.command is required`);
    }
    return {
      task: config.task,
      context,
      run: config.run,
      produce: config.produce,
      on: config.on,
      evaluate: buildDeclarativeEvaluator(config.validate!),
      policy: buildLoopPolicy(config.validate!),
      loop: { name: phaseName },
    };
  }

  if (config.on.fail || config.on.ask || config.on.rollback) {
    throw new Error(`workflow phase "${phaseName}" cannot define fail/ask/rollback transitions without validate`);
  }

  return {
    task: config.task,
    context,
    run: config.run,
    produce: config.produce,
    next: config.on.pass,
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
      compilePhaseConfig(phaseName, phaseConfig, config.skills, config.repos),
    ])
  );

  return {
    run: config.run,
    repos: config.repos,
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
