import type { TUIView, MissionControlState, ViewPort } from './tui-views.js';
import type { LogActor } from '../state/log-entry.js';
import { truncateDisplay, wrapPlainDisplay, colorize } from './tui-ansi.js';
import { filterLogEntriesByLock, formatLogStreamLines } from './log-stream.js';

export interface WorkersViewMetrics {
  totalLines: number;
  availableLogLines: number;
  maxOffset: number;
}

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

    const entries = filterLogEntriesByLock(state.logEntries, lock);
    const streamLines = formatLogStreamLines(entries, {
      lock,
      switchNotice: context?.sourceSwitchNotice ?? null,
      pendingPrompt: state.pendingPrompt,
      useColor,
      previousActor: null,
    });

    const wrapped = streamLines.flatMap((line) => wrapPlainDisplay(line, width));
    const reserved = 2;
    const availableLogLines = Math.max(1, viewport.height - reserved);
    const maxOffset = Math.max(0, wrapped.length - availableLogLines);
    const safeOffset = scrollOffset >= Number.MAX_SAFE_INTEGER
      ? maxOffset
      : Math.min(scrollOffset, maxOffset);
    const visibleLogLines = wrapped.slice(safeOffset, safeOffset + availableLogLines);
    const followMode = context?.workersFollowMode
      ?? (scrollOffset >= Number.MAX_SAFE_INTEGER ? 'live' : 'scrollback');
    const unreadCount = Math.max(0, context?.workersUnreadCount ?? 0);
    const modeLabel = followMode === 'live'
      ? colorize('LIVE', 'kind_done', useColor)
      : colorize(
        unreadCount > 0 ? `SCROLLBACK +${unreadCount} new` : 'SCROLLBACK',
        unreadCount > 0 ? 'kind_write' : 'label_dim',
        useColor
      );
    const lineSummary = wrapped.length === 0
      ? 'Lines 0/0'
      : `Lines ${safeOffset + 1}-${Math.min(wrapped.length, safeOffset + availableLogLines)}/${wrapped.length}`;

    return [
      truncateDisplay(`${nowRunning}  ${modeLabel}  ${lineSummary}`, width),
      separator,
      ...visibleLogLines.map((line) => truncateDisplay(line, width)),
    ];
  },
};

export function computeWorkersScrollMetrics(
  viewport: ViewPort,
  state: MissionControlState,
  context?: {
    logSourceLock?: 'auto' | 'worker' | 'manager';
    sourceSwitchNotice?: string | null;
    useColor?: boolean;
  }
): WorkersViewMetrics {
  const width = Math.max(40, viewport.width);
  const lock = context?.logSourceLock ?? 'auto';
  const entries = filterLogEntriesByLock(state.logEntries, lock);
  const streamLines = formatLogStreamLines(entries, {
    lock,
    switchNotice: context?.sourceSwitchNotice ?? null,
    pendingPrompt: state.pendingPrompt,
    useColor: context?.useColor === true,
    previousActor: null,
  });
  const wrapped = streamLines.flatMap((line) => wrapPlainDisplay(line, width));
  const reserved = 2;
  const availableLogLines = Math.max(1, viewport.height - reserved);
  return {
    totalLines: wrapped.length,
    availableLogLines,
    maxOffset: Math.max(0, wrapped.length - availableLogLines),
  };
}

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
