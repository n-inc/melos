import { buildRouteCommandOptions, buildRunCommandOptions, createProgram } from '../../cli.js';

describe('cli run command', () => {
  it('registers route/prompt execution options', () => {
    const program = createProgram();
    const runCommand = program.commands.find((command) => command.name() === 'run');
    const routeCommand = program.commands.find((command) => command.name() === 'route');
    expect(runCommand).toBeDefined();
    expect(routeCommand).toBeDefined();

    const options = new Set(runCommand?.options.map((option) => option.long));
    expect(options.has('--route')).toBe(true);
    expect(options.has('--prompt')).toBe(true);
    expect(options.has('--output-format')).toBe(true);
    expect(options.has('--start-phase')).toBe(true);
    expect(options.has('--criteria')).toBe(false);
    expect(options.has('--no-ask')).toBe(true);
    expect(options.has('--always-ask')).toBe(true);
    expect(options.has('--keep-handoff')).toBe(false);
    expect(options.has('--steering')).toBe(false);

    const routeOptions = new Set(routeCommand?.options.map((option) => option.long));
    expect(routeOptions.has('--route')).toBe(false);
    expect(routeOptions.has('--prompt')).toBe(false);
    expect(routeOptions.has('--output-format')).toBe(true);
    expect(routeOptions.has('--start-phase')).toBe(true);
    expect(routeOptions.has('--no-ask')).toBe(true);
    expect(routeOptions.has('--always-ask')).toBe(true);
  });

  it('limits output format choices', () => {
    const program = createProgram();
    const runCommand = program.commands.find((command) => command.name() === 'run');
    const outputFormatOption = runCommand?.options.find((option) => option.long === '--output-format');
    expect(outputFormatOption?.argChoices).toEqual(['text', 'json', 'stream-json']);
  });

  it('maps --no-ask to run noAsk', () => {
    expect(buildRunCommandOptions({
      prompt: 'hello',
      model: 'codex-latest',
      outputFormat: 'text',
      ask: false,
    })).toEqual(expect.objectContaining({
      prompt: 'hello',
      noAsk: true,
    }));
  });

  it('maps --route to run route', () => {
    expect(buildRunCommandOptions({
      route: '/tmp/sample.ts',
      model: 'codex-latest',
      outputFormat: 'text',
    })).toEqual(expect.objectContaining({
      route: '/tmp/sample.ts',
    }));
  });

  it('maps melos route positional path to run route', () => {
    expect(buildRouteCommandOptions('/tmp/sample.ts', {
      model: 'codex-latest',
      outputFormat: 'text',
      startPhase: 'export',
    })).toEqual(expect.objectContaining({
      route: '/tmp/sample.ts',
      startPhase: 'export',
    }));
  });

  it('does not set a commander default for --model', () => {
    const program = createProgram();
    const runCommand = program.commands.find((command) => command.name() === 'run');
    const modelOption = runCommand?.options.find((option) => option.long === '--model');

    expect(modelOption?.defaultValue).toBeUndefined();
  });

  it('keeps model undefined when the CLI did not provide one', () => {
    expect(buildRunCommandOptions({
      route: '/tmp/sample.ts',
      outputFormat: 'text',
    })).toEqual(expect.objectContaining({
      route: '/tmp/sample.ts',
      model: undefined,
    }));
  });
});
