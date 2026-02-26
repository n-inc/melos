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
  type OrchestratorConfig,
  type OrchestratorLifecycleEvent,
} from './orchestrator.js';
import { loadConfig, type MelosConfig } from './config/index.js';
import type { ExecutionMode } from './state/progress.js';
import {
  clearSession,
  loadSession,
} from './state/session.js';
import {
  clearRuntime,
  isProcessAlive,
  loadRuntime,
  saveRuntime,
  terminateProcess,
} from './state/runtime.js';
import { createInteractiveInputController } from './ui/interactive.js';
import { playSystemSound } from './ui/sound.js';

/**
 * CLI オプション
 */
export interface CLIOptions {
  /** 最大イテレーション数 */
  maxIterations?: number;
  /** モデル名（Claude: haiku, sonnet, opus / Codex: gpt-5.3-codex など） */
  model?: string;
  /** Codex 推論努力レベル */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** Claude effort レベル（Opus 4.6+） */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Claude thinking budget（旧モデル向け） */
  thinkingBudget?: number;
  /** 開始前にリセット（スモークテスト用） */
  dangerouslyResetBeforeStart?: boolean;
  /** プレーン出力モード（スピナー無効） */
  plain?: boolean;
  /** ドライラン（計画のみ、Worker実行しない） */
  dryRun?: boolean;
  /** レビューループ専用モード */
  reviewOnly?: boolean;
}

/** Claude 専用モデル名（Worker では無効） */
const CLAUDE_ONLY_MODELS = ['haiku', 'sonnet', 'opus'];

export type KillCommandResult =
  | { status: 'killed'; pid: number }
  | { status: 'not_running' }
  | { status: 'stale'; pid: number };

