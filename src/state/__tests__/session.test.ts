import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearSession,
  getSessionPath,
  loadSession,
  saveSession,
  sessionExists,
} from '../session.js';

describe('session state', () => {
  let rootDir: string;
  let melosDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'melos-session-test-'));
    melosDir = join(rootDir, '.melos');
    await mkdir(melosDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('saves and loads SESSION.json', async () => {
    await saveSession(melosDir, {
      threadId: 'thr_123',
      currentTaskId: 'task-5',
      iteration: 3,
      interruptedAt: '2026-02-22T00:00:00.000Z',
      model: 'gpt-5.3-codex',
    });

    expect(sessionExists(melosDir)).toBe(true);
    await expect(loadSession(melosDir)).resolves.toEqual({
      threadId: 'thr_123',
      currentTaskId: 'task-5',
      iteration: 3,
      interruptedAt: '2026-02-22T00:00:00.000Z',
      model: 'gpt-5.3-codex',
    });
  });

  it('clears SESSION.json', async () => {
    await saveSession(melosDir, {
      threadId: 'thr_123',
      currentTaskId: 'task-5',
      iteration: 3,
      interruptedAt: '2026-02-22T00:00:00.000Z',
      model: 'gpt-5.3-codex',
    });
    await clearSession(melosDir);

    expect(sessionExists(melosDir)).toBe(false);
    await expect(loadSession(melosDir)).resolves.toBeNull();
  });

  it('returns SESSION.json path', () => {
    expect(getSessionPath('/tmp/project/.melos')).toBe('/tmp/project/.melos/SESSION.json');
  });

  it('saves and loads pending steers without active task', async () => {
    await saveSession(melosDir, {
      iteration: 7,
      interruptedAt: '2026-02-25T00:00:00.000Z',
      pendingSteers: ['fix flaky tests', 'avoid force push'],
    });

    await expect(loadSession(melosDir)).resolves.toEqual({
      iteration: 7,
      interruptedAt: '2026-02-25T00:00:00.000Z',
      pendingSteers: ['fix flaky tests', 'avoid force push'],
    });
  });
});
