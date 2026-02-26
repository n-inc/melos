import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import {
  clearRuntime,
  getRuntimePath,
  isProcessAlive,
  loadRuntime,
  runtimeExists,
  saveRuntime,
  terminateProcess,
} from '../runtime.js';

describe('runtime state', () => {
  let rootDir: string;
  let melosDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'melos-runtime-test-'));
    melosDir = join(rootDir, '.melos');
    await mkdir(melosDir, { recursive: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('saves and loads RUN.json', async () => {
    await saveRuntime(melosDir, {
      pid: 1234,
      startedAt: '2026-02-25T00:00:00.000Z',
      cwd: '/tmp/project',
    });

    expect(runtimeExists(melosDir)).toBe(true);
    await expect(loadRuntime(melosDir)).resolves.toEqual({
      pid: 1234,
      startedAt: '2026-02-25T00:00:00.000Z',
      cwd: '/tmp/project',
    });
  });

  it('clears RUN.json', async () => {
    await saveRuntime(melosDir, {
      pid: 1234,
      startedAt: '2026-02-25T00:00:00.000Z',
      cwd: '/tmp/project',
    });
    await clearRuntime(melosDir);

    expect(runtimeExists(melosDir)).toBe(false);
    await expect(loadRuntime(melosDir)).resolves.toBeNull();
  });

  it('returns RUN.json path', () => {
    expect(getRuntimePath('/tmp/project/.melos')).toBe('/tmp/project/.melos/RUN.json');
  });

  it('treats EPERM as alive in process check', () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }) as typeof process.kill);

    expect(isProcessAlive(4321)).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(4321, 0);
  });

  it('returns false for ESRCH in process check', () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((() => {
      const error = new Error('no such process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    }) as typeof process.kill);

    expect(isProcessAlive(4321)).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(4321, 0);
  });

  it('returns false for invalid pid', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });

  it('sends SIGTERM to target pid', () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    terminateProcess(777);

    expect(killSpy).toHaveBeenCalledWith(777, 'SIGTERM');
  });
});
