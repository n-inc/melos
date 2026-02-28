import { spawn, type ChildProcess } from 'node:child_process';
import { Engine, EngineOptions, EngineResult } from './base.js';
import { JsonlBuffer } from '../utils/jsonl-formatter.js';

/**
 * JSONL からアシスタントのテキスト出力を抽出する
 *
 * @param jsonlOutput JSONL形式の生データ
 * @returns 抽出されたアシスタントテキスト
 */
function extractAssistantTextFromJsonl(jsonlOutput: string): string {
  const texts: string[] = [];

  for (const line of jsonlOutput.split('\n')) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line);

      // assistant メッセージからテキストを抽出
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            texts.push(block.text);
          }
        }
      }

      // result イベントの result フィールドも含める（最終出力）
      if (event.type === 'result' && event.result) {
        texts.push(event.result);
      }
    } catch {
      // JSON 以外の行は無視
    }
  }

  return texts.join('\n\n');
}

/**
 * Claude Code 固有のオプション
 */
export interface ClaudeEngineOptions extends EngineOptions {
  /** 権限スキップフラグ（デフォルト: true） */
  skipPermissions?: boolean;
  /** 出力モード: print(-p) or interactive */
  printMode?: boolean;
  /** モデル名（haiku, sonnet, opus など） */
  model?: string;
  /** Claude effort レベル（Opus 4.6+: adaptive thinking 制御、デフォルト: max） */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Claude thinking budget（旧モデル向け、1024〜31999） */
  thinkingBudget?: number;
  /** エージェントメッセージ差分（統一UI向け） */
  onStream?: (chunk: string) => void;
  /** コマンド出力差分（将来拡張用） */
  onCommandOutput?: (chunk: string) => void;
  /** イベント通知（tool_use / tool_result など） */
  onEvent?: (method: string, params: unknown) => void;
  /** true の場合、端末への直接出力を抑止してコールバック経由に統一する */
  suppressTerminalOutput?: boolean;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    const record = toRecord(item);
    if (!record) {
      continue;
    }
    if (typeof record.text === 'string') {
      parts.push(record.text);
    }
  }
  return parts.join('\n');
}

function emitClaudeStreamEvent(
  event: unknown,
  callbacks: Pick<ClaudeEngineOptions, 'onStream' | 'onEvent'>
): void {
  const record = toRecord(event);
  if (!record) {
    return;
  }

  const type = typeof record.type === 'string' ? record.type : '';
  const message = toRecord(record.message);
  const content = Array.isArray(message?.content) ? message.content : [];

  if (type === 'assistant') {
    for (const rawBlock of content) {
      const block = toRecord(rawBlock);
      if (!block) {
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        callbacks.onStream?.(block.text.replace(/\r\n/g, '\n') + '\n');
        continue;
      }
      if (block.type === 'tool_use') {
        callbacks.onEvent?.('claude/tool_use', {
          name: typeof block.name === 'string' ? block.name : '',
          input: toRecord(block.input) ?? {},
        });
      }
    }
    return;
  }

  if (type === 'user') {
    for (const rawBlock of content) {
      const block = toRecord(rawBlock);
      if (!block || block.type !== 'tool_result') {
        continue;
      }
      const params: Record<string, unknown> = {
        content: extractToolResultText(block.content),
      };
      if (typeof block.is_error === 'boolean') {
        params.is_error = block.is_error;
      }
      if (typeof block.exit_code === 'number') {
        params.exit_code = block.exit_code;
      }
      if (typeof block.duration_ms === 'number') {
        params.duration_ms = block.duration_ms;
      }
      callbacks.onEvent?.('claude/tool_result', {
        ...params,
      });
    }
    return;
  }

  if (type === 'result') {
    callbacks.onEvent?.('claude/result', record);
  }
}

/**
 * Claude Code エンジン
 *
 * Claude CLI を使用してプロンプトを実行する。
 * デフォルトで `claude -p --dangerously-skip-permissions` を使用。
 */
export class ClaudeEngine extends Engine {
  readonly name = 'claude';
  private activeChild: ChildProcess | null = null;

