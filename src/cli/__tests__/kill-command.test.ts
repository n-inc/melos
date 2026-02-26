import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { killMelosRun } from '../../cli.js';
import { runtimeExists, saveRuntime } from '../../state/runtime.js';

describe('kill command core', () => {
  let rootDir: string;
  let melosDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'melos-kill-test-'));
    melosDir = join(rootDir, '.melos');
    await mkdir(melosDir, { recursive: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('returns not_running when RUN.json does not exist', async () => {
    await expect(killMelosRun(rootDir)).resolves.toEqual({ status: 'not_running' });
  });

  it('returns stale and clears RUN.json when pid is not alive', async () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((() => {
      const error = new Error('no such process') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    }) as typeof process.kill);

    await saveRuntime(melosDir, {
      pid: 2468,
      startedAt: '2026-02-25T00:00:00.000Z',
      cwd: rootDir,
    });

    await expect(killMelosRun(rootDir)).resolves.toEqual({
      status: 'stale',
      pid: 2468,
    });
    expect(runtimeExists(melosDir)).toBe(false);
    expect(killSpy).toHaveBeenCalledWith(2468, 0);
  });

  it('sends SIGTERM when pid is alive', async () => {
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill);

    await saveRuntime(melosDir, {
      pid: 8642,
      startedAt: '2026-02-25T00:00:00.000Z',
      cwd: rootDir,
    });

    await expect(killMelosRun(rootDir)).resolves.toEqual({
      status: 'killed',
      pid: 8642,
    });
    expect(killSpy).toHaveBeenCalledWith(8642, 0);
    expect(killSpy).toHaveBeenCalledWith(8642, 'SIGTERM');
  });
});
