import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface MissionSnapshot<TState = Record<string, unknown>> {
  seq: number;
  savedAt: string;
  state: TState;
}

export function getSnapshotPath(melosDir: string): string {
  return join(melosDir, 'state.json');
}

export async function saveSnapshot<TState>(
  melosDir: string,
  snapshot: MissionSnapshot<TState>
): Promise<void> {
  await writeFile(getSnapshotPath(melosDir), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
}

export async function loadSnapshot<TState>(
  melosDir: string
): Promise<MissionSnapshot<TState> | null> {
  const path = getSnapshotPath(melosDir);
  if (!existsSync(path)) {
    return null;
  }

  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as MissionSnapshot<TState>;
}
