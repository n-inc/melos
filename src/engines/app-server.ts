import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { Engine, EngineOptions, EngineResult } from './base.js';
import {
  AppServerApprovalPolicy,
  AppServerSandboxMode,
  AppServerSandboxPolicyOption,
  AppServerServiceTier,
  CommandExecutionApprovalResponse,
  CommandExecutionOutputDeltaNotification,
  CommandExecutionRequestApprovalParams,
  createTextInput,
  EmptyResponse,
  FileChangeApprovalResponse,
  FileChangeRequestApprovalParams,
  InitializeParams,
  ThreadStartLikeResponse,
  TurnCompletedNotification,
  TurnSteerResponse,
  TurnStartResponse,
  TurnStatus,
} from './app-server-types.js';
import {
  JsonRpcError,
  JsonRpcTransport,
} from './jsonrpc-transport.js';
import { CODEX_LATEST_ALIAS, resolveRuntimeModel } from '../models/registry.js';

const DEFAULT_MODEL = CODEX_LATEST_ALIAS;
const DEFAULT_REASONING_EFFORT = 'high';
const DEFAULT_SERVICE_TIER: AppServerServiceTier = 'flex';
const DEFAULT_APPROVAL_POLICY: AppServerApprovalPolicy = 'never';
const DEFAULT_SANDBOX_POLICY: AppServerSandboxPolicyOption = 'dangerFullAccess';
const SERVER_OVERLOADED_ERROR_CODE = -32001;
const MAX_RETRY_COUNT = 3;

/**
 * App Server 固有のオプション
 */
export interface AppServerEngineOptions extends EngineOptions {
  model?: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  approvalPolicy?: AppServerApprovalPolicy;
  sandboxPolicy?: AppServerSandboxPolicyOption;
  enabledFeatures?: string[];
  threadId?: string;
  onStream?: (chunk: string) => void;
  onCommandOutput?: (chunk: string) => void;
  onEvent?: (method: string, params: unknown) => void;
  execMode?: boolean;
  suppressTerminalOutput?: boolean;
}

interface AppServerEngineDependencies {
  spawnProcess?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      stdio: ['pipe', 'pipe', 'pipe'];
    }
  ) => ChildProcessWithoutNullStreams;
  createTransport?: (input: Readable, output: Writable) => JsonRpcTransport;
}

interface TurnCompletionResult {
  status: TurnStatus;
  errorMessage: string | null;
}

/**
 * Codex App Server エンジン
 */
export class AppServerEngine extends Engine {
  readonly name = 'codex-app-server';

  private readonly spawnProcess;
  private readonly createTransport;
  private serverProcess: ChildProcessWithoutNullStreams | null = null;
  private transport: JsonRpcTransport | null = null;
  private initialized = false;
  private isExecuting = false;
  private activeThreadId: string | null = null;
  private activeTurnId: string | null = null;
  private suppressTerminalOutput = false;
  private onEventSink: ((method: string, params: unknown) => void) | null = null;
  private enabledFeaturesKey = '';

  constructor(dependencies: AppServerEngineDependencies = {}) {
    super();
    this.spawnProcess = dependencies.spawnProcess ?? spawn;
    this.createTransport = dependencies.createTransport
      ?? ((input, output) => new JsonRpcTransport(input, output));
  }

