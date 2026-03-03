import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Orchestrator, type OrchestratorConfig } from './orchestrator.js';
import { loadConfig, type MelosConfig } from './config/index.js';
import {
  loadMissionPlan,
  saveMissionPlan,
  transitionMissionState,
  type MissionPlan,
  type MissionState,
} from './state/mission.js';
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
  headless?: boolean;
  detach?: boolean;
}

export type KillCommandResult =
  | { status: 'killed'; pid: number }
  | { status: 'not_running' }
  | { status: 'stale'; pid: number };

const ARCHIVE_ON_RUN_STATES = new Set<MissionState>(['completed', 'failed', 'aborted']);
const AUTO_RESUME_ON_RUN_STATES = new Set<MissionState>(['paused', 'aborted']);

interface SignalControllerHooks {
  abort: () => void;
  stopUI: () => void;
  setExitCode: (code: number) => void;
  exitNow: (code: number) => void;
  write: (message: string) => void;
  forceExitAfterMs?: number;
}

export interface SignalController {
  handle: (signal: NodeJS.Signals) => void;
  getExitCode: () => number | null;
  clear: () => void;
}

export function createSignalController(hooks: SignalControllerHooks): SignalController {
  const forceExitAfterMs = hooks.forceExitAfterMs ?? 4000;
  let signalExitCode: number | null = null;
  let forceExitTimer: NodeJS.Timeout | null = null;

  const clear = () => {
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }
  };

  const forceExit = (code: number) => {
    hooks.write('\n[melos] 中断処理がタイムアウトしたため、強制終了します。\n');
    hooks.stopUI();
    hooks.exitNow(code);
  };

  const handle = (signal: NodeJS.Signals) => {
    const nextCode = signal === 'SIGTERM' ? 143 : 130;
    if (signalExitCode !== null) {
      hooks.write('\n[melos] 強制終了します。\n');
      hooks.stopUI();
      hooks.exitNow(nextCode);
      return;
    }

    signalExitCode = nextCode;
    hooks.setExitCode(signalExitCode);
    hooks.write('\n[melos] 中断しています...（もう一度 Ctrl+C で強制終了）\n');
    hooks.abort();

    forceExitTimer = setTimeout(() => {
      forceExit(signalExitCode ?? nextCode);
    }, forceExitAfterMs);
    forceExitTimer.unref?.();
  };

  return {
    handle,
    getExitCode: () => signalExitCode,
    clear,
  };
}

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
    .option('--headless', 'TUIを無効化し、外部コマンドで監視/承認するヘッドレスモード')
    .option('--detach', 'バックグラウンドで実行して即時に終了（--headless推奨）')
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
      await handleCommandAction(async () => {
        if (options.detach) {
          const pid = spawnDetachedSelf();
          console.log(`Detached melos run started (pid: ${pid})`);
          return;
        }
        await executeWithOptions(options, { resume: false });
      });
    }));

  applyCommonRunOptions(program
    .command('resume')
    .description('中断したミッションを再開')
    .action(async (options: CLIOptions) => {
      await handleCommandAction(async () => {
        if (options.detach) {
          const pid = spawnDetachedSelf();
          console.log(`Detached melos resume started (pid: ${pid})`);
          return;
        }
        await executeWithOptions(options, { resume: true });
      });
    }));

  program
    .command('status')
    .description('現在のミッション状態を表示（デフォルトJSON）')
    .option('--plain', '人間向けの短いテキストで表示')
    .action(async (options: { plain?: boolean }) => {
      await handleCommandAction(async () => {
        const status = await readMissionStatus(process.cwd());
        if (options.plain) {
          console.log(formatStatusPlain(status));
          return;
        }
        console.log(JSON.stringify(status, null, 2));
      });
    });

  program
    .command('logs')
    .description('イベントログを表示（デフォルトJSON）')
    .option('--after-seq <number>', 'このseqより後のイベントのみ', (value: string) => parseInt(value, 10), 0)
    .option('--tail <number>', '末尾N件のみ', (value: string) => parseInt(value, 10))
    .option('--actor <actor>', 'actorで絞り込み (orchestrator|manager|worker|system)')
    .option('--plain', '人間向け表示')
    .action(async (options: { afterSeq?: number; tail?: number; actor?: string; plain?: boolean }) => {
      await handleCommandAction(async () => {
        const logs = await readMissionLogs(process.cwd(), {
          afterSeq: Number.isFinite(options.afterSeq) ? Math.max(0, options.afterSeq ?? 0) : 0,
          tail: Number.isFinite(options.tail) ? Math.max(1, options.tail ?? 0) : undefined,
          actor: options.actor,
        });
        if (options.plain) {
          for (const event of logs) {
            console.log(`${event.seq} ${event.timestamp} ${event.type} ${event.agent ?? '-'} ${JSON.stringify(event.payload)}`);
          }
          return;
        }
        console.log(JSON.stringify(logs, null, 2));
      });
    });

  program
    .command('approve')
    .description('awaiting_approval のミッションを承認して実行状態にする')
    .action(async () => {
      await handleCommandAction(async () => {
        const result = await applyApprovalDecision(process.cwd(), 'approve');
        console.log(result);
      });
    });

  program
    .command('reject')
    .description('awaiting_approval のミッションを差し戻し（planningへ戻す）')
    .action(async () => {
      await handleCommandAction(async () => {
        const result = await applyApprovalDecision(process.cwd(), 'reject');
        console.log(result);
      });
    });

  program
    .command('cancel')
    .description('同一プロジェクトで実行中の Melos を停止（kill の同義）')
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
    await handleCommandAction(async () => {
      if (options.detach) {
        const pid = spawnDetachedSelf();
        console.log(`Detached melos run started (pid: ${pid})`);
        return;
      }
      await executeWithOptions(options, { resume: false });
    });
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

  const autoResumeState = runtimeOptions.resume
    ? null
    : await detectResumableMissionState(missionFilePath);
  const effectiveResume = runtimeOptions.resume || autoResumeState !== null;

  const preflightMessages = await prepareRunPreflight({
    cwd,
    melosDir,
    missionFilePath,
    prdFilePath,
    resume: effectiveResume,
  });
  if (autoResumeState) {
    preflightMessages.unshift(`TASK.json の状態 ${autoResumeState} を検出したため、自動で再開モードに切り替えます。`);
  }
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
    resume: effectiveResume,
    missionId: options.missionId,
    runtimeUIMode: uiMode,
    gitStrategy: resolveGitStrategy(options, fileConfig),
    onStatusUpdate: async (state) => {
      runtimeUI.updateState(state);
    },
  };

  const orchestrator = new Orchestrator(orchestratorConfig);

  let runFailureMessage: string | null = null;
  const signalController = createSignalController({
    abort: () => orchestrator.abort(),
    stopUI: () => runtimeUI.stop(),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    exitNow: (code) => {
      process.exit(code);
    },
    write: (message) => {
      process.stderr.write(message);
    },
  });
  const handleSignal = (signal: NodeJS.Signals) => {
    signalController.handle(signal);
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
      onCycleModel: (role) => {
        void orchestrator.cycleModel(role);
      },
    });

    const result = await orchestrator.run();
    if (signalController.getExitCode() !== null) {
      return;
    }

    if (!result.success) {
      const detail = result.error ? ` (${result.error})` : '';
      runFailureMessage = `実行失敗: ${result.reason}${detail}`;
      return;
    }
  } finally {
    signalController.clear();
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

export interface MissionStatusPayload {
  running: boolean;
  pid: number | null;
  missionState: MissionState | 'unknown';
  progressLabel: string;
  activeMilestoneId: string | null;
  activeFeatureId: string | null;
  pendingPrompt: string | null;
  lastEventSeq: number;
  lastEventType: string | null;
  runtimeStartedAt: string | null;
}

export async function readMissionStatus(cwd: string): Promise<MissionStatusPayload> {
  const melosDir = join(cwd, '.melos');
  const runtime = await loadRuntime(melosDir);
  const runAlive = runtime ? isProcessAlive(runtime.pid) : false;
  const missionFilePath = join(cwd, 'TASK.json');
  let missionState: MissionState | 'unknown' = 'unknown';
  let progressLabel = '0/0 (0%)';
  let activeMilestoneId: string | null = null;
  let activeFeatureId: string | null = null;
  let pendingPrompt: string | null = null;

  if (existsSync(missionFilePath)) {
    try {
      const mission = await loadMissionPlan(missionFilePath);
      missionState = mission.state;
      const totalFeatures = mission.milestones.reduce((sum, milestone) => sum + milestone.features.length, 0);
      const completedFeatures = mission.milestones.reduce(
        (sum, milestone) => sum + milestone.features.filter((feature) => feature.status === 'done' || feature.status === 'skipped').length,
        0
      );
      const progressPercent = totalFeatures === 0 ? 0 : Math.floor((completedFeatures / totalFeatures) * 100);
      progressLabel = `${completedFeatures}/${totalFeatures} (${progressPercent}%)`;
      activeMilestoneId = mission.activeMilestoneId;
      activeFeatureId = mission.activeFeatureId;
    } catch {
      missionState = 'unknown';
    }
  }

  const eventsPath = join(melosDir, 'events.jsonl');
  let lastEventSeq = 0;
  let lastEventType: string | null = null;
  if (existsSync(eventsPath)) {
    const lines = readFileSync(eventsPath, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    const last = lines[lines.length - 1];
    if (last) {
      try {
        const parsed = JSON.parse(last) as { seq?: number; type?: string; payload?: { message?: string } };
        lastEventSeq = typeof parsed.seq === 'number' ? parsed.seq : 0;
        lastEventType = typeof parsed.type === 'string' ? parsed.type : null;
        pendingPrompt = parsed.type === 'manager_decision'
          && typeof parsed.payload?.message === 'string'
          && parsed.payload.message.includes('pending input')
          ? parsed.payload.message
          : null;
      } catch {
        // noop
      }
    }
  }

  return {
    running: runAlive,
    pid: runAlive && runtime ? runtime.pid : null,
    missionState,
    progressLabel,
    activeMilestoneId,
    activeFeatureId,
    pendingPrompt,
    lastEventSeq,
    lastEventType,
    runtimeStartedAt: runtime?.startedAt ?? null,
  };
}

function formatStatusPlain(status: MissionStatusPayload): string {
  return [
    `running=${status.running ? 'yes' : 'no'} pid=${status.pid ?? '-'}`,
    `state=${status.missionState} progress=${status.progressLabel}`,
    `active=${status.activeMilestoneId ?? '-'} / ${status.activeFeatureId ?? '-'}`,
    `lastEvent=${status.lastEventSeq}:${status.lastEventType ?? '-'}`,
  ].join('\n');
}

export async function readMissionLogs(
  cwd: string,
  options: { afterSeq: number; tail?: number; actor?: string }
): Promise<Array<{ seq: number; timestamp: string; type: string; agent: string | null; payload: Record<string, unknown> }>> {
  const eventsPath = join(cwd, '.melos', 'events.jsonl');
  if (!existsSync(eventsPath)) {
    return [];
  }

  const lines = readFileSync(eventsPath, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  let events = lines
    .map((line) => {
      try {
        return JSON.parse(line) as { seq: number; timestamp: string; type: string; agent: string | null; payload: Record<string, unknown> };
      } catch {
        return null;
      }
    })
    .filter((event): event is { seq: number; timestamp: string; type: string; agent: string | null; payload: Record<string, unknown> } => event !== null);

  events = events.filter((event) => event.seq > options.afterSeq);
  if (options.actor) {
    events = events.filter((event) => (event.agent ?? '').toLowerCase() === options.actor?.toLowerCase());
  }
  if (options.tail && events.length > options.tail) {
    events = events.slice(events.length - options.tail);
  }

  return events;
}

export async function applyApprovalDecision(cwd: string, decision: 'approve' | 'reject'): Promise<string> {
  const missionFilePath = join(cwd, 'TASK.json');
  if (!existsSync(missionFilePath)) {
    throw new Error(`TASK.json が見つかりません: ${missionFilePath}`);
  }
  const mission = await loadMissionPlan(missionFilePath);
  if (mission.state !== 'awaiting_approval') {
    return `No-op: mission state is ${mission.state}`;
  }

  const next = decision === 'approve'
    ? transitionMissionState(mission, 'running', { approvalMethod: 'interactive' })
    : transitionMissionState(mission, 'planning');
  await saveMissionPlan(missionFilePath, next);
  return decision === 'approve'
    ? 'Mission approved. state=running'
    : 'Mission rejected. state=planning';
}

function spawnDetachedSelf(): number {
  const argv = process.argv.slice(1).filter((arg) => arg !== '--detach');
  const child = spawn(process.execPath, argv, {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return child.pid ?? -1;
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

  let missionPlan: MissionPlan;
  try {
    missionPlan = await loadMissionPlan(input.missionFilePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new Error([
      `TASK.json の読み込みに失敗したため、実行を停止しました: ${reason}`,
      'TASK.json を修正してから再実行してください。',
    ].join('\n'));
  }

  if (!ARCHIVE_ON_RUN_STATES.has(missionPlan.state)) {
    return messages;
  }
  throw new Error([
    `TASK.json は終了状態 (${missionPlan.state}) のため、そのままでは新規ミッションを開始しません。`,
    'TASK.json を手動で更新してから再実行してください。',
  ].join('\n'));
}

export async function detectResumableMissionState(missionFilePath: string): Promise<MissionState | null> {
  if (!existsSync(missionFilePath)) {
    return null;
  }
  try {
    const missionPlan = await loadMissionPlan(missionFilePath);
    return AUTO_RESUME_ON_RUN_STATES.has(missionPlan.state) ? missionPlan.state : null;
  } catch {
    return null;
  }
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
