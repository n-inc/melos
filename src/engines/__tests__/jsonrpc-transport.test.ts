import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { JsonRpcError, JsonRpcTransport } from '../jsonrpc-transport.js';

function parseFirstJsonLine(chunk: Buffer | string): Record<string, unknown> {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
  const [line] = text.split('\n');
  return JSON.parse(line) as Record<string, unknown>;
}

describe('JsonRpcTransport', () => {
  let serverToClient: PassThrough;
  let clientToServer: PassThrough;
  let transport: JsonRpcTransport;

  beforeEach(() => {
    serverToClient = new PassThrough();
    clientToServer = new PassThrough();
    transport = new JsonRpcTransport(serverToClient, clientToServer, {
      defaultTimeoutMs: 200,
    });
    transport.start();
  });

  afterEach(() => {
    transport.close();
    serverToClient.destroy();
    clientToServer.destroy();
  });

  it('correlates request and response by id', async () => {
    const responsePromise = transport.request<{ ok: boolean }>('thread/start', {
      model: 'gpt-5.3-codex',
    });

    const [rawRequest] = await once(clientToServer, 'data');
    const request = parseFirstJsonLine(rawRequest as Buffer);
    expect(request.method).toBe('thread/start');
    expect(typeof request.id).toBe('number');

    serverToClient.write(
      JSON.stringify({
        id: request.id,
        result: { ok: true },
      }) + '\n'
    );

    await expect(responsePromise).resolves.toEqual({ ok: true });
  });

  it('dispatches notifications', async () => {
    const received = new Promise<{ method: string; params: unknown }>((resolve) => {
      transport.onNotification((method, params) => {
        resolve({ method, params });
      });
    });

    serverToClient.write(
      JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { delta: 'hello' },
      }) + '\n'
    );

    await expect(received).resolves.toEqual({
      method: 'item/agentMessage/delta',
      params: { delta: 'hello' },
    });
  });

  it('handles server request and sends response', async () => {
    transport.setServerRequestHandler(async (request) => {
      expect(request.method).toBe('item/commandExecution/requestApproval');
      return { decision: 'accept' };
    });

    serverToClient.write(
      JSON.stringify({
        id: 42,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_1' },
      }) + '\n'
    );

    const [rawResponse] = await once(clientToServer, 'data');
    const response = parseFirstJsonLine(rawResponse as Buffer);
    expect(response).toEqual({
      id: 42,
      result: { decision: 'accept' },
    });
  });

  it('times out when response does not arrive', async () => {
    const promise = transport.request('turn/start', { input: [] }, 20);
    await expect(promise).rejects.toBeInstanceOf(JsonRpcError);
    await expect(promise).rejects.toMatchObject({
      message: 'Request timed out: turn/start',
    });
  });

  it('buffers partial JSONL chunks', async () => {
    const received = new Promise<string>((resolve) => {
      transport.onNotification((method, params) => {
        if (method === 'item/agentMessage/delta') {
          const payload = params as { delta?: string };
          resolve(payload.delta ?? '');
        }
      });
    });

    serverToClient.write('{"method":"item/agentMessage/delta","params":{"delta":"hel');
    serverToClient.write('lo"}}\n');

    await expect(received).resolves.toBe('hello');
  });
});

