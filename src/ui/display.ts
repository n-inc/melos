import type { ExecutionMode } from '../state/progress.js';

/**
 * ANSI カラーコード
 */
const Colors = {
  // 基本色
  RED: '\x1b[0;31m',
  GREEN: '\x1b[0;32m',
  YELLOW: '\x1b[1;33m',
  BLUE: '\x1b[0;34m',
  CYAN: '\x1b[0;36m',
  MAGENTA: '\x1b[0;35m',
  WHITE: '\x1b[0;37m',

  // スタイル
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',

  // 明るい色
  BRIGHT_GREEN: '\x1b[1;32m',
  BRIGHT_CYAN: '\x1b[1;36m',
  BRIGHT_BLUE: '\x1b[1;34m',

  NC: '\x1b[0m', // No Color
} as const;

/**
 * ボックス描画文字
 */
const Box = {
  // シャープコーナー（ヘッダー用）
  TOP_LEFT: '┌',
  TOP_RIGHT: '┐',
  BOTTOM_LEFT: '└',
  BOTTOM_RIGHT: '┘',
  HORIZONTAL: '─',
  VERTICAL: '│',
  T_LEFT: '├',
  T_RIGHT: '┤',

  // ラウンドコーナー（サマリー用）
  ROUND_TOP_LEFT: '╭',
  ROUND_TOP_RIGHT: '╮',
  ROUND_BOTTOM_LEFT: '╰',
  ROUND_BOTTOM_RIGHT: '╯',
} as const;

/**
 * Braille スピナーパターン
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * スピナーを有効にするかどうかを判定
 * - MELOS_NO_SPINNER=1: 強制無効
 * - MELOS_SPINNER=1: 強制有効
 * - CLAUDECODE=1 / CODEX_*: 自動無効
 * - TERM=dumb: 自動無効（\r による同一行更新が効かないため）
 * - それ以外: TTY検出（stderr.isTTY）
 */
function shouldEnableSpinner(): boolean {
  // 環境変数で明示的に無効化
  if (process.env.MELOS_NO_SPINNER === '1') {
    return false;
  }
  // 環境変数で明示的に有効化
  if (process.env.MELOS_SPINNER === '1') {
    return true;
  }

  // Claude/Codex 環境では自動的に無効化
  // pty経由だと isTTY が true でも \r による同一行更新が効かず、ログが増殖するため
  if (
    process.env.CLAUDECODE === '1' ||
    process.env.CODEX_CI === '1' ||
    process.env.CODEX_SHELL === '1' ||
    process.env.__CFBundleIdentifier === 'com.openai.codex'
  ) {
    return false;
  }

  // dumb terminal では同一行更新が機能しないためスピナー無効
  if ((process.env.TERM ?? '').toLowerCase() === 'dumb') {
    return false;
  }

  // TTY検出（デフォルト動作）
  return process.stderr.isTTY === true;
}

function supportsInlineTerminalControl(): boolean {
  return process.stderr.isTTY === true;
}

/**
 * モード表示名
 */
const MODE_NAMES: Record<ExecutionMode, string> = {
  default: 'デフォルト',
  'review-only': 'レビューのみ',
  'ci-fix-only': 'CI修正のみ',
  'task-only': 'タスクのみ',
};

export interface QuestionBoxPrompt {
  question: string;
  context?: string;
  options?: Array<{ label: string; description: string }>;
  recommendation?: string;
  allowFreeText?: boolean;
}

/**
 * 経過時間をフォーマット
 */
