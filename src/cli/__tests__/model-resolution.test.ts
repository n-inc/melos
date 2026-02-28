import { createProgram } from '../../cli.js';

describe('CLI v0.8 options', () => {
  it('registers run/resume/kill commands', () => {
    const program = createProgram();
    const commandNames = new Set(program.commands.map((command) => command.name()));

    expect(commandNames.has('run')).toBe(true);
    expect(commandNames.has('resume')).toBe(true);
    expect(commandNames.has('kill')).toBe(true);
  });

  it('registers mission options on run command', () => {
    const program = createProgram();
    const runCommand = program.commands.find((command) => command.name() === 'run');
    expect(runCommand).toBeDefined();

    const options = new Set(runCommand?.options.map((option) => option.long));
    expect(options.has('--interactive')).toBe(true);
    expect(options.has('--auto-approve')).toBe(true);
    expect(options.has('--git-strategy')).toBe(true);
    expect(options.has('--base-branch')).toBe(true);
    expect(options.has('--mission-id')).toBe(true);
    expect(options.has('--planner-model')).toBe(true);
    expect(options.has('--worker-model')).toBe(true);
  });
});
