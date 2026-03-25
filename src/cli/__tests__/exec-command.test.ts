import { buildExecCommandOptions, createProgram } from '../../cli.js';
import { CODEX_LATEST_ALIAS } from '../../models/registry.js';

describe('cli exec command', () => {
  it('registers route/prompt execution options', () => {
    const program = createProgram();
    const execCommand = program.commands.find((command) => command.name() === 'exec');
    expect(execCommand).toBeDefined();

    const options = new Set(execCommand?.options.map((option) => option.long));
    expect(options.has('--route')).toBe(true);
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

  it('maps --route to exec route', () => {
    expect(buildExecCommandOptions({
      route: '/tmp/sample.ts',
      model: 'codex-latest',
      outputFormat: 'text',
    })).toEqual(expect.objectContaining({
      route: '/tmp/sample.ts',
    }));
  });

  it('defaults exec --model to codex-latest', () => {
    const program = createProgram();
    const execCommand = program.commands.find((command) => command.name() === 'exec');
    const modelOption = execCommand?.options.find((option) => option.long === '--model');

    expect(modelOption?.defaultValue).toBe(CODEX_LATEST_ALIAS);
  });
});
