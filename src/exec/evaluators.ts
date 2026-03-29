import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

import { AppServerEngine } from '../engines/app-server.js';
import { ClaudeEngine } from '../engines/claude.js';
import type { Engine, EngineOptions } from '../engines/base.js';
import { isClaudeFamily, resolveModelEngine, resolveRuntimeModel } from '../models/registry.js';
import { parseJsonOrEmbedded } from './json.js';
import { renderPromptWithSections } from './prompt-sections.js';
import { normalizeObservation, type Evaluator, type Observation, type ObservationInput, type RecipeRunConfig } from './recipe.js';
import { resolveShellExecutable } from './shell.js';

export interface CommandExecutionResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export interface ShellCommandOptions {
  cwd: string;
  timeoutMs?: number;
}

export async function runShellCommand(
  command: string,
  options: ShellCommandOptions
): Promise<CommandExecutionResult> {
  const startedAt = Date.now();
  const shell = resolveShellExecutable();

  return new Promise((resolve) => {
    const child = spawn(shell, ['-lc', command], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutId: NodeJS.Timeout | undefined;

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, options.timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (error) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve({
        command,
        cwd: options.cwd,
        stdout,
        stderr: [stderr.trim(), error.message].filter((part) => part.length > 0).join('\n'),
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.on('close', (code) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve({
        command,
        cwd: options.cwd,
        stdout,
        stderr,
        exitCode: timedOut ? 124 : (code ?? 1),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

export interface ShellCommandSpec {
  command: string;
  cwd?: string;
  title?: string;
  timeoutMs?: number;
}

type ShellCheck = string | ShellCommandSpec;

function resolveCommandCwd(baseCwd: string, commandCwd?: string): string {
  if (!commandCwd) {
    return baseCwd;
  }
  return isAbsolute(commandCwd) ? commandCwd : resolve(baseCwd, commandCwd);
}

export function shellChecks(checks: ShellCheck[] | ShellCheck): Evaluator {
  const normalizedChecks = Array.isArray(checks) ? checks : [checks];

  return async (ctx) => {
    const results: CommandExecutionResult[] = [];

    for (const check of normalizedChecks) {
      const config = typeof check === 'string' ? { command: check } : check;
      const result = await runShellCommand(config.command, {
        cwd: resolveCommandCwd(ctx.cwd, config.cwd),
        timeoutMs: config.timeoutMs,
      });
      results.push(result);
      if (result.exitCode !== 0) {
        return normalizeObservation({
          ok: false,
          status: result.timedOut ? 'error' : 'fail',
          summary: `${config.title ?? config.command} failed`,
          details: [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0).join('\n'),
          data: { checks: results },
        });
      }
    }

    return normalizeObservation({
      ok: true,
      status: 'pass',
      summary: `shell checks passed (${results.length})`,
      data: { checks: results },
    });
  };
}

export interface CommandJsonOptions {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  summary?: string;
}

export function commandJson(options: CommandJsonOptions): Evaluator {
  return async (ctx) => {
    const result = await runShellCommand(options.command, {
      cwd: resolveCommandCwd(ctx.cwd, options.cwd),
      timeoutMs: options.timeoutMs,
    });

    if (result.exitCode !== 0) {
      return normalizeObservation({
        ok: false,
        status: result.timedOut ? 'error' : 'fail',
        summary: `${options.command} failed`,
        details: [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0).join('\n'),
        data: result,
      });
    }

    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const metrics: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          metrics[key] = value;
        }
      }
      return normalizeObservation({
        ok: true,
        status: 'pass',
        summary: options.summary ?? `${options.command} returned JSON`,
        metrics,
        data: parsed,
      });
    } catch (error) {
      return normalizeObservation({
        ok: false,
        status: 'error',
        summary: `${options.command} did not return valid JSON`,
        details: error instanceof Error ? error.message : String(error),
        data: result,
      });
    }
  };
}

export interface MetricExtraction {
  metrics: Record<string, number>;
  summary?: string;
  ok?: boolean;
  details?: string;
  data?: unknown;
}

export interface MetricExtractorOptions {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  extract?: (input: { result: CommandExecutionResult; parsedJson?: unknown }) => MetricExtraction | Record<string, number> | number | Promise<MetricExtraction | Record<string, number> | number>;
}

function normalizeMetricExtraction(value: MetricExtraction | Record<string, number> | number): MetricExtraction {
  if (typeof value === 'number') {
    return { metrics: { value } };
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const candidate = value as Partial<MetricExtraction>;
    if (candidate.metrics && typeof candidate.metrics === 'object') {
      return {
        metrics: candidate.metrics,
        summary: candidate.summary,
        ok: candidate.ok,
        details: candidate.details,
        data: candidate.data,
      };
    }
  }
  return { metrics: value as Record<string, number> };
}

export function metricExtractor(options: MetricExtractorOptions): Evaluator {
  return async (ctx) => {
    const result = await runShellCommand(options.command, {
      cwd: resolveCommandCwd(ctx.cwd, options.cwd),
      timeoutMs: options.timeoutMs,
    });
    if (result.exitCode !== 0) {
      return normalizeObservation({
        ok: false,
        status: result.timedOut ? 'error' : 'fail',
        summary: `${options.command} failed`,
        details: [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0).join('\n'),
        data: result,
      });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(result.stdout);
    } catch {
      parsedJson = undefined;
    }

    const extracted = options.extract
      ? normalizeMetricExtraction(await options.extract({ result, parsedJson }))
      : normalizeMetricExtraction(parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)
        ? Object.fromEntries(
          Object.entries(parsedJson as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
            .map(([key, value]) => [key, value as number])
        )
        : {});

    return normalizeObservation({
      ok: extracted.ok ?? true,
      status: extracted.ok === false ? 'fail' : 'pass',
      summary: extracted.summary ?? `${options.command} extracted metrics`,
      details: extracted.details,
      metrics: extracted.metrics,
      data: extracted.data ?? parsedJson ?? result.stdout,
    });
  };
}

export function customEvaluator(
  evaluator: (ctx: Parameters<Evaluator>[0]) => ObservationInput | Promise<ObservationInput>
): Evaluator {
  return async (ctx) => normalizeObservation(await evaluator(ctx));
}

export function asObservation(input: ObservationInput): Observation {
  return normalizeObservation(input);
}

type LlmEngine = 'claude' | 'codex' | 'auto';
const LLM_EVALUATE_MAX_ATTEMPTS = 2;

export interface LlmEvaluateOptions {
  criteria: string[];
  engine?: LlmEngine;
  model?: string;
  effort?: EngineOptions['effort'] | EngineOptions['reasoningEffort'];
  timeoutMs?: number;
}

interface LlmCriterionResult {
  criterion: string;
  verdict: 'yes' | 'no';
  rationale?: string;
}

function createLlmEngine(engine: LlmEngine, runConfig?: RecipeRunConfig, model?: string): Engine {
  const resolvedModel = model ?? runConfig?.model;
  const engineName = engine === 'auto'
    ? resolveModelEngine(resolvedModel)
    : engine;
  return engineName === 'claude'
    ? new ClaudeEngine()
    : new AppServerEngine();
}

function resolveLlmEngineName(engine: LlmEngine, runConfig?: RecipeRunConfig, model?: string): 'claude' | 'codex' {
  if (engine !== 'auto') {
    return engine;
  }
  return resolveModelEngine(model ?? runConfig?.model);
}

function buildLlmEngineOptions(
  engine: 'claude' | 'codex',
  options: LlmEvaluateOptions,
  runConfig?: RecipeRunConfig,
  cwd?: string
): EngineOptions {
  const model = options.model ?? runConfig?.model;
  const runEffort = options.effort ?? runConfig?.effort;
  const resolvedModel = model
    ? resolveRuntimeModel(model)
    : undefined;

  const engineOptions: EngineOptions = {
    cwd: cwd ?? runConfig?.cwd,
    timeout: options.timeoutMs,
  };
  if (resolvedModel) {
    engineOptions.model = resolvedModel;
  }
  if (runEffort) {
    if (engine === 'claude' || isClaudeFamily(model)) {
      engineOptions.effort = runEffort as EngineOptions['effort'];
    } else {
      engineOptions.reasoningEffort = runEffort as EngineOptions['reasoningEffort'];
    }
  }
  return engineOptions;
}

function buildLlmEvaluatePrompt(input: {
  assistantText: string;
  criteria: string[];
  sections: Array<{ title: string; content: string }>;
}): string {
  const criteriaBlock = input.criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n');
  return renderPromptWithSections(
    [
      'Evaluate the candidate answer against every criterion.',
      'Do not use tools, file reads, web access, or external context.',
      'Use only the candidate answer and provided sections in this prompt.',
      'Return strict JSON with this exact shape:',
      '{"criteria":[{"criterion":"...","verdict":"yes|no","rationale":"..."}]}',
      'Use only "yes" or "no" for verdict.',
      'Return "yes" only if the criterion is fully satisfied.',
    ].join('\n'),
    [
      {
        title: 'candidate answer',
        content: input.assistantText.trim() || '(empty assistant output)',
      },
      {
        title: 'criteria',
        content: criteriaBlock,
      },
      ...input.sections,
    ]
  );
}

function truncatePromptText(text: string, maxLength = 12000): string {
  if (text.length <= maxLength) {
    return text;
  }
  const omitted = text.length - maxLength;
  return `${text.slice(0, maxLength)}\n...(truncated ${omitted} chars)`;
}

function buildPhaseOutputSections(ctx: Parameters<Evaluator>[0]): Array<{ title: string; content: string }> {
  const phaseName = ctx.workflow?.phase ?? ctx.state.currentPhase;
  if (!phaseName) {
    return [];
  }

  const output = ctx.state.outputs[phaseName];
  if (output === undefined) {
    return [];
  }

  const content = typeof output === 'string'
    ? output
    : JSON.stringify(output, null, 2);
  if (typeof content !== 'string' || content.trim().length === 0) {
    return [];
  }

  if (content.trim() === ctx.assistantText.trim()) {
    return [];
  }

  return [{
    title: 'current phase output',
    content: truncatePromptText(content),
  }];
}

function normalizeLlmCriteria(
  parsed: unknown,
  criteria: string[]
): LlmCriterionResult[] | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const items = (parsed as { criteria?: unknown }).criteria;
  if (!Array.isArray(items)) {
    return null;
  }

  const normalized = items
    .flatMap((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return [];
      }
      const criterion = typeof (item as { criterion?: unknown }).criterion === 'string'
        ? (item as { criterion: string }).criterion
        : null;
      const verdict = typeof (item as { verdict?: unknown }).verdict === 'string'
        ? (item as { verdict: string }).verdict.toLowerCase()
        : null;
      if (!criterion || (verdict !== 'yes' && verdict !== 'no')) {
        return [];
      }
      return [{
        criterion,
        verdict,
        rationale: typeof (item as { rationale?: unknown }).rationale === 'string'
          ? (item as { rationale: string }).rationale
          : undefined,
      } satisfies LlmCriterionResult];
    });

  if (normalized.length !== criteria.length) {
    return null;
  }

  const expectedCounts = new Map<string, number>();
  for (const criterion of criteria) {
    expectedCounts.set(criterion, (expectedCounts.get(criterion) ?? 0) + 1);
  }

  const actualCounts = new Map<string, number>();
  for (const item of normalized) {
    if (!expectedCounts.has(item.criterion)) {
      return null;
    }
    const nextCount = (actualCounts.get(item.criterion) ?? 0) + 1;
    if (nextCount > (expectedCounts.get(item.criterion) ?? 0)) {
      return null;
    }
    actualCounts.set(item.criterion, nextCount);
  }

  for (const [criterion, expectedCount] of expectedCounts) {
    if ((actualCounts.get(criterion) ?? 0) !== expectedCount) {
      return null;
    }
  }

  return normalized;
}

async function shutdownLlmEngine(engine: Engine): Promise<void> {
  const maybeShutdown = (engine as Engine & { shutdown?: () => Promise<void> }).shutdown;
  if (typeof maybeShutdown === 'function') {
    await maybeShutdown.call(engine);
  }
}

export function llmEvaluate(options: LlmEvaluateOptions): Evaluator {
  if (Object.prototype.hasOwnProperty.call(options, 'context')) {
    throw new Error('llmEvaluate context has been removed');
  }

  return async (ctx) => {
    const engineName = resolveLlmEngineName(options.engine ?? 'auto', ctx.runConfig, options.model);
    const prompt = buildLlmEvaluatePrompt({
      assistantText: ctx.assistantText,
      criteria: options.criteria,
      sections: buildPhaseOutputSections(ctx),
    });
    const engineOptions = buildLlmEngineOptions(engineName, options, ctx.runConfig, ctx.cwd);

    for (let attempt = 1; attempt <= LLM_EVALUATE_MAX_ATTEMPTS; attempt += 1) {
      const engine = createLlmEngine(options.engine ?? 'auto', ctx.runConfig, options.model);
      const result = await (async () => {
        try {
          return await engine.execute(prompt, engineOptions);
        } finally {
          await shutdownLlmEngine(engine);
        }
      })();
      const attempts = { attempt, maxAttempts: LLM_EVALUATE_MAX_ATTEMPTS };

      if (!result.success) {
        if (attempt < LLM_EVALUATE_MAX_ATTEMPTS) {
          continue;
        }
        return normalizeObservation({
          ok: false,
          status: 'error',
          summary: 'llm evaluation failed',
          details: result.error ?? result.output,
          data: {
            engine: engineName,
            output: result.output,
            attempts,
          },
        });
      }

      const parsed = parseJsonOrEmbedded(result.output);
      if (!parsed.ok) {
        if (attempt < LLM_EVALUATE_MAX_ATTEMPTS) {
          continue;
        }
        return normalizeObservation({
          ok: false,
          status: 'error',
          summary: 'llm evaluation returned invalid JSON',
          details: parsed.error instanceof Error ? parsed.error.message : String(parsed.error),
          data: {
            engine: engineName,
            output: result.output,
            attempts,
          },
        });
      }

      const normalized = normalizeLlmCriteria(parsed.value, options.criteria);
      if (!normalized) {
        if (attempt < LLM_EVALUATE_MAX_ATTEMPTS) {
          continue;
        }
        return normalizeObservation({
          ok: false,
          status: 'error',
          summary: 'llm evaluation returned an invalid criteria payload',
          data: {
            engine: engineName,
            output: result.output,
            attempts,
          },
        });
      }

      const ok = normalized.every((item) => item.verdict === 'yes');
      return normalizeObservation({
        ok,
        status: ok ? 'pass' : 'fail',
        summary: ok ? 'llm evaluation passed' : 'llm evaluation failed',
        data: {
          engine: engineName,
          criteria: normalized,
          attempts,
        },
      });
    }

    return normalizeObservation({
      ok: false,
      status: 'error',
      summary: 'llm evaluation failed',
      data: {
        engine: engineName,
        attempts: {
          attempt: LLM_EVALUATE_MAX_ATTEMPTS,
          maxAttempts: LLM_EVALUATE_MAX_ATTEMPTS,
        },
      },
    });
  };
}
