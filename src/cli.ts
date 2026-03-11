import { Command, Option } from 'commander';
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
import { loadSnapshot } from './state/snapshot.js';
import { loadGitStrategyState, type PullRequestState } from './state/git-strategy.js';
import { getCurrentBranch, isGitRepository } from './state/git.js';
import type { MissionEvent } from './state/events.js';
import {
  formatRuntimeWarningRecord,
  runtimeWarningRecordFromEvent,
  type MissionKernelState,
} from './state/event-reducer.js';
import { normalizeLogMessage } from './state/log-entry.js';
import { formatLogStreamLines } from './ui/log-stream.js';
import { canUseColor } from './ui/tui-ansi.js';
import { createRuntimeUI, resolveRuntimeUIMode, type SessionInfo, type TerminalCapabilities } from './ui/tui.js';
import { CODEX_LATEST_ALIAS, normalizeModelName } from './models/registry.js';

export interface CLIOptions {
  input?: string;
  maxIterations?: number;
  plannerModel?: string;
  workerModel?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  plain?: boolean;
  dryRun?: boolean;
  interactive?: boolean;
  autoApprove?: boolean;
  quick?: boolean;
  gitStrategy?: boolean;
  createPr?: boolean;
  baseBranch?: string;
  missionId?: string;
  headless?: boolean;
  detach?: boolean;
  __detachedChild?: boolean;
}

export type KillCommandResult =
  | { status: 'killed'; pid: number }
  | { status: 'not_running' }
  | { status: 'stale'; pid: number };

const ARCHIVE_ON_RUN_STATES = new Set<MissionState>(['completed', 'failed', 'aborted']);
const AUTO_RESUME_ON_RUN_STATES = new Set<MissionState>(['paused', 'aborted']);
const DETACHED_CHILD_FLAG = '--__detached-child';
const LOG_ACTORS = ['planning', 'manager', 'worker', 'validator', 'system', 'all'] as const;
type LogActorFilter = typeof LOG_ACTORS[number];

interface SignalControllerHooks {
  abort: (signal: NodeJS.Signals) => void;
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
    hooks.abort(signal);

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
    .option('--input <path>', 'RunSpec JSON ファイルからミッションを起動')
    .option('--max-iterations <number>', '最大イテレーション数', parseMaxIterations)
    .option('--model <model>', '全ロールの共通モデル')
    .option('--planner-model <model>', 'Planner/Manager モデル')
    .option('--worker-model <model>', 'Worker モデル')
    .option('--reasoning-effort <level>', 'Worker 推論努力レベル (minimal|low|medium|high|xhigh)')
    .option('--effort <level>', 'Planner effort レベル (low|medium|high|max)')
    .option('--plain', 'プレーン出力モード')
    .option('--headless', 'TUIを無効化し、外部コマンドで監視/承認するヘッドレスモード')
    .option('--detach', 'バックグラウンドで実行して即時に終了（--headless推奨）')
    .option('--dry-run', '実装を行わず計画のみ進める')
    .option('--quick', '計画スキップ・単一 Feature 即実行')
    .option('--interactive', '対話型 planning を有効化')
    .option('--auto-approve', 'plan 承認を自動化')
    .option('--git-strategy', 'Git-as-Truth ハンドオフを有効化')
    .option('--create-pr', 'final review 後に GitHub Pull Request 作成と post-PR follow-up を有効化')
    .option('--base-branch <branch>', 'Git戦略のベースブランチ')
    .option('--mission-id <id>', 'ミッションID')
    .addOption(new Option(DETACHED_CHILD_FLAG).hideHelp());

  applyCommonRunOptions(program
    .command('run')
    .description('ミッションを開始')
    .action(async (options: CLIOptions) => {
      await handleCommandAction(async () => {
        if (options.detach && !options.__detachedChild) {
          const startedAt = new Date().toISOString();
          const pid = spawnDetachedSelf();
          console.log(JSON.stringify(buildDetachedRunPayload('run', pid, startedAt), null, 2));
          return;
        }
        if (options.__detachedChild) {
          options.detach = false;
        }
        await executeWithOptions(options, { resume: false });
      });
    }));