  /**
   * 子プロセス（可能ならプロセスグループ）へシグナル送信
   */
  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid;
    if (pid) {
      try {
        // detached で起動した子プロセスグループ全体へ送る
        process.kill(-pid, signal);
        return;
      } catch {
        // フォールバックで単体プロセスに送る
      }
    }
    try {
      child.kill(signal);
    } catch {
      // 既に終了している場合は何もしない
    }
  }

  /**
   * Claude CLI でプロンプトを実行する
   */
  async execute(
    prompt: string,
    options: ClaudeEngineOptions = {}
  ): Promise<EngineResult> {
    const {
      cwd = process.cwd(),
      timeout,
      skipPermissions = true,
      printMode = true,
      model,
      effort,
      thinkingBudget,
      onStream,
      onEvent,
      suppressTerminalOutput = false,
    } = options;

    const args: string[] = [];

    if (printMode) {
      args.push('-p');
      // ストリーミングJSON形式で出力を取得（--verbose が必須）
      args.push('--verbose');
      args.push('--output-format', 'stream-json');
    }

    if (skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    if (model) {
      args.push('--model', model);
    }

    args.push(prompt);

    return new Promise((resolve) => {
      const child = spawn('claude', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(effort
            ? { CLAUDE_CODE_EFFORT_LEVEL: effort }
            : thinkingBudget != null
              ? { MAX_THINKING_TOKENS: String(thinkingBudget) }
            : { CLAUDE_CODE_EFFORT_LEVEL: 'max' }
          ),
        },
        detached: true,
      });
      this.activeChild = child;

      let stdout = '';
      let stderr = '';
      let timeoutId: NodeJS.Timeout | undefined;
      const jsonlBuffer = printMode ? new JsonlBuffer() : null;
      const hasExternalStreamHandler = Boolean(onStream || onEvent);
      let callbackBuffer = '';
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (this.activeChild === child) {
          this.activeChild = null;
        }
      };

      if (timeout) {
        timeoutId = setTimeout(() => {
          this.signalChild(child, 'SIGTERM');
        }, timeout);
      }

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;

        // printMode の場合は JSONL をパースしてフォーマット表示
        if (jsonlBuffer) {
          const formatted = jsonlBuffer.processChunk(chunk);
          if (!hasExternalStreamHandler && !suppressTerminalOutput) {
            for (const line of formatted) {
              // スピナー行をクリアしてから出力
              process.stdout.write('\x1b[2K\r' + line + '\n');
            }
          }
        } else {
          // 非 printMode はそのまま出力
          if (!hasExternalStreamHandler && !suppressTerminalOutput) {
            process.stdout.write(chunk);
          }
        }

        if (hasExternalStreamHandler) {
          callbackBuffer += chunk;
          const lines = callbackBuffer.split('\n');
          callbackBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }
            try {
              emitClaudeStreamEvent(JSON.parse(trimmed), { onStream, onEvent });
            } catch {
              // JSONL 以外は無視
            }
          }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        if (!suppressTerminalOutput) {
          process.stderr.write(chunk);
        }
        onEvent?.('claude/stderr', { text: chunk });
      });

      child.on('close', (code) => {
        cleanup();

        // バッファに残っているデータを処理
        if (jsonlBuffer) {
          const remaining = jsonlBuffer.flush();
          if (!hasExternalStreamHandler && !suppressTerminalOutput) {
            for (const line of remaining) {
              // スピナー行をクリアしてから出力
              process.stdout.write('\x1b[2K\r' + line + '\n');
            }
          }
        }
        if (hasExternalStreamHandler && callbackBuffer.trim().length > 0) {
          try {
            emitClaudeStreamEvent(JSON.parse(callbackBuffer.trim()), { onStream, onEvent });
          } catch {
            // JSONL 以外は無視
          }
        }

        const exitCode = code ?? 1;

        // JSONL からアシスタント出力を抽出
        const extractedOutput = printMode
          ? extractAssistantTextFromJsonl(stdout)
          : stdout;

        if (exitCode === 0) {
          resolve({
            success: true,
            output: extractedOutput,
            exitCode,
          });
        } else {
          resolve({
            success: false,
            output: extractedOutput,
            error: stderr || `Process exited with code ${exitCode}`,
            exitCode,
          });
        }
      });

      child.on('error', (err) => {
        cleanup();

        resolve({
          success: false,
          output: '',
          error: err.message,
          exitCode: 1,
        });
      });
    });
  }

  /**
   * 実行中の Claude プロセスを中断する
   */
  abort(): void {
    const child = this.activeChild;
    if (!child || child.killed) {
      return;
    }

    try {
      this.signalChild(child, 'SIGINT');
    } catch {
      // 既に終了している場合は何もしない
      return;
    }

    const terminateTimer = setTimeout(() => {
      if (this.activeChild !== child || child.killed) {
        return;
      }
      try {
        this.signalChild(child, 'SIGTERM');
      } catch {
        return;
      }

      const forceKillTimer = setTimeout(() => {
        if (this.activeChild !== child || child.killed) {
          return;
        }
        try {
          this.signalChild(child, 'SIGKILL');
        } catch {
          // 無視
        }
      }, 1500);
      forceKillTimer.unref();
    }, 500);
    terminateTimer.unref();
  }

  /**
   * Claude CLI が利用可能か確認する
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('which', ['claude'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      child.on('close', (code) => {
        resolve(code === 0);
      });

      child.on('error', () => {
        resolve(false);
      });
    });
  }
}
