import { Command, Option } from 'commander';

import type { RunCommandOptions } from './run/index.js';
import { CODEX_LATEST_ALIAS } from './models/registry.js';

export interface RunCommandActionOptions {
  route?: string;
  prompt?: string;
  model?: string;
  cwd?: string;
  outputFormat?: 'text' | 'json' | 'stream-json';
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  ask?: boolean;
  alwaysAsk?: boolean;
}

type SharedRunCommandActionOptions = Omit<RunCommandActionOptions, 'route' | 'prompt'>;

export function createProgram(): Command {
  const program = new Command();

  program
    .name('melos')
    .description('Melos route runner')
    .version('0.11.0', '-v, --version', 'バージョンを表示')
    .helpOption('-h, --help', 'ヘルプを表示');

  program
    .command('run')
    .description('route または prompt を実行する')
    .option('--route <path>', '実行する route module (.ts または -)')
    .option('--prompt <text>', '1回だけ実行する prompt')
    .option('--model <model>', 'モデル', CODEX_LATEST_ALIAS)
    .option('--cwd <dir>', '作業ディレクトリ')
    .addOption(new Option('--output-format <format>', '出力形式').choices(['text', 'json', 'stream-json']).default('text'))
    .option('--effort <level>', '推論 effort (simple prompt mode 用)')
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
    .option('--model <model>', 'モデル', CODEX_LATEST_ALIAS)
    .option('--cwd <dir>', '作業ディレクトリ')
    .addOption(new Option('--output-format <format>', '出力形式').choices(['text', 'json', 'stream-json']).default('text'))
    .option('--effort <level>', '推論 effort')
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
    outputFormat: options.outputFormat,
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
