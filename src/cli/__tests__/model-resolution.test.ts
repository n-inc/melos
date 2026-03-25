import { createProgram } from '../../cli.js';

describe('cli command registry', () => {
  it('keeps only run as the public execution command', () => {
    const program = createProgram();
    const commandNames = new Set(program.commands.map((command) => command.name()));

    expect(commandNames.has('run')).toBe(true);
    expect(commandNames.has('exec')).toBe(false);
    expect(commandNames.has('resume')).toBe(false);
    expect(commandNames.has('status')).toBe(false);
    expect(commandNames.has('logs')).toBe(false);
    expect(commandNames.has('approve')).toBe(false);
    expect(commandNames.has('reject')).toBe(false);
    expect(commandNames.has('cancel')).toBe(false);
    expect(commandNames.has('kill')).toBe(false);
  });
});
