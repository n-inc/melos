import { readFile, unlink, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AskUserPrompt } from '../agents/types.js';
import type { Escalation } from './escalation.js';

/**
 * 中断時セッション
 */
export interface MelosSession {
  threadId?: string;
  currentTaskId?: string;
  interruptedAgent?: 'manager' | 'worker';
  iteration: number;
  interruptedAt: string;
  model?: string;
  pendingSteers?: string[];
  pendingQuestion?: AskUserPrompt;
  pendingEscalation?: Escalation;
}

/**
 * SESSION.json のパス
 */
export function getSessionPath(melosDir: string): string {
  return join(melosDir, 'SESSION.json');
}

/**
 * セッションが存在するか
 */
export function sessionExists(melosDir: string): boolean {
  return existsSync(getSessionPath(melosDir));
}

/**
 * セッション読み込み
 */
export async function loadSession(melosDir: string): Promise<MelosSession | null> {
  const path = getSessionPath(melosDir);
  if (!existsSync(path)) {
    return null;
  }
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as MelosSession;
}

/**
 * セッション保存
 */
export async function saveSession(melosDir: string, session: MelosSession): Promise<void> {
  if (!existsSync(melosDir)) {
    mkdirSync(melosDir, { recursive: true });
  }
  const path = getSessionPath(melosDir);
  await writeFile(path, JSON.stringify(session, null, 2) + '\n', 'utf-8');
}

/**
 * セッションクリア
 */
export async function clearSession(melosDir: string): Promise<void> {
  const path = getSessionPath(melosDir);
  if (!existsSync(path)) {
    return;
  }
  await unlink(path);
}