  /**
   * エンジン実行
   */
  async execute(
    prompt: string,
    options: AppServerEngineOptions = {}
  ): Promise<EngineResult> {
    if (this.isExecuting) {
      return {
        success: false,
        output: '',
        error: 'AppServerEngine is already running a turn',
        exitCode: 1,
      };
    }

    this.isExecuting = true;
    try {
      const {
        cwd = process.cwd(),
        timeout = 60 * 60 * 1000,
        model = DEFAULT_MODEL,
        reasoningEffort = DEFAULT_REASONING_EFFORT,
        serviceTier = DEFAULT_SERVICE_TIER,
        approvalPolicy = DEFAULT_APPROVAL_POLICY,
        sandboxPolicy = DEFAULT_SANDBOX_POLICY,
        enabledFeatures,
        threadId: requestedThreadId,
        onStream,
        onCommandOutput,
        onEvent = () => {
          // no-op
        },
        suppressTerminalOutput = false,
      } = options;
      this.suppressTerminalOutput = suppressTerminalOutput;
      this.onEventSink = onEvent;
      await this.ensureRunning(enabledFeatures);
      const runtimeModel = resolveRuntimeModel(model, DEFAULT_MODEL);

      const threadId = requestedThreadId
        ? await this.resumeThread(requestedThreadId, {
            model: runtimeModel,
            cwd,
            approvalPolicy,
            sandboxPolicy,
          })
        : await this.startThread({
            model: runtimeModel,
            cwd,
            approvalPolicy,
            sandboxPolicy,
          });

      this.activeThreadId = threadId;

      const outputChunks: string[] = [];
      let turnId: string | null = null;

      const waitForCompleted = this.waitForTurnCompleted(
        threadId,
        () => turnId,
        timeout,
        {
          onAgentDelta: (chunk) => {
            outputChunks.push(chunk);
            onStream?.(chunk);
          },
          onCommandOutputDelta: (chunk) => {
            if (onCommandOutput) {
              onCommandOutput(chunk);
              return;
            }
            if (!suppressTerminalOutput) {
              process.stderr.write('\x1b[2K\r' + chunk);
            }
          },
          onEvent,
        }
      );

      const startResponse = await this.requestWithRetry<TurnStartResponse>(
        'turn/start',
        {
          threadId,
          input: [createTextInput(prompt)],
          cwd,
          approvalPolicy,
          model: runtimeModel,
          effort: reasoningEffort,
          serviceTier,
        },
        timeout
      );
      turnId = startResponse.turn.id;
      this.activeTurnId = turnId;

      const completion = await waitForCompleted;
      const output = outputChunks.join('');

      if (completion.status === 'completed') {
        return {
          success: true,
          output,
          exitCode: 0,
        };
      }

      return {
        success: false,
        output,
        error: completion.errorMessage ?? `Turn ${completion.status}`,
        exitCode: 1,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    } finally {
      this.isExecuting = false;
      this.activeTurnId = null;
      this.suppressTerminalOutput = false;
      this.onEventSink = null;
    }
  }

  /**
   * App Server が利用可能か確認
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('codex', ['app-server', '--help'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('close', (code) => {
        resolve(code === 0);
      });
      child.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * 実行中ターンを中断する
   */
  abort(): void {
    const transport = this.transport;
    const threadId = this.activeThreadId;
    const turnId = this.activeTurnId;
    if (!transport || !threadId || !turnId) {
      return;
    }

    void this.requestWithRetry<EmptyResponse>(
      'turn/interrupt',
      { threadId, turnId },
      10_000
    ).catch(() => {
      // 中断失敗時は次ターンで回復する
    });
  }

  /**
   * 実行中ターンへ追加指示を注入する
   */
  async steer(instruction: string): Promise<boolean> {
    const text = instruction.trim();
    if (text.length === 0) {
      return false;
    }

    const threadId = this.activeThreadId;
    const turnId = this.activeTurnId;
    if (!threadId || !turnId || !this.isExecuting) {
      return false;
    }

    const result = await this.requestWithRetry<TurnSteerResponse>(
      'turn/steer',
      {
        threadId,
        input: [createTextInput(text)],
        expectedTurnId: turnId,
      },
      10_000
    );

    return result.turnId === turnId;
  }

  /**
   * App Server を起動し、初期化する
   */
  async ensureRunning(enabledFeatures?: string[]): Promise<void> {
    const normalizedFeatures = normalizeEnabledFeatures(enabledFeatures);
    const featuresKey = normalizedFeatures.join('\0');
    if (
      this.serverProcess
      && this.transport
      && this.initialized
      && this.enabledFeaturesKey === featuresKey
    ) {
      return;
    }

    await this.shutdown();

    const args = ['app-server', '--listen', 'stdio://'];
    for (const feature of normalizedFeatures) {
      args.push('--enable', feature);
    }

    const child = this.spawnProcess(
      'codex',
      args,
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    this.serverProcess = child;
    const transport = this.createTransport(child.stdout, child.stdin);
    this.transport = transport;
    transport.setServerRequestHandler(this.handleServerRequest);
    transport.start();

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      if (text.trim().length > 0 && !this.suppressTerminalOutput) {
        process.stderr.write(text);
      }
      this.onEventSink?.('app-server/stderr', { text });
    });

    child.on('close', () => {
      this.initialized = false;
      this.activeTurnId = null;
      this.transport?.close();
      this.transport = null;
      this.serverProcess = null;
    });

    const initializeParams: InitializeParams = {
      clientInfo: {
        name: 'melos',
        title: 'Melos Orchestrator',
        version: '0.6.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    };

    await this.requestWithRetry('initialize', initializeParams, 30_000);
    transport.notify('initialized');
    this.initialized = true;
    this.enabledFeaturesKey = featuresKey;
  }

  /**
   * App Server を停止する
   */
  async shutdown(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    if (transport) {
      transport.close();
    }

    const child = this.serverProcess;
    this.serverProcess = null;
    this.initialized = false;
    this.activeTurnId = null;
    this.enabledFeaturesKey = '';

    if (!child || child.killed) {
      return;
    }

    child.kill('SIGTERM');
    const forceKillTimer = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    }, 1000);
    forceKillTimer.unref();

    await new Promise<void>((resolve) => {
      child.once('close', () => {
        clearTimeout(forceKillTimer);
        resolve();
      });
      child.once('error', () => {
        clearTimeout(forceKillTimer);
        resolve();
      });
    });
  }

