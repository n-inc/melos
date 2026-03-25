import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';

const spawnMock = jest.fn();

jest.unstable_mockModule('node:child_process', () => ({
  spawn: spawnMock,
}));

const { ClaudeEngine } = await import('../claude.js');

function mockSuccessfulSpawn() {
  let capturedArgs: string[] = [];
  spawnMock.mockImplementation((...spawnArgs: unknown[]) => {
    capturedArgs = Array.isArray(spawnArgs[1]) ? [...spawnArgs[1] as string[]] : [];
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 12345;
    child.kill = () => undefined;
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('{"type":"result","result":"ok"}\n'));
      child.emit('close', 0);
    });
    return child;
  });
  return () => capturedArgs;
}

describe('ClaudeEngine', () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it('does not combine permissionMode with dangerously-skip-permissions by default', async () => {
    const readArgs = mockSuccessfulSpawn();
    const engine = new ClaudeEngine();

    const result = await engine.execute('hello', { permissionMode: 'dontAsk' });

    expect(result.success).toBe(true);
    expect(readArgs()).toContain('--permission-mode');
    expect(readArgs()).toContain('dontAsk');
    expect(readArgs()).not.toContain('--dangerously-skip-permissions');
  });

  it('keeps dangerously-skip-permissions enabled when no permissionMode is provided', async () => {
    const readArgs = mockSuccessfulSpawn();
    const engine = new ClaudeEngine();

    const result = await engine.execute('hello');

    expect(result.success).toBe(true);
    expect(readArgs()).toContain('--dangerously-skip-permissions');
  });
});