function notifyLifecycleEvent(event: OrchestratorLifecycleEvent): void {
  playSystemSound(event);
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
 * CLI プログラムを作成
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('melos')
    .description('Melos - 自律的エージェントループシステム')
    .version(getVersion(), '-v, --version', 'バージョンを表示')
    .option(
      '--max-iterations <number>',
      '最大イテレーション数',
      parseMaxIterations
    )
    .option(
      '--model <model>',
      'モデル名（Claude: haiku, sonnet, opus / Codex: gpt-5.3-codex など）'
    )
    .option(
      '--reasoning-effort <level>',
      'Codex 推論努力レベル (minimal | low | medium | high | xhigh、デフォルト: high)'
    )
    .option(
      '--effort <level>',
      'Claude effort レベル (low | medium | high | max、デフォルト: max)'
    )
    .option(
      '--thinking-budget <number>',
      'Claude thinking budget（旧モデル向け、1024〜31999）',
      parseThinkingBudget
    )
    .option(
      '--plain',
      'プレーン出力モード（スピナー無効）'
    )
    .addOption(
      new Option('--dangerously-reset-before-start', '開始前にTASK.json等をリセット（スモークテスト用）').hideHelp()
    )
    .option(
      '--dry-run',
      'ドライラン（計画のみ、Worker実行しない）'
    )
    .option(
      '--review-only',
      'レビューのみモード（コードレビュー→修正のループ）'
    )
    .helpOption('-h, --help', 'ヘルプを表示');

  program
    .command('run')
    .description('Melos ループを実行')
    .option(
      '--max-iterations <number>',
      '最大イテレーション数',
      parseMaxIterations
    )
    .option(
      '--model <model>',
      'モデル名（Claude: haiku, sonnet, opus / Codex: gpt-5.3-codex など）'
    )
    .option(
      '--reasoning-effort <level>',
      'Codex 推論努力レベル (minimal | low | medium | high | xhigh、デフォルト: high)'
    )
    .option(
      '--effort <level>',
      'Claude effort レベル (low | medium | high | max、デフォルト: max)'
    )
    .option(
      '--thinking-budget <number>',
      'Claude thinking budget（旧モデル向け、1024〜31999）',
      parseThinkingBudget
    )
    .option(
      '--plain',
      'プレーン出力モード（スピナー無効）'
    )
    .addOption(
      new Option('--dangerously-reset-before-start', '開始前にTASK.json等をリセット（スモークテスト用）').hideHelp()
    )
    .option(
      '--dry-run',
      'ドライラン（計画のみ、Worker実行しない）'
    )
    .option(
      '--review-only',
      'レビューのみモード（コードレビュー→修正のループ）'
    )
    .action(async (options: CLIOptions) => {
      await handleCommandAction(() => executeWithOptions(options));
    });

  program
    .command('resume')
    .description('中断したセッションを再開')
    .option(
      '--max-iterations <number>',
      '最大イテレーション数',
      parseMaxIterations
    )
    .option(
      '--model <model>',
      'モデル名（Claude: haiku, sonnet, opus / Codex: gpt-5.3-codex など）'
    )
    .option(
      '--reasoning-effort <level>',
      'Codex 推論努力レベル (minimal | low | medium | high | xhigh、デフォルト: high)'
    )
    .option(
      '--effort <level>',
      'Claude effort レベル (low | medium | high | max、デフォルト: max)'
    )
    .option(
      '--thinking-budget <number>',
      'Claude thinking budget（旧モデル向け、1024〜31999）',
      parseThinkingBudget
    )
    .option(
      '--plain',
      'プレーン出力モード（スピナー無効）'
    )
    .option(
      '--dry-run',
      'ドライラン（計画のみ、Worker実行しない）'
    )
    .option(
      '--review-only',
      'レビューのみモード（コードレビュー→修正のループ）'
    )
    .action(async (options: CLIOptions) => {
      await handleCommandAction(() => executeWithOptions(options, { resume: true }));
    });

  program
    .command('kill')
    .description('同一プロジェクトで実行中の Melos を停止')
    .action(async () => {
      await handleCommandAction(async () => {
        const result = await killMelosRun(process.cwd());
        if (result.status === 'killed') {
          console.log(`PID ${result.pid} に SIGTERM を送信しました。`);
          return;
        }
        if (result.status === 'stale') {
          console.error(`実行中の Melos が見つかりませんでした（stale PID: ${result.pid}）。`);
          process.exit(1);
          return;
        }
        console.error('実行中の Melos が見つかりませんでした。');
        process.exit(1);
      });
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
 * 同一プロジェクトで実行中の Melos を停止する
 */
export async function killMelosRun(cwd: string): Promise<KillCommandResult> {
  const melosDir = join(cwd, '.melos');
  const runtime = await loadRuntime(melosDir);
  if (!runtime) {
    return { status: 'not_running' };
  }

  if (!isProcessAlive(runtime.pid)) {
    await clearRuntime(melosDir);
    return { status: 'stale', pid: runtime.pid };
  }

  terminateProcess(runtime.pid);
  return { status: 'killed', pid: runtime.pid };
}

/**
 * オプションを使用して実行
 */
export async function executeWithOptions(
  options: CLIOptions,
  runtimeOptions: {
    resume?: boolean;
  } = {}
): Promise<void> {
  const shouldEnableInteractiveInput = process.stdin.isTTY && !options.plain;
  const previousMelosNoSpinner = process.env.MELOS_NO_SPINNER;
  const autoDisabledSpinnerForInteractive =
    shouldEnableInteractiveInput
    && process.env.MELOS_SPINNER !== '1'
    && process.env.MELOS_NO_SPINNER !== '1';

  if (autoDisabledSpinnerForInteractive) {
    process.env.MELOS_NO_SPINNER = '1';
  }

  // --plain オプションが指定された場合、環境変数を設定
  if (options.plain) {
    process.env.MELOS_NO_SPINNER = '1';
  }

  const cwd = process.cwd();
  const melosDir = join(cwd, '.melos');

  // 設定ファイルを読み込み
  const fileConfig = await loadConfig(cwd);

  // 推論努力レベルを検証
  const reasoningEffort = options.reasoningEffort
    ? validateReasoningEffort(options.reasoningEffort)
    : undefined;

  // effort レベルを検証
  const effort = options.effort
    ? validateEffort(options.effort)
    : undefined;

  // CLI オプション > .melos.json の個別設定 > .melos.json の model の順で候補を選ぶ。
  // Worker については Claude 専用モデル名を自動スキップして次候補へフォールバックする。
  const managerModel = resolveManagerModel(options, fileConfig);
  const managerEffort = effort ?? fileConfig.manager?.effort;
  const workerModel = resolveWorkerModel(options, fileConfig);
  const workerReasoningEffort =
    reasoningEffort ?? fileConfig.worker?.effort ?? fileConfig.worker?.reasoningEffort;
  const executionMode = resolveExecutionMode(options);
  const maxIterations = resolveMaxIterations(options, fileConfig, executionMode);
  const taskFilePath = join(cwd, 'TASK.json');
  const legacyPlanPath = join(cwd, 'PLAN.json');

  if (!existsSync(taskFilePath) && existsSync(legacyPlanPath)) {
    throw new Error(
      'PLAN.json は廃止されました。PLAN.json を TASK.json にリネームして再実行してください。'
    );
  }

  // 設定を作成
  const resumeSession = runtimeOptions.resume
    ? await loadSession(melosDir)
    : null;
  if (runtimeOptions.resume && !resumeSession) {
    throw new Error('再開可能なセッションがありません');
  }

  const config: OrchestratorConfig = {
    cwd,
    maxIterations,
    prdFile: join(cwd, 'PRD.md'),
    taskFile: taskFilePath,
    progressFile: join(cwd, 'PROGRESS.md'),
    melosDir,
    managerModel,
    managerEffort,
    workerModel,
    workerReasoningEffort,
    executionMode,
    dryRun: options.dryRun,
    resumeSession,
    interactiveInputEnabled: process.stdin.isTTY,
    onLifecycleEvent: notifyLifecycleEvent,
  };

  // オーケストレーターを作成
  const orchestrator = new Orchestrator(config);

  // Ctrl+C ハンドラー
  let isSignalHandled = false;
  let signalExitCode: number | null = null;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (isSignalHandled) {
      return;
    }
    isSignalHandled = true;
    signalExitCode = signal === 'SIGTERM' ? 143 : 130;
    process.exitCode = signalExitCode;
    console.error('\n\x1b[1;33m中断されました。\x1b[0m');
    orchestrator.abort();
    void orchestrator.saveSession().then((saved) => {
      if (saved) {
        console.error('\x1b[0;36m再開: npx melos resume\x1b[0m');
      }
    }).catch(() => {
      // 保存失敗時も中断自体は継続
    });
    setTimeout(() => {
      process.exit(signalExitCode ?? 130);
    }, 3000).unref();
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  let stdinResumedByMelos = false;
  let interactiveInputController: ReturnType<typeof createInteractiveInputController> | null = null;
  const handleStdinData = (chunk: Buffer | string) => {
    const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // raw mode 等で Ctrl+C がシグナルではなく ETX として届くケースに対応
    if (data.includes('\u0003')) {
      handleSignal('SIGINT');
    }
  };

  if (process.stdin.isTTY) {
    process.stdin.on('data', handleStdinData);
    process.stdin.resume();
    stdinResumedByMelos = true;
    interactiveInputController = createInteractiveInputController({
      input: process.stdin,
      output: process.stdout,
      onSubmit: async (instruction) => {
        return await orchestrator.steer(instruction);
      },
    });
    interactiveInputController.start();
  }

  // スモークテスト用リセット（開始前）
  if (options.dangerouslyResetBeforeStart) {
    resetForSmokeTest();
  }

  await saveRuntime(melosDir, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd,
  });

  try {
    const result = await orchestrator.run();

    if (signalExitCode !== null) {
      // シグナル中断時は既に exitCode を設定済み
      return;
    }

    if (!result.success) {
      const detail = result.error ? ` / error: ${result.error}` : '';
      console.error(
        `\x1b[0;31m実行が失敗しました (reason: ${result.reason}${detail})\x1b[0m`
      );
      process.exit(1);
    }

    await clearSession(melosDir);
  } finally {
    await clearRuntime(melosDir);
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    if (process.stdin.isTTY) {
      process.stdin.removeListener('data', handleStdinData);
      interactiveInputController?.stop();
      if (stdinResumedByMelos && !process.stdin.isPaused()) {
        process.stdin.pause();
      }
    }
    if (autoDisabledSpinnerForInteractive) {
      if (previousMelosNoSpinner === undefined) {
        delete process.env.MELOS_NO_SPINNER;
      } else {
        process.env.MELOS_NO_SPINNER = previousMelosNoSpinner;
      }
    }
  }
}

export function resolveExecutionMode(
  options: Pick<CLIOptions, 'reviewOnly'>
): ExecutionMode {
  return options.reviewOnly ? 'review-only' : 'default';
}

export function resolveMaxIterations(
  options: Pick<CLIOptions, 'maxIterations'>,
  fileConfig: Pick<MelosConfig, 'maxIterations'>,
  executionMode: ExecutionMode
): number {
  const modeDefaultMaxIterations = executionMode === 'review-only' ? 10 : 30;
  return options.maxIterations ?? fileConfig.maxIterations ?? modeDefaultMaxIterations;
}

/**
 * Manager に渡すモデルを解決する
 */
export function resolveManagerModel(
  options: Pick<CLIOptions, 'model'>,
  fileConfig: MelosConfig
): string | undefined {
  const candidates = [options.model, fileConfig.manager?.model, fileConfig.model];
  return candidates.find((model): model is string => {
    return isNonEmptyString(model);
  });
}

/**
 * Worker(Codex) に渡すモデルを解決する
 */
export function resolveWorkerModel(
  options: Pick<CLIOptions, 'model'>,
  fileConfig: MelosConfig
): string | undefined {
  const candidates = [options.model, fileConfig.worker?.model, fileConfig.model];
  return candidates.find((model): model is string => {
    return isNonEmptyString(model) && !isClaudeOnlyModel(model);
  });
}

/**
 * 空でない文字列かどうか
 */
function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Claude 専用モデルかどうか（Worker には渡さない）
 */
function isClaudeOnlyModel(model: string): boolean {
  return CLAUDE_ONLY_MODELS.includes(model.toLowerCase());
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
 * 推論努力レベルを検証
 */
function validateReasoningEffort(level: string): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  if (level === 'minimal' || level === 'low' || level === 'medium' || level === 'high' || level === 'xhigh') {
    return level;
  }
  throw new Error(`無効な推論努力レベル: ${level}（minimal, low, medium, high, xhigh のいずれかを指定してください）`);
}

/**
 * Claude effort レベルを検証
 */
function validateEffort(level: string): 'low' | 'medium' | 'high' | 'max' {
  if (level === 'low' || level === 'medium' || level === 'high' || level === 'max') {
    return level;
  }
  throw new Error(`無効な effort レベル: ${level}（low, medium, high, max のいずれかを指定してください）`);
}

/**
 * スモークテスト用リセット処理
 * TASK.json の passes と checks.passed を false にリセットし、証拠URLも空にする
 * PROGRESS.md を削除
 */
function resetForSmokeTest(): void {
  const cwd = process.cwd();
  const taskPath = join(cwd, 'TASK.json');
  const progressPath = join(cwd, 'PROGRESS.md');

  console.log('\n🔄 Smoke Test リセット...');

  // TASK.json をリセット
  if (existsSync(taskPath)) {
    try {
      const tasks = JSON.parse(readFileSync(taskPath, 'utf-8'));
      if (Array.isArray(tasks)) {
        const resetTasks = tasks.map((task: {
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
        writeFileSync(taskPath, JSON.stringify(resetTasks, null, 2) + '\n');
        console.log('  Reset TASK.json');
      }
    } catch {
      console.error('  Failed to reset TASK.json');
    }
  }

  // PROGRESS.md を削除
  if (existsSync(progressPath)) {
    unlinkSync(progressPath);
    console.log('  Removed PROGRESS.md');
  }

  console.log('\n✅ リセット完了\n');
}
