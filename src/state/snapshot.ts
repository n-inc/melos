import { existsSync, mkdirSync } from 'node:fs';
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
  mkdirSync(melosDir, { recursive: true });
  await writeFile(getSnapshotPath(melosDir), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
}

export async function loadSnapshot<TState>(
  melosDir: string
): Promise<MissionSnapshot<TState> | null> {
  const path = getSnapshotPath(melosDir);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as MissionSnapshot<TState>;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
