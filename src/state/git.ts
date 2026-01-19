import { spawnSync, execSync } from 'node:child_process';
import type { GitState } from './status.js';

/**
 * 現在のブランチ名を取得
 */
export function getCurrentBranch(cwd: string): string {
  const result = spawnSync('git', ['branch', '--show-current'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0 || !result.stdout) {
    return '';
  }

  return result.stdout.trim();
}

/**
 * 最後のコミットハッシュを取得
 */
export function getLastCommitHash(cwd: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0 || !result.stdout) {
    return '';
  }

  return result.stdout.trim().slice(0, 7);
}

/**
 * リモートにプッシュ済みか確認
 */
export function isPushedToRemote(cwd: string, branch: string): boolean {
  if (!branch) {
    return false;
  }

  // リモート追跡ブランチが存在するか確認
  const result = spawnSync(
    'git',
    ['rev-parse', '--verify', `origin/${branch}`],
    {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  if (result.status !== 0) {
    return false;
  }

  // ローカルとリモートが同じコミットを指しているか確認
  const localResult = spawnSync('git', ['rev-parse', branch], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const remoteResult = spawnSync('git', ['rev-parse', `origin/${branch}`], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (localResult.status !== 0 || remoteResult.status !== 0) {
    return false;
  }

  return localResult.stdout.trim() === remoteResult.stdout.trim();
}

/**
 * PR情報を取得
 */
export function getPullRequest(
  cwd: string
): { number: number; url: string } | null {
  try {
    const output = execSync('gh pr view --json number,url', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const data = JSON.parse(output);
    if (data.number && data.url) {
      return {
        number: data.number,
        url: data.url,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Git状態を取得
 */
export function fetchGitState(cwd: string): GitState {
  const branch = getCurrentBranch(cwd);
  const lastCommitHash = getLastCommitHash(cwd);
  const isPushed = isPushedToRemote(cwd, branch);
  const pullRequest = getPullRequest(cwd);

  return {
    branch,
    isPushed,
    pullRequest,
    lastCommitHash,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * git push を実行
 */
export function gitPush(cwd: string): boolean {
  // まず通常の push を試みる
  const pushResult = spawnSync('git', ['push'], {
    cwd,
    stdio: ['inherit', 'inherit', 'inherit'],
  });

  if (pushResult.status === 0) {
    return true;
  }

  // リモートブランチがない場合は -u origin でプッシュ
  const branch = getCurrentBranch(cwd);
  if (!branch) {
    return false;
  }

  const pushWithUpstreamResult = spawnSync(
    'git',
    ['push', '-u', 'origin', branch],
    {
      cwd,
      stdio: ['inherit', 'inherit', 'inherit'],
    }
  );

  return pushWithUpstreamResult.status === 0;
}

/**
 * CIの完了を待機
 */
export async function waitForCI(cwd: string): Promise<boolean> {
  // PR が存在しない場合はスキップ
  if (!getPullRequest(cwd)) {
    return true;
  }

  try {
    // gh pr checks --watch を使用
    execSync('gh pr checks --watch --fail-fast', {
      cwd,
      stdio: ['inherit', 'inherit', 'inherit'],
      timeout: 600000, // 10分
    });
    return true;
  } catch {
    return false;
  }
}
