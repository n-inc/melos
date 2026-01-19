/**
 * Marathon CLI - コマンドライン引数の解析と実行
 *
 * @module cli
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Orchestrator,
  getDefaultConfig,
  getDefaultMaxIterations,
  type EngineType,
} from './orchestrator.js';
import type { ExecutionMode } from './state/progress.js';
import { watchPlanFile } from './watch.js';

/**
 * CLI オプション
 */
export interface CLIOptions {
  /** CI修正のみモード */
  ciFixOnly?: boolean;
  /** レビューのみモード */
  reviewOnly?: boolean;
  /** タスク実行のみモード */
  taskOnly?: boolean;
  /** 最大イテレーション数 */
  maxIterations?: number;
  /** HITL モード */
  hitl?: boolean;
  /** エンジン選択 */
  engine?: EngineType;
}

/**
 * package.json からバージョンを取得
 */
function getVersion(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const packageJsonPath = join(__dirname, '..', 'package.json');
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * コマンドアクションのエラーハンドリングを共通化
 */
async function handleCommandAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\x1b[0;31mエラー: ${message}\x1b[0m`);
    process.exit(1);
  }
}

/**
 * CLI オプションから実行モードを決定
 */
export function getExecutionMode(options: CLIOptions): ExecutionMode {
  if (options.ciFixOnly) {
    return 'ci-fix-only';
  }
  if (options.reviewOnly) {
    return 'review-only';
  }
  if (options.taskOnly) {
    return 'task-only';
  }
  return 'default';
}

/**
 * CLI プログラムを作成
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('marathon')
    .description('Marathon - 自律的エージェントループシステム')
    .version(getVersion(), '-v, --version', 'バージョンを表示')
    .option('--task-only', 'タスク実行のみ（レビュー・CI修正なし）')
    .option('--review-only', 'レビュー→修正のサイクルのみ実行（5イテレーション）')
    .option('--ci-fix-only', 'CI修正のみ実行（5イテレーション）')
    .option(
      '--max-iterations <number>',
      '最大イテレーション数',
      parseMaxIterations
    )
    .option('--hitl', '対話モード（1イテレーションずつ実行）')
    .option(
      '--engine <engine>',
      'エンジン選択 (claude | codex)',
      'claude'
    )
    .helpOption('-h, --help', 'ヘルプを表示');

  program
    .command('watch')
    .description('PLAN.json を監視して Marathon ループを自動起動')
    .option(
      '--max-iterations <number>',
      '最大イテレーション数',
      parseMaxIterations
    )
    .option('--hitl', '対話モード（1イテレーションずつ実行）')
    .option(
      '--engine <engine>',
      'エンジン選択 (claude | codex)',
      'claude'
    )
    .action(async (options: CLIOptions) => {
      await handleCommandAction(() => executeWatch(options));
    });

  return program;
}

/**
 * CLI を実行
 */
export async function run(argv?: string[]): Promise<void> {
  const program = createProgram();

  program.action(async (options: CLIOptions) => {
    await handleCommandAction(() => executeWithOptions(options));
  });

  await program.parseAsync(argv ?? process.argv);
}

/**
 * オプションを使用して実行
 */
export async function executeWithOptions(options: CLIOptions): Promise<void> {
  // 実行モードを決定
  const mode = getExecutionMode(options);

  // デフォルトイテレーション数を取得
  const defaultIterations = getDefaultMaxIterations(mode);

  // エンジンを検証
  const engine = validateEngine(options.engine ?? 'claude');

  // 設定を作成
  const config = getDefaultConfig({
    mode,
    maxIterations: options.maxIterations ?? defaultIterations,
    hitl: options.hitl ?? false,
    engine,
  });

  // オーケストレーターを作成して実行
  const orchestrator = new Orchestrator(config);

  // Ctrl+C ハンドラー
  const handleSignal = () => {
    console.error('\n\x1b[1;33m中断されました。\x1b[0m');
    orchestrator.abort();
    process.exit(130);
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    const result = await orchestrator.run();

    if (!result.success) {
      process.exit(1);
    }
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
  }
}

/**
 * watch モードを実行
 */
export async function executeWatch(options: CLIOptions): Promise<void> {
  const engine = validateEngine(options.engine ?? 'claude');
  const maxIterations =
    options.maxIterations ?? getDefaultMaxIterations('default');

  await watchPlanFile({
    engine,
    maxIterations,
    hitl: options.hitl ?? false,
  });
}

/**
 * --max-iterations オプションをパース
 */
function parseMaxIterations(value: string): number {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < 1 || num > 1000) {
    throw new Error(
      `無効な --max-iterations: ${value}（1〜1000 の整数を指定してください）`
    );
  }
  return num;
}

/**
 * エンジン名を検証
 */
function validateEngine(engine: string): EngineType {
  if (engine === 'claude' || engine === 'codex') {
    return engine;
  }
  throw new Error(`無効なエンジン: ${engine}（claude または codex を指定してください）`);
}
