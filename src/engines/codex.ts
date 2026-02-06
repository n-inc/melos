import { spawn } from 'node:child_process';
import { Engine, EngineOptions, EngineResult } from './base.js';

/**
 * Codex 固有のオプション
 */
export interface CodexEngineOptions extends EngineOptions {
  /** モデル名（デフォルト: gpt-5.3-codex） */
  model?: string;
  /** 推論努力レベル（デフォルト: xhigh） */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** 実行モード: exec（print）または interactive */
  execMode?: boolean;
}

/** デフォルトモデル */
const DEFAULT_MODEL = 'gpt-5.3-codex';
/** デフォルト推論努力レベル */
const DEFAULT_REASONING_EFFORT = 'xhigh';
/** Claude 専用モデル名（Codex では無視してデフォルトを使用） */
const CLAUDE_ONLY_MODELS = ['haiku', 'sonnet', 'opus'];
/** ANSI エスケープコード */
const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;]*m/g;
/** Codex CLI 既知ノイズ: rollout path missing */
const ROLLOUT_PATH_MISSING_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+Z ERROR codex_core::rollout::list: state db missing rollout path for thread [0-9a-f-]+$/i;

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
      model: rawModel,
      reasoningEffort = DEFAULT_REASONING_EFFORT,
      execMode = true,
    } = options;

    // Claude 専用モデル名が渡された場合はデフォルトを使用
    const model =
      rawModel && !CLAUDE_ONLY_MODELS.includes(rawModel) ? rawModel : DEFAULT_MODEL;

    const args: string[] = [];

    if (execMode) {
      args.push('exec');
    }

    args.push('-m', model);
    args.push('-c', `model_reasoning_effort=${reasoningEffort}`);
    args.push('--dangerously-bypass-approvals-and-sandbox');
    args.push(prompt);

    return new Promise((resolve) => {
      const child = spawn('codex', args, {
        cwd,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      let stderrPartialLine = '';
      let timeoutId: NodeJS.Timeout | undefined;

      if (timeout) {
        timeoutId = setTimeout(() => {
          child.kill('SIGTERM');
        }, timeout);
      }

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        // スピナー行をクリアしてからリアルタイムで stdout に出力
        process.stdout.write('\x1b[2K\r' + chunk);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;

        // チャンクを行単位で処理し、既知ノイズを表示しない
        stderrPartialLine += chunk;
        const lines = stderrPartialLine.split(/\r?\n/);
        stderrPartialLine = lines.pop() ?? '';

        for (const line of lines) {
          if (this.isIgnorableCodexStderrLine(line)) {
            continue;
          }
          // スピナー行をクリアしてから出力
          process.stderr.write('\x1b[2K\r' + line + '\n');
        }
      });

      child.on('close', (code) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        // 改行なしの末尾行が残っている場合も処理
        if (stderrPartialLine && !this.isIgnorableCodexStderrLine(stderrPartialLine)) {
          process.stderr.write('\x1b[2K\r' + stderrPartialLine);
        }

        const exitCode = code ?? 1;
        const filteredStderr = this.filterCodexStderr(stderr);

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
            error: filteredStderr || `Process exited with code ${exitCode}`,
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
   * - Promise タグがフィルタで失われた場合は追加（無限ループ防止）
   */
  private filterCodexOutput(output: string): string {
    // ANSI エスケープコードを除去（カラー出力が Promise 検出を妨げる可能性があるため）
    const cleanOutput = output.replace(ANSI_ESCAPE_REGEX, '');

    // Promise タグを先に抽出（フィルタで失われる可能性があるため）
    const promiseMatch = cleanOutput.match(/<promise>(COMPLETE|TASK_DONE|ESCALATE)<\/promise>/);

    const lines = cleanOutput.split('\n');
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

    // マーカーが見つからない場合は ANSI コード除去済みの出力を返す
    if (!inBlock) {
      return cleanOutput;
    }

    let result = lastBlock.join('\n');

    // Promise タグがフィルタで失われた場合は追加
    if (promiseMatch && !result.includes(promiseMatch[0])) {
      result = result + '\n' + promiseMatch[0];
    }

    return result;
  }

  /**
   * Codex stderr から既知ノイズ行を除去する
   */
  private filterCodexStderr(stderr: string): string {
    const filtered = stderr
      .split(/\r?\n/)
      .filter((line) => !this.isIgnorableCodexStderrLine(line))
      .join('\n')
      .trimEnd();

    return filtered.trim() ? filtered : '';
  }

  /**
   * 表示・エラー返却から除外してよい Codex 既知ノイズ判定
   */
  private isIgnorableCodexStderrLine(line: string): boolean {
    const normalized = line.replace(ANSI_ESCAPE_REGEX, '').trim();

    if (!normalized) {
      return false;
    }

    if (normalized === 'mcp startup: no servers') {
      return true;
    }

    return ROLLOUT_PATH_MISSING_REGEX.test(normalized);
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
