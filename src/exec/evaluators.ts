import { spawn } from 'node:child_process';

import { normalizeObservation, type Evaluator, type Observation, type ObservationInput } from './recipe.js';

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

  return new Promise((resolve) => {
    const child = spawn('/bin/zsh', ['-lc', command], {
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

type ShellCheck = string | { command: string; title?: string; timeoutMs?: number };

export function shellChecks(checks: ShellCheck[] | ShellCheck): Evaluator {
  const normalizedChecks = Array.isArray(checks) ? checks : [checks];

  return async (ctx) => {
    const results: CommandExecutionResult[] = [];

    for (const check of normalizedChecks) {
      const config = typeof check === 'string' ? { command: check } : check;
      const result = await runShellCommand(config.command, {
        cwd: ctx.cwd,
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
  timeoutMs?: number;
  summary?: string;
}

export function commandJson(options: CommandJsonOptions): Evaluator {
  return async (ctx) => {
    const result = await runShellCommand(options.command, {
      cwd: ctx.cwd,
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
      cwd: ctx.cwd,
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