export function formatElapsed(startTime: Date | string): string {
  const start = typeof startTime === 'string' ? new Date(startTime) : startTime;
  const elapsed = Math.floor((Date.now() - start.getTime()) / 1000);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;

  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

/**
 * 進捗率に応じた色を取得
 * 0-33%: 赤（まだまだ）
 * 34-66%: 黄（半分超えた）
 * 67-100%: 緑（もう少し）
 */
function getProgressColor(percent: number): string {
  if (percent <= 33) {
    return Colors.RED;
  } else if (percent <= 66) {
    return Colors.YELLOW;
  } else {
    return Colors.BRIGHT_GREEN;
  }
}

/**
 * プログレスバーを生成（色なし）
 */
export function createProgressBar(
  current: number,
  total: number,
  width: number = 20
): string {
  if (total === 0) {
    return '░'.repeat(width);
  }

  const ratio = Math.min(current / total, 1);
  const filled = Math.floor(ratio * width);
  const empty = width - filled;

  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * 色付きプログレスバーを生成
 */
export function createColoredProgressBar(
  current: number,
  total: number,
  width: number = 12
): string {
  if (total === 0) {
    return `${Colors.DIM}${'░'.repeat(width)}${Colors.NC}`;
  }

  const ratio = Math.min(current / total, 1);
  const percent = Math.floor(ratio * 100);
  const filled = Math.floor(ratio * width);
  const empty = width - filled;

  const color = getProgressColor(percent);
  const filledBar = '█'.repeat(filled);
  const emptyBar = '░'.repeat(empty);

  return `${color}${filledBar}${Colors.DIM}${emptyBar}${Colors.NC}`;
}

/** ボックスの幅 */
const BOX_WIDTH = 42;

/**
 * 文字の表示幅を取得（全角=2、半角=1）
 */
function getCharWidth(char: string): number {
  const code = char.charCodeAt(0);
  if (
    (code >= 0x3000 && code <= 0x9fff) || // CJK文字
    (code >= 0xff00 && code <= 0xffef) // 全角英数
  ) {
    return 2;
  }
  return 1;
}

/**
 * 文字列の表示幅を計算（全角文字を考慮）
 */
function getDisplayWidth(str: string): number {
  // ANSIエスケープコードを除去
  const plain = str.replace(/\x1b\[[0-9;]*m/g, '');
  let width = 0;
  for (const char of plain) {
    width += getCharWidth(char);
  }
  return width;
}

/**
 * 文字列を表示幅ベースで切り詰める
 */
function truncateByWidth(str: string, maxWidth: number): string {
  let width = 0;
  let result = '';
  for (const char of str) {
    const charWidth = getCharWidth(char);
    if (width + charWidth > maxWidth - 1) {
      return result + '…';
    }
    width += charWidth;
    result += char;
  }
  return str;
}

/**
 * ボックス内の行を生成（左右にパディングを追加）
 */
function boxLine(content: string, width: number = BOX_WIDTH): string {
  const displayWidth = getDisplayWidth(content);
  const padding = width - 2 - displayWidth; // 左右の│を除く
  const spaces = padding > 0 ? ' '.repeat(padding) : '';
  return `${Colors.BRIGHT_BLUE}${Box.VERTICAL}${Colors.NC}${content}${spaces}${Colors.BRIGHT_BLUE}${Box.VERTICAL}${Colors.NC}`;
}

/**
 * ボックスの上辺を生成
 */
function boxTop(width: number = BOX_WIDTH): string {
  return `${Colors.BRIGHT_BLUE}${Box.TOP_LEFT}${Box.HORIZONTAL.repeat(width - 2)}${Box.TOP_RIGHT}${Colors.NC}`;
}

/**
 * ボックスの下辺を生成
 */
function boxBottom(width: number = BOX_WIDTH): string {
  return `${Colors.BRIGHT_BLUE}${Box.BOTTOM_LEFT}${Box.HORIZONTAL.repeat(width - 2)}${Box.BOTTOM_RIGHT}${Colors.NC}`;
}

/**
 * ボックスの区切り線を生成
 */
function boxDivider(width: number = BOX_WIDTH): string {
  return `${Colors.BRIGHT_BLUE}${Box.T_LEFT}${Box.HORIZONTAL.repeat(width - 2)}${Box.T_RIGHT}${Colors.NC}`;
}

/**
 * イテレーション開始時のヘッダーを表示
 */
export function printIterationHeader(
  iteration: number,
  maxIterations: number,
  mode: ExecutionMode,
  currentTask: { id: string; description: string } | null,
  completedTasks: number,
  totalTasks: number,
  startedAt: string,
  engine: 'claude' | 'codex',
  prdTitle?: string | null,
  model?: string | null,
  thinkingBudget?: number | null,
  reasoningEffort?: string | null,
  effort?: string | null
): void {
  const modeName = MODE_NAMES[mode];
  const progressBar = createColoredProgressBar(completedTasks, totalTasks);
  const progressPercent =
    totalTasks > 0 ? Math.floor((completedTasks / totalTasks) * 100) : 0;
  const elapsed = formatElapsed(startedAt);

  const taskDisplay = currentTask
    ? `[${currentTask.id}] ${currentTask.description}`
    : '(タスク未選択)';

  // タスク名が長すぎる場合は切り詰め（表示幅ベース）
  const maxTaskWidth = 26;
  const truncatedTask =
    getDisplayWidth(taskDisplay) > maxTaskWidth
      ? truncateByWidth(taskDisplay, maxTaskWidth)
      : taskDisplay;

  // PRD タイトルが長すぎる場合は切り詰め（表示幅ベース）
  const maxPrdWidth = 26;
  const truncatedPrd = prdTitle
    ? getDisplayWidth(prdTitle) > maxPrdWidth
      ? truncateByWidth(prdTitle, maxPrdWidth)
      : prdTitle
    : null;

  const lines = [
    '',
    boxTop(),
    boxLine(`  ${Colors.BOLD}▶ イテレーション ${iteration} / ${maxIterations}${Colors.NC}`),
    boxDivider(),
  ];

  // PRD タイトルがある場合は表示
  if (truncatedPrd) {
    lines.push(boxLine(`  ${Colors.DIM}PRD${Colors.NC}       ${truncatedPrd}`));
  }

  // デフォルト以外のモードなら表示
  if (mode !== 'default') {
    lines.push(boxLine(`  ${Colors.DIM}モード${Colors.NC}    ${modeName}`));
  }

  // エンジン表示を構築
  // codex エンジンの場合、Claude専用モデル名は表示しない（実際には使われないため）
  const CLAUDE_ONLY_MODELS = ['haiku', 'sonnet', 'opus'];
  let engineDisplay = engine;
  if (model && !(engine === 'codex' && CLAUDE_ONLY_MODELS.includes(model))) {
    engineDisplay += ` (${model})`;
  }

  lines.push(
    boxLine(`  ${Colors.DIM}タスク${Colors.NC}    ${truncatedTask}`),
    boxLine(`  ${Colors.DIM}進捗${Colors.NC}      [${progressBar}] ${progressPercent}%`),
    boxLine(`  ${Colors.DIM}経過${Colors.NC}      ${elapsed}`),
    boxLine(`  ${Colors.DIM}エンジン${Colors.NC}  ${engineDisplay}`)
  );

  // Claude エンジンの場合は effort または thinking budget を表示
  if (engine === 'claude') {
    if (effort) {
      lines.push(boxLine(`  ${Colors.DIM}effort${Colors.NC}    ${effort}`));
    } else {
      lines.push(boxLine(`  ${Colors.DIM}thinking${Colors.NC}  ${thinkingBudget ?? 31999}`));
    }
  }
  // Codex エンジンの場合は reasoning effort を別行で表示
  if (engine === 'codex' && reasoningEffort) {
    lines.push(boxLine(`  ${Colors.DIM}effort${Colors.NC}    ${reasoningEffort}`));
  }

  lines.push(boxBottom(), '');

  for (const line of lines) {
    process.stderr.write(line + '\n');
  }
}

/**
 * スピナーインスタンス
 */
export interface Spinner {
  /** スピナーを更新 */
  update: () => void;
  /** スピナーを停止してクリア */
  stop: () => void;
  /** スピナーを成功状態で停止 */
  succeed: (message?: string) => void;
  /** スピナーを失敗状態で停止 */
  fail: (message?: string) => void;
}

/**
 * App Server のストリーミング表示を行うレンダラー
 */
export interface StreamRenderer {
  writeAgentDelta: (chunk: string) => void;
  writeCommandDelta: (chunk: string) => void;
  finish: () => void;
}

/**
 * App Server 通知イベントの表示
 */
export interface AppServerEventLogger {
  writeEvent: (method: string, params: unknown) => void;
  writeCommandDelta: (chunk: string) => void;
  finish: () => void;
}

/**
 * スピナーを作成
 * TTYでない場合やMELOS_NO_SPINNER=1の場合は、シンプルな行出力に切り替わる
 */
export function createSpinner(
  message: string,
  startTime: Date = new Date()
): Spinner {
  // スピナー無効時はシンプルな出力モード
  if (!shouldEnableSpinner()) {
    // 開始メッセージを1行出力
    process.stderr.write(`${message}...\n`);

    return {
      update: () => {
        // 何もしない
      },
      stop: () => {
        // 何もしない
      },
      succeed: (msg?: string) => {
        const elapsed = formatElapsed(startTime);
        const finalMessage = msg || message;
        process.stderr.write(
          `${Colors.GREEN}✓${Colors.NC} ${finalMessage} ${Colors.DIM}${elapsed}${Colors.NC}\n`
        );
      },
      fail: (msg?: string) => {
        const elapsed = formatElapsed(startTime);
        const finalMessage = msg || message;
        process.stderr.write(
          `${Colors.RED}✗${Colors.NC} ${finalMessage} ${Colors.DIM}${elapsed}${Colors.NC}\n`
        );
      },
    };
  }

  // TTY時は通常のスピナー表示
  let frameIndex = 0;
  let intervalId: NodeJS.Timeout | null = null;

  const render = () => {
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    const elapsed = formatElapsed(startTime);
    const terminalWidth =
      process.stderr.columns ?? process.stdout.columns ?? 80;
    const frameWidth = getDisplayWidth(frame);
    const elapsedWidth = getDisplayWidth(elapsed);
    const maxMessageWidth = Math.max(
      0,
      terminalWidth - frameWidth - elapsedWidth - 2
    );
    const spinnerMessage =
      maxMessageWidth > 0 && getDisplayWidth(message) > maxMessageWidth
        ? truncateByWidth(message, maxMessageWidth)
        : message;
    const spacer = spinnerMessage.length > 0 ? ' ' : '';
    const line = `${Colors.CYAN}${frame}${Colors.NC} ${spinnerMessage}${spacer}${Colors.DIM}${elapsed}${Colors.NC}`;

    // 前の行をクリア
    process.stderr.write('\x1b[2K\r');
    process.stderr.write(line);

    frameIndex++;
  };

  const update = () => {
    render();
  };

  const stop = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    // 行をクリア
    process.stderr.write('\x1b[2K\r');
  };

  const succeed = (msg?: string) => {
    stop();
    const elapsed = formatElapsed(startTime);
    const finalMessage = msg || message;
    process.stderr.write(
      `${Colors.GREEN}✓${Colors.NC} ${finalMessage} ${Colors.DIM}${elapsed}${Colors.NC}\n`
    );
  };

  const fail = (msg?: string) => {
    stop();
    const elapsed = formatElapsed(startTime);
    const finalMessage = msg || message;
    process.stderr.write(
      `${Colors.RED}✗${Colors.NC} ${finalMessage} ${Colors.DIM}${elapsed}${Colors.NC}\n`
    );
  };

  // 初回描画
  render();

  // 100ms ごとに更新
  intervalId = setInterval(render, 100);

  return { update, stop, succeed, fail };
}

/**
 * App Server ストリーミング出力を見やすい形式で表示する
 */
export function createStreamRenderer(): StreamRenderer {
  const showThinking = process.env.MELOS_SHOW_THINKING === '1';
  const inlineControlSupported = supportsInlineTerminalControl();
  let agentBuffer = '';
  let commandBuffer = '';
  let partialAgentFlushTimer: NodeJS.Timeout | null = null;

  const clearStatusLine = () => {
    if (!inlineControlSupported) {
      return;
    }
    process.stderr.write('\x1b[2K\r');
  };

  const shouldSuppressThinkingLine = (line: string): boolean => {
    if (showThinking) {
      return false;
    }
    const normalized = line.trim().toLowerCase();
    return normalized === 'thinking...'
      || normalized.startsWith('thinking:')
      || normalized.startsWith('thinking done:');
  };

  const flushPartialAgentLine = () => {
    if (agentBuffer.length === 0) {
      return;
    }
    if (shouldSuppressThinkingLine(agentBuffer)) {
      agentBuffer = '';
      return;
    }
    clearStatusLine();
    process.stderr.write(agentBuffer + '\n');
    agentBuffer = '';
  };

  const schedulePartialAgentFlush = () => {
    if (partialAgentFlushTimer) {
      clearTimeout(partialAgentFlushTimer);
    }
    partialAgentFlushTimer = setTimeout(() => {
      partialAgentFlushTimer = null;
      flushPartialAgentLine();
    }, 500);
    partialAgentFlushTimer.unref();
  };

  const flushAgentLines = (forceFlushPartial: boolean) => {
    const lines = agentBuffer.split('\n');
    agentBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (shouldSuppressThinkingLine(line)) {
        continue;
      }
      clearStatusLine();
      process.stderr.write(line + '\n');
    }

    if (forceFlushPartial && agentBuffer.length > 0) {
      if (!shouldSuppressThinkingLine(agentBuffer)) {
        clearStatusLine();
        process.stderr.write(agentBuffer + '\n');
      }
      agentBuffer = '';
    }
  };

  const writeAgentDelta = (chunk: string) => {
    if (!chunk) {
      return;
    }
    agentBuffer += chunk.replace(/\r\n/g, '\n');
    flushAgentLines(false);
    if (agentBuffer.length > 0) {
      schedulePartialAgentFlush();
    }
  };

  const flushCommandLines = (forceFlushPartial: boolean) => {
    const lines = commandBuffer.split('\n');
    commandBuffer = lines.pop() ?? '';

    for (const line of lines) {
      clearStatusLine();
      process.stderr.write(line + '\n');
    }

    if (forceFlushPartial && commandBuffer.length > 0) {
      clearStatusLine();
      process.stderr.write(commandBuffer + '\n');
      commandBuffer = '';
    }
  };

  const writeCommandDelta = (chunk: string) => {
    if (!chunk) {
      return;
    }
    commandBuffer += chunk.replace(/\r\n/g, '\n');
    flushCommandLines(false);
  };

  const finish = () => {
    if (partialAgentFlushTimer) {
      clearTimeout(partialAgentFlushTimer);
      partialAgentFlushTimer = null;
    }
    flushAgentLines(true);
    flushCommandLines(true);
  };

  return {
    writeAgentDelta,
    writeCommandDelta,
    finish,
  };
}

/**
 * App Server の通知イベントを CLI 風に逐次表示する
 */
export function createAppServerEventLogger(
  agentLabel: 'manager' | 'worker'
): AppServerEventLogger {
  void agentLabel;
  const inlineControlSupported = supportsInlineTerminalControl();
  const prefix = inlineControlSupported ? '\x1b[2K\r' : '';
  const maxPreviewLines = 3;
  const maxPreviewWidth = 160;

  let activeCommand: string | null = null;
  let commandBuffer = '';
  let commandOutputLines = 0;
  let commandPreview: string[] = [];

  const writeLine = (line: string) => {
    process.stderr.write(`${prefix}${line}\n`);
  };

  const resetCommandState = () => {
    activeCommand = null;
    commandBuffer = '';
    commandOutputLines = 0;
    commandPreview = [];
  };

  const appendCommandOutputLine = (line: string) => {
    const normalized = line.replace(/\r$/, '');
    if (normalized.length === 0) {
      return;
    }
    commandOutputLines += 1;
    if (commandPreview.length < maxPreviewLines) {
      commandPreview.push(truncateLine(normalized, maxPreviewWidth));
    }
  };

  const flushCommandBuffer = (force: boolean) => {
    const lines = commandBuffer.split('\n');
    commandBuffer = lines.pop() ?? '';
    for (const line of lines) {
      appendCommandOutputLine(line);
    }
    if (force && commandBuffer.length > 0) {
      appendCommandOutputLine(commandBuffer);
      commandBuffer = '';
    }
  };

  const emitCommandOutputSummary = () => {
    if (commandOutputLines === 0) {
      return;
    }
    for (const line of commandPreview) {
      writeLine(`  │ ${line}`);
    }
    if (commandOutputLines > commandPreview.length) {
      writeLine(`  └─ 出力 ${commandOutputLines}行（展開: e）`);
    }
  };

  const beginCommandCard = (command: string | null) => {
    const title = command ? truncateLine(command, 140) : '(command)';
    activeCommand = title;
    commandBuffer = '';
    commandOutputLines = 0;
    commandPreview = [];
    writeLine(`● Bash: ${title}`);
  };

  const finishCommandCard = (
    status: string,
    exitCode: number | null,
    durationMs: number | null
  ) => {
    flushCommandBuffer(true);
    const isSuccess = status !== 'failed' && (exitCode === null || exitCode === 0);
    const parts = [
      exitCode !== null ? `exit ${exitCode}` : null,
      durationMs !== null ? `${durationMs}ms` : null,
    ].filter((value): value is string => value !== null);
    writeLine(`  ${isSuccess ? '✓ 完了' : '✗ 失敗'}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`);
    emitCommandOutputSummary();
    resetCommandState();
  };

  const emitClaudeToolUse = (params: unknown) => {
    const data = toRecord(params);
    if (!data) {
      return;
    }
    const name = readStringAny(data, ['name']) ?? 'Tool';
    const input = readRecordAny(data, ['input']) ?? {};
    if (name === 'Bash') {
      beginCommandCard(readStringAny(input, ['command']));
      return;
    }
    if (name === 'Read') {
      const filePath = readStringAny(input, ['file_path']) ?? '(unknown)';
      const limit = readNumberAny(input, ['limit']);
      const suffix = typeof limit === 'number' ? ` (${limit} lines)` : '';
      writeLine(`● Read ${filePath}${suffix}`);
      return;
    }
    if (name === 'Write' || name === 'Edit') {
      const filePath = readStringAny(input, ['file_path']) ?? '(unknown)';
      const oldString = readStringAny(input, ['old_string']) ?? '';
      const newString = readStringAny(input, ['new_string']) ?? readStringAny(input, ['content']) ?? '';
      const diffLines = [
        ...contentToDiffLines(oldString, '-'),
        ...contentToDiffLines(newString, '+'),
      ];
      writeLine(`● Write ${filePath}`);
      for (const line of diffLines.slice(0, maxPreviewLines)) {
        writeLine(`  ${truncateDiffLine(line, maxPreviewWidth)}`);
      }
      if (diffLines.length > maxPreviewLines) {
        writeLine(`  └─ +${diffLines.length - maxPreviewLines}行（展開: e）`);
      }
      return;
    }
    writeLine(`● ${name}: ${truncateLine(JSON.stringify(input), 120)}`);
  };

  const emitClaudeToolResult = (params: unknown) => {
    const data = toRecord(params);
    const content = readStringAny(data, ['content']) ?? '';
    const isError = readBooleanAny(data, ['is_error', 'isError']) ?? false;
    const exitCode = readNumberAny(data, ['exit_code', 'exitCode']);
    const durationMs = readNumberAny(data, ['duration_ms', 'durationMs']);
    if (content.length > 0) {
      commandBuffer += content.replace(/\r\n/g, '\n');
    }
    if (activeCommand) {
      finishCommandCard(isError ? 'failed' : 'completed', exitCode, durationMs);
      return;
    }
    if (content.length > 0) {
      writeLine(`  └─ ${truncateLine(content, 140)}`);
    }
  };

  return {
    writeEvent: (method: string, params: unknown) => {
      if (method === 'claude/tool_use') {
        emitClaudeToolUse(params);
        return;
      }
      if (method === 'claude/tool_result') {
        emitClaudeToolResult(params);
        return;
      }

      const editLines = formatEditEventLines(method, params);
      if (editLines.length > 0) {
        for (const line of editLines) {
          writeLine(line);
        }
        return;
      }

      if (method === 'item/started' || method === 'item/completed') {
        const data = toRecord(params);
        const item = readRecordAny(data, ['item']);
        const itemType = normalizeItemType(readStringAny(item, ['type']) ?? '');
        if (itemType === 'commandexecution') {
          if (method === 'item/started') {
            beginCommandCard(readStringAny(item, ['command']));
            return;
          }
          finishCommandCard(
            readStringAny(item, ['status']) ?? 'completed',
            readNumberAny(item, ['exitCode']),
            readNumberAny(item, ['durationMs'])
          );
          return;
        }
      }

      const line = formatAppServerEventLine(method, params);
      if (!line) {
        return;
      }
      writeLine(line);
    },
    writeCommandDelta: (chunk: string) => {
      if (!chunk) {
        return;
      }
      commandBuffer += chunk.replace(/\r\n/g, '\n');
      flushCommandBuffer(false);
    },
    finish: () => {
      flushCommandBuffer(true);
    },
  };
}

function formatAppServerEventLine(method: string, params: unknown): string | null {
  const data = toRecord(params);
  if (!data) {
    return null;
  }

  if (method === 'thread/started') {
    const thread = toRecord(data.thread);
    const threadId = readStringAny(thread, ['id']) ?? readStringAny(data, ['threadId', 'thread_id']);
    return threadId ? `thread started (${threadId})` : 'thread started';
  }

  if (method === 'turn/started') {
    const turn = toRecord(data.turn);
    const turnId = readStringAny(turn, ['id']) ?? readStringAny(data, ['turnId', 'turn_id']);
    return turnId ? `turn started (${turnId})` : 'turn started';
  }

  if (method === 'turn/completed') {
    const turn = toRecord(data.turn);
    const turnId = readStringAny(turn, ['id']) ?? readStringAny(data, ['turnId', 'turn_id']);
    const status = readStringAny(turn, ['status']);
    if (turnId && status) {
      return `turn completed (${status}, ${turnId})`;
    }
    if (status) {
      return `turn completed (${status})`;
    }
    return 'turn completed';
  }

  if (method === 'item/started' || method === 'item/completed') {
    const item = toRecord(data.item);
    const itemType = readStringAny(item, ['type']) ?? 'item';
    const normalizedItemType = normalizeItemType(itemType);
    const phase = method === 'item/started' ? 'started' : 'completed';
    if (normalizedItemType === 'usermessage') {
      return null;
    }
    if (normalizedItemType === 'agentmessage') {
      return null;
    }
    if (normalizedItemType === 'reasoning') {
      if (phase === 'started') {
        return 'thinking...';
      }
      return null;
    }
    if (normalizedItemType === 'commandexecution') {
      return null;
    }
    if (normalizedItemType === 'mcptoolcall') {
      return `mcp tool ${phase}`;
    }
    if (normalizedItemType === 'filechange') {
      return null;
    }
    return `${itemType} ${phase}`;
  }

  if (method === 'item/reasoning/summaryTextDelta') {
    return null;
  }

  if (method === 'item/reasoning/summaryPartAdded') {
    return null;
  }

  if (method === 'thread/tokenUsage/updated') {
    const usage = toRecord(data.tokenUsage);
    if (!usage) {
      return null;
    }
    const input = readNumberAny(usage, ['inputTokens', 'input_tokens']);
    const output = readNumberAny(usage, ['outputTokens', 'output_tokens']);
    const total = readNumberAny(usage, ['totalTokens', 'total_tokens']);
    const parts = [
      typeof input === 'number' ? `in=${input}` : null,
      typeof output === 'number' ? `out=${output}` : null,
      typeof total === 'number' ? `total=${total}` : null,
    ].filter((v): v is string => v !== null);
    return parts.length > 0 ? `usage ${parts.join(' ')}` : null;
  }

  if (method === 'item/commandExecution/requestApproval') {
    return 'approval requested (command)';
  }

  if (method === 'item/fileChange/requestApproval') {
    return 'approval requested (file change)';
  }

  if (method === 'codex/event/apply_patch_begin' || method === 'codex/event/patch_apply_begin') {
    return null;
  }

  // delta や内部イベントの大量出力は表示しない（ストリーム表示と重複する）
  if (
    method.startsWith('item/agentMessage/')
    || method.startsWith('item/commandExecution/outputDelta')
    || method.startsWith('codex/event/')
    || method === 'account/rateLimits/updated'
  ) {
    return null;
  }

  return null;
}

function normalizeItemType(itemType: string): string {
  return itemType.replace(/[_-]/g, '').toLowerCase();
}

interface EditPreview {
  path: string;
  added: number;
  removed: number;
  diffLines: string[];
}

function formatEditEventLines(method: string, params: unknown): string[] {
  const data = toRecord(params);
  if (!data) {
    return [];
  }

  const previews = extractEditPreviews(method, data);
  if (previews.length === 0) {
    return [];
  }

  const lines: string[] = [];
  const maxFiles = 4;
  const maxDiffLines = 3;
  for (const preview of previews.slice(0, maxFiles)) {
    lines.push(`● Write ${preview.path} (+${preview.added} -${preview.removed})`);
    const visible = preview.diffLines.slice(0, maxDiffLines);
    for (const line of visible) {
      lines.push(`  ${line}`);
    }
    if (preview.diffLines.length > maxDiffLines) {
      lines.push(`  └─ +${preview.diffLines.length - maxDiffLines}行（展開: e）`);
    }
  }

  if (previews.length > maxFiles) {
    lines.push(`... (${previews.length - maxFiles} more files)`);
  }

  return lines;
}

function extractEditPreviews(method: string, data: Record<string, unknown>): EditPreview[] {
  if (method === 'codex/event/apply_patch_begin' || method === 'codex/event/patch_apply_begin') {
    const msg = readRecordAny(data, ['msg']);
    const changes = readRecordAny(msg, ['changes', 'file_changes']);
    return extractEditPreviewsFromChangeMap(changes);
  }

  if (method === 'item/completed') {
    const item = readRecordAny(data, ['item']);
    const itemType = normalizeItemType(readStringAny(item, ['type']) ?? '');
    if (itemType !== 'filechange') {
      return [];
    }

    const changes = item?.changes;
    if (!Array.isArray(changes)) {
      return [];
    }
    return extractEditPreviewsFromChangeArray(changes);
  }

  return [];
}

function extractEditPreviewsFromChangeMap(
  changes: Record<string, unknown> | null
): EditPreview[] {
  if (!changes) {
    return [];
  }

  const previews: EditPreview[] = [];
  for (const [path, value] of Object.entries(changes)) {
    const change = toRecord(value);
    const type = readStringAny(change, ['type']);
    if (!type) {
      continue;
    }

    if (type === 'add') {
      const content = readStringAny(change, ['content']) ?? '';
      const diffLines = contentToDiffLines(content, '+');
      previews.push({
        path,
        added: countTextLines(content),
        removed: 0,
        diffLines,
      });
      continue;
    }

    if (type === 'delete') {
      const content = readStringAny(change, ['content']) ?? '';
      const diffLines = contentToDiffLines(content, '-');
      previews.push({
        path,
        added: 0,
        removed: countTextLines(content),
        diffLines,
      });
      continue;
    }

    const diff = readStringAny(change, ['unified_diff', 'diff']) ?? '';
    const parsed = parseUnifiedDiff(diff);
    previews.push({
      path,
      added: parsed.added,
      removed: parsed.removed,
      diffLines: parsed.lines,
    });
  }

  return previews;
}

function extractEditPreviewsFromChangeArray(changes: unknown[]): EditPreview[] {
  const previews: EditPreview[] = [];
  for (const value of changes) {
    const change = toRecord(value);
    const path = readStringAny(change, ['path']) ?? '(unknown)';
    const diff = readStringAny(change, ['diff']) ?? '';
    const parsed = parseUnifiedDiff(diff);
    previews.push({
      path,
      added: parsed.added,
      removed: parsed.removed,
      diffLines: parsed.lines,
    });
  }
  return previews;
}

function parseUnifiedDiff(diff: string): {
  added: number;
  removed: number;
  lines: string[];
} {
  let added = 0;
  let removed = 0;
  const lines: string[] = [];
  for (const rawLine of diff.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('@@')) {
      lines.push(truncateDiffLine(line, 160));
      continue;
    }
    if (line.startsWith('+')) {
      added++;
      lines.push(truncateDiffLine(line, 160));
      continue;
    }
    if (line.startsWith('-')) {
      removed++;
      lines.push(truncateDiffLine(line, 160));
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('\\')) {
      lines.push(truncateDiffLine(line, 160));
    }
  }
  return { added, removed, lines };
}

