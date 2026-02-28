import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Orchestrator, type OrchestratorConfig } from './orchestrator.js';
import { loadConfig, type MelosConfig } from './config/index.js';
import { loadMissionPlan, type MissionState } from './state/mission.js';
import {
  clearRuntime,
  isProcessAlive,
  loadRuntime,
  saveRuntime,
  terminateProcess,
} from './state/runtime.js';
import { createRuntimeUI, resolveRuntimeUIMode, type SessionInfo, type TerminalCapabilities } from './ui/tui.js';

export interface CLIOptions {
  maxIterations?: number;
  plannerModel?: string;
  workerModel?: string;
  validatorModel?: string;
  researchModel?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  plain?: boolean;
  dryRun?: boolean;
  interactive?: boolean;
  autoApprove?: boolean;
  gitStrategy?: boolean;
  baseBranch?: string;
  missionId?: string;
}

export type KillCommandResult =
  | { status: 'killed'; pid: number }
  | { status: 'not_running' }
  | { status: 'stale'; pid: number };

const ARCHIVE_ON_RUN_STATES = new Set<MissionState>(['completed', 'failed', 'aborted']);

export function createProgram(): Command {
  const program = new Command();

  program
    .name('melos')
    .description('Melos v0.8.0 Mission Orchestrator')
    .version(getVersion(), '-v, --version', 'バージョンを表示')
    .helpOption('-h, --help', 'ヘルプを表示');

  const applyCommonRunOptions = (cmd: Command): Command => cmd
    .option('--max-iterations <number>', '最大イテレーション数', parseMaxIterations)
    .option('--model <model>', '全ロールの共通モデル')
    .option('--planner-model <model>', 'Planner/Manager モデル')
    .option('--worker-model <model>', 'Worker モデル')
    .option('--validator-model <model>', 'Validator モデル')
    .option('--research-model <model>', 'Research モデル')
    .option('--reasoning-effort <level>', 'Worker 推論努力レベル (minimal|low|medium|high|xhigh)')
    .option('--effort <level>', 'Planner effort レベル (low|medium|high|max)')
    .option('--plain', 'プレーン出力モード')
    .option('--dry-run', '実装を行わず計画のみ進める')
    .option('--interactive', '対話型 planning を有効化')
    .option('--auto-approve', 'plan 承認を自動化')
    .option('--git-strategy', 'Git-as-Truth ハンドオフを有効化')
    .option('--base-branch <branch>', 'Git戦略のベースブランチ')
    .option('--mission-id <id>', 'ミッションID');

  applyCommonRunOptions(program
    .command('run')
    .description('ミッションを開始')
    .action(async (options: CLIOptions) => {
      await handleCommandAction(() => executeWithOptions(options, { resume: false }));
    }));

  applyCommonRunOptions(program
    .command('resume')
    .description('中断したミッションを再開')
    .action(async (options: CLIOptions) => {
      await handleCommandAction(() => executeWithOptions(options, { resume: true }));
    }));

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

export async function run(argv?: string[]): Promise<void> {
  const program = createProgram();

  program.action(async (options: CLIOptions) => {
    await handleCommandAction(() => executeWithOptions(options, { resume: false }));
  });

  await program.parseAsync(argv ?? process.argv);
}

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

export async function executeWithOptions(
  options: CLIOptions,
  runtimeOptions: { resume: boolean }
): Promise<void> {
  const cwd = process.cwd();
  const melosDir = join(cwd, '.melos');
  const missionFilePath = join(cwd, 'TASK.json');
  const prdFilePath = join(cwd, 'PRD.md');

  const preflightMessages = await prepareRunPreflight({
    cwd,
    melosDir,
    missionFilePath,
    prdFilePath,
    resume: runtimeOptions.resume,
  });
  for (const message of preflightMessages) {
    process.stderr.write(`[melos] ${message}\n`);
  }

  const terminalCapabilities: TerminalCapabilities = {
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
  };
  const uiMode = resolveRuntimeUIMode(options, terminalCapabilities);
  const runtimeUI = createRuntimeUI(uiMode, process.stderr, process.stdin);

  const fileConfig = await loadConfig(cwd);
  const models = resolveModels(options, fileConfig);

  const orchestratorConfig: OrchestratorConfig = {
    cwd,
    maxIterations: options.maxIterations ?? fileConfig.maxIterations ?? 200,
    prdFile: prdFilePath,
    missionFile: missionFilePath,
    melosDir,
    plannerModel: models.planner,
    workerModel: models.worker,
    validatorModel: models.validator,
    researchModel: models.research,
    managerEffort: options.effort ?? 'high',
    workerReasoningEffort: options.reasoningEffort ?? 'high',
    interactivePlanning: options.interactive === true,
    autoApprove: options.autoApprove === true,
    dryRun: options.dryRun === true,
    resume: runtimeOptions.resume,
    missionId: options.missionId,
    runtimeUIMode: uiMode,
    gitStrategy: resolveGitStrategy(options, fileConfig),
    onStatusUpdate: async (state) => {
      runtimeUI.updateState(state);
    },
  };

  const orchestrator = new Orchestrator(orchestratorConfig);

  let signalExitCode: number | null = null;
  let runFailureMessage: string | null = null;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (signalExitCode !== null) {
      return;
    }
    signalExitCode = signal === 'SIGTERM' ? 143 : 130;
    process.exitCode = signalExitCode;
    orchestrator.abort();
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    await saveRuntime(melosDir, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      cwd,
    });

    runtimeUI.start(buildSessionInfo({
      version: getVersion(),
      missionId: options.missionId ?? 'mission',
      missionTitle: readPrdTitle(prdFilePath),
      planner: models.planner,
      worker: models.worker,
    }), {
      onPause: () => orchestrator.pause(),
      onResume: () => orchestrator.resume(),
      onSteer: (instruction) => {
        void orchestrator.steer(instruction);
      },
    });

    const result = await orchestrator.run();
    if (signalExitCode !== null) {
      return;
    }

    if (!result.success) {
      const detail = result.error ? ` (${result.error})` : '';
      runFailureMessage = `実行失敗: ${result.reason}${detail}`;
      return;
    }
  } finally {
    runtimeUI.stop();
    await clearRuntime(melosDir);
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
  }

  if (runFailureMessage) {
    console.error(runFailureMessage);
    process.exitCode = 1;
  }
}

