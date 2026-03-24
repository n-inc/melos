import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, resolve, relative } from 'node:path';

import { readHandoffHistory, readLatestHandoff } from './handoff.js';
import type { ContextProvider, ContextSection, RecipeContextBase } from './recipe.js';
import { resolveShellExecutable } from './shell.js';

interface ProviderOptions {
  title?: string;
}

interface FileProviderOptions extends ProviderOptions {
  maxBytes?: number;
}

function resolveProviderPath(ctx: RecipeContextBase, targetPath: string): string {
  return resolve(ctx.cwd, targetPath);
}

function trimContent(content: string, maxBytes?: number): string {
  if (!maxBytes || Buffer.byteLength(content, 'utf-8') <= maxBytes) {
    return content;
  }
  return `${content.slice(0, maxBytes)}\n... [truncated]`;
}

function toSection(title: string, content: string): ContextSection | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return { title, content: trimmed };
}

export function file(targetPath: string, options: FileProviderOptions = {}): ContextProvider {
  return (ctx) => {
    const absolutePath = resolveProviderPath(ctx, targetPath);
    const content = readFileSync(absolutePath, 'utf-8');
    return toSection(options.title ?? `file: ${relative(ctx.cwd, absolutePath) || basename(absolutePath)}`, trimContent(content, options.maxBytes));
  };
}

export function optionalFile(targetPath: string, options: FileProviderOptions = {}): ContextProvider {
  return (ctx) => {
    const absolutePath = resolveProviderPath(ctx, targetPath);
    if (!existsSync(absolutePath)) {
      return null;
    }
    const content = readFileSync(absolutePath, 'utf-8');
    return toSection(options.title ?? `file: ${relative(ctx.cwd, absolutePath) || basename(absolutePath)}`, trimContent(content, options.maxBytes));
  };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function walkFiles(root: string, current: string, files: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const entryPath = resolve(current, entry.name);
    if (entry.isDirectory()) {
      walkFiles(root, entryPath, files);
      continue;
    }
    if (entry.isFile()) {
      files.push(relative(root, entryPath).split('\\').join('/'));
    }
  }
}

export function glob(pattern: string, options: ProviderOptions & { maxResults?: number } = {}): ContextProvider {
  return (ctx) => {
    const matcher = globToRegExp(pattern);
    const files: string[] = [];
    walkFiles(ctx.cwd, ctx.cwd, files);
    const matches = files.filter((filePath) => matcher.test(filePath)).slice(0, options.maxResults ?? 200);
    if (matches.length === 0) {
      return null;
    }
    return {
      title: options.title ?? `glob: ${pattern}`,
      content: matches.join('\n'),
    };
  };
}

export function command(commandText: string, options: ProviderOptions = {}): ContextProvider {
  return (ctx) => {
    try {
      const stdout = execSync(commandText, {
        cwd: ctx.cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: resolveShellExecutable(),
      });
      return toSection(options.title ?? `command: ${commandText}`, stdout);
    } catch (error) {
      const record = error as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
      const stdout = typeof record.stdout === 'string' ? record.stdout : record.stdout?.toString('utf-8') ?? '';
      const stderr = typeof record.stderr === 'string' ? record.stderr : record.stderr?.toString('utf-8') ?? '';
      return toSection(
        options.title ?? `command: ${commandText}`,
        [`exitCode: ${record.status ?? 1}`, stdout.trim(), stderr.trim()].filter((part) => part.length > 0).join('\n')
      );
    }
  };
}

export function gitDiffStat(options: ProviderOptions = {}): ContextProvider {
  return (ctx) => {
    try {
      const output = execSync('git diff --stat', {
        cwd: ctx.cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return toSection(options.title ?? 'git diff stat', output || 'clean worktree');
    } catch {
      return toSection(options.title ?? 'git diff stat', 'git diff --stat failed');
    }
  };
}

export function gitLog(options: ProviderOptions & { count?: number } = {}): ContextProvider {
  return (ctx) => {
    const count = Math.max(1, options.count ?? 5);
    try {
      const output = execSync(`git log -n ${count} --oneline`, {
        cwd: ctx.cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return toSection(options.title ?? 'git log', output);
    } catch {
      return toSection(options.title ?? 'git log', 'git log failed');
    }
  };
}

export function tail(targetPath: string, options: ProviderOptions & { lines?: number } = {}): ContextProvider {
  return (ctx) => {
    const absolutePath = resolveProviderPath(ctx, targetPath);
    const content = readFileSync(absolutePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const picked = lines.slice(Math.max(0, lines.length - (options.lines ?? 40)));
    return toSection(options.title ?? `tail: ${relative(ctx.cwd, absolutePath) || basename(absolutePath)}`, picked.join('\n'));
  };
}

export function state(options: ProviderOptions = {}): ContextProvider {
  return (ctx) => toSection(
    options.title ?? 'state',
    JSON.stringify({
      iteration: ctx.state.iteration,
      attempts: ctx.state.attempts,
      checkpointRef: ctx.state.checkpointRef,
      bestMetrics: ctx.state.bestMetrics,
      cwd: ctx.state.cwd,
      recipePath: ctx.state.recipePath,
      resolvedQuestions: ctx.resolvedQuestions,
      lastHandoffPath: ctx.state.lastHandoffPath,
    }, null, 2)
  );
}

export function previousObservation(options: ProviderOptions = {}): ContextProvider {
  return (ctx) => {
    if (!ctx.previousObservation) {
      return null;
    }
    return toSection(options.title ?? 'previous observation', JSON.stringify(ctx.previousObservation, null, 2));
  };
}

export function previousHandoff(options: ProviderOptions = {}): ContextProvider {
  return (ctx) => {
    const handoff = readLatestHandoff(ctx.melosDir);
    if (!handoff) {
      return null;
    }
    return toSection(options.title ?? 'previous handoff', JSON.stringify(handoff, null, 2));
  };
}

export function handoffHistory(
  options: ProviderOptions & { count?: number } = {}
): ContextProvider {
  return (ctx) => {
    const history = readHandoffHistory(ctx.melosDir, { count: options.count });
    if (history.length === 0) {
      return null;
    }
    return toSection(options.title ?? 'handoff history', JSON.stringify(history, null, 2));
  };
}

export function fileStat(targetPath: string, options: ProviderOptions = {}): ContextProvider {
  return (ctx) => {
    const absolutePath = resolveProviderPath(ctx, targetPath);
    const stats = statSync(absolutePath);
    return toSection(options.title ?? `stat: ${relative(ctx.cwd, absolutePath) || basename(absolutePath)}`, JSON.stringify({
      path: absolutePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    }, null, 2));
  };
}
