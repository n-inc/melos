import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';

import type { MissionEvent } from '../state/events.js';
import { CODEX_LATEST_ALIAS } from '../models/registry.js';
import { loadRouteModule, resolveRouteSource } from './loader.js';
import { renderFinalReportText } from './report.js';
import { runRoute, eventLog, type ExecRunSummary } from './runner.js';
import { createSimpleRoute } from './simple.js';
import type { RouteDefinition } from './recipe.js';

export * from './recipe.js';
export * from './loader.js';
export * from './providers.js';
export * from './evaluators.js';
export * from './policies.js';
export * from './checkpoint.js';
export * from './runner.js';
export * from './simple.js';
export * from './handoff.js';
export * from './report.js';

const DEFAULT_EXEC_MODEL = CODEX_LATEST_ALIAS;

export type ExecOutputFormat = 'text' | 'json' | 'stream-json';

export interface ExecCommandOptions {
  route?: string;
  prompt?: string;
  model?: string;
  cwd?: string;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  outputFormat?: ExecOutputFormat;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  noAsk?: boolean;
  alwaysAsk?: boolean;
}

function assertExclusiveInput(options: ExecCommandOptions): void {
  const inputCount = Number(Boolean(options.route)) + Number(Boolean(options.prompt));
  if (inputCount !== 1) {
    throw new Error('--route と --prompt のどちらか一方だけを指定してください');
  }
}

function createProgressSink(stderr: NodeJS.WritableStream): (event: MissionEvent) => void {
  return (event) => {
    if (event.type === 'route_loaded') {
      stderr.write(`route loaded: ${String(event.payload.path ?? event.payload.mode ?? 'unknown')}\n`);
      return;
    }
    if (event.type === 'iteration_started') {
      stderr.write(`[iteration ${event.iteration}]\n`);
      return;
    }
    if (event.type === 'decision_made') {
      stderr.write(`decision: ${String(event.payload.kind ?? 'unknown')}\n`);
      return;
    }
    if (event.type === 'rollback_applied') {
      stderr.write(`rollback: ${String(event.payload.ref ?? '')}\n`);
      return;
    }
    if (event.type === 'run_asked') {
      stderr.write(`ask: ${String(event.payload.question ?? '')}\n`);
      return;
    }
    if (event.type === 'report_generated') {
      stderr.write(`report: ${String(event.payload.path ?? '')}\n`);
      return;
    }
    if (event.type === 'run_failed') {
      stderr.write(`failed: ${String(event.payload.summary ?? '')}\n`);
      return;
    }
    if (event.type === 'run_completed') {
      stderr.write(`completed: ${String(event.payload.summary ?? '')}\n`);
    }
  };
}

function formatTextSummary(summary: ExecRunSummary): string {
  if (summary.status === 'asked') {
    return summary.question ?? summary.summary;
  }
  if (summary.report && summary.reportStdout !== false) {
    return renderFinalReportText(summary.report, summary.reportPath, {
      degraded: summary.reportDegraded,
    });
  }
  if (typeof summary.output === 'string' && summary.output.trim().length > 0) {
    return summary.output.trim();
  }
  return summary.summary;
}

function resolveAskMode(options: ExecCommandOptions): 'agent-first' | 'never-user' | 'always-user' {
  if (options.noAsk && options.alwaysAsk) {
    throw new Error('--no-ask と --always-ask は同時に指定できません');
  }
  if (options.noAsk) {
    return 'never-user';
  }
  if (options.alwaysAsk) {
    return 'always-user';
  }
  return 'agent-first';
}

function createAskUserPrompt(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream
): (input: { question: string }) => Promise<string | null> {
  return async ({ question }) => {
    const interactiveInput = stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const interactiveOutput = stdout as NodeJS.WriteStream & { isTTY?: boolean };
    if (interactiveInput.isTTY !== true || interactiveOutput.isTTY !== true) {
      return null;
    }

    stderr.write(`Question: ${question}\n> `);
    const rl = createInterface({
      input: stdin,
      output: stderr,
    });
    try {
      const answer = await rl.question('');
      return answer.trim().length > 0 ? answer.trim() : null;
    } finally {
      rl.close();
    }
  };
}

export async function exec(options: ExecCommandOptions): Promise<ExecRunSummary> {
  assertExclusiveInput(options);

  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = resolve(options.cwd ?? process.cwd());
  const melosDir = join(cwd, '.melos');
  mkdirSync(melosDir, { recursive: true });

  const outputFormat = options.outputFormat ?? 'text';
  const askMode = resolveAskMode(options);
  const onEvent = outputFormat === 'stream-json'
    ? (event: MissionEvent) => {
      stdout.write(`${JSON.stringify(event)}\n`);
    }
    : outputFormat === 'text'
      ? createProgressSink(stderr)
      : undefined;

  const log = eventLog({
    melosDir,
    onEvent,
  });
  log.emit({
    type: 'run_started',
    iteration: 0,
    agent: 'system',
    payload: {
      cwd,
      mode: options.route ? 'route' : 'prompt',
      outputFormat,
    },
  });

  let cleanup: (() => void) | undefined;
  try {
    let recipe: RouteDefinition;
    let recipePath: string | undefined;

    if (options.route) {
      const resolved = await resolveRouteSource({
        routePath: options.route,
        cwd,
        stdin: options.stdin,
      });
      cleanup = resolved.cleanup;
      recipePath = resolved.path;
      recipe = await loadRouteModule(resolved.path);
      recipe.log ??= log;
      log.emit({
        type: 'route_loaded',
        iteration: 0,
        agent: 'system',
        payload: {
          path: resolved.path,
          fromStdin: resolved.fromStdin,
        },
      });
    } else {
      recipe = createSimpleRoute({
        prompt: options.prompt ?? '',
        model: options.model ?? DEFAULT_EXEC_MODEL,
        cwd,
        effort: options.effort,
      });
      recipe.log = log;
      log.emit({
        type: 'route_loaded',
        iteration: 0,
        agent: 'system',
        payload: {
          mode: 'prompt',
        },
      });
    }

    const summary = await runRoute({
      recipe,
      cwd,
      melosDir,
      recipePath,
      askMode,
      askUser: createAskUserPrompt(
        options.stdin ?? process.stdin,
        stdout,
        stderr
      ),
    });

    if (outputFormat === 'json') {
      stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else if (outputFormat === 'text') {
      stdout.write(`${formatTextSummary(summary)}\n`);
    }

    return summary;
  } catch (error) {
    const summary: ExecRunSummary = {
      status: 'failed',
      success: false,
      iterations: 0,
      decision: 'failed',
      summary: error instanceof Error ? error.message : String(error),
      cwd,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    log.emit({
      type: 'run_failed',
      iteration: 0,
      agent: 'system',
      payload: summary as unknown as Record<string, unknown>,
    });
    if (outputFormat === 'json') {
      stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else if (outputFormat === 'text') {
      stdout.write(`${summary.summary}\n`);
    }
    return summary;
  } finally {
    cleanup?.();
  }
}
