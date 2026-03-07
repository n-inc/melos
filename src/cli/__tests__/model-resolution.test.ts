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

  it('keeps pull request automation disabled by default', () => {
    expect(resolveGitStrategy({}, {})).toBeUndefined();
  });
});
