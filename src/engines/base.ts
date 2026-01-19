/**
 * エンジン実行結果
 */
export interface EngineResult {
  /** 実行成功フラグ */
  success: boolean;
  /** エンジンからの出力 */
  output: string;
  /** エラーメッセージ（失敗時） */
  error?: string;
  /** 終了コード */
  exitCode: number;
}

/**
 * エンジン設定オプション
 */
export interface EngineOptions {
  /** 作業ディレクトリ */
  cwd?: string;
  /** タイムアウト（ミリ秒） */
  timeout?: number;
}

/**
 * エンジン抽象クラス
 *
 * Claude Code、Codex などの AI エンジンの共通インターフェースを定義。
 * 各エンジンはこのクラスを継承して実装する。
 */
export abstract class Engine {
  /** エンジン名 */
  abstract readonly name: string;

  /**
   * プロンプトを実行する
   * @param prompt 実行するプロンプト
   * @param options 実行オプション
   * @returns 実行結果
   */
  abstract execute(prompt: string, options?: EngineOptions): Promise<EngineResult>;

  /**
   * エンジンが利用可能か確認する
   * @returns 利用可能な場合 true
   */
  abstract isAvailable(): Promise<boolean>;
}