function contentToDiffLines(content: string, prefix: '+' | '-'): string[] {
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => truncateDiffLine(`${prefix}${line}`, 160));
}

function countTextLines(content: string): number {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\n$/, '');
  if (normalized.length === 0) {
    return 0;
  }
  return normalized.split('\n').length;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readStringAny(source: Record<string, unknown> | null, keys: string[]): string | null {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

function readNumberAny(source: Record<string, unknown> | null, keys: string[]): number | null {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number') {
      return value;
    }
  }
  return null;
}

function readBooleanAny(source: Record<string, unknown> | null, keys: string[]): boolean | null {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return null;
}

function truncateLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength - 3) + '...';
}

function truncateDiffLine(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength - 3) + '...';
}

function wrapByDisplayWidth(value: string, maxWidth: number): string[] {
  const normalized = value.replace(/\r\n/g, '\n');
  const rawLines = normalized.split('\n');
  const wrapped: string[] = [];

  for (const rawLine of rawLines) {
    if (rawLine.length === 0) {
      wrapped.push('');
      continue;
    }

    let current = '';
    let width = 0;
    for (const char of rawLine) {
      const charWidth = getCharWidth(char);
      if (width + charWidth > maxWidth && current.length > 0) {
        wrapped.push(current);
        current = char;
        width = charWidth;
      } else {
        current += char;
        width += charWidth;
      }
    }
    wrapped.push(current);
  }

  return wrapped;
}

