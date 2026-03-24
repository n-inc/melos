import { buildExecCommandOptions, createProgram } from '../../cli.js';

describe('cli exec command', () => {
  it('registers recipe/prompt execution options', () => {
    const program = createProgram();
    const execCommand = program.commands.find((command) => command.name() === 'exec');
    expect(execCommand).toBeDefined();

    const options = new Set(execCommand?.options.map((option) => option.long));
    expect(options.has('--recipe')).toBe(true);
    expect(options.has('--prompt')).toBe(true);
    expect(options.has('--output-format')).toBe(true);
    expect(options.has('--criteria')).toBe(false);
    expect(options.has('--no-ask')).toBe(true);
    expect(options.has('--always-ask')).toBe(true);
    expect(options.has('--keep-handoff')).toBe(false);
    expect(options.has('--steering')).toBe(false);
  });

  it('limits output format choices', () => {
    const program = createProgram();
    const execCommand = program.commands.find((command) => command.name() === 'exec');
    const outputFormatOption = execCommand?.options.find((option) => option.long === '--output-format');
    expect(outputFormatOption?.argChoices).toEqual(['text', 'json', 'stream-json']);
  });

  it('maps --no-ask to exec noAsk', () => {
    expect(buildExecCommandOptions({
      prompt: 'hello',
      model: 'codex-latest',
      outputFormat: 'text',
      ask: false,
    })).toEqual(expect.objectContaining({
      prompt: 'hello',
      noAsk: true,
    }));
  });
});