  /**
   * 現在アクティブな threadId を返す
   */
  getActiveThreadId(): string | null {
    return this.activeThreadId;
  }

  /**
   * 組み込みレビューを実行
   */
  async review(threadId: string): Promise<EngineResult> {
    try {
      await this.ensureRunning();
      const outputChunks: string[] = [];
      let turnId: string | null = null;

      const waitForCompleted = this.waitForTurnCompleted(
        threadId,
        () => turnId,
        15 * 60 * 1000,
        {
          onAgentDelta: (chunk) => {
            outputChunks.push(chunk);
          },
          onCommandOutputDelta: () => {
            // review は command 出力を特別扱いしない
          },
          onEvent: () => {
            // review はデフォルトではイベントを出さない
          },
        }
      );

      const result = await this.requestWithRetry<{ turn: { id: string } }>(
        'review/start',
        {
          threadId,
          target: { type: 'uncommittedChanges' },
        }
      );
      turnId = result.turn.id;
      this.activeThreadId = threadId;
      this.activeTurnId = turnId;

      const completion = await waitForCompleted;
      const output = outputChunks.join('');

      if (completion.status === 'completed') {
        return { success: true, output, exitCode: 0 };
      }
      return {
        success: false,
        output,
        error: completion.errorMessage ?? `Review turn ${completion.status}`,
        exitCode: 1,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error),
        exitCode: 1,
      };
    } finally {
      this.activeTurnId = null;
    }
  }

  private async startThread(params: {
    model: string;
    cwd: string;
    approvalPolicy: AppServerApprovalPolicy;
    sandboxPolicy: AppServerSandboxPolicyOption;
  }): Promise<string> {
    const result = await this.requestWithRetry<ThreadStartLikeResponse>(
      'thread/start',
      {
        model: params.model,
        cwd: params.cwd,
        approvalPolicy: params.approvalPolicy,
        sandbox: mapSandboxMode(params.sandboxPolicy),
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      }
    );
    return result.thread.id;
  }

  private async resumeThread(
    threadId: string,
    params: {
      model: string;
      cwd: string;
      approvalPolicy: AppServerApprovalPolicy;
      sandboxPolicy: AppServerSandboxPolicyOption;
    }
  ): Promise<string> {
    const result = await this.requestWithRetry<ThreadStartLikeResponse>(
      'thread/resume',
      {
        threadId,
        model: params.model,
        cwd: params.cwd,
        approvalPolicy: params.approvalPolicy,
        sandbox: mapSandboxMode(params.sandboxPolicy),
        persistExtendedHistory: true,
      }
    );
    return result.thread.id;
  }

  private async waitForTurnCompleted(
    threadId: string,
    getTurnId: () => string | null,
    timeoutMs: number,
    handlers: {
      onAgentDelta: (delta: string) => void;
      onCommandOutputDelta: (delta: string) => void;
      onEvent: (method: string, params: unknown) => void;
    }
  ): Promise<TurnCompletionResult> {
    const transport = this.getTransport();

    return new Promise<TurnCompletionResult>((resolve, reject) => {
      // timeoutMs <= 0 means no timeout (long-running exec tasks)
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          unsubscribe();
          void this.interruptActiveTurn().catch(() => {
            // タイムアウト時の中断失敗は握りつぶす
          });
          reject(new Error('Timed out while waiting for turn completion'));
        }, timeoutMs)
        : null;
      if (timer) timer.unref();

      const unsubscribe = transport.onNotification((method, rawParams) => {
        handlers.onEvent(method, rawParams);
        if (!isRecord(rawParams)) {
          return;
        }

        const expectedTurnId = getTurnId();
        if (method === 'item/agentMessage/delta') {
          const notification = parseAgentMessageDelta(rawParams);
          if (!notification) {
            return;
          }
          if (
            notification.threadId === threadId
            && (expectedTurnId === null || notification.turnId === expectedTurnId)
          ) {
            handlers.onAgentDelta(notification.delta);
          }
          return;
        }

        if (method === 'item/commandExecution/outputDelta') {
          const notification = parseCommandExecutionDelta(rawParams);
          if (!notification) {
            return;
          }
          if (
            notification.threadId === threadId
            && (expectedTurnId === null || notification.turnId === expectedTurnId)
          ) {
            handlers.onCommandOutputDelta(notification.delta);
          }
          return;
        }

        if (method === 'turn/completed') {
          const notification = parseTurnCompleted(rawParams);
          if (!notification) {
            return;
          }
          if (notification.threadId !== threadId) {
            return;
          }
          if (expectedTurnId !== null && notification.turn.id !== expectedTurnId) {
            return;
          }

          if (timer) clearTimeout(timer);
          unsubscribe();
          resolve({
            status: notification.turn.status,
            errorMessage: notification.turn.error?.message ?? null,
          });
        }
      });
    });
  }

  private readonly handleServerRequest = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> => {
    if (method === 'item/commandExecution/requestApproval') {
      this.onEventSink?.(method, params ?? {});
      return {
        decision: 'accept',
      } satisfies CommandExecutionApprovalResponse;
    }
    if (method === 'item/fileChange/requestApproval') {
      this.onEventSink?.(method, params ?? {});
      return {
        decision: 'accept',
      } satisfies FileChangeApprovalResponse;
    }
    return {};
  };

  private async interruptActiveTurn(): Promise<void> {
    const threadId = this.activeThreadId;
    const turnId = this.activeTurnId;
    if (!threadId || !turnId) {
      return;
    }
    await this.requestWithRetry<EmptyResponse>(
      'turn/interrupt',
      { threadId, turnId },
      10_000
    );
  }

  private getTransport(): JsonRpcTransport {
    if (!this.transport) {
      throw new Error('JSON-RPC transport is not initialized');
    }
    return this.transport;
  }

  private async requestWithRetry<T>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<T> {
    const transport = this.getTransport();
    let attempt = 0;

    while (true) {
      try {
        return await transport.request<T>(method, params, timeoutMs);
      } catch (error) {
        const isRetryable = error instanceof JsonRpcError
          && error.code === SERVER_OVERLOADED_ERROR_CODE;
        if (!isRetryable || attempt >= MAX_RETRY_COUNT) {
          throw error;
        }
        const backoffMs = Math.min(2000, 200 * (2 ** attempt));
        const jitterMs = Math.floor(Math.random() * 100);
        await sleep(backoffMs + jitterMs);
        attempt++;
      }
    }
  }
}

