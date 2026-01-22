import { Engine, EngineOptions, EngineResult } from './base.js';

/**
 * MockEngine 設定オプション
 */
export interface MockEngineOptions extends EngineOptions {
  /** カスタム出力（デフォルト: COMPLETE promise） */
  customOutput?: string;
  /** 成功フラグ（デフォルト: true） */
  success?: boolean;
  /** 終了コード（デフォルト: 0） */
  exitCode?: number;
  /** 実行遅延（ミリ秒、デフォルト: 0） */
  delay?: number;
}

/**
 * テスト用 MockEngine
 *
 * 実際の AI API を呼び出さずに、設定された応答を返す。
 * 統合テストで Orchestrator のフロー検証に使用。
 */
export class MockEngine extends Engine {
  readonly name = 'mock';

  private defaultOutput =
    'Task completed successfully.\n<promise>COMPLETE</promise>';
  private options: MockEngineOptions;

  constructor(options: MockEngineOptions = {}) {
    super();
    this.options = options;
  }

  /**
   * モック実行（設定された応答を返す）
   */
  async execute(
    _prompt: string,
    options: MockEngineOptions = {}
  ): Promise<EngineResult> {
    const mergedOptions = { ...this.options, ...options };
    const {
      customOutput,
      success = true,
      exitCode = 0,
      delay = 0,
    } = mergedOptions;

    // 遅延シミュレーション
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const output = customOutput ?? this.defaultOutput;

    return {
      success,
      output,
      exitCode,
      ...(success ? {} : { error: 'Mock execution failed' }),
    };
  }

  /**
   * MockEngine は常に利用可能
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * デフォルト出力を設定
   */
  setDefaultOutput(output: string): void {
    this.defaultOutput = output;
  }

  /**
   * オプションを更新
   */
  setOptions(options: MockEngineOptions): void {
    this.options = { ...this.options, ...options };
  }
}
