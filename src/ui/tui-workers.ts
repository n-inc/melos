import type { TUIView, MissionControlState, ViewPort } from './tui-views.js';
import type { LogActor, UnifiedLogEntry } from '../state/log-entry.js';
import { truncateDisplay } from './tui-ansi.js';

const SWITCH_BAR = '─'.repeat(10);

export const workersView: TUIView = {
  id: 'workers',
  render(viewport: ViewPort, state: MissionControlState, context): string[] {
    const width = Math.max(40, viewport.width);
    const lock = context?.logSourceLock ?? 'auto';
    const secondaryVisible = context?.secondaryVisible !== false;
    const activeActor = resolveDisplayActor(state, lock);
    const nowRunning = buildNowRunningLine(state, activeActor);
    const separator = '─'.repeat(width);

    const entries = selectLogEntries(state.logEntries, lock);
    const streamLines = formatLogStreamLines(entries, {
      lock,
      switchNotice: context?.sourceSwitchNotice ?? null,
      secondaryVisible,
      activeActor,
      pendingPrompt: state.pendingPrompt,
    });

    const reserved = 2;
    const availableLogLines = Math.max(1, viewport.height - reserved);
    const visibleLogLines = streamLines.slice(-availableLogLines);

    return [
      truncateDisplay(nowRunning, width),
      separator,
      ...visibleLogLines.map((line) => truncateDisplay(line, width)),
    ];
  },
};

function resolveDisplayActor(
  state: MissionControlState,
  lock: 'auto' | 'worker' | 'manager'
): LogActor {
  if (lock === 'worker') {
    return 'worker';
  }
  if (lock === 'manager') {
    return state.currentActor === 'planning' ? 'planning' : 'manager';
  }
  if (state.currentActor !== 'idle' && state.currentActor !== 'system') {
    return state.currentActor;
  }
  const latest = state.logEntries[state.logEntries.length - 1];
  if (!latest) {
    return state.pendingPrompt ? 'manager' : 'idle';
  }
  return latest.actor;
}

function buildNowRunningLine(state: MissionControlState, actor: LogActor): string {
  if (actor === 'worker') {
    const running = [...state.workerRuns].reverse().find((run) => run.status === 'running') ?? state.workerRuns[state.workerRuns.length - 1];
    if (!running) {
      return 'NOW RUNNING  WORKER  waiting for first worker run';
    }
    const target = running.featureId ?? running.milestoneId ?? '-';
    const model = running.model ?? '-';
    return `NOW RUNNING  WORKER #${running.id}  ${target}  model=${model}  elapsed=${running.durationLabel}`;
  }
  if (actor === 'planning') {
    return 'NOW RUNNING  PLANNING  mission plan generation';
  }
  if (actor === 'manager') {
    const target = state.activeFeatureId ?? state.activeMilestoneId ?? '-';
    return `NOW RUNNING  MANAGER  ${target}  ${state.activity}`;
  }
  if (actor === 'validator') {
    const target = state.activeMilestoneId ?? '-';
    return `NOW RUNNING  VALIDATION  ${target}`;
  }
  return `NOW RUNNING  IDLE  ${state.activity}`;
}

function selectLogEntries(
  entries: UnifiedLogEntry[],
  lock: 'auto' | 'worker' | 'manager'
): UnifiedLogEntry[] {
  if (lock === 'auto') {
    return entries;
  }
  if (lock === 'worker') {
    return entries.filter((entry) => entry.actor === 'worker');
  }
  return entries.filter((entry) => entry.actor === 'manager' || entry.actor === 'planning');
}

function formatLogStreamLines(
  entries: UnifiedLogEntry[],
  options: {
    lock: 'auto' | 'worker' | 'manager';
    switchNotice: string | null;
    secondaryVisible: boolean;
    activeActor: LogActor;
    pendingPrompt?: string | null;
  }
): string[] {
  const lines: string[] = [];

  if (options.switchNotice) {
    lines.push(formatSwitchLine(options.switchNotice));
  }

  let previousActor: LogActor | null = null;
  for (const entry of entries) {
    if (options.lock === 'auto' && previousActor && previousActor !== entry.actor) {
      lines.push(formatSwitchLine(`SWITCH: ${actorName(previousActor)} -> ${actorName(entry.actor)}`));
    }
    previousActor = entry.actor;

    lines.push(`${entry.timestamp.slice(11, 19)} [${entry.kind}] ${entry.message}`);
    for (const detail of entry.detailLines ?? []) {
      lines.push(`         ${detail}`);
    }
  }

  if (lines.length === 0) {
    if (options.pendingPrompt) {
      return [`[APPROVAL_WAIT] ${options.pendingPrompt}`];
    }
    return ['No logs yet. Waiting for next event...'];
  }

  if (options.secondaryVisible && options.lock !== 'auto') {
    lines.push('');
    lines.push(`Collapsed actor: ${actorName(options.activeActor)} (focused by lock=${options.lock})`);
  }

  return lines;
}

function formatSwitchLine(message: string): string {
  return `${SWITCH_BAR} ${message} ${SWITCH_BAR}`;
}

function actorName(actor: LogActor): string {
  switch (actor) {
    case 'planning':
      return 'PLANNING';
    case 'manager':
      return 'MANAGER';
    case 'worker':
      return 'WORKER';
    case 'validator':
      return 'VALIDATION';
    case 'system':
      return 'SYSTEM';
    default:
      return 'IDLE';
  }
}

