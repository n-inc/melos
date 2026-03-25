import { execFileSync } from 'node:child_process';

import type { CommitConfig, Decision, Observation, RecipeContextBase } from './recipe.js';

export interface CommitContext extends RecipeContextBase {
  decision: Decision;
  observation: Observation;
  assistantText: string;
  changedFiles: string[];
}

export interface CommitResult {
  ref: string;
  message: string;
  changedFiles: string[];
}

export interface CommitWorkspaceStatus {
  changedFiles: string[];
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function resolveGitRoot(cwd: string): string {
  return runGit(cwd, ['rev-parse', '--show-toplevel']);
}

function isCommittablePath(path: string): boolean {
  return path.length > 0 && path !== '.melos' && !path.startsWith('.melos/');
}

function listChangedFiles(cwd: string): string[] {
  const gitRoot = resolveGitRoot(cwd);
  const tracked = runGit(gitRoot, ['diff', '--name-only', '--'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const staged = runGit(gitRoot, ['diff', '--cached', '--name-only', '--'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const untracked = runGit(gitRoot, ['ls-files', '--others', '--exclude-standard'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return Array.from(new Set([...tracked, ...staged, ...untracked]))
    .filter((path) => isCommittablePath(path));
}

export function isCommitEnabled(config: CommitConfig | undefined): boolean {
  return (config?.when ?? 'never') !== 'never';
}

export function readCommitWorkspaceStatus(cwd: string): CommitWorkspaceStatus {
  return {
    changedFiles: listChangedFiles(cwd),
  };
}

export function assertCommitWorkspaceClean(cwd: string): void {
  const { changedFiles } = readCommitWorkspaceStatus(cwd);
  if (changedFiles.length === 0) {
    return;
  }

  const preview = changedFiles.slice(0, 5).join(', ');
  const suffix = changedFiles.length > 5 ? ` (+${changedFiles.length - 5} more)` : '';
  throw new Error(
    `auto-commit requires a clean git worktree before the run starts; existing changes: ${preview}${suffix}`
  );
}

function sanitizeSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 72) {
    return normalized;
  }
  return `${normalized.slice(0, 69).trimEnd()}...`;
}

async function resolveCommitMessage(config: CommitConfig, ctx: CommitContext): Promise<string> {
  if (typeof config.message === 'function') {
    const resolved = await config.message(ctx);
    if (resolved.trim().length > 0) {
      return resolved.trim();
    }
  }
  if (typeof config.message === 'string' && config.message.trim().length > 0) {
    return config.message.trim();
  }

  const action = ctx.decision.kind === 'stop' ? 'finalize' : 'keep';
  return `melos: ${action} iteration ${ctx.state.iteration} (${sanitizeSummary(ctx.observation.summary)})`;
}

export function shouldCommitDecision(config: CommitConfig | undefined, decision: Decision): boolean {
  const when = config?.when ?? 'never';
  if (when === 'never') {
    return false;
  }
  if (when === 'stop') {
    return decision.kind === 'stop';
  }
  return decision.kind === 'continue' || decision.kind === 'stop';
}

export async function applyConfiguredCommit(input: {
  config: CommitConfig;
  baseContext: RecipeContextBase;
  decision: Decision;
  observation: Observation;
  assistantText: string;
}): Promise<CommitResult | null> {
  if (!shouldCommitDecision(input.config, input.decision)) {
    return null;
  }
  const changedFiles = listChangedFiles(input.baseContext.cwd);
  if (changedFiles.length === 0) {
    return null;
  }
  const message = await resolveCommitMessage(input.config, {
    ...input.baseContext,
    decision: input.decision,
    observation: input.observation,
    assistantText: input.assistantText,
    changedFiles,
  });
  const gitRoot = resolveGitRoot(input.baseContext.cwd);

  runGit(gitRoot, ['add', '-A', '--', '.']);
  runGit(gitRoot, ['rm', '-r', '--cached', '--ignore-unmatch', '--', '.melos']);
  runGit(gitRoot, ['commit', '--no-verify', '-m', message]);
  const ref = runGit(gitRoot, ['rev-parse', 'HEAD']);

  return {
    ref,
    message,
    changedFiles,
  };
}
