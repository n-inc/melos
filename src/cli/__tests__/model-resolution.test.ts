import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProgram, resolveGitStrategy } from '../../cli.js';

describe('CLI v0.8 options', () => {
  it('registers run/resume/kill/cancel/status/logs/approve/reject commands', () => {
    const program = createProgram();
    const commandNames = new Set(program.commands.map((command) => command.name()));

    expect(commandNames.has('run')).toBe(true);
    expect(commandNames.has('resume')).toBe(true);
    expect(commandNames.has('kill')).toBe(true);
    expect(commandNames.has('cancel')).toBe(true);
    expect(commandNames.has('status')).toBe(true);
    expect(commandNames.has('logs')).toBe(true);
    expect(commandNames.has('approve')).toBe(true);
    expect(commandNames.has('reject')).toBe(true);
  });

  it('registers mission options on run command', () => {
    const program = createProgram();
    const runCommand = program.commands.find((command) => command.name() === 'run');
    expect(runCommand).toBeDefined();

    const options = new Set(runCommand?.options.map((option) => option.long));
    expect(options.has('--interactive')).toBe(true);
    expect(options.has('--auto-approve')).toBe(true);
    expect(options.has('--headless')).toBe(true);
    expect(options.has('--detach')).toBe(true);
    expect(options.has('--git-strategy')).toBe(true);
    expect(options.has('--create-pr')).toBe(true);
    expect(options.has('--base-branch')).toBe(true);
    expect(options.has('--mission-id')).toBe(true);
    expect(options.has('--planner-model')).toBe(true);
    expect(options.has('--worker-model')).toBe(true);
  });

  it('enables git strategy automatically when pull request automation is requested', () => {
    const gitStrategy = resolveGitStrategy(
      {
        createPr: true,
        missionId: 'persona-lp',
      },
      {
        git: {
          baseBranch: 'develop',
        },
      }
    );

    expect(gitStrategy).toMatchObject({
      enabled: true,
      missionId: 'persona-lp',
      baseBranch: 'develop',
      pullRequestEnabled: true,
    });
  });

  it('prefers CLI create-pr over config when resolving git strategy', () => {
    const gitStrategy = resolveGitStrategy(
      {
        createPr: true,
        gitStrategy: true,
        missionId: 'persona-lp',
      },
      {
        git: {
          enabled: false,
          pullRequest: {
            enabled: false,
          },
        },
      }
    );

    expect(gitStrategy?.pullRequestEnabled).toBe(true);
  });

  it('auto-enables git strategy in git repositories and infers the current branch as baseBranch', () => {
    const cwd = createGitRepository();
    const previousCwd = process.cwd();

    try {
      process.chdir(cwd);
      const gitStrategy = resolveGitStrategy({}, {});
      expect(gitStrategy).toMatchObject({
        enabled: true,
        baseBranch: execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim(),
      });
      expect(gitStrategy?.pullRequestEnabled).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('keeps git strategy disabled outside git repositories by default', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-cli-no-git-'));
    const previousCwd = process.cwd();

    try {
      process.chdir(cwd);
      expect(resolveGitStrategy({}, {})).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('respects explicit git.enabled=false as an opt-out', () => {
    const cwd = createGitRepository();
    const previousCwd = process.cwd();

    try {
      process.chdir(cwd);
      expect(resolveGitStrategy({}, { git: { enabled: false } })).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
    }
  });
});

function createGitRepository(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'melos-cli-git-'));
  execSync('git init', { cwd, stdio: 'ignore' });
  execSync('git config user.email "melos-test@example.com"', { cwd, stdio: 'ignore' });
  execSync('git config user.name "Melos Test"', { cwd, stdio: 'ignore' });
  writeFileSync(join(cwd, '.gitkeep'), 'seed\n', 'utf-8');
  execSync('git add -A', { cwd, stdio: 'ignore' });
  execSync('git commit -m "test: initial"', { cwd, stdio: 'ignore' });
  return cwd;
}
