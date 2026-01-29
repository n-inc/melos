/**
 * Melos CLI - コマンドライン引数の解析と実行
 *
 * @module cli
 */

import { Command, Option } from 'commander';
import { readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
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
import { loadConfig, type MelosConfig } from './config/index.js';

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
  /** モデル名（Claude: haiku, sonnet, opus / Codex: gpt-5.2-codex など） */
  model?: string;
  /** Codex 推論努力レベル */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Claude thinking budget */
  thinkingBudget?: number;
  /** 開始前にリセット（スモークテスト用） */
  dangerouslyResetBeforeStart?: boolean;
  /** プレーン出力モード（スピナー無効） */
  plain?: boolean;
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
export function getExecutionMode(options: CLIOptions, _cwd: string = process.cwd()): ExecutionMode {
  if (options.ciFixOnly) {
    return 'ci-fix-only';
  }
  if (options.reviewOnly) {
    return 'review-only';
  }
  if (options.taskOnly) {
    return 'task-only';
  }
  // PLAN.json の有無に関係なく default モード
  // （PLAN.json がない場合は研究フェーズで生成）
  return 'default';
}

/**
 * CLI プログラムを作成
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('melos')
    .description('Melos - 自律的エージェントループシステム')
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
      'エンジン選択 (claude | codex)'
    )
    .option(
      '--model <model>',
      'モデル名（Claude: haiku, sonnet, opus / Codex: gpt-5.2-codex など）'
    )
    .option(
      '--reasoning-effort <level>',
      'Codex 推論努力レベル (low | medium | high | xhigh)'
    )
    .option(
      '--thinking-budget <number>',
      'Claude thinking budget（1024〜31999、デフォルト: 31999）',
      parseThinkingBudget
    )
    .option(
      '--plain',
      'プレーン出力モード（スピナー無効）'
    )
    .addOption(
      new Option('--dangerously-reset-before-start', '開始前にPLAN.json等をリセット（スモークテスト用）').hideHelp()
    )
    .helpOption('-h, --help', 'ヘルプを表示');

  program
    .command('watch')
    .description('PLAN.json を監視して Melos ループを自動起動')
    .option(
      '--max-iterations <number>',
      '最大イテレーション数',
      parseMaxIterations
    )
    .option('--hitl', '対話モード（1イテレーションずつ実行）')
    .option(
      '--engine <engine>',
      'エンジン選択 (claude | codex)'
    )
    .option(
      '--model <model>',
      'モデル名（Claude: haiku, sonnet, opus / Codex: gpt-5.2-codex など）'
    )
    .option(
      '--reasoning-effort <level>',
      'Codex 推論努力レベル (low | medium | high | xhigh)'
    )
    .option(
      '--thinking-budget <number>',
      'Claude thinking budget（1024〜31999、デフォルト: 31999）',
      parseThinkingBudget
    )
    .option(
      '--plain',
      'プレーン出力モード（スピナー無効）'
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
  // --plain オプションが指定された場合、環境変数を設定
  if (options.plain) {
    process.env.MELOS_NO_SPINNER = '1';
  }

  // 設定ファイルを読み込み
  const fileConfig = await loadConfig();

  // CLI オプションと設定ファイルをマージ（CLI が優先）
  const merged = mergeOptions(options, fileConfig);

  // 実行モードを決定
  const cwd = process.cwd();
  const mode = getExecutionMode(merged, cwd);


  // デフォルトイテレーション数を取得
  const defaultIterations = getDefaultMaxIterations(mode);

  // エンジンを検証
  const engine = validateEngine(merged.engine ?? 'claude');

  // 推論努力レベルを検証
  const reasoningEffort = merged.reasoningEffort
    ? validateReasoningEffort(merged.reasoningEffort)
    : undefined;

  // デフォルトモデルを決定（スモークテストは haiku、それ以外は opus）
  const defaultModel = options.dangerouslyResetBeforeStart ? 'haiku' : 'opus';

  // 設定を作成
  const config = getDefaultConfig({
    mode,
    maxIterations: merged.maxIterations ?? defaultIterations,
    hitl: merged.hitl ?? false,
    engine,
    model: merged.model ?? defaultModel,
    reasoningEffort,
    thinkingBudget: merged.thinkingBudget,
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

  // スモークテスト用リセット（開始前）
  if (options.dangerouslyResetBeforeStart) {
    resetForSmokeTest();
  }

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
  // --plain オプションが指定された場合、環境変数を設定
  if (options.plain) {
    process.env.MELOS_NO_SPINNER = '1';
  }

  // 設定ファイルを読み込み
  const fileConfig = await loadConfig();

  // CLI オプションと設定ファイルをマージ（CLI が優先）
  const merged = mergeOptions(options, fileConfig);

  const engine = validateEngine(merged.engine ?? 'claude');
  const maxIterations =
    merged.maxIterations ?? getDefaultMaxIterations('default');
  const reasoningEffort = merged.reasoningEffort
    ? validateReasoningEffort(merged.reasoningEffort)
    : undefined;

  await watchPlanFile({
    engine,
    maxIterations,
    hitl: merged.hitl ?? false,
    model: merged.model ?? 'opus',
    reasoningEffort,
    thinkingBudget: merged.thinkingBudget,
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
 * --thinking-budget オプションをパース
 */
function parseThinkingBudget(value: string): number {
  const num = parseInt(value, 10);
  if (isNaN(num) || num < 1024 || num > 31999) {
    throw new Error(
      `無効な --thinking-budget: ${value}（1024〜31999 の整数を指定してください）`
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

/**
 * 推論努力レベルを検証
 */
function validateReasoningEffort(level: string): 'low' | 'medium' | 'high' | 'xhigh' {
  if (level === 'low' || level === 'medium' || level === 'high' || level === 'xhigh') {
    return level;
  }
  throw new Error(`無効な推論努力レベル: ${level}（low, medium, high, xhigh のいずれかを指定してください）`);
}

/**
 * CLI オプションと設定ファイルをマージ（CLI が優先）
 */
function mergeOptions(cliOptions: CLIOptions, fileConfig: MelosConfig): CLIOptions {
  return {
    ...cliOptions,
    // CLI で明示的に指定されていない場合のみ設定ファイルの値を使用
    engine: cliOptions.engine ?? fileConfig.engine,
    model: cliOptions.model ?? fileConfig.model,
    reasoningEffort: cliOptions.reasoningEffort ?? fileConfig.reasoningEffort,
    thinkingBudget: cliOptions.thinkingBudget ?? fileConfig.thinkingBudget,
    maxIterations: cliOptions.maxIterations ?? fileConfig.maxIterations,
    hitl: cliOptions.hitl ?? fileConfig.hitl,
  };
}

/**
 * スモークテスト用リセット処理
 * PLAN.json の passes と checks.passed を false にリセットし、証拠URLも空にする
 * PROGRESS.md と STATUS.json を削除
 */
function resetForSmokeTest(): void {
  const cwd = process.cwd();
  const planPath = join(cwd, 'PLAN.json');
  const progressPath = join(cwd, 'PROGRESS.md');
  const statusPath = join(cwd, 'STATUS.json');

  console.log('\n🔄 Smoke Test リセット...');

  // PLAN.json をリセット
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      if (Array.isArray(plan)) {
        const resetPlan = plan.map((task: {
          passes?: boolean;
          checks?: Array<{
            text: string;
            type: string;
            passed: boolean;
            screenshot?: string;
            video?: string;
          }>;
        }) => ({
          ...task,
          passes: false,
          // checks が存在する場合は各項目の passed も false にリセット、証拠URLも空に
          ...(task.checks && {
            checks: task.checks.map((check) => ({
              ...check,
              passed: false,
              // 証拠フィールドが存在する場合は空にリセット
              ...(check.screenshot !== undefined && { screenshot: '' }),
              ...(check.video !== undefined && { video: '' }),
            })),
          }),
        }));
        writeFileSync(planPath, JSON.stringify(resetPlan, null, 2) + '\n');
        console.log('  Reset PLAN.json');
      }
    } catch {
      console.error('  Failed to reset PLAN.json');
    }
  }

  // PROGRESS.md を削除
  if (existsSync(progressPath)) {
    unlinkSync(progressPath);
    console.log('  Removed PROGRESS.md');
  }

  // STATUS.json を削除
  if (existsSync(statusPath)) {
    unlinkSync(statusPath);
    console.log('  Removed STATUS.json');
  }

  console.log('\n✅ リセット完了\n');
}
