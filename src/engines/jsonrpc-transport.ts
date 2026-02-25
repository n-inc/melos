import { Readable, Writable } from 'node:stream';
import {
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcNotificationMessage,
  JsonRpcRequestMessage,
  JsonRpcServerRequestMessage,
  JsonRpcSuccessResponse,
} from './app-server-types.js';

/**
 * JSON-RPC エラー
 */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

/**
 * 通知ハンドラー
 */
export type JsonRpcNotificationHandler = (
  method: string,
  params: unknown
) => void | Promise<void>;

/**
 * サーバーリクエストハンドラー
 */
export type JsonRpcServerRequestHandler = (
  request: JsonRpcServerRequestMessage
) => unknown | Promise<unknown>;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeoutId?: NodeJS.Timeout;
}

/**
 * JSON-RPC 2.0 (JSONL) トランスポート
 */
export class JsonRpcTransport {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly defaultTimeoutMs: number;
  private buffer = '';
  private closed = false;
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Set<JsonRpcNotificationHandler>();
  private serverRequestHandler: JsonRpcServerRequestHandler | null = null;

  constructor(
    input: Readable,
    output: Writable,
    options: { defaultTimeoutMs?: number } = {}
  ) {
    this.input = input;
    this.output = output;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60_000;
  }

  /**
   * ストリーム監視を開始する
   */
  start(): void {
    this.input.on('data', this.handleData);
    this.input.on('error', this.handleInputError);
    this.input.on('end', this.handleStreamClosed);
    this.input.on('close', this.handleStreamClosed);
    this.output.on('error', this.handleOutputError);
    this.output.on('close', this.handleStreamClosed);
  }

  /**
   * トランスポートを閉じる
   */
  close(): void {
    this.shutdown(new Error('JSON-RPC transport closed'));
  }

  /**
   * 通知ハンドラーを登録する
   */
  onNotification(handler: JsonRpcNotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  /**
   * サーバーリクエストハンドラーを設定する
   */
  setServerRequestHandler(handler: JsonRpcServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /**
   * リクエスト送信
   */
  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('JSON-RPC transport is closed'));
    }

    const id: JsonRpcId = this.nextRequestId++;
    const request: JsonRpcRequestMessage = { method, id, params };
    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timeoutId = timeout > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(
              new JsonRpcError(
                `Request timed out: ${method}`,
                -32000
              )
            );
          }, timeout)
        : undefined;

      if (timeoutId) {
        timeoutId.unref();
      }

      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeoutId,
      });

      try {
        this.writeMessage(request);
      } catch (error) {
        this.pending.delete(id);
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * 通知送信
   */
  notify(method: string, params?: unknown): void {
    if (this.closed) {
      throw new Error('JSON-RPC transport is closed');
    }
    const notification: JsonRpcNotificationMessage = { method, params };
    this.writeMessage(notification);
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        continue;
      }

      void this.dispatchMessage(parsed);
    }
  };

  private readonly handleInputError = (error: Error): void => {
    this.shutdown(error);
  };

  private readonly handleOutputError = (error: Error): void => {
    this.shutdown(error);
  };

  private readonly handleStreamClosed = (): void => {
    this.shutdown(new Error('JSON-RPC transport stream closed'));
  };

  private async dispatchMessage(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }

    if (this.isResponseMessage(message)) {
      this.handleResponse(
        message as unknown as JsonRpcSuccessResponse | JsonRpcErrorResponse
      );
      return;
    }

    if (this.isServerRequestMessage(message)) {
      await this.handleServerRequest(
        message as unknown as JsonRpcServerRequestMessage
      );
      return;
    }

    if (this.isNotificationMessage(message)) {
      const notification = message as unknown as JsonRpcNotificationMessage;
      const params = 'params' in notification ? notification.params : undefined;
      for (const handler of this.notificationHandlers) {
        await handler(notification.method, params);
      }
    }
  }

  private isResponseMessage(
    message: Record<string, unknown>
  ): boolean {
    if (!('id' in message)) {
      return false;
    }
    return 'result' in message || 'error' in message;
  }

  private isServerRequestMessage(
    message: Record<string, unknown>
  ): boolean {
    return (
      'id' in message &&
      typeof message.id !== 'undefined' &&
      typeof message.method === 'string' &&
      !('result' in message) &&
      !('error' in message)
    );
  }

  private isNotificationMessage(
    message: Record<string, unknown>
  ): boolean {
    return (
      !('id' in message) &&
      typeof message.method === 'string'
    );
  }

  private handleResponse(message: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }

    if ('error' in message && message.error) {
      const errorObject = message.error as JsonRpcErrorObject;
      pending.reject(
        new JsonRpcError(
          errorObject.message ?? `Request failed: ${pending.method}`,
          errorObject.code ?? -32000,
          errorObject.data
        )
      );
      return;
    }

    pending.resolve((message as JsonRpcSuccessResponse).result);
  }

  private async handleServerRequest(request: JsonRpcServerRequestMessage): Promise<void> {
    if (!this.serverRequestHandler) {
      this.writeErrorResponse(request.id, {
        code: -32601,
        message: `Unhandled server request: ${request.method}`,
      });
      return;
    }

    try {
      const result = await this.serverRequestHandler(request);
      this.writeMessage({
        id: request.id,
        result: result ?? {},
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.writeErrorResponse(request.id, {
        code: -32000,
        message,
      });
    }
  }

  private writeErrorResponse(id: JsonRpcId, error: JsonRpcErrorObject): void {
    this.writeMessage({
      id,
      error,
    });
  }

  private writeMessage(message: unknown): void {
    const line = JSON.stringify(message) + '\n';
    if (!this.output.write(line)) {
      // backpressure は Node 側で吸収。ここでは書き込み結果のみ監視する。
    }
  }

  private shutdown(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    this.input.removeListener('data', this.handleData);
    this.input.removeListener('error', this.handleInputError);
    this.input.removeListener('end', this.handleStreamClosed);
    this.input.removeListener('close', this.handleStreamClosed);
    this.output.removeListener('error', this.handleOutputError);
    this.output.removeListener('close', this.handleStreamClosed);

    for (const [id, pending] of this.pending) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
