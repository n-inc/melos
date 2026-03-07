import type { LogActor, UnifiedLogEntry } from '../state/log-entry.js';
import { colorize } from './tui-ansi.js';

const SWITCH_BAR = '─'.repeat(10);
const MAX_SUMMARIZED_READS = 5;
const MAX_SUMMARIZED_SEARCHES = 3;
const INSPECTION_COMMAND_PREFIXES = [
  'rg ',
  'grep ',
  'find ',
  'ls ',
  'cat ',
  'sed ',
  'head ',
  'tail ',
  'git diff ',
  'git log ',
] as const;
const VERIFICATION_COMMAND_PREFIXES = [
  'npm test',
  'npm run typecheck',
  'pnpm test',
  'pnpm typecheck',
  'bun test',
  'tsc ',
  'eslint ',
  'playwright ',
  'npx playwright ',
] as const;

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
    summarizeExploration?: boolean;
  }
): string[] {
  const lock = options.lock ?? 'auto';
  const lines: string[] = [];
  const displayEntries = options.summarizeExploration
    ? summarizeLowPriorityLogEntries(entries)
    : entries;

  if (options.switchNotice) {
    lines.push(formatSwitchLine(options.switchNotice, options.useColor));
  }

  let previousActor = options.previousActor ?? null;
  for (const entry of displayEntries) {
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

export function summarizeLowPriorityLogEntries(
  entries: Array<FormattedLogEntry | UnifiedLogEntry>
): FormattedLogEntry[] {
  const summarized: FormattedLogEntry[] = [];
  let buffer: FormattedLogEntry[] = [];

  const flush = () => {
    if (buffer.length === 0) {
      return;
    }
    const explored = createExplorationSummaryEntry(buffer);
    if (explored) {
      summarized.push(explored);
    }
    buffer = [];
  };

  for (const entry of entries) {
    const normalizedEntry = toFormattedLogEntry(entry);
    const absorbIntoExploration = shouldAbsorbExplorationCompletion(normalizedEntry, buffer);
    if (!absorbIntoExploration && !isLowPriorityLogEntry(normalizedEntry)) {
      flush();
      summarized.push(normalizedEntry);
      continue;
    }

    if (buffer.length > 0 && buffer[0]?.actor !== normalizedEntry.actor) {
      flush();
    }
    buffer.push(normalizedEntry);
  }

  flush();
  return summarized;
}

function shouldAbsorbExplorationCompletion(
  entry: FormattedLogEntry,
  buffer: FormattedLogEntry[]
): boolean {
  if (buffer.length === 0) {
    return false;
  }
  if (entry.actor !== buffer[0]?.actor) {
    return false;
  }
  if (entry.kind.trim().toUpperCase() !== 'DONE') {
    return false;
  }
  return /^exit=0 \d+ms$/.test(entry.message);
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

function toFormattedLogEntry(entry: FormattedLogEntry | UnifiedLogEntry): FormattedLogEntry {
  return {
    seq: entry.seq,
    timestamp: entry.timestamp,
    actor: entry.actor,
    kind: entry.kind,
    message: entry.message,
    detailLines: entry.detailLines ? [...entry.detailLines] : undefined,
  };
}

function isLowPriorityLogEntry(entry: FormattedLogEntry): boolean {
  const normalizedKind = entry.kind.trim().toUpperCase();
  if (normalizedKind === 'READ') {
    return true;
  }
  if (normalizedKind === 'BASH') {
    return isInspectionCommand(entry.message);
  }
  if (normalizedKind !== 'INFO') {
    return false;
  }
  return isLowPriorityInfoEntry(entry);
}

function isInspectionCommand(message: string): boolean {
  const normalized = normalizeInspectionCommand(message);
  if (startsWithAny(normalized, VERIFICATION_COMMAND_PREFIXES)) {
    return false;
  }
  return startsWithAny(normalized, INSPECTION_COMMAND_PREFIXES);
}

function normalizeInspectionCommand(message: string): string {
  let normalized = message.trim().replace(/\s+/g, ' ');
  const shellWrapped = normalized.match(/^(?:\/bin\/\S+|bash|zsh|sh)\s+-lc\s+(['"])([\s\S]*)\1$/);
  if (shellWrapped) {
    normalized = shellWrapped[2] ?? normalized;
  }
  return normalized
    .replace(/\\"/g, '"')
    .replace(/\\'/g, '\'')
    .trim();
}

function startsWithAny(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

function isLowPriorityInfoEntry(entry: FormattedLogEntry): boolean {
  const lines = [entry.message, ...(entry.detailLines ?? [])];
  if (entry.message.startsWith('verbose tool output omitted')) {
    return true;
  }
  if (entry.message.startsWith('No matches found')) {
    return true;
  }
  if (entry.message.startsWith('File does not exist.')) {
    return true;
  }
  if (entry.message.startsWith('> ')) {
    return true;
  }
  return lines.length > 0 && lines.every((line) => looksLikeSearchResultLine(line));
}

function looksLikeSearchResultLine(value: string): boolean {
  const line = value.trim();
  if (!line) {
    return false;
  }
  return /^\d+:\s*\S+/.test(line) || /^[^:\s]+:\d+(?::| ).+/.test(line);
}

function createExplorationSummaryEntry(entries: FormattedLogEntry[]): FormattedLogEntry | null {
  const summary = summarizeExploration(entries);
  const primaryParts = [
    summary.reads.length > 0 ? formatCount(summary.reads.length, 'file') : null,
    summary.searches.length > 0 ? formatCount(summary.searches.length, 'search', 'searches') : null,
    summary.omittedOutputs > 0 ? formatCount(summary.omittedOutputs, 'omitted output') : null,
  ].filter((value): value is string => value !== null);

  if (primaryParts.length === 0 && summary.missingFiles.length === 0) {
    return null;
  }

  const detailLines: string[] = [];
  if (summary.reads.length > 0) {
    detailLines.push(`Read: ${formatLimitedList(summary.reads, MAX_SUMMARIZED_READS)}`);
  }
  if (summary.searches.length > 0) {
    detailLines.push(`Search: ${formatLimitedList(summary.searches, MAX_SUMMARIZED_SEARCHES)}`);
  }

  const noteParts: string[] = [];
  for (const file of summary.missingFiles) {
    noteParts.push(`${file} missing`);
  }
  if (summary.lowPriorityInfoCount > 0) {
    noteParts.push(formatCount(summary.lowPriorityInfoCount, 'low-priority info'));
  }
  if (noteParts.length > 0) {
    detailLines.push(`Notes: ${noteParts.join(', ')}`);
  }

  return {
    seq: entries[0]?.seq,
    timestamp: entries[0]?.timestamp ?? new Date().toISOString(),
    actor: entries[0]?.actor ?? 'system',
    kind: 'EXPLORED',
    message: primaryParts.length > 0 ? primaryParts.join(', ') : 'low-priority activity',
    detailLines: detailLines.length > 0 ? detailLines : undefined,
  };
}

function summarizeExploration(entries: FormattedLogEntry[]): {
  reads: string[];
  searches: string[];
  omittedOutputs: number;
  missingFiles: string[];
  lowPriorityInfoCount: number;
} {
  const reads: string[] = [];
  const searches: string[] = [];
  const missingFiles: string[] = [];
  let omittedOutputs = 0;
  let lowPriorityInfoCount = 0;
  let lastRead: string | null = null;

  for (const entry of entries) {
    const normalizedKind = entry.kind.trim().toUpperCase();
    if (normalizedKind === 'READ') {
      const fileName = extractReadFileName(entry.message);
      if (fileName) {
        pushUnique(reads, fileName);
        lastRead = fileName;
      }
      continue;
    }

    if (normalizedKind === 'BASH') {
      const labels = extractSearchLabels(entry.message);
      if (labels.length === 0) {
        pushUnique(searches, buildSearchFallbackLabel(entry.message));
      } else {
        for (const label of labels) {
          pushUnique(searches, label);
        }
      }
      continue;
    }

    if (entry.message.startsWith('verbose tool output omitted')) {
      omittedOutputs += 1;
      continue;
    }
    if (entry.message.startsWith('File does not exist.')) {
      if (lastRead) {
        pushUnique(missingFiles, lastRead);
      }
      continue;
    }
    if (entry.message.startsWith('No matches found')) {
      continue;
    }
    const lines = [entry.message, ...(entry.detailLines ?? [])];
    if (lines.every((line) => looksLikeSearchResultLine(line))) {
      continue;
    }
    if (isLowPriorityInfoEntry(entry)) {
      lowPriorityInfoCount += 1;
    }
  }

  return {
    reads,
    searches,
    omittedOutputs,
    missingFiles,
    lowPriorityInfoCount,
  };
}

function extractReadFileName(message: string): string | null {
  const rawPath = message.split(' (')[0]?.trim();
  if (!rawPath) {
    return null;
  }
  const segments = rawPath.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? rawPath;
}

function extractSearchLabels(message: string): string[] {
  const normalized = normalizeInspectionCommand(message);
  const patternLabels = extractPatternLabels(normalized);
  if (patternLabels.length > 0) {
    return patternLabels;
  }

  const pathLabels = extractPathLabels(normalized);
  if (pathLabels.length > 0) {
    return pathLabels;
  }
  return [];
}

function extractPatternLabels(command: string): string[] {
  if (!/^(?:rg|grep)\b/.test(command)) {
    return [];
  }

  const labels: string[] = [];
  for (const segment of extractQuotedSegments(command)) {
    if (!/[A-Za-z0-9_[\].-]/.test(segment) || segment.includes('*.')) {
      continue;
    }
    for (const rawPart of segment.split('|')) {
      const cleaned = normalizeSearchLabel(rawPart);
      if (cleaned) {
        pushUnique(labels, cleaned);
      }
    }
  }
  return labels;
}

function extractQuotedSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | '\'' | null = null;
  let escaping = false;

  for (const char of command) {
    if (quote) {
      if (escaping) {
        current += char;
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === quote) {
        if (current.length > 0) {
          segments.push(current);
        }
        current = '';
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === '\'') {
      quote = char;
    }
  }

  return segments;
}

function normalizeSearchLabel(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed
    .replace(/\\([.[\]{}()+?*|\\])/g, '$1')
    .replace(/\\\//g, '/')
    .trim();
}

function extractPathLabels(command: string): string[] {
  const labels: string[] = [];
  const gitPathMatch = command.match(/\s--\s([^|;&]+)/);
  if (gitPathMatch?.[1]) {
    for (const token of gitPathMatch[1].trim().split(/\s+/)) {
      const cleaned = normalizePathLabel(token);
      if (cleaned) {
        pushUnique(labels, cleaned);
      }
    }
    return labels;
  }

  const pathMatches = command.match(/(?:\.{0,2}\/)?[A-Za-z0-9_@[\]-]+(?:\/[A-Za-z0-9_@.[\]-]+)*(?:\.[A-Za-z0-9_-]+)?/g) ?? [];
  for (const token of pathMatches) {
    const cleaned = normalizePathLabel(token);
    if (cleaned) {
      pushUnique(labels, cleaned);
    }
  }
  return labels;
}

function normalizePathLabel(value: string): string | null {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return null;
  }
  if (/^(?:rg|grep|find|ls|cat|sed|head|tail|git|npm|pnpm|bun|tsc|eslint)$/.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith('-')) {
    return null;
  }
  if (!/[/.[]/.test(trimmed) && !trimmed.includes('src') && !trimmed.includes('test') && !trimmed.includes('page')) {
    return null;
  }
  return trimmed;
}

function buildSearchFallbackLabel(message: string): string {
  const normalized = normalizeInspectionCommand(message);
  return normalized.length > 48
    ? `${normalized.slice(0, 45)}...`
    : normalized;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatLimitedList(values: string[], limit: number): string {
  if (values.length <= limit) {
    return values.join(', ');
  }
  return `${values.slice(0, limit).join(', ')}, +${values.length - limit} more`;
}

function pushUnique(values: string[], next: string): void {
  if (!values.includes(next)) {
    values.push(next);
  }
}
