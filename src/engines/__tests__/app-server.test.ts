import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { jest } from '@jest/globals';
import { AppServerEngine } from '../app-server.js';
import { JsonRpcTransport } from '../jsonrpc-transport.js';

class MockTransport {
  readonly requests: Array<{ method: string; params: unknown; timeoutMs?: number }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  private readonly notificationHandlers = new Set<
    (method: string, params: unknown) => void | Promise<void>
  >();
  private serverRequestHandler:
    | ((request: { method: string; id: string | number; params?: unknown }) => unknown | Promise<unknown>)
    | null = null;
  requestHandler: (
    method: string,
    params: unknown,
    timeoutMs?: number
  ) => Promise<unknown> = async () => ({});

  start(): void {
    // no-op
  }

  close(): void {
    this.notificationHandlers.clear();
  }

  setServerRequestHandler(
    handler: (request: { method: string; id: string | number; params?: unknown }) => unknown | Promise<unknown>
  ): void {
    this.serverRequestHandler = handler;
  }

  onNotification(
    handler: (method: string, params: unknown) => void | Promise<void>
  ): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    this.requests.push({ method, params, timeoutMs });
    return await this.requestHandler(method, params, timeoutMs) as T;
  }

  async emitNotification(method: string, params: unknown): Promise<void> {
    for (const handler of this.notificationHandlers) {
      await handler(method, params);
    }
  }

  async handleServerRequest(method: string, id: number, params?: unknown): Promise<unknown> {
    if (!this.serverRequestHandler) {
      throw new Error('no server request handler');
    }
    return await this.serverRequestHandler({ method, id, params });
  }
}

function createFakeChildProcess(): ChildProcessWithoutNullStreams {
  const emitter = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  emitter.stdin = new PassThrough();
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.killed = false;
  emitter.kill = () => {
    emitter.killed = true;
    setImmediate(() => {
      emitter.emit('close', 0);
    });
    return true;
  };
  return emitter as unknown as ChildProcessWithoutNullStreams;
}

