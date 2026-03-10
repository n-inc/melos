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

export interface GitStrategyState {
  config: GitStrategyConfig;
  activeBranch: string | null;
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
    activeBranch: null,
    pullRequest: null,
    handledFeedbackIds: [],
    lastExternalActivityAt: null,
    quietUntil: null,
  };
}

export function setActiveBranch(
  state: GitStrategyState,
  branchName: string
): GitStrategyState {
  return {
    ...state,
    activeBranch: branchName,
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
    validationCommands: [],
    pullRequestEnabled: false,
  };

  return {
    config: {
      ...config,
      pullRequestEnabled: config.pullRequestEnabled === true,
    },
    activeBranch: typeof value.activeBranch === 'string' ? value.activeBranch : null,
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
