import { spawnSync, execSync } from 'node:child_process';

interface GitState {
  branch: string;
  isPushed: boolean;
  pullRequest: { number: number; url: string } | null;
  lastCommitHash: string;
  fetchedAt: string;
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string; code: number } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    code: result.status ?? 1,
  };
}

function assertGit(cwd: string, args: string[], errorPrefix: string): string {
  const result = runGit(cwd, args);
  if (!result.ok) {
    throw new Error(`${errorPrefix}: git ${args.join(' ')}\n${result.stderr}`);
  }
  return result.stdout;
}

export function getCurrentBranch(cwd: string): string {
  return runGit(cwd, ['branch', '--show-current']).stdout;
}

export function isGitRepository(cwd: string): boolean {
  const result = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return result.ok && result.stdout === 'true';
}

export function getLastCommitHash(cwd: string): string {
  return runGit(cwd, ['rev-parse', '--short', 'HEAD']).stdout;
}

export function getHeadCommitHash(cwd: string): string {
  return assertGit(cwd, ['rev-parse', 'HEAD'], 'failed to get HEAD commit hash');
}

export function isWorkingTreeClean(cwd: string): boolean {
  const status = runGit(cwd, ['status', '--porcelain']);
  return status.ok && status.stdout.length === 0;
}

export function getDirtyWorkingTreePaths(cwd: string, limit: number = Number.POSITIVE_INFINITY): string[] {
  const status = runGit(cwd, ['status', '--porcelain']);
  if (!status.ok || status.stdout.length === 0) {
    return [];
  }

  const paths: string[] = [];
  for (const line of status.stdout.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }

    const rawPath = line.replace(/^[A-Z? !]{1,2}\s+/, '').trim();
    if (!rawPath) {
      continue;
    }

    const normalizedPath = rawPath.includes(' -> ')
      ? rawPath.split(' -> ').pop()?.trim() ?? rawPath
      : rawPath;
    paths.push(normalizedPath);
    if (paths.length >= limit) {
      break;
    }
  }

  return paths;
}

export function createBranch(cwd: string, branchName: string, baseBranch: string): void {
  assertGit(cwd, ['checkout', baseBranch], `failed to checkout base branch ${baseBranch}`);
  assertGit(cwd, ['checkout', '-B', branchName], `failed to create branch ${branchName}`);
}

export function checkoutBranch(cwd: string, branchName: string): void {
  assertGit(cwd, ['checkout', branchName], `failed to checkout branch ${branchName}`);
}

export function hasConflicts(cwd: string, branchName: string, baseBranch: string): boolean {
  assertGit(cwd, ['checkout', baseBranch], `failed to checkout base branch ${baseBranch}`);
  const result = runGit(cwd, ['merge', '--no-commit', '--no-ff', branchName]);
  const hasConflict = /CONFLICT/i.test(result.stdout) || /CONFLICT/i.test(result.stderr);
  runGit(cwd, ['merge', '--abort']);
  return hasConflict;
}

export function mergeBranch(cwd: string, branchName: string, baseBranch: string): void {
  assertGit(cwd, ['checkout', baseBranch], `failed to checkout base branch ${baseBranch}`);
  assertGit(cwd, ['merge', '--ff-only', branchName], `failed to merge ${branchName} to ${baseBranch}`);
}

export function commitAll(cwd: string, message: string): string {
  assertGit(cwd, ['add', '-A'], 'failed to stage changes');
  const result = runGit(cwd, ['commit', '-m', message]);
  if (!result.ok) {
    const noChanges = /nothing to commit|no changes added/i.test(result.stdout + result.stderr);
    if (noChanges) {
      return getHeadCommitHash(cwd);
    }
    throw new Error(`failed to commit changes: ${result.stderr || result.stdout}`);
  }
  return getHeadCommitHash(cwd);
}

export function runGitCommand(
  cwd: string,
  command: string
): { exitCode: number; stdout: string; stderr: string; durationMs: number } {
  const startedAt = Date.now();
  const result = spawnSync('bash', ['-lc', command], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    durationMs: Date.now() - startedAt,
  };
}

export function isPushedToRemote(cwd: string, branch: string): boolean {
  if (!branch) {
    return false;
  }

  const verify = runGit(cwd, ['rev-parse', '--verify', `origin/${branch}`]);
  if (!verify.ok) {
    return false;
  }

  const local = runGit(cwd, ['rev-parse', branch]);
  const remote = runGit(cwd, ['rev-parse', `origin/${branch}`]);
  if (!local.ok || !remote.ok) {
    return false;
  }

  return local.stdout === remote.stdout;
}

export function getPullRequest(
  cwd: string
): { number: number; url: string } | null {
  try {
    const output = execSync('gh pr view --json number,url', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const data = JSON.parse(output) as { number?: number; url?: string };
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

export function getCIStatus(cwd: string): 'passing' | 'failing' | 'pending' | 'unknown' {
  if (!getPullRequest(cwd)) {
    return 'unknown';
  }

  try {
    const output = execSync('gh pr checks --json bucket', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const checks = JSON.parse(output) as Array<{ bucket: string }>;

    if (checks.length === 0) {
      return 'unknown';
    }

    const hasFail = checks.some((check) => check.bucket === 'fail' || check.bucket === 'cancel');
    const hasPending = checks.some((check) => check.bucket === 'pending');
    const allPass = checks.every((check) => check.bucket === 'pass' || check.bucket === 'skipping');

    if (hasFail) return 'failing';
    if (hasPending) return 'pending';
    if (allPass) return 'passing';

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

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

export function gitPush(cwd: string): boolean {
  const push = spawnSync('git', ['push'], {
    cwd,
    stdio: ['inherit', 'inherit', 'inherit'],
  });

  if (push.status === 0) {
    return true;
  }

  const branch = getCurrentBranch(cwd);
  if (!branch) {
    return false;
  }

  const pushWithUpstream = spawnSync('git', ['push', '-u', 'origin', branch], {
    cwd,
    stdio: ['inherit', 'inherit', 'inherit'],
  });

  return pushWithUpstream.status === 0;
}

export async function waitForCI(cwd: string): Promise<boolean> {
  if (!getPullRequest(cwd)) {
    return true;
  }

  try {
    execSync('gh pr checks --watch --fail-fast', {
      cwd,
      stdio: ['inherit', 'inherit', 'inherit'],
      timeout: 10 * 60 * 1000,
    });
    return true;
  } catch {
    return false;
  }
}