  applyCommonRunOptions(program
    .command('resume')
    .description('中断したミッションを再開')
    .action(async (options: CLIOptions) => {
      await handleCommandAction(async () => {
        if (options.detach && !options.__detachedChild) {
          const startedAt = new Date().toISOString();
          const pid = spawnDetachedSelf();
          console.log(JSON.stringify(buildDetachedRunPayload('resume', pid, startedAt), null, 2));
          return;
        }
        if (options.__detachedChild) {
          options.detach = false;
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
    .option('--actor <actor>', 'actorで絞り込み (planning|manager|worker|validator|system|all)', 'all')
    .option('--plain', '人間向け表示')
    .action(async (options: { afterSeq?: number; tail?: number; actor?: string; plain?: boolean }) => {
      await handleCommandAction(async () => {
        const logs = await readMissionLogs(process.cwd(), {
          afterSeq: Number.isFinite(options.afterSeq) ? Math.max(0, options.afterSeq ?? 0) : 0,
          tail: Number.isFinite(options.tail) ? Math.max(1, options.tail ?? 0) : undefined,
          actor: options.actor,
        });
        if (options.plain) {
          if (logs.entries.length === 0) {
            console.log('(no logs)');
          } else {
            const lines = formatLogStreamLines(logs.entries, {
              useColor: canUseColor(process.stdout.isTTY === true),
              showSeq: true,
              showActor: true,
              summarizeExploration: true,
            });
            console.log(lines.join('\n'));
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
    .option('--plain', '人間向け表示')
    .action(async (options: { plain?: boolean }) => {
      await handleCommandAction(async () => {
        const result = await killMelosRun(process.cwd());
        const payload = buildCancelPayload(result);
        if (options.plain) {
          if (payload.status === 'killed') {
            console.log(payload.message);
            return;
          }
          console.error(payload.message);
          process.exit(1);
          return;
        }
        console.log(JSON.stringify(payload, null, 2));
        if (payload.status !== 'killed') {
          process.exit(1);
        }
      });
    });

  program
    .command('kill')
    .description('同一プロジェクトで実行中の Melos を停止')
    .option('--plain', '人間向け表示')
    .action(async (options: { plain?: boolean }) => {
      await handleCommandAction(async () => {
        const result = await killMelosRun(process.cwd());
        const payload = buildCancelPayload(result);
        if (options.plain) {
          if (payload.status === 'killed') {
            console.log(payload.message);
            return;
          }
          console.error(payload.message);
          process.exit(1);
          return;
        }
        console.log(JSON.stringify(payload, null, 2));
        if (payload.status !== 'killed') {
          process.exit(1);
        }
      });
    });

  return program;
}

export async function run(argv?: string[]): Promise<void> {
  const program = createProgram();

  program.action(async (options: CLIOptions) => {
    await handleCommandAction(async () => {
      if (options.detach && !options.__detachedChild) {
        const startedAt = new Date().toISOString();
        const pid = spawnDetachedSelf();
        console.log(JSON.stringify(buildDetachedRunPayload('run', pid, startedAt), null, 2));
        return;
      }
      if (options.__detachedChild) {
        options.detach = false;
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
  let prdOverride: string | undefined;
  let runIdentity: OrchestratorConfig['runIdentity'];
  let runSpecTitle: string | undefined;

  if (options.input) {
    const { loadRunSpec, runSpecToPrdText, extractRunIdentity } = await import('./run-spec.js');
    const runSpec = await loadRunSpec(options.input);
    runSpecTitle = runSpec.source.title;
    prdOverride = runSpecToPrdText(runSpec);
    runIdentity = extractRunIdentity(runSpec);

    if (runSpec.options?.quick) {
      options.quick = true;
    }
    if (runSpec.options?.maxIterations) {
      options.maxIterations ??= runSpec.options.maxIterations;
    }
    if (runSpec.options?.model) {
      options.workerModel ??= runSpec.options.model;
      options.plannerModel ??= runSpec.options.model;
    }
  }
  if (options.quick === true) {
    options.autoApprove = true;
  }

  const autoResumeState = runtimeOptions.resume
    ? null
    : await detectResumableMissionState(missionFilePath);
  const effectiveResume = runtimeOptions.resume || autoResumeState !== null;
  const fileConfig = await loadConfig(cwd);
  const gitStrategy = resolveGitStrategy(options, fileConfig);

  const preflightMessages = await prepareRunPreflight({
    cwd,
    melosDir,
    missionFilePath,
    prdFilePath,
    hasRunSpecInput: options.input !== undefined,
    resume: effectiveResume,
    gitStrategyEnabled: gitStrategy?.enabled === true,
  });
  if (autoResumeState) {
    preflightMessages.unshift([
      `TASK.json の状態 ${autoResumeState} を検出したため、自動で再開モードに切り替えます。`,
      '前回のミッションを継続します。状態確認は別端末で `melos status --plain` / `melos logs --plain` を使ってください。',
      '新規ミッションを開始したい場合は、既存の TASK.json を退避または更新してから再実行してください。',
    ].join('\n'));
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

  const models = resolveModels(options, fileConfig);

  const orchestratorConfig: OrchestratorConfig = {
    cwd,
    maxIterations: options.maxIterations ?? fileConfig.maxIterations ?? 200,
    prdFile: prdFilePath,
    missionFile: missionFilePath,
    melosDir,
    plannerModel: models.planner,
    workerModel: models.worker,
    execution: fileConfig.execution,
    verification: fileConfig.verification,
    managerEffort: options.effort ?? 'high',
    workerReasoningEffort: options.reasoningEffort ?? 'high',
    interactivePlanning: options.interactive === true,
    autoApprove: options.autoApprove === true,
    dryRun: options.dryRun === true,
    quick: options.quick === true,
    runIdentity,
    prdOverride,
    resume: effectiveResume,
    missionId: options.missionId,
    runtimeUIMode: uiMode,
    gitStrategy,
    onStatusUpdate: async (state) => {
      runtimeUI.updateState(state);
    },
  };

  const orchestrator = new Orchestrator(orchestratorConfig);

  let runFailureMessage: string | null = null;
  let runCompletionMessage: string | null = null;
  const signalController = createSignalController({
    abort: (signal) => orchestrator.abort(signal),
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
      missionTitle: runSpecTitle ?? readPrdTitle(prdFilePath),
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
      onSetActiveFeatureModel: (model) => {
        void orchestrator.setActiveFeatureModel(model);
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

    const status = await readMissionStatus(cwd);
    runCompletionMessage = buildRunCompletionMessage(status, {
      initialState: autoResumeState,
      uiMode,
    });
  } finally {
    signalController.clear();
    runtimeUI.stop();
    await clearRuntime(melosDir);
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
  }

  if (runCompletionMessage) {
    process.stderr.write(`[melos] ${runCompletionMessage}\n`);
  }
  if (runFailureMessage) {
    console.error(runFailureMessage);
    process.exitCode = 1;
  }
}

function buildRunCompletionMessage(
  status: {
    mission: {
      state: MissionState | 'unknown' | 'not_initialized';
      progress: { label: string };
    };
    lastEvent: { seq: number; type: string } | null;
  },
  options: {
    initialState: MissionState | null;
    uiMode: 'tui' | 'plain' | 'headless';
  }
): string {
  const details = [
    `progress=${status.mission.progress.label}`,
    status.lastEvent ? `lastEvent=${status.lastEvent.seq}:${status.lastEvent.type}` : null,
  ].filter((value): value is string => Boolean(value));
  const detailSuffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  const completionDetail = options.uiMode === 'tui'
    ? ' TUI を終了しました。'
    : '';

  if (options.initialState) {
    return `起動時点では state=${options.initialState} でしたが、自動再開後の最終状態は state=${status.mission.state} です${detailSuffix}。${completionDetail}`;
  }
  return `ミッションが完了しました。最終状態は state=${status.mission.state} です${detailSuffix}。${completionDetail}`;
}

export interface MissionStatusPayload {
  schemaVersion: 1;
  initialized: boolean;
  warnings: string[];
  running: boolean;
  pid: number | null;
  runtime: {
    startedAt: string | null;
    cwd: string;
    missionFile: string;
    melosDir: string;
  };
  mission: {
    state: MissionState | 'unknown' | 'not_initialized';
    progress: {
      completed: number;
      total: number;
      percent: number;
      label: string;
    };
    activeMilestoneId: string | null;
    activeFeatureId: string | null;
    totalIterations: number;
  };
  validation: {
    milestoneId: string;
    attempt: number;
    passed: boolean;
    failedCheckCount: number;
    warningCount: number;
  } | null;
  qa: {
    summaries: Array<{
      milestoneId: string;
      total: number;
      passed: number;
      failed: number;
      pending: number;
    }>;
  } | null;
  review: {
    reviewType: 'product' | 'code';
    generation: number;
    activeFeatureId: string | null;
    latestFindingCount: number;
    blockingFindingCount: number;
    passed: boolean | null;
    summary?: string;
  } | null;
  retry: {
    queued: Array<{
      milestoneId: string;
      featureId: string;
      nextAttempt: number;
      dueAt: string;
      reason: string;
    }>;
  } | null;
  git: {
    activeBranch: string | null;
    pullRequest: PullRequestState | null;
    quietUntil: string | null;
    lastExternalActivityAt: string | null;
  } | null;
  pendingPrompt: string | null;
  lastEvent: {
    seq: number;
    type: string;
    timestamp: string;
    actor: Exclude<LogActorFilter, 'all'>;
  } | null;
  cursor: {
    nextSeq: number;
  };
}

export async function readMissionStatus(cwd: string): Promise<MissionStatusPayload> {
  const melosDir = join(cwd, '.melos');
  const runtime = await loadRuntime(melosDir);
  const runAlive = runtime ? isProcessAlive(runtime.pid) : false;
  const missionFilePath = join(cwd, 'TASK.json');
  const warnings: string[] = [];
  let missionState: MissionState | 'unknown' | 'not_initialized' = 'not_initialized';
  let progress = { completed: 0, total: 0, percent: 0, label: '0/0 (0%)' };
  let activeMilestoneId: string | null = null;
  let activeFeatureId: string | null = null;
  let totalIterations = 0;
  let pendingPrompt: string | null = null;
  let validation: MissionStatusPayload['validation'] = null;
  let qa: MissionStatusPayload['qa'] = null;
  let review: MissionStatusPayload['review'] = null;
  let retry: MissionStatusPayload['retry'] = null;
  let git: MissionStatusPayload['git'] = null;
  let missionFromTask = false;
  let initialized = false;
  let missionPlanForReview: MissionPlan | null = null;

  if (existsSync(missionFilePath)) {
    try {
      const mission = await loadMissionPlan(missionFilePath);
      missionPlanForReview = mission;
      missionFromTask = true;
      missionState = mission.state;
      const totalFeatures = mission.milestones.reduce((sum, milestone) => sum + milestone.features.length, 0);
      const completedFeatures = mission.milestones.reduce(
        (sum, milestone) => sum + milestone.features.filter((feature) => feature.status === 'done' || feature.status === 'skipped').length,
        0
      );
      const progressPercent = totalFeatures === 0 ? 0 : Math.floor((completedFeatures / totalFeatures) * 100);
      progress = {
        completed: completedFeatures,
        total: totalFeatures,
        percent: progressPercent,
        label: `${completedFeatures}/${totalFeatures} (${progressPercent}%)`,
      };
      activeMilestoneId = mission.activeMilestoneId;
      activeFeatureId = mission.activeFeatureId;
      totalIterations = mission.totalIterations;
      initialized = true;
    } catch {
      missionState = 'unknown';
      warnings.push('TASK.json の読み込みに失敗しました。');
    }
  }

  const snapshot = await loadSnapshot<{ kernel?: MissionKernelState }>(melosDir);
  if (!snapshot) {
    warnings.push('state.json が存在しません（未開始または初期化前）。');
  } else {
    const snapshotPlan = snapshot.state?.kernel?.missionPlan;
    if (!missionFromTask && snapshotPlan) {
      missionPlanForReview = snapshotPlan;
      missionState = snapshotPlan.state;
      const totalFeatures = snapshotPlan.milestones.reduce((sum, milestone) => sum + milestone.features.length, 0);
      const completedFeatures = snapshotPlan.milestones.reduce(
        (sum, milestone) => sum + milestone.features.filter((feature) => feature.status === 'done' || feature.status === 'skipped').length,
        0
      );
      const progressPercent = totalFeatures === 0 ? 0 : Math.floor((completedFeatures / totalFeatures) * 100);
      progress = {
        completed: completedFeatures,
        total: totalFeatures,
        percent: progressPercent,
        label: `${completedFeatures}/${totalFeatures} (${progressPercent}%)`,
      };
      activeMilestoneId = snapshotPlan.activeMilestoneId;
      activeFeatureId = snapshotPlan.activeFeatureId;
      totalIterations = snapshotPlan.totalIterations;
      initialized = true;
    }
    appendRuntimeStatusWarnings(warnings, snapshot.state?.kernel?.warnings);
    validation = buildMissionStatusValidation(snapshot.state?.kernel?.latestValidationReport ?? null);
    qa = buildMissionStatusQa(missionPlanForReview);
    review = buildMissionStatusReview(
      missionPlanForReview,
      snapshot.state?.kernel?.latestReviewReport ?? null
    );
    retry = buildMissionStatusRetry(snapshot.state?.kernel?.featureRetries ?? []);
    if (!pendingPrompt && snapshot.state?.kernel?.logEntries) {
      const entries = snapshot.state.kernel.logEntries;
      for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
        const line = entries[idx];
        if (line?.kind === 'INPUT' || line?.kind === 'APPROVAL_WAIT') {
          pendingPrompt = line.message;
          break;
        }
      }
    }
  }

  const gitStrategy = snapshot?.state?.kernel?.gitStrategy ?? await loadGitStrategyState(melosDir);
  git = buildMissionStatusGit(cwd, gitStrategy);
  qa = qa ?? buildMissionStatusQa(missionPlanForReview);

  const events = readEventFile(join(melosDir, 'events.jsonl'));
  const last = events[events.length - 1] ?? null;
  const maxSeq = last?.seq ?? 0;
  pendingPrompt = resolvePendingPromptFromEvents(events) ?? pendingPrompt;
  if (missionState !== 'awaiting_approval') {
    pendingPrompt = null;
  }

  return {
    schemaVersion: 1,
    initialized,
    warnings,
    running: runAlive,
    pid: runAlive && runtime ? runtime.pid : null,
    runtime: {
      startedAt: runtime?.startedAt ?? null,
      cwd,
      missionFile: missionFilePath,
      melosDir,
    },
    mission: {
      state: missionState,
      progress,
      activeMilestoneId,
      activeFeatureId,
      totalIterations,
    },
    validation,
    qa,
    review,
    retry,
    git,
    pendingPrompt,
    lastEvent: last
      ? {
        seq: last.seq,
        type: last.type,
        timestamp: last.timestamp,
        actor: deriveLogActor(last),
      }
      : null,
    cursor: {
      nextSeq: maxSeq === 0 ? 0 : maxSeq + 1,
    },
  };
}

function formatStatusPlain(status: MissionStatusPayload): string {
  const lines = [
    `running=${status.running ? 'yes' : 'no'} pid=${status.pid ?? '-'}`,
    `state=${status.mission.state} progress=${status.mission.progress.label}`,
    `active=${status.mission.activeMilestoneId ?? '-'} / ${status.mission.activeFeatureId ?? '-'}`,
    `lastEvent=${status.lastEvent ? `${status.lastEvent.seq}:${status.lastEvent.type}` : '-'}`,
    `nextSeq=${status.cursor.nextSeq}`,
  ];
  if (status.review) {
    lines.push(
      `review=${status.review.reviewType} g${status.review.generation} active=${status.review.activeFeatureId ?? '-'} findings=${status.review.latestFindingCount} blocking=${status.review.blockingFindingCount} passed=${status.review.passed === null ? '-' : status.review.passed ? 'yes' : 'no'}`
    );
  }
  if (status.validation) {
    lines.push(
      `validation=${status.validation.milestoneId} attempt=${status.validation.attempt} passed=${status.validation.passed ? 'yes' : 'no'} failedChecks=${status.validation.failedCheckCount} warnings=${status.validation.warningCount}`
    );
  }
  if (status.qa) {
    for (const summary of status.qa.summaries) {
      lines.push(
        `qa=${summary.milestoneId} total=${summary.total} passed=${summary.passed} failed=${summary.failed} pending=${summary.pending}`
      );
    }
  }
  if (status.retry && status.retry.queued.length > 0) {
    for (const item of status.retry.queued) {
      lines.push(
        `retry=${item.milestoneId}/${item.featureId} nextAttempt=${item.nextAttempt} dueAt=${item.dueAt} reason=${item.reason}`
      );
    }
  }
  if (status.git) {
    lines.push(
      `git=active=${status.git.activeBranch ?? '-'} quietUntil=${status.git.quietUntil ?? '-'}`
    );
    if (status.git.pullRequest) {
      lines.push(
        `pr=#${status.git.pullRequest.number ?? '-'} action=${status.git.pullRequest.action} url=${status.git.pullRequest.url}`
      );
    }
  }
  if (status.pendingPrompt) {
    lines.push(`pending=${status.pendingPrompt}`);
  }
  for (const warning of status.warnings) {
    lines.push(`warning=${warning}`);
  }
  return lines.join('\n');
}

export interface MissionLogRecord {
  seq: number;
  timestamp: string;
  iteration: number;
  actor: Exclude<LogActorFilter, 'all'>;
  kind: string;
  message: string;
  detailLines?: string[];
  eventType: string;
}

export interface MissionLogsPayload {
  entries: MissionLogRecord[];
  cursor: {
    nextSeq: number;
  };
}

export async function readMissionLogs(
  cwd: string,
  options: { afterSeq: number; tail?: number; actor?: string }
): Promise<MissionLogsPayload> {
  const eventsPath = join(cwd, '.melos', 'events.jsonl');
  if (!existsSync(eventsPath)) {
    return {
      entries: [],
      cursor: {
        nextSeq: 0,
      },
    };
  }

  const actorFilter = parseActorFilter(options.actor);
  const events = readEventFile(eventsPath);
  const maxSeq = events.length > 0 ? events[events.length - 1].seq : 0;

  let entries = events
    .filter((event) => event.seq > options.afterSeq)
    .map(normalizeMissionLogRecord);

  if (actorFilter !== 'all') {
    entries = entries.filter((entry) => entry.actor === actorFilter);
  }
  if (options.tail && entries.length > options.tail) {
    entries = entries.slice(entries.length - options.tail);
  }

  return {
    entries,
    cursor: {
      nextSeq: maxSeq === 0 ? 0 : maxSeq + 1,
    },
  };
}

export async function applyApprovalDecision(cwd: string, decision: 'approve' | 'reject'): Promise<string> {
  const missionFilePath = join(cwd, 'TASK.json');
  if (!existsSync(missionFilePath)) {
    throw new Error(`TASK.json が見つかりません: ${missionFilePath}`);
  }
  const mission = await loadMissionPlan(missionFilePath);
  if (mission.state !== 'awaiting_approval') {
    throw new Error(`${decision} は awaiting_approval でのみ使用可能です (current=${mission.state})`);
  }

  const next = decision === 'approve'
    ? transitionMissionState(mission, 'running')
    : transitionMissionState(mission, 'planning');
  await saveMissionPlan(missionFilePath, next);
  return decision === 'approve'
    ? 'Mission approved. state=running'
    : 'Mission rejected. state=planning';
}

interface CancelPayload {
  status: KillCommandResult['status'];
  pid: number | null;
  message: string;
}

function buildCancelPayload(result: KillCommandResult): CancelPayload {
  if (result.status === 'killed') {
    return {
      status: 'killed',
      pid: result.pid,
      message: `PID ${result.pid} に SIGTERM を送信しました。`,
    };
  }
  if (result.status === 'stale') {
    return {
      status: 'stale',
      pid: result.pid,
      message: `実行中の Melos が見つかりませんでした（stale PID: ${result.pid}）。`,
    };
  }
  return {
    status: 'not_running',
    pid: null,
    message: '実行中の Melos が見つかりませんでした。',
  };
}
function spawnDetachedSelf(): number {
  const argv = process.argv.slice(1)
    .filter((arg) => arg !== '--detach' && arg !== DETACHED_CHILD_FLAG);
  argv.push(DETACHED_CHILD_FLAG);
  const child = spawn(process.execPath, argv, {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return child.pid ?? -1;
}

function buildDetachedRunPayload(command: 'run' | 'resume', pid: number, startedAt: string): {
  command: 'run' | 'resume';
  pid: number;
  startedAt: string;
  cwd: string;
  missionFile: string;
  melosDir: string;
} {
  const cwd = process.cwd();
  return {
    command,
    pid,
    startedAt,
    cwd,
    missionFile: join(cwd, 'TASK.json'),
    melosDir: join(cwd, '.melos'),
  };
}

function readEventFile(path: string): MissionEvent[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf-8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as MissionEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is MissionEvent => event !== null && typeof event.seq === 'number')
    .sort((a, b) => a.seq - b.seq);
}

function appendRuntimeStatusWarnings(
  target: string[],
  warnings: MissionKernelState['warnings']
): void {
  if (!Array.isArray(warnings)) {
    return;
  }

  for (const warning of warnings) {
    if (!warning) {
      continue;
    }
    appendWarningLine(target, formatRuntimeWarningRecord(warning));
  }
}

function appendWarningLine(target: string[], message: string): void {
  const normalized = message.trim();
  if (normalized.length === 0 || target.includes(normalized)) {
    return;
  }
  target.push(normalized);
}

function resolvePendingPromptFromEvents(events: MissionEvent[]): string | null {
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = events[idx];
    if (event.type !== 'manager_decision') {
      continue;
    }
    if (event.payload?.action !== 'pending_input') {
      continue;
    }
    const message = typeof event.payload?.message === 'string' ? event.payload.message.trim() : '';
    if (message.length === 0 || message === 'pending input cleared') {
      return null;
    }
    return message;
  }
  return null;
}

function parseActorFilter(actor: string | undefined): LogActorFilter {
  const normalized = (actor ?? 'all').toLowerCase();
  if ((LOG_ACTORS as readonly string[]).includes(normalized)) {
    return normalized as LogActorFilter;
  }
  throw new Error(`--actor は ${LOG_ACTORS.join('|')} のいずれかを指定してください`);
}

function deriveLogActor(event: MissionEvent): Exclude<LogActorFilter, 'all'> {
  if (event.type.startsWith('validation_')) {
    return 'validator';
  }
  if (event.type.startsWith('review_')) {
    return 'worker';
  }
  if (event.type === 'warning_emitted') {
    const source = event.payload?.source;
    if (source === 'validation') {
      return 'validator';
    }
    if (source === 'worker') {
      return 'worker';
    }
    return 'system';
  }
  if (event.type.startsWith('plan_')) {
    return 'planning';
  }
  if (event.type.startsWith('manager_')) {
    if (typeof event.payload?.phase === 'string' && event.payload.phase === 'planning') {
      return 'planning';
    }
    return 'manager';
  }
  if (event.type.startsWith('worker_') || event.type === 'command_executed' || event.type === 'file_changed') {
    return 'worker';
  }
  return 'system';
}

function normalizeMissionLogRecord(event: MissionEvent): MissionLogRecord {
  const actor = deriveLogActor(event);
  const { kind, message, detailLines } = normalizeKindAndMessage(event);
  return {
    seq: event.seq,
    timestamp: event.timestamp,
    iteration: event.iteration,
    actor,
    kind,
    message,
    detailLines,
    eventType: event.type,
  };
}

function normalizeKindAndMessage(event: MissionEvent): { kind: string; message: string; detailLines?: string[] } {
  const warning = runtimeWarningRecordFromEvent(event);
  if (warning) {
    return {
      kind: 'WARN',
      message: formatRuntimeWarningRecord(warning),
    };
  }

  const payloadMessage = typeof event.payload?.message === 'string' ? event.payload.message : '';
  if (payloadMessage.trim().length > 0) {
    return normalizeLogMessage(payloadMessage, resolveDefaultKind(event));
  }

  if (event.type === 'command_executed') {
    const command = typeof event.payload?.command === 'string' ? event.payload.command : '';
    return {
      kind: 'BASH',
      message: command.length > 0 ? command : 'command executed',
    };
  }
  if (event.type === 'worker_started') {
    return {
      kind: 'STARTED',
      message: typeof event.payload?.message === 'string'
        ? event.payload.message
        : `worker #${String(event.payload?.runId ?? '?')} started`,
    };
  }
  if (event.type === 'worker_finished') {
    return {
      kind: 'DONE',
      message: typeof event.payload?.message === 'string'
        ? event.payload.message
        : `worker #${String(event.payload?.runId ?? '?')} finished`,
    };
  }
  if (event.type === 'worker_partial') {
    return {
      kind: 'WARN',
      message: typeof event.payload?.message === 'string'
        ? event.payload.message
        : `worker #${String(event.payload?.runId ?? '?')} finished partially`,
    };
  }
  if (event.type === 'worker_error' || event.type === 'manager_error' || event.type === 'error' || event.type === 'mission_failed') {
    return {
      kind: 'ERR',
      message: payloadMessage || event.type,
    };
  }
  if (event.type === 'review_started') {
    const reviewType = typeof event.payload?.reviewType === 'string' ? event.payload.reviewType : 'review';
    const generation = typeof event.payload?.generation === 'number' ? event.payload.generation : 1;
    return {
      kind: 'REVIEW',
      message: `${reviewType} review g${generation} started`,
    };
  }
  if (event.type === 'review_result') {
    const summary = typeof event.payload?.summary === 'string' ? event.payload.summary : 'review completed';
    const blockingFindingCount = typeof event.payload?.blockingFindingCount === 'number'
      ? event.payload.blockingFindingCount
      : 0;
    const passed = event.payload?.passed === true;
    return {
      kind: passed ? 'DONE' : 'REVIEW',
      message: `${summary} [${passed ? 'passed' : `${blockingFindingCount} blocking`}]`,
    };
  }
  if (event.type === 'validation_started') {
    return { kind: 'VALIDATE', message: payloadMessage || 'validation started' };
  }
  if (event.type === 'validation_result') {
    return { kind: 'VALIDATE', message: payloadMessage || 'validation result' };
  }
  if (event.type === 'plan_created' || event.type === 'plan_updated') {
    return { kind: 'PLAN', message: payloadMessage || event.type };
  }
  if (event.type === 'manager_decision') {
    return { kind: 'INFO', message: payloadMessage || 'manager decision' };
  }
  return {
    kind: event.type.toUpperCase(),
    message: payloadMessage || event.type,
  };
}

function resolveDefaultKind(event: MissionEvent): string {
  if (event.type === 'command_executed') {
    return 'BASH';
  }
  if (event.type === 'warning_emitted') {
    return 'WARN';
  }
  if (event.type === 'worker_started') {
    return 'STARTED';
  }
  if (event.type === 'worker_finished') {
    return 'DONE';
  }
  if (event.type === 'worker_partial') {
    return 'WARN';
  }
  if (event.type === 'worker_error' || event.type === 'manager_error' || event.type === 'error' || event.type === 'mission_failed') {
    return 'ERR';
  }
  if (event.type === 'review_started' || event.type === 'review_result') {
    return 'REVIEW';
  }
  if (event.type === 'validation_started' || event.type === 'validation_result') {
    return 'VALIDATE';
  }
  if (event.type === 'plan_created' || event.type === 'plan_updated') {
    return 'PLAN';
  }
  if (event.type === 'manager_decision') {
    return 'INFO';
  }
  return event.type.toUpperCase();
}

interface RunPreflightInput {
  cwd: string;
  melosDir: string;
  missionFilePath: string;
  prdFilePath: string;
  hasRunSpecInput: boolean;
  resume: boolean;
  gitStrategyEnabled: boolean;
}

export async function prepareRunPreflight(input: RunPreflightInput): Promise<string[]> {
  const messages: string[] = [];

  if (input.resume) {
    return messages;
  }

  if (input.hasRunSpecInput) {
    // RunSpec input supplies the mission content directly, so PRD.md is optional here.
  } else if (!existsSync(input.prdFilePath)) {
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

  const effectiveState = resolveTerminalMissionStateForRun(missionPlan);
  if (!effectiveState || !ARCHIVE_ON_RUN_STATES.has(effectiveState)) {
    return messages;
  }
  throw new Error([
    `TASK.json は終了状態 (${effectiveState}) のため、そのままでは新規ミッションを開始しません。`,
    buildTerminalStateGuidance(effectiveState),
  ].join('\n'));
}

export async function detectResumableMissionState(missionFilePath: string): Promise<MissionState | null> {
  if (!existsSync(missionFilePath)) {
    return null;
  }
  try {
    const missionPlan = await loadMissionPlan(missionFilePath);
    const effectiveState = resolveTerminalMissionStateForRun(missionPlan) ?? missionPlan.state;
    return AUTO_RESUME_ON_RUN_STATES.has(effectiveState) ? effectiveState : null;
  } catch {
    return null;
  }
}

function resolveTerminalMissionStateForRun(missionPlan: MissionPlan): MissionState | null {
  if (missionPlan.state === 'aborted' || missionPlan.state === 'paused') {
    const totalFeatures = missionPlan.milestones.reduce((sum, milestone) => sum + milestone.features.length, 0);
    if (totalFeatures > 0) {
      const completedFeatures = missionPlan.milestones.reduce(
        (sum, milestone) => sum + milestone.features.filter((feature) => feature.status === 'done' || feature.status === 'skipped').length,
        0
      );
      if (completedFeatures === totalFeatures) {
        return 'completed';
      }
    }
  }
  return missionPlan.state;
}

function buildTerminalStateGuidance(state: MissionState): string {
  switch (state) {
    case 'completed':
      return [
        '前回のミッションは完了済みです。結果確認は `melos status --plain` / `melos logs --plain` を使ってください。',
        '新規ミッションを開始するには、既存の TASK.json を退避または更新し、必要なら PRD.md も見直してから再実行してください。',
      ].join('\n');
    case 'failed':
      return [
        '前回のミッションは失敗状態で終了しています。詳細確認は `melos status --plain` / `melos logs --plain` を使ってください。',
        '再開ではなく新規ミッションとして始める場合は、TASK.json を退避または更新してから再実行してください。',
      ].join('\n');
    case 'aborted':
      return [
        '前回のミッションは中断されています。通常は `melos resume` で再開できます。',
        '新規ミッションを開始する場合は、TASK.json を退避または更新してから再実行してください。',
      ].join('\n');
    default:
      return 'TASK.json を手動で更新してから再実行してください。';
  }
}

export function resolveGitStrategy(
  options: CLIOptions,
  config: MelosConfig
): OrchestratorConfig['gitStrategy'] {
  const cwd = process.cwd();
  const pullRequestEnabled = options.createPr ?? config.git?.pullRequest?.enabled ?? false;
  const enabled = options.gitStrategy === true
    ? true
    : options.createPr === true
      ? true
      : typeof config.git?.enabled === 'boolean'
        ? config.git.enabled
        : pullRequestEnabled
          ? true
          : isGitRepository(cwd);
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
    validationCommands: config.git?.validationCommands ?? [],
    pullRequestEnabled,
  };
}

function resolveModels(options: CLIOptions, config: MelosConfig): {
  planner: string;
  worker: string;
} {
  const fallback = normalizeModelName(options.model) ?? CODEX_LATEST_ALIAS;

  return {
    planner: normalizeModelName(options.plannerModel ?? config.models?.planner) ?? fallback,
    worker: normalizeModelName(options.workerModel ?? config.models?.worker) ?? fallback,
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

function buildMissionStatusValidation(
  latestValidationReport: MissionKernelState['latestValidationReport']
): MissionStatusPayload['validation'] {
  if (!latestValidationReport) {
    return null;
  }

  return {
    milestoneId: latestValidationReport.milestoneId,
    attempt: latestValidationReport.attempt,
    passed: latestValidationReport.passed,
    failedCheckCount: latestValidationReport.results.filter((result) => !result.passed).length,
    warningCount: latestValidationReport.results.filter((result) => typeof result.warning === 'string' && result.warning.trim().length > 0).length,
  };
}

function buildMissionStatusQa(
  missionPlan: MissionPlan | null
): MissionStatusPayload['qa'] {
  if (!missionPlan) {
    return null;
  }

  const summaries = missionPlan.milestones
    .map((milestone) => {
      const qaChecks = milestone.validationContract.qaChecks ?? [];
      if (qaChecks.length === 0) {
        return null;
      }

      const passed = qaChecks.filter((check) => check.passed).length;
      const failed = qaChecks.filter((check) => !check.passed && check.failureCount > 0).length;
      return {
        milestoneId: milestone.id,
        total: qaChecks.length,
        passed,
        failed,
        pending: qaChecks.length - passed - failed,
      };
    })
    .filter((summary): summary is NonNullable<typeof summary> => summary !== null);

  return summaries.length > 0 ? { summaries } : null;
}

function buildMissionStatusRetry(
  featureRetries: MissionKernelState['featureRetries']
): MissionStatusPayload['retry'] {
  if (!Array.isArray(featureRetries) || featureRetries.length === 0) {
    return null;
  }

  return {
    queued: featureRetries.map((retry) => ({
      milestoneId: retry.milestoneId,
      featureId: retry.featureId,
      nextAttempt: retry.nextAttempt,
      dueAt: retry.dueAt,
      reason: retry.reason,
    })),
  };
}

function buildMissionStatusGit(
  cwd: string,
  gitStrategy: MissionKernelState['gitStrategy'] | null | undefined
): MissionStatusPayload['git'] {
  if (!gitStrategy) {
    return null;
  }

  return {
    activeBranch: gitStrategy.activeBranch ?? (getCurrentBranch(cwd).trim() || null),
    pullRequest: gitStrategy.pullRequest,
    quietUntil: gitStrategy.quietUntil,
    lastExternalActivityAt: gitStrategy.lastExternalActivityAt,
  };
}

function buildMissionStatusReview(
  missionPlan: MissionPlan | null,
  latestReviewReport: MissionKernelState['latestReviewReport']
): MissionStatusPayload['review'] {
  const activeReviewFeature = findActiveReviewFeature(missionPlan);
  if (!activeReviewFeature && !latestReviewReport) {
    return null;
  }

  return {
    reviewType: activeReviewFeature?.reviewType ?? latestReviewReport?.reviewType ?? 'code',
    generation: activeReviewFeature?.reviewGeneration ?? latestReviewReport?.generation ?? 1,
    activeFeatureId: activeReviewFeature?.id ?? null,
    latestFindingCount: latestReviewReport?.findings.length ?? 0,
    blockingFindingCount: latestReviewReport?.blockingFindingCount ?? 0,
    passed: latestReviewReport?.passed ?? null,
    summary: latestReviewReport?.summary,
  };
}

function findActiveReviewFeature(missionPlan: MissionPlan | null) {
  if (!missionPlan?.activeFeatureId) {
    return null;
  }
  for (const milestone of missionPlan.milestones) {
    const feature = milestone.features.find((candidate) =>
      candidate.id === missionPlan.activeFeatureId && candidate.kind === 'review'
    );
    if (feature) {
      return feature;
    }
  }
  return null;
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
