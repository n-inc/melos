export type LogActor = 'planning' | 'manager' | 'worker' | 'validator' | 'system' | 'idle';

export interface UnifiedLogEntry {
  seq?: number;
  timestamp: string;
  actor: LogActor;
  kind: string;
  message: string;
  detailLines?: string[];
}

export interface NormalizedLogMessage {
  kind: string;
  message: string;
  detailLines?: string[];
}

export function normalizeLogMessage(
  rawMessage: string,
  defaultKind: string,
  options?: {
    maxDetailLines?: number;
    maxDetailWidth?: number;
    maxMessageWidth?: number;
    maxWrappedMessageLines?: number;
  }
): NormalizedLogMessage {
  const lines = splitLogLines(rawMessage);
  const first = lines[0] ?? '';
  const parsed = parseKindAndMessage(first, defaultKind);
  const wrappedMessage = wrapLogText(
    parsed.message,
    options?.maxMessageWidth ?? 140,
    options?.maxWrappedMessageLines ?? 6
  );
  const detailSource = [
    ...wrappedMessage.slice(1),
    ...lines.slice(1),
  ];
  const detailLines = detailSource.length > 0
    ? limitDetailLines(detailSource, options?.maxDetailLines ?? 12, options?.maxDetailWidth ?? 220)
    : undefined;
  return {
    kind: parsed.kind,
    message: wrappedMessage[0] ?? parsed.message,
    detailLines,
  };
}

export function wrapLogText(
  value: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let remaining = normalized;
  while (remaining.length > 0) {
    if (remaining.length <= maxWidth) {
      lines.push(remaining);
      break;
    }

    const splitAt = findWrapBoundary(remaining, maxWidth);
    lines.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  return limitLineCount(lines, maxLines);
}

function splitLogLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ''))
    .filter((line) => line.length > 0);
}

function parseKindAndMessage(firstLine: string, defaultKind: string): { kind: string; message: string } {
  const normalized = stripKnownLogPrefix(firstLine.trim());
  const tagged = normalized.match(/^\[([A-Z0-9_]+)\]\s*(.*)$/);
  if (tagged) {
    const kind = tagged[1];
    const message = tagged[2] && tagged[2].trim().length > 0 ? tagged[2].trim() : kind;
    return { kind, message };
  }
  const cleanMessage = normalized.trim();
  return {
    kind: defaultKind,
    message: cleanMessage.length > 0 ? cleanMessage : defaultKind,
  };
}

function stripKnownLogPrefix(value: string): string {
  let normalized = value;
  while (true) {
    const stripped = normalized.replace(/^(planning|briefing|manager|worker|validator|validation|system):\s*/i, '');
    if (stripped === normalized) {
      return normalized;
    }
    normalized = stripped;
  }
}

function limitDetailLines(
  lines: string[],
  maxLines: number,
  maxWidth: number
): string[] {
  const clipped = lines
    .slice(0, maxLines)
    .map((line) => (line.length > maxWidth ? `${line.slice(0, maxWidth - 3)}...` : line));
  if (lines.length > maxLines) {
    clipped.push(`... +${lines.length - maxLines} more lines`);
  }
  return clipped;
}

function limitLineCount(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  return [
    ...lines.slice(0, maxLines - 1),
    `... +${lines.length - (maxLines - 1)} more lines`,
  ];
}

function findWrapBoundary(value: string, maxWidth: number): number {
  const preferred = [
    value.lastIndexOf('. ', maxWidth),
    value.lastIndexOf('。', maxWidth),
    value.lastIndexOf('、', maxWidth),
    value.lastIndexOf(', ', maxWidth),
    value.lastIndexOf(' ', maxWidth),
  ].find((index) => index >= Math.floor(maxWidth * 0.55));

  if (preferred === undefined || preferred < 0) {
    return maxWidth;
  }
  return preferred + (value[preferred] === ' ' ? 0 : 1);
}
