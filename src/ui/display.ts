import type { MarathonStatus } from '../state/status.js';
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
 * モード表示名
 */
const MODE_NAMES: Record<ExecutionMode, string> = {
  default: 'デフォルト',
  'review-only': 'レビューのみ',
  'ci-fix-only': 'CI修正のみ',
  'task-only': 'タスクのみ',
};

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
  reasoningEffort?: string | null
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
  let engineDisplay = engine;
  if (model) {
    engineDisplay += ` (${model})`;
  }

  lines.push(
    boxLine(`  ${Colors.DIM}タスク${Colors.NC}    ${truncatedTask}`),
    boxLine(`  ${Colors.DIM}進捗${Colors.NC}      [${progressBar}] ${progressPercent}%`),
    boxLine(`  ${Colors.DIM}経過${Colors.NC}      ${elapsed}`),
    boxLine(`  ${Colors.DIM}エンジン${Colors.NC}  ${engineDisplay}`)
  );

  // Claude エンジンの場合は thinking budget を別行で表示
  if (engine === 'claude') {
    lines.push(boxLine(`  ${Colors.DIM}thinking${Colors.NC}  ${thinkingBudget ?? 31999}`));
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
 * イテレーション開始時のヘッダーを表示（ステータスオブジェクトから）
 * NOTE: MarathonStatusにはmodeが含まれないため、デフォルトモードを使用
 */
export function printIterationHeaderFromStatus(status: MarathonStatus): void {
  printIterationHeader(
    status.iteration,
    status.maxIterations,
    'default',
    status.currentTask,
    status.completedTasks,
    status.totalTasks,
    status.startedAt,
    status.engine
  );
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
 * スピナーを作成
 */
export function createSpinner(
  message: string,
  startTime: Date = new Date()
): Spinner {
  let frameIndex = 0;
  let intervalId: NodeJS.Timeout | null = null;
  let lastLineLength = 0;

  const render = () => {
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    const elapsed = formatElapsed(startTime);
    const line = `${Colors.CYAN}${frame}${Colors.NC} ${message} ${Colors.DIM}${elapsed}${Colors.NC}`;

    // 前の行をクリア
    process.stderr.write('\r' + ' '.repeat(lastLineLength) + '\r');
    process.stderr.write(line);

    // ANSIコードを除いた実際の文字数を計算
    lastLineLength = line.replace(/\x1b\[[0-9;]*m/g, '').length;
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
    process.stderr.write('\r' + ' '.repeat(lastLineLength) + '\r');
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
  process.stderr.write(`${Colors.GREEN}✓ Marathon ${modeName} 完了！${Colors.NC}\n`);
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
