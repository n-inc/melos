import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { MissionEvent } from '../state/events.js';
import { CODEX_LATEST_ALIAS } from '../models/registry.js';
import { loadRecipeModule, resolveRecipeSource } from './loader.js';
import { runRecipe, eventLog, type ExecRunSummary } from './runner.js';
import { createSimpleRecipe } from './simple.js';
import type { RecipeDefinition } from './recipe.js';

export * from './recipe.js';
export * from './loader.js';
export * from './providers.js';
export * from './evaluators.js';
export * from './policies.js';
export * from './checkpoint.js';
export * from './runner.js';
export * from './simple.js';

export type ExecOutputFormat = 'text' | 'json' | 'stream-json';

export interface ExecCommandOptions {
  recipe?: string;
  prompt?: string;
  model?: string;
  cwd?: string;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  outputFormat?: ExecOutputFormat;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

function assertExclusiveInput(options: ExecCommandOptions): void {
  const inputCount = Number(Boolean(options.recipe)) + Number(Boolean(options.prompt));
  if (inputCount !== 1) {
    throw new Error('--recipe と --prompt のどちらか一方だけを指定してください');
  }
}

function createProgressSink(stderr: NodeJS.WritableStream): (event: MissionEvent) => void {
  return (event) => {
    if (event.type === 'recipe_loaded') {
      stderr.write(`recipe loaded: ${String(event.payload.path ?? event.payload.mode ?? 'unknown')}\n`);
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
    if (event.type === 'exec_asked') {
      stderr.write(`ask: ${String(event.payload.question ?? '')}\n`);
      return;
    }
    if (event.type === 'exec_failed') {
      stderr.write(`failed: ${String(event.payload.summary ?? '')}\n`);
      return;
    }
    if (event.type === 'exec_completed') {
      stderr.write(`completed: ${String(event.payload.summary ?? '')}\n`);
    }
  };
}

function formatTextSummary(summary: ExecRunSummary): string {
  if (summary.status === 'asked') {
    return summary.question ?? summary.summary;
  }
  if (typeof summary.output === 'string' && summary.output.trim().length > 0) {
    return summary.output.trim();
  }
  return summary.summary;
}

export async function exec(options: ExecCommandOptions): Promise<ExecRunSummary> {
  assertExclusiveInput(options);

  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const cwd = resolve(options.cwd ?? process.cwd());
  const melosDir = join(cwd, '.melos');
  mkdirSync(melosDir, { recursive: true });

  const outputFormat = options.outputFormat ?? 'text';
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
    type: 'exec_started',
    iteration: 0,
    agent: 'system',
    payload: {
      cwd,
      mode: options.recipe ? 'recipe' : 'prompt',
      outputFormat,
    },
  });

  let cleanup: (() => void) | undefined;
  try {
    let recipe: RecipeDefinition;
    let recipePath: string | undefined;

    if (options.recipe) {
      const resolved = await resolveRecipeSource({
        recipePath: options.recipe,
        cwd,
        stdin: options.stdin,
      });
      cleanup = resolved.cleanup;
      recipePath = resolved.path;
      recipe = await loadRecipeModule(resolved.path);
      recipe.log ??= log;
      log.emit({
        type: 'recipe_loaded',
        iteration: 0,
        agent: 'system',
        payload: {
          path: resolved.path,
          fromStdin: resolved.fromStdin,
        },
      });
    } else {
      recipe = createSimpleRecipe({
        prompt: options.prompt ?? '',
        model: options.model ?? CODEX_LATEST_ALIAS,
        cwd,
        effort: options.effort,
      });
      recipe.log = log;
      log.emit({
        type: 'recipe_loaded',
        iteration: 0,
        agent: 'system',
        payload: {
          mode: 'prompt',
        },
      });
    }

    const summary = await runRecipe({
      recipe,
      cwd,
      melosDir,
      recipePath,
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
      type: 'exec_failed',
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
