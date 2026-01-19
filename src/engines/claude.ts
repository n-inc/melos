import { spawn } from 'node:child_process';
import { Engine, EngineOptions, EngineResult } from './base.js';

/**
 * Claude Code 固有のオプション
 */
export interface ClaudeEngineOptions extends EngineOptions {
  /** 権限スキップフラグ（デフォルト: true） */
  skipPermissions?: boolean;
  /** 出力モード: print(-p) or interactive */
  printMode?: boolean;
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
    } = options;

    const args: string[] = [];

    if (printMode) {
      args.push('-p');
    }

    if (skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    args.push(prompt);

    return new Promise((resolve) => {
      const child = spawn('claude', args, {
        cwd,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      let timeoutId: NodeJS.Timeout | undefined;

      if (timeout) {
        timeoutId = setTimeout(() => {
          child.kill('SIGTERM');
        }, timeout);
      }

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        // リアルタイムで stderr に出力（ターミナル表示用）
        process.stderr.write(chunk);
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