function readRecordAny(
  source: Record<string, unknown> | null,
  keys: string[]
): Record<string, unknown> | null {
  if (!source) {
    return null;
  }
  for (const key of keys) {
    const value = toRecord(source[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

/**
 * ラウンドボックスの上辺を生成（タイトル付き）
 */
function roundBoxTop(title: string, width: number = BOX_WIDTH): string {
  const titlePart = `${Colors.DIM}─${Colors.NC} ${Colors.BOLD}${title}${Colors.NC} `;
  const titleDisplayWidth = getDisplayWidth(title) + 4; // " title "
  const lineWidth = width - 2 - titleDisplayWidth;
  return `${Colors.BRIGHT_CYAN}${Box.ROUND_TOP_LEFT}${Colors.NC}${titlePart}${Colors.BRIGHT_CYAN}${Box.HORIZONTAL.repeat(lineWidth)}${Box.ROUND_TOP_RIGHT}${Colors.NC}`;
}

/**
 * ラウンドボックスの下辺を生成
 */
function roundBoxBottom(width: number = BOX_WIDTH): string {
  return `${Colors.BRIGHT_CYAN}${Box.ROUND_BOTTOM_LEFT}${Box.HORIZONTAL.repeat(width - 2)}${Box.ROUND_BOTTOM_RIGHT}${Colors.NC}`;
}

/**
 * ラウンドボックス内の行を生成
 */
function roundBoxLine(content: string, width: number = BOX_WIDTH): string {
  const displayWidth = getDisplayWidth(content);
  const padding = width - 2 - displayWidth;
  const spaces = padding > 0 ? ' '.repeat(padding) : '';
  return `${Colors.BRIGHT_CYAN}${Box.VERTICAL}${Colors.NC}${content}${spaces}${Colors.BRIGHT_CYAN}${Box.VERTICAL}${Colors.NC}`;
}

export function formatQuestionBoxLines(
  prompt: QuestionBoxPrompt,
  width: number = 62
): string[] {
  const lines: string[] = [];
  const bodyWidth = Math.max(1, width - 4);

  lines.push('');
  lines.push(roundBoxTop('ユーザー確認', width));

  if (prompt.context && prompt.context.trim().length > 0) {
    const contextLines = wrapByDisplayWidth(prompt.context.trim(), bodyWidth);
    for (const [index, contextLine] of contextLines.entries()) {
      const prefix = index === 0 ? `${Colors.DIM}コンテキスト:${Colors.NC} ` : '  ';
      lines.push(roundBoxLine(` ${prefix}${contextLine}`, width));
    }
    lines.push(roundBoxLine('', width));
  }

  const questionLines = wrapByDisplayWidth(prompt.question.trim(), bodyWidth);
  for (const [index, questionLine] of questionLines.entries()) {
    const prefix = index === 0 ? `${Colors.BOLD}質問:${Colors.NC} ` : '   ';
    lines.push(roundBoxLine(` ${prefix}${questionLine}`, width));
  }

  const options = prompt.options ?? [];
  if (options.length > 0) {
    lines.push(roundBoxLine('', width));
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const optionText = `${i + 1}. ${option.label} - ${option.description}`;
      const optionLines = wrapByDisplayWidth(optionText, bodyWidth);
      for (const optionLine of optionLines) {
        lines.push(roundBoxLine(` ${optionLine}`, width));
      }
    }
  }

  if (prompt.recommendation && prompt.recommendation.trim().length > 0) {
    lines.push(roundBoxLine('', width));
    const recommendationLines = wrapByDisplayWidth(
      `推奨: ${prompt.recommendation.trim()}`,
      bodyWidth
    );
    for (const recommendationLine of recommendationLines) {
      lines.push(roundBoxLine(` ${Colors.BRIGHT_GREEN}${recommendationLine}${Colors.NC}`, width));
    }
  }

  lines.push(roundBoxLine('', width));
  lines.push(roundBoxLine(' 回答方法: 番号 / ラベル / 自由入力', width));
  lines.push(roundBoxBottom(width));
  lines.push('');

  return lines;
}

export function printQuestionBox(
  prompt: QuestionBoxPrompt,
  output: NodeJS.WriteStream = process.stderr
): void {
  const lines = formatQuestionBoxLines(prompt);
  for (const line of lines) {
    output.write(line + '\n');
  }
}

/**
 * イテレーション完了時のサマリーを表示
 */
export function printIterationSummary(
  duration: string,
  promiseType: string | null,
  diffSummary: string | null,
  progressUpdate: string | null
): void {
  const lines: string[] = [''];

  lines.push(roundBoxTop('サマリー'));

  // 所要時間
  lines.push(roundBoxLine(` ${Colors.BRIGHT_GREEN}✓${Colors.NC} ${Colors.DIM}所要時間${Colors.NC} ${duration}`));

  // Promise
  if (promiseType) {
    const promiseColor = promiseType === 'COMPLETE' ? Colors.BRIGHT_GREEN : Colors.YELLOW;
    const checkMark = promiseType === 'COMPLETE' ? `${Colors.BRIGHT_GREEN}✓${Colors.NC}` : `${Colors.YELLOW}○${Colors.NC}`;
    const promiseLabel = promiseType === 'COMPLETE' ? '完了' : '継続';
    lines.push(roundBoxLine(` ${checkMark} ${Colors.DIM}状態${Colors.NC}     ${promiseColor}${promiseLabel}${Colors.NC}`));
  }

  // 空行
  lines.push(roundBoxLine(''));

  // 変更差分
  if (diffSummary) {
    lines.push(roundBoxLine(` ${Colors.DIM}変更:${Colors.NC}`));
    // diffSummaryが複数行の場合は各行を処理
    const diffLines = diffSummary.split('\n').filter((l) => l.trim());
    for (const diffLine of diffLines.slice(0, 3)) {
      // 最大3行まで表示
      const truncated =
        getDisplayWidth(diffLine) > 36 ? diffLine.slice(0, 35) + '…' : diffLine;
      lines.push(roundBoxLine(`   ${truncated}`));
    }
  }

  // 進捗更新
  if (progressUpdate) {
    lines.push(roundBoxLine(''));
    lines.push(roundBoxLine(` ${Colors.DIM}進捗:${Colors.NC}`));
    const progressLines = progressUpdate.split('\n').filter((l) => l.trim());
    for (const progressLine of progressLines.slice(0, 2)) {
      const truncated =
        getDisplayWidth(progressLine) > 36
          ? progressLine.slice(0, 35) + '…'
          : progressLine;
      lines.push(roundBoxLine(`   ${truncated}`));
    }
  }

  lines.push(roundBoxBottom());
  lines.push('');

  for (const line of lines) {
    process.stderr.write(line + '\n');
  }
}

/**
 * 引き継ぎレポートの内容
 */
export interface HandoffContent {
  /** HANDOFF.md の全内容 */
  content: string;
  /** ファイルパス */
  filePath: string;
}

/**
 * 引き継ぎレポートを表示
 */
export function printHandoffContent(handoff: HandoffContent): void {
  const separator = '────────────────────────────────────────';

  process.stderr.write('\n');
  process.stderr.write(`${Colors.DIM}${separator}${Colors.NC}\n`);
  process.stderr.write(`${Colors.CYAN}📋 引き継ぎレポート${Colors.NC}\n`);
  process.stderr.write(`${Colors.DIM}${separator}${Colors.NC}\n`);
  process.stderr.write('\n');
  process.stderr.write(`${handoff.content}\n`);
  process.stderr.write('\n');
  process.stderr.write(`${Colors.DIM}ファイル: ${handoff.filePath}${Colors.NC}\n`);
}

/**
 * 完了メッセージを表示
 */
export function printCompletion(
  mode: ExecutionMode,
  totalIterations: number,
  handoff?: HandoffContent | null
): void {
  const separator = '========================================';
  const modeName = MODE_NAMES[mode];

  process.stderr.write('\n');
  process.stderr.write(`${Colors.GREEN}${separator}${Colors.NC}\n`);
  process.stderr.write(`${Colors.GREEN}✓ Melos ${modeName} 完了！${Colors.NC}\n`);
  process.stderr.write(`${Colors.GREEN}${separator}${Colors.NC}\n`);
  process.stderr.write('\n');
  process.stderr.write(
    `${Colors.NC}合計イテレーション: ${totalIterations}${Colors.NC}\n`
  );

  // 引き継ぎレポートがあれば表示
  if (handoff) {
    printHandoffContent(handoff);
  }
}

/**
 * 警告メッセージを表示
 */
export function printWarning(message: string): void {
  process.stderr.write(`${Colors.YELLOW}⚠ ${message}${Colors.NC}\n`);
}

/**
 * エラーメッセージを表示
 */
export function printError(message: string): void {
  process.stderr.write(`${Colors.RED}✗ ${message}${Colors.NC}\n`);
}

/**
 * 情報メッセージを表示
 */
export function printInfo(message: string): void {
  process.stderr.write(`${Colors.CYAN}ℹ ${message}${Colors.NC}\n`);
}

/**
 * 次のイテレーションへの遷移を表示
 */
export function printNextIteration(): void {
  process.stderr.write(`\n${Colors.CYAN}▶ 次のイテレーションへ...${Colors.NC}\n`);
}
