import type { TUIView, MissionControlState, ViewPort } from './tui-views.js';
import type { LogActor, UnifiedLogEntry } from '../state/log-entry.js';
import { truncateDisplay, wrapPlainDisplay, colorize } from './tui-ansi.js';

const SWITCH_BAR = '─'.repeat(10);

export const workersView: TUIView = {
  id: 'workers',
  render(viewport: ViewPort, state: MissionControlState, context): string[] {
    const width = Math.max(40, viewport.width);
    const lock = context?.logSourceLock ?? 'auto';
    const useColor = context?.useColor === true;
    const scrollOffset = Math.max(0, context?.scrollOffset ?? 0);
    const activeActor = resolveDisplayActor(state, lock);
    const nowRunning = buildNowRunningLine(state, activeActor);
    const separator = '─'.repeat(width);

    const entries = selectLogEntries(state.logEntries, lock);
    const streamLines = formatLogStreamLines(entries, {
      lock,
      switchNotice: context?.sourceSwitchNotice ?? null,
      pendingPrompt: state.pendingPrompt,
      useColor,
    });

    const wrapped = streamLines.flatMap((line) => wrapPlainDisplay(line, width));
    const reserved = 2;
    const availableLogLines = Math.max(1, viewport.height - reserved);
    const maxOffset = Math.max(0, wrapped.length - availableLogLines);
    const safeOffset = scrollOffset >= Number.MAX_SAFE_INTEGER
      ? maxOffset
      : Math.min(scrollOffset, maxOffset);
    const visibleLogLines = wrapped.slice(safeOffset, safeOffset + availableLogLines);
    const lineSummary = wrapped.length === 0
      ? 'Lines 0/0'
      : `Lines ${safeOffset + 1}-${Math.min(wrapped.length, safeOffset + availableLogLines)}/${wrapped.length}`;

    return [
      truncateDisplay(`${nowRunning}  ${lineSummary}`, width),
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
    pendingPrompt?: string | null;
    useColor: boolean;
  }
): string[] {
  const lines: string[] = [];

  if (options.switchNotice) {
    lines.push(formatSwitchLine(options.switchNotice, options.useColor));
  }

  let previousActor: LogActor | null = null;
  for (const entry of entries) {
    if (!previousActor) {
      lines.push(formatSwitchLine(`LOG START: ${actorName(entry.actor)}`, options.useColor));
    } else if (options.lock === 'auto' && previousActor !== entry.actor) {
      lines.push(formatSwitchLine(`SWITCH: ${actorName(previousActor)} -> ${actorName(entry.actor)}`, options.useColor));
    }
    previousActor = entry.actor;

    const kindTag = formatKindTag(entry.kind, options.useColor);
    lines.push(`${entry.timestamp.slice(11, 19)} ${kindTag} ${entry.message}`);
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

  return lines;
}

function formatSwitchLine(message: string, useColor: boolean): string {
  const body = `${SWITCH_BAR} ${message} ${SWITCH_BAR}`;
  return colorize(body, 'kind_switch', useColor);
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

function formatKindTag(kind: string, useColor: boolean): string {
  const tag = `[${kind}]`;
  const normalized = kind.trim().toUpperCase();
  if (normalized === 'READ') {
    return colorize(tag, 'kind_read', useColor);
  }
  if (normalized === 'WRITE') {
    return colorize(tag, 'kind_write', useColor);
  }
  if (normalized === 'BASH' || normalized === 'EXEC') {
    return colorize(tag, 'kind_bash', useColor);
  }
  if (normalized === 'DONE') {
    return colorize(tag, 'kind_done', useColor);
  }
  if (normalized === 'ERR' || normalized === 'ERROR') {
    return colorize(tag, 'kind_err', useColor);
  }
  return colorize(tag, 'kind_info', useColor);
}
