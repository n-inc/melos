import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface GitStrategyConfig {
  missionId: string;
  baseBranch: string;
  autoPush: boolean;
  preMergeValidation: boolean;
  validationCommands: string[];
}

export interface FeatureBranch {
  name: string;
  taskIds: string[];
  baseBranch: string;
  baseCommitHash: string;
  status: 'pending' | 'active' | 'ready' | 'validated' | 'merged' | 'abandoned';
  commits: string[];
  lastCheckpoint: string | null;
  createdAt: string;
  mergedAt: string | null;
}

export interface GitStrategyState {
  config: GitStrategyConfig;
  branches: FeatureBranch[];
  activeBranch: string | null;
}

export function getGitStrategyPath(melosDir: string): string {
  return join(melosDir, 'git-strategy.json');
}

export function gitStrategyExists(melosDir: string): boolean {
  return existsSync(getGitStrategyPath(melosDir));
}

export async function loadGitStrategyState(melosDir: string): Promise<GitStrategyState | null> {
  const path = getGitStrategyPath(melosDir);
  if (!existsSync(path)) {
    return null;
  }
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as GitStrategyState;
}

export async function saveGitStrategyState(melosDir: string, state: GitStrategyState): Promise<void> {
  const path = getGitStrategyPath(melosDir);
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

export function createGitStrategyState(config: GitStrategyConfig): GitStrategyState {
  return {
    config,
    branches: [],
    activeBranch: null,
  };
}

export function createFeatureBranchName(
  missionId: string,
  featureId: string,
  featureDescription: string
): string {
  const slug = `${featureId}-${featureDescription}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `melos/${missionId}/${slug}`;
}

export function registerFeatureBranch(
  state: GitStrategyState,
  params: {
    name: string;
    taskId: string;
    baseCommitHash: string;
    checkpoint?: string | null;
  }
): GitStrategyState {
  const now = new Date().toISOString();
  const existing = state.branches.find((branch) => branch.name === params.name);
  if (existing) {
    if (!existing.taskIds.includes(params.taskId)) {
      existing.taskIds.push(params.taskId);
    }
    existing.status = 'active';
    state.activeBranch = existing.name;
    return {
      ...state,
      branches: [...state.branches],
    };
  }

  return {
    ...state,
    activeBranch: params.name,
    branches: [
      ...state.branches,
      {
        name: params.name,
        taskIds: [params.taskId],
        baseBranch: state.config.baseBranch,
        baseCommitHash: params.baseCommitHash,
        status: 'active',
        commits: [],
        lastCheckpoint: params.checkpoint ?? null,
        createdAt: now,
        mergedAt: null,
      },
    ],
  };
}

export function updateFeatureBranchStatus(
  state: GitStrategyState,
  branchName: string,
  status: FeatureBranch['status'],
  options: { commitHash?: string; checkpoint?: string | null; mergedAt?: string | null } = {}
): GitStrategyState {
  return {
    ...state,
    activeBranch: status === 'merged' || status === 'abandoned' ? null : state.activeBranch,
    branches: state.branches.map((branch) => {
      if (branch.name !== branchName) {
        return branch;
      }
      const commits = options.commitHash
        ? [...branch.commits, options.commitHash]
        : branch.commits;
      return {
        ...branch,
        status,
        commits,
        lastCheckpoint: options.checkpoint ?? branch.lastCheckpoint,
        mergedAt: options.mergedAt ?? (status === 'merged' ? new Date().toISOString() : branch.mergedAt),
      };
    }),
  };
}
