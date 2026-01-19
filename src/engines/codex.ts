import { spawn } from 'node:child_process';
import { Engine, EngineOptions, EngineResult } from './base.js';

/**
 * Codex 固有のオプション
 */
export interface CodexEngineOptions extends EngineOptions {
  /** モデル名（デフォルト: gpt-5.2-codex） */
  model?: string;
  /** 推論努力レベル（デフォルト: xhigh） */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** 実行モード: exec（print）または interactive */
  execMode?: boolean;
}

/** デフォルトモデル */
const DEFAULT_MODEL = 'gpt-5.2-codex';
/** デフォルト推論努力レベル */
const DEFAULT_REASONING_EFFORT = 'xhigh';

/**
 * Codex エンジン
 *
 * Codex CLI を使用してプロンプトを実行する。
 * - exec モード: `codex exec -m MODEL -c model_reasoning_effort=EFFORT PROMPT`
 * - interactive モード: `codex -m MODEL -c model_reasoning_effort=EFFORT PROMPT`
 */
export class CodexEngine extends Engine {
  readonly name = 'codex';

  /**
   * Codex CLI でプロンプトを実行する
   */
  async execute(
    prompt: string,
    options: CodexEngineOptions = {}
  ): Promise<EngineResult> {
    const {
      cwd = process.cwd(),
      timeout,
      model = DEFAULT_MODEL,
      reasoningEffort = DEFAULT_REASONING_EFFORT,
      execMode = true,
    } = options;

    const args: string[] = [];

    if (execMode) {
      args.push('exec');
    }

    args.push('-m', model);
    args.push('-c', `model_reasoning_effort=${reasoningEffort}`);
    args.push(prompt);

    return new Promise((resolve) => {
      const child = spawn('codex', args, {
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
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
      });

      child.on('close', (code) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        const exitCode = code ?? 1;

        // Codex exec の出力から最後の "codex" ブロックを抽出
        const filteredOutput = execMode ? this.filterCodexOutput(stdout) : stdout;

        if (exitCode === 0) {
          resolve({
            success: true,
            output: filteredOutput,
            exitCode,
          });
        } else {
          resolve({
            success: false,
            output: filteredOutput,
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
   * Codex exec の出力から最後の "codex" ブロックを抽出する
   *
   * Bash スクリプトの AWK 処理と同等:
   * - "codex" という行が出現したらブロック開始
   * - 次の "codex" が出現するか EOF まで蓄積
   * - 最後のブロックを返す
   * - マーカーが見つからない場合は元の出力をそのまま返す（フォールバック）
   */
  private filterCodexOutput(output: string): string {
    const lines = output.split('\n');
    let currentBlock: string[] = [];
    let lastBlock: string[] = [];
    let inBlock = false;

    for (const line of lines) {
      if (line === 'codex') {
        // 新しいブロック開始、前のブロックを保存
        if (inBlock && currentBlock.length > 0) {
          lastBlock = currentBlock;
        }
        currentBlock = [];
        inBlock = true;
      } else if (inBlock) {
        currentBlock.push(line);
      }
    }

    // 最後のブロックを確定
    if (inBlock && currentBlock.length > 0) {
      lastBlock = currentBlock;
    }

    // マーカーが見つからない場合は元の出力をそのまま返す
    if (!inBlock) {
      return output;
    }

    return lastBlock.join('\n');
  }

  /**
   * Codex CLI が利用可能か確認する
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('which', ['codex'], {
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
