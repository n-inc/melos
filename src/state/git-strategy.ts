import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface GitStrategyConfig {
  missionId: string;
  baseBranch: string;
  autoPush: boolean;
  preMergeValidation: boolean;
  validationCommands: string[];
  pullRequestEnabled: boolean;
}

export interface PullRequestState {
  number?: number;
  url: string;
  title?: string;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
  action: 'created' | 'updated';
  updatedAt: string;
}

export interface PullRequestFollowUpState {
  handledFeedbackIds: string[];
  lastExternalActivityAt: string | null;
  quietUntil: string | null;
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
  missionBranch: string | null;
  pullRequest: PullRequestState | null;
  handledFeedbackIds: string[];
  lastExternalActivityAt: string | null;
  quietUntil: string | null;
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
  return normalizeGitStrategyState(JSON.parse(raw) as Partial<GitStrategyState>);
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
    missionBranch: null,
    pullRequest: null,
    handledFeedbackIds: [],
    lastExternalActivityAt: null,
    quietUntil: null,
  };
}

export function createMissionBranchName(missionId: string): string {
  const safeMissionId = typeof missionId === 'string' && missionId.trim().length > 0
    ? missionId.trim()
    : 'mission';
  return `melos/${safeMissionId}/mission`;
}

export function createFeatureBranchName(
  missionId: string,
  featureId: string,
  featureDescription: string
): string {
  const safeMissionId = typeof missionId === 'string' && missionId.trim().length > 0
    ? missionId.trim()
    : 'mission';
  const safeFeatureId = typeof featureId === 'string' && featureId.trim().length > 0
    ? featureId.trim()
    : 'feature';
  const safeDescription = typeof featureDescription === 'string' && featureDescription.trim().length > 0
    ? featureDescription.trim()
    : 'no-description';

  const slug = `${safeFeatureId}-${safeDescription}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `melos/${safeMissionId}/${slug || safeFeatureId}`;
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

export function setMissionBranch(
  state: GitStrategyState,
  branchName: string
): GitStrategyState {
  return {
    ...state,
    missionBranch: branchName,
    activeBranch: branchName,
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
    activeBranch: status === 'merged' || status === 'abandoned'
      ? state.missionBranch
      : state.activeBranch,
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

export function updatePullRequestState(
  state: GitStrategyState,
  pullRequest: Omit<PullRequestState, 'updatedAt'> & { updatedAt?: string }
): GitStrategyState {
  return {
    ...state,
    pullRequest: {
      ...pullRequest,
      updatedAt: pullRequest.updatedAt ?? new Date().toISOString(),
    },
  };
}

export function updatePullRequestFollowUpState(
  state: GitStrategyState,
  followUp: Partial<PullRequestFollowUpState>
): GitStrategyState {
  const handledFeedbackIds = Array.isArray(followUp.handledFeedbackIds)
    ? Array.from(new Set([
      ...state.handledFeedbackIds,
      ...followUp.handledFeedbackIds.filter((value) => typeof value === 'string' && value.trim().length > 0),
    ]))
    : state.handledFeedbackIds;

  return {
    ...state,
    handledFeedbackIds,
    lastExternalActivityAt: followUp.lastExternalActivityAt ?? state.lastExternalActivityAt,
    quietUntil: followUp.quietUntil ?? state.quietUntil,
  };
}

function normalizeGitStrategyState(value: Partial<GitStrategyState>): GitStrategyState {
  const config = value.config ?? {
    missionId: 'mission',
    baseBranch: 'main',
    autoPush: false,
    preMergeValidation: true,
    validationCommands: ['npm run typecheck', 'npm test'],
    pullRequestEnabled: false,
  };

  return {
    config: {
      ...config,
      pullRequestEnabled: config.pullRequestEnabled === true,
    },
    branches: Array.isArray(value.branches) ? value.branches : [],
    activeBranch: typeof value.activeBranch === 'string' ? value.activeBranch : null,
    missionBranch: typeof value.missionBranch === 'string' ? value.missionBranch : null,
    pullRequest: value.pullRequest && typeof value.pullRequest.url === 'string'
      ? {
        ...value.pullRequest,
        updatedAt: typeof value.pullRequest.updatedAt === 'string'
          ? value.pullRequest.updatedAt
          : new Date().toISOString(),
      }
      : null,
    handledFeedbackIds: Array.isArray(value.handledFeedbackIds)
      ? value.handledFeedbackIds.filter((item): item is string => typeof item === 'string')
      : [],
    lastExternalActivityAt: typeof value.lastExternalActivityAt === 'string'
      ? value.lastExternalActivityAt
      : null,
    quietUntil: typeof value.quietUntil === 'string'
      ? value.quietUntil
      : null,
  };
}