interface RunPreflightInput {
  cwd: string;
  melosDir: string;
  missionFilePath: string;
  prdFilePath: string;
  resume: boolean;
}

export async function prepareRunPreflight(input: RunPreflightInput): Promise<string[]> {
  if (input.resume) {
    return [];
  }

  const messages: string[] = [];

  if (!existsSync(input.prdFilePath)) {
    throw new Error([
      `PRD.md が見つからないためミッションを開始できません: ${input.prdFilePath}`,
      '先に PRD.md を作成してから `melos run` を実行してください。',
    ].join('\n'));
  }

  if (!existsSync(input.missionFilePath)) {
    return messages;
  }

  try {
    const missionPlan = await loadMissionPlan(input.missionFilePath);
    if (!ARCHIVE_ON_RUN_STATES.has(missionPlan.state)) {
      return messages;
    }

    const archivedPath = await archiveTaskFile(
      input.melosDir,
      input.missionFilePath,
      `state-${missionPlan.state}`
    );
    messages.push(
      `TASK.json が終了状態 (${missionPlan.state}) だったため退避し、新規ミッションを開始します: ${archivedPath}`
    );
    return messages;
  } catch (error) {
    const archivedPath = await archiveTaskFile(input.melosDir, input.missionFilePath, 'invalid');
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    messages.push(
      `TASK.json の読み込みに失敗したため退避し、新規ミッションを開始します: ${archivedPath}`
    );
    messages.push(`読み込みエラー: ${reason}`);
    return messages;
  }
}

async function archiveTaskFile(
  melosDir: string,
  missionFilePath: string,
  reason: string
): Promise<string> {
  const archiveDir = join(melosDir, 'archive');
  await mkdir(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivePath = join(archiveDir, `TASK.${stamp}.${reason}.json`);
  await rename(missionFilePath, archivePath);
  return archivePath;
}

function resolveGitStrategy(
  options: CLIOptions,
  config: MelosConfig
): OrchestratorConfig['gitStrategy'] {
  const enabled = options.gitStrategy ?? config.git?.enabled ?? false;
  if (!enabled) {
    return undefined;
  }

  const missionId = options.missionId ?? inferMissionIdFromCwd(process.cwd());
  return {
    enabled: true,
    baseBranch: options.baseBranch ?? config.git?.baseBranch ?? 'main',
    missionId,
    autoPush: config.git?.autoPush ?? false,
    preMergeValidation: config.git?.preMergeValidation ?? true,
    validationCommands: config.git?.validationCommands ?? ['npm run typecheck', 'npm test'],
  };
}

function resolveModels(options: CLIOptions, config: MelosConfig): {
  planner: string;
  worker: string;
  validator: string;
  research: string;
} {
  const fallback = options.model ?? config.models?.planner ?? 'opus';
  const workerFallback = options.model ?? config.models?.worker ?? 'gpt-5.3-codex';

  return {
    planner: options.plannerModel ?? config.models?.planner ?? fallback,
    worker: options.workerModel ?? config.models?.worker ?? workerFallback,
    validator: options.validatorModel ?? config.models?.validator ?? 'gpt-5.3-codex',
    research: options.researchModel ?? config.models?.research ?? 'opus',
  };
}

function getVersion(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const packageJsonPath = join(__dirname, '..', 'package.json');
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
    return packageJson.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function buildSessionInfo(input: {
  version: string;
  missionId: string;
  missionTitle: string;
  planner: string;
  worker: string;
}): SessionInfo {
  return {
    version: input.version,
    missionId: input.missionId,
    missionTitle: input.missionTitle,
    planner: input.planner,
    worker: input.worker,
  };
}

function parseMaxIterations(value: string): number {
  const num = parseInt(value, 10);
  if (Number.isNaN(num) || num < 1 || num > 10000) {
    throw new Error('max-iterations は 1〜10000 の整数で指定してください');
  }
  return num;
}

function readPrdTitle(prdFilePath: string): string {
  if (!existsSync(prdFilePath)) {
    return 'Untitled mission';
  }
  const content = readFileSync(prdFilePath, 'utf-8');
  const heading = content.split(/\r?\n/).find((line) => line.startsWith('# '));
  return heading ? heading.replace(/^#\s+/, '').trim() : 'Untitled mission';
}

function inferMissionIdFromCwd(cwd: string): string {
  const base = cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'mission';
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'mission';
}

async function handleCommandAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`エラー: ${message}`);
    process.exit(1);
  }
}
