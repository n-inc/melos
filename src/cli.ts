import { Command, Option } from 'commander';

import type { RunCommandOptions } from './run/index.js';

export interface RunCommandActionOptions {
  route?: string;
  prompt?: string;
  model?: string;
  cwd?: string;
  outputFormat?: 'text' | 'json' | 'stream-json';
  startPhase?: string;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  fast?: boolean;
  ask?: boolean;
  alwaysAsk?: boolean;
}

type SharedRunCommandActionOptions = Omit<RunCommandActionOptions, 'route' | 'prompt'>;

export function createProgram(): Command {
  const program = new Command();

  program
    .name('melos')
    .description('Melos route runner')
    .version('0.12.1', '-v, --version', 'バージョンを表示')
    .helpOption('-h, --help', 'ヘルプを表示');

  program
    .command('run')
    .description('route または prompt を実行する')
    .option('--route <path>', '実行する route module (.ts または -)')
    .option('--prompt <text>', '1回だけ実行する prompt')
    .option('--model <model>', 'モデル')
    .option('--cwd <dir>', '作業ディレクトリ')
    .addOption(new Option('--output-format <format>', '出力形式').choices(['text', 'json', 'stream-json']).default('text'))
    .option('--start-phase <phase>', 'route を指定した phase から再開する')
    .option('--effort <level>', '推論 effort (simple prompt mode 用)')
    .option('--fast', 'Codex を fast tier で実行する（デフォルト: flex）')
    .option('--no-ask', 'ユーザーには質問せず agent 解決のみを試みる')
    .option('--always-ask', 'agent 解決をスキップして必ずユーザーに質問する')
    .action(async (options: RunCommandActionOptions) => {
      await handleCommandAction(async () => {
        const { run } = await import('./run/index.js');
        const summary = await run(buildRunCommandOptions(options));
        if (!summary.success) process.exit(1);
      });
    });

  program
    .command('route <path>')
    .description('route module を実行する')
    .option('--model <model>', 'モデル')
    .option('--cwd <dir>', '作業ディレクトリ')
    .addOption(new Option('--output-format <format>', '出力形式').choices(['text', 'json', 'stream-json']).default('text'))
    .option('--start-phase <phase>', 'route を指定した phase から再開する')
    .option('--effort <level>', '推論 effort')
    .option('--fast', 'Codex を fast tier で実行する（デフォルト: flex）')
    .option('--no-ask', 'ユーザーには質問せず agent 解決のみを試みる')
    .option('--always-ask', 'agent 解決をスキップして必ずユーザーに質問する')
    .action(async (path: string, options: SharedRunCommandActionOptions) => {
      await handleCommandAction(async () => {
        const { run } = await import('./run/index.js');
        const summary = await run(buildRouteCommandOptions(path, options));
        if (!summary.success) process.exit(1);
      });
    });

  return program;
}

export function buildRunCommandOptions(options: RunCommandActionOptions): RunCommandOptions {
  return {
    route: options.route,
    prompt: options.prompt,
    model: options.model,
    cwd: options.cwd ?? process.cwd(),
    effort: options.effort,
    fast: options.fast,
    outputFormat: options.outputFormat,
    startPhase: options.startPhase,
    noAsk: options.ask === false,
    alwaysAsk: options.alwaysAsk,
  };
}

export function buildRouteCommandOptions(path: string, options: SharedRunCommandActionOptions): RunCommandOptions {
  return buildRunCommandOptions({
    ...options,
    route: path,
  });
}

export async function run(argv?: string[]): Promise<void> {
  const program = createProgram();
  const input = argv ?? process.argv;

  if (input.length <= 2) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(input);
}

async function handleCommandAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