describe('AppServerEngine', () => {
  it('executes a turn and streams agent deltas', async () => {
    const transport = new MockTransport();
    transport.requestHandler = async (method) => {
      if (method === 'initialize') {
        return { userAgent: 'codex-app-server-test' };
      }
      if (method === 'thread/start') {
        return { thread: { id: 'thr_1' } };
      }
      if (method === 'turn/start') {
        setImmediate(async () => {
          await transport.emitNotification('item/agentMessage/delta', {
            threadId: 'thr_1',
            turnId: 'turn_1',
            itemId: 'item_1',
            delta: 'hello ',
          });
          await transport.emitNotification('item/agentMessage/delta', {
            threadId: 'thr_1',
            turnId: 'turn_1',
            itemId: 'item_1',
            delta: 'world',
          });
          await transport.emitNotification('turn/completed', {
            threadId: 'thr_1',
            turn: {
              id: 'turn_1',
              status: 'completed',
              error: null,
            },
          });
        });
        return { turn: { id: 'turn_1' } };
      }
      throw new Error(`unexpected method: ${method}`);
    };

    const engine = new AppServerEngine({
      spawnProcess: () => createFakeChildProcess(),
      createTransport: () => transport as unknown as JsonRpcTransport,
    });

    const chunks: string[] = [];
    const events: string[] = [];
    const result = await engine.execute('test prompt', {
      cwd: process.cwd(),
      onStream: (chunk) => {
        chunks.push(chunk);
      },
      onEvent: (method) => {
        events.push(method);
      },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('hello world');
    expect(chunks).toEqual(['hello ', 'world']);
    expect(events).toEqual(['item/agentMessage/delta', 'item/agentMessage/delta', 'turn/completed']);
    expect(engine.getActiveThreadId()).toBe('thr_1');
    expect(transport.notifications.some((event) => event.method === 'initialized')).toBe(true);
    const turnStartRequest = transport.requests.find((request) => request.method === 'turn/start');
    expect(turnStartRequest).toBeDefined();
    expect(turnStartRequest?.params).toMatchObject({ effort: 'high' });
  });

  it('resolves latest aliases before starting a new thread', async () => {
    const transport = new MockTransport();
    transport.requestHandler = async (method) => {
      if (method === 'initialize') {
        return { userAgent: 'codex-app-server-test' };
      }
      if (method === 'thread/start') {
        return { thread: { id: 'thr_alias' } };
      }
      if (method === 'turn/start') {
        setImmediate(async () => {
          await transport.emitNotification('turn/completed', {
            threadId: 'thr_alias',
            turn: {
              id: 'turn_alias',
              status: 'completed',
              error: null,
            },
          });
        });
        return { turn: { id: 'turn_alias' } };
      }
      throw new Error(`unexpected method: ${method}`);
    };

    const engine = new AppServerEngine({
      spawnProcess: () => createFakeChildProcess(),
      createTransport: () => transport as unknown as JsonRpcTransport,
    });

    const result = await engine.execute('test prompt', {
      model: 'codex-latest',
    });

    expect(result.success).toBe(true);
    const threadStartRequest = transport.requests.find((request) => request.method === 'thread/start');
    const turnStartRequest = transport.requests.find((request) => request.method === 'turn/start');
    expect(threadStartRequest?.params).toMatchObject({ model: 'gpt-5.4' });
    expect(turnStartRequest?.params).toMatchObject({ model: 'gpt-5.4' });
  });

  it('sends turn/interrupt on abort', async () => {
    const transport = new MockTransport();
    transport.requestHandler = async (method) => {
      if (method === 'initialize') {
        return { userAgent: 'codex-app-server-test' };
      }
      if (method === 'thread/start') {
        return { thread: { id: 'thr_2' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn_2' } };
      }
      if (method === 'turn/interrupt') {
        setImmediate(async () => {
          await transport.emitNotification('turn/completed', {
            threadId: 'thr_2',
            turn: {
              id: 'turn_2',
              status: 'interrupted',
              error: null,
            },
          });
        });
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    };

    const engine = new AppServerEngine({
      spawnProcess: () => createFakeChildProcess(),
      createTransport: () => transport as unknown as JsonRpcTransport,
    });

    const executePromise = engine.execute('long running');
    await new Promise((resolve) => setTimeout(resolve, 10));
    engine.abort();
    const result = await executePromise;

    const interruptCall = transport.requests.find((req) => req.method === 'turn/interrupt');
    expect(interruptCall).toBeDefined();
    expect(result.success).toBe(false);
    expect(result.error).toBe('Turn interrupted');
  });

  it('sends turn/steer while a turn is active', async () => {
    const transport = new MockTransport();
    transport.requestHandler = async (method) => {
      if (method === 'initialize') {
        return { userAgent: 'codex-app-server-test' };
      }
      if (method === 'thread/start') {
        return { thread: { id: 'thr_3' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn_3' } };
      }
      if (method === 'turn/steer') {
        setImmediate(async () => {
          await transport.emitNotification('item/agentMessage/delta', {
            threadId: 'thr_3',
            turnId: 'turn_3',
            itemId: 'item_3',
            delta: 'updated',
          });
          await transport.emitNotification('turn/completed', {
            threadId: 'thr_3',
            turn: {
              id: 'turn_3',
              status: 'completed',
              error: null,
            },
          });
        });
        return { turnId: 'turn_3' };
      }
      throw new Error(`unexpected method: ${method}`);
    };

    const engine = new AppServerEngine({
      spawnProcess: () => createFakeChildProcess(),
      createTransport: () => transport as unknown as JsonRpcTransport,
    });

    const executePromise = engine.execute('long running');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const steerAccepted = await engine.steer('follow this direction');
    const result = await executePromise;

    const steerCall = transport.requests.find((req) => req.method === 'turn/steer');
    expect(steerAccepted).toBe(true);
    expect(steerCall).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.output).toBe('updated');
  });

  it('suppresses terminal writes when suppressTerminalOutput is enabled', async () => {
    const transport = new MockTransport();
    const child = createFakeChildProcess();
    transport.requestHandler = async (method) => {
      if (method === 'initialize') {
        return { userAgent: 'codex-app-server-test' };
      }
      if (method === 'thread/start') {
        return { thread: { id: 'thr_4' } };
      }
      if (method === 'turn/start') {
        setImmediate(async () => {
          (child.stderr as PassThrough).write('worker stderr noise\n');
          await transport.emitNotification('item/commandExecution/outputDelta', {
            threadId: 'thr_4',
            turnId: 'turn_4',
            itemId: 'item_4',
            delta: 'running tests...',
          });
          await transport.emitNotification('turn/completed', {
            threadId: 'thr_4',
            turn: {
              id: 'turn_4',
              status: 'completed',
              error: null,
            },
          });
        });
        return { turn: { id: 'turn_4' } };
      }
      throw new Error(`unexpected method: ${method}`);
    };

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const events: Array<{ method: string; params: unknown }> = [];

    const engine = new AppServerEngine({
      spawnProcess: () => child,
      createTransport: () => transport as unknown as JsonRpcTransport,
    });

    const result = await engine.execute('suppress output', {
      suppressTerminalOutput: true,
      onEvent: (method, params) => {
        events.push({ method, params });
      },
    });

    expect(result.success).toBe(true);
    expect(events.some((entry) => entry.method === 'app-server/stderr')).toBe(true);
    const writes = stderrSpy.mock.calls.map((call) => String(call[0] ?? ''));
    expect(writes.some((line) => line.includes('worker stderr noise'))).toBe(false);
    expect(writes.some((line) => line.includes('running tests...'))).toBe(false);
    stderrSpy.mockRestore();
  });

  it('starts codex app-server with enabled features when requested', async () => {
    const transport = new MockTransport();
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    transport.requestHandler = async (method) => {
      if (method === 'initialize') {
        return { userAgent: 'codex-app-server-test' };
      }
      if (method === 'thread/start') {
        return { thread: { id: 'thr_5' } };
      }
      if (method === 'turn/start') {
        setImmediate(async () => {
          await transport.emitNotification('turn/completed', {
            threadId: 'thr_5',
            turn: {
              id: 'turn_5',
              status: 'completed',
              error: null,
            },
          });
        });
        return { turn: { id: 'turn_5' } };
      }
      throw new Error(`unexpected method: ${method}`);
    };

    const engine = new AppServerEngine({
      spawnProcess: (command, args) => {
        spawnCalls.push({ command, args });
        return createFakeChildProcess();
      },
      createTransport: () => transport as unknown as JsonRpcTransport,
    });

    const result = await engine.execute('product review', {
      enabledFeatures: [' js_repl ', 'js_repl', ''],
    });

    expect(result.success).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual({
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://', '--enable', 'js_repl'],
    });
  });

  it('reuses the running app-server when enabled features stay the same', async () => {
    const transport = new MockTransport();
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    let turnCounter = 0;
    let threadCounter = 0;
    transport.requestHandler = async (method) => {
      if (method === 'initialize') {
        return { userAgent: 'codex-app-server-test' };
      }
      if (method === 'thread/start') {
        threadCounter += 1;
        return { thread: { id: `thr_reuse_${threadCounter}` } };
      }
      if (method === 'turn/start') {
        turnCounter += 1;
        const currentTurnId = `turn_reuse_${turnCounter}`;
        const currentThreadId = `thr_reuse_${threadCounter}`;
        setImmediate(async () => {
          await transport.emitNotification('turn/completed', {
            threadId: currentThreadId,
            turn: {
              id: currentTurnId,
              status: 'completed',
              error: null,
            },
          });
        });
        return { turn: { id: currentTurnId } };
      }
      throw new Error(`unexpected method: ${method}`);
    };

    const engine = new AppServerEngine({
      spawnProcess: (command, args) => {
        spawnCalls.push({ command, args });
        return createFakeChildProcess();
      },
      createTransport: () => transport as unknown as JsonRpcTransport,
    });

    await engine.execute('review 1', {
      enabledFeatures: ['js_repl'],
    });
    await engine.execute('review 2', {
      enabledFeatures: ['js_repl'],
    });

    expect(spawnCalls).toHaveLength(1);
  });

  it('restarts the app-server when enabled features change', async () => {
    const transport = new MockTransport();
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    let turnCounter = 0;
    let threadCounter = 0;
    transport.requestHandler = async (method) => {
      if (method === 'initialize') {
        return { userAgent: 'codex-app-server-test' };
      }
      if (method === 'thread/start') {
        threadCounter += 1;
        return { thread: { id: `thr_restart_${threadCounter}` } };
      }
      if (method === 'turn/start') {
        turnCounter += 1;
        const currentTurnId = `turn_restart_${turnCounter}`;
        const currentThreadId = `thr_restart_${threadCounter}`;
        setImmediate(async () => {
          await transport.emitNotification('turn/completed', {
            threadId: currentThreadId,
            turn: {
              id: currentTurnId,
              status: 'completed',
              error: null,
            },
          });
        });
        return { turn: { id: currentTurnId } };
      }
      throw new Error(`unexpected method: ${method}`);
    };

    const engine = new AppServerEngine({
      spawnProcess: (command, args) => {
        spawnCalls.push({ command, args });
        return createFakeChildProcess();
      },
      createTransport: () => transport as unknown as JsonRpcTransport,
    });

    await engine.execute('implementation', {});
    await engine.execute('product review', {
      enabledFeatures: ['js_repl'],
    });

    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]).toEqual({
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
    });
    expect(spawnCalls[1]).toEqual({
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://', '--enable', 'js_repl'],
    });
  });
});
