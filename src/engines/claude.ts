import { spawn } from 'node:child_process';
import { Engine, EngineOptions, EngineResult } from './base.js';
import { JsonlBuffer } from '../utils/jsonl-formatter.js';

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
  /** Claude thinking budget（デフォルト: 31999） */
  thinkingBudget?: number;
}

/**
 * Claude Code エンジン
 *
 * Claude CLI を使用してプロンプトを実行する。
 * デフォルトで `claude -p --dangerously-skip-permissions` を使用。
 */
export class ClaudeEngine extends Engine {
  readonly name = 'claude';

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
      thinkingBudget,
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
        stdio: ['inherit', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MAX_THINKING_TOKENS: String(thinkingBudget ?? 31999),
        },
      });

      let stdout = '';
      let stderr = '';
      let timeoutId: NodeJS.Timeout | undefined;
      const jsonlBuffer = printMode ? new JsonlBuffer() : null;

      if (timeout) {
        timeoutId = setTimeout(() => {
          child.kill('SIGTERM');
        }, timeout);
      }

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;

        // printMode の場合は JSONL をパースしてフォーマット表示
        if (jsonlBuffer) {
          const formatted = jsonlBuffer.processChunk(chunk);
          for (const line of formatted) {
            // スピナー行をクリアしてから出力
            process.stderr.write('\x1b[2K\r' + line + '\n');
          }
        } else {
          // 非 printMode はそのまま出力
          process.stderr.write(chunk);
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        process.stderr.write(chunk);
      });

      child.on('close', (code) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        // バッファに残っているデータを処理
        if (jsonlBuffer) {
          const remaining = jsonlBuffer.flush();
          for (const line of remaining) {
            // スピナー行をクリアしてから出力
            process.stderr.write('\x1b[2K\r' + line + '\n');
          }
        }

        const exitCode = code ?? 1;

        if (exitCode === 0) {
          resolve({
            success: true,
            output: stdout,
            exitCode,
          });
        } else {
          resolve({
            success: false,
            output: stdout,
            error: stderr || `Process exited with code ${exitCode}`,
            exitCode,
          });
        }
      });

      child.on('error', (err) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

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
