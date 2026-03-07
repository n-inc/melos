export interface ProgressLogEntry {
  timestamp: string;
  message: string;
}

export function selectRecentProgressEntries(
  entries: ProgressLogEntry[],
  maxRows: number
): ProgressLogEntry[] {
  if (entries.length === 0 || maxRows <= 0) {
    return [];
  }

  const nonHeartbeatEntries = entries.filter((entry) => !isManagerHeartbeat(entry.message));
  if (nonHeartbeatEntries.length > 0) {
    return nonHeartbeatEntries.slice(-maxRows);
  }

  return entries.slice(-1);
}

function isManagerHeartbeat(message: string): boolean {
  return /^Manager is .*\(\d+s elapsed\)$/.test(message.trim());
}
