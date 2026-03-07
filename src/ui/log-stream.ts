import type { LogActor, UnifiedLogEntry } from '../state/log-entry.js';
import { colorize } from './tui-ansi.js';

const SWITCH_BAR = '─'.repeat(10);

export interface FormattedLogEntry {
  seq?: number;
  timestamp: string;
  actor: LogActor;
  kind: string;
  message: string;
  detailLines?: string[];
}

export function filterLogEntriesByLock<T extends { actor: LogActor }>(
  entries: T[],
  lock: 'auto' | 'worker' | 'manager'
): T[] {
  if (lock === 'auto') {
    return entries;
  }
  if (lock === 'worker') {
    return entries.filter((entry) => entry.actor === 'worker');
  }
  return entries.filter((entry) => entry.actor === 'manager' || entry.actor === 'planning');
}

export function formatLogStreamLines(
  entries: Array<FormattedLogEntry | UnifiedLogEntry>,
  options: {
    lock?: 'auto' | 'worker' | 'manager';
    switchNotice?: string | null;
    pendingPrompt?: string | null;
    useColor: boolean;
    showSeq?: boolean;
    showActor?: boolean;
    previousActor?: LogActor | null;
  }
): string[] {
  const lock = options.lock ?? 'auto';
  const lines: string[] = [];

  if (options.switchNotice) {
    lines.push(formatSwitchLine(options.switchNotice, options.useColor));
  }

  let previousActor = options.previousActor ?? null;
  for (const entry of entries) {
    if (!previousActor) {
      lines.push(formatSwitchLine(`LOG START: ${actorName(entry.actor)}`, options.useColor));
    } else if (lock === 'auto' && previousActor !== entry.actor) {
      lines.push(formatSwitchLine(`SWITCH: ${actorName(previousActor)} -> ${actorName(entry.actor)}`, options.useColor));
    }
    previousActor = entry.actor;

    const parts: string[] = [];
    if (options.showSeq && typeof entry.seq === 'number') {
      parts.push(`#${String(entry.seq).padStart(4, '0')}`);
    }
    parts.push(entry.timestamp.slice(11, 19));
    if (options.showActor) {
      parts.push(actorName(entry.actor).padEnd(10, ' '));
    }
    parts.push(formatKindTag(entry.kind, options.useColor));
    parts.push(entry.message);
    lines.push(parts.join(' '));

    for (const detail of entry.detailLines ?? []) {
      lines.push(`  │ ${detail}`);
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

export function actorName(actor: LogActor): string {
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

export function formatKindTag(kind: string, useColor: boolean): string {
  const tag = `[${kind}]`;
  const normalized = kind.trim().toUpperCase();
  if (normalized === 'READ') {
    return colorize(tag, 'kind_read', useColor);
  }
  if (normalized === 'WRITE' || normalized === 'APPROVAL_WAIT' || normalized === 'INPUT') {
    return colorize(tag, 'kind_write', useColor);
  }
  if (normalized === 'BASH' || normalized === 'EXEC' || normalized === 'OUTPUT' || normalized === 'CMD') {
    return colorize(tag, 'kind_bash', useColor);
  }
  if (normalized === 'DONE') {
    return colorize(tag, 'kind_done', useColor);
  }
  if (normalized === 'REPLY') {
    return colorize(tag, 'kind_reply', useColor);
  }
  if (normalized === 'THINK') {
    return colorize(tag, 'kind_think', useColor);
  }
  if (normalized === 'ERR' || normalized === 'ERROR' || normalized === 'FALLBACK') {
    return colorize(tag, 'kind_err', useColor);
  }
  return colorize(tag, 'kind_info', useColor);
}

function formatSwitchLine(message: string, useColor: boolean): string {
  const body = `${SWITCH_BAR} ${message} ${SWITCH_BAR}`;
  return colorize(body, 'kind_switch', useColor);
}