function normalizeEnabledFeatures(enabledFeatures: string[] | undefined): string[] {
  if (!Array.isArray(enabledFeatures)) {
    return [];
  }

  const unique = new Set<string>();
  for (const value of enabledFeatures) {
    if (typeof value !== 'string') {
      continue;
    }
    const normalized = value.trim();
    if (normalized.length === 0) {
      continue;
    }
    unique.add(normalized);
  }

  return Array.from(unique).sort();
}

function mapSandboxMode(policy: AppServerSandboxPolicyOption): AppServerSandboxMode {
  if (policy === 'readOnly') {
    return 'read-only';
  }
  if (policy === 'workspaceWrite') {
    return 'workspace-write';
  }
  return 'danger-full-access';
}

function parseAgentMessageDelta(
  params: Record<string, unknown>
): {
  threadId: string;
  turnId: string;
  delta: string;
} | null {
  const threadId = readStringAny(params, ['threadId', 'thread_id']);
  const turnId = readStringAny(params, ['turnId', 'turn_id']);
  const delta = readString(params, 'delta');
  if (!threadId || !turnId || delta === null) {
    return null;
  }
  return { threadId, turnId, delta };
}

function parseCommandExecutionDelta(
  params: Record<string, unknown>
): CommandExecutionOutputDeltaNotification | null {
  const threadId = readStringAny(params, ['threadId', 'thread_id']);
  const turnId = readStringAny(params, ['turnId', 'turn_id']);
  const itemId = readStringAny(params, ['itemId', 'item_id']);
  const delta = readString(params, 'delta');
  if (!threadId || !turnId || !itemId || delta === null) {
    return null;
  }
  return {
    threadId,
    turnId,
    itemId,
    delta,
  };
}

function parseTurnCompleted(
  params: Record<string, unknown>
): TurnCompletedNotification | null {
  const threadId = readStringAny(params, ['threadId', 'thread_id']);
  const turnValue = params.turn;
  if (!threadId || !isRecord(turnValue)) {
    return null;
  }

  const turnId = readStringAny(turnValue, ['id', 'turn_id']);
  const status = readString(turnValue, 'status');
  if (!turnId || !isTurnStatus(status)) {
    return null;
  }

  const errorValue = turnValue.error;
  let errorMessage: string | null = null;
  if (isRecord(errorValue)) {
    const msg = readString(errorValue, 'message');
    errorMessage = msg ?? null;
  }

  return {
    threadId,
    turn: {
      id: turnId,
      status,
      error: errorMessage ? { message: errorMessage } : null,
    },
  };
}

function isTurnStatus(value: string | null): value is TurnStatus {
  return value === 'completed'
    || value === 'interrupted'
    || value === 'failed'
    || value === 'inProgress';
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function readStringAny(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export type {
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
};
