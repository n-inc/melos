export type InteractiveSubmitResult =
  | { status: 'accepted' }
  | { status: 'answered'; answer: string }
  | { status: 'queued'; queuedCount: number; target: 'manager-codex' }
  | { status: 'unavailable' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

export interface InteractiveInputController {
  start: () => void;
  stop: () => void;
}

interface CreateInteractiveInputControllerOptions {
  onSubmit: (instruction: string) => Promise<InteractiveSubmitResult>;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  prompt?: string;
  fixedInputArea?: boolean;
  feedbackClearDelayMs?: number;
}

const DIM = '\x1b[2m';
const CYAN = '\x1b[0;36m';
const YELLOW = '\x1b[1;33m';
const RED = '\x1b[0;31m';
const RESET = '\x1b[0m';
const DEFAULT_TERMINAL_COLUMNS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const DEFAULT_FEEDBACK_CLEAR_DELAY_MS = 4000;
const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const ANSI_ESCAPE_PREFIX_PATTERN = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/;
const ANSI_SGR_PATTERN = /^\x1b\[[0-9;?]*m$/;

type SgrState = 'none' | 'set' | 'reset';

function getCharDisplayWidth(char: string): number {
  const code = char.charCodeAt(0);
  if (
    (code >= 0x3000 && code <= 0x9fff) ||
    (code >= 0xff00 && code <= 0xffef)
  ) {
    return 2;
  }
  return 1;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '');
}

function getDisplayWidth(value: string): number {
  let width = 0;
  for (const char of stripAnsi(value)) {
    width += getCharDisplayWidth(char);
  }
  return width;
}

function getSgrState(sequence: string): SgrState {
  if (!ANSI_SGR_PATTERN.test(sequence)) {
    return 'none';
  }

  const params = sequence.slice(2, -1);
  if (params.length === 0) {
    return 'reset';
  }

  const hasNonZeroParam = params.split(';').some((param) => {
    const parsed = Number(param);
    return Number.isFinite(parsed) && parsed !== 0;
  });
  return hasNonZeroParam ? 'set' : 'reset';
}

interface DisplayToken {
  text: string;
  width: number;
  sgrState: SgrState;
}

function tokenizeDisplayValue(value: string): DisplayToken[] {
  const tokens: DisplayToken[] = [];
  let index = 0;

  while (index < value.length) {
    if (value[index] === '\x1b') {
      const escaped = value.slice(index).match(ANSI_ESCAPE_PREFIX_PATTERN)?.[0];
      if (escaped) {
        tokens.push({
          text: escaped,
          width: 0,
          sgrState: getSgrState(escaped),
        });
        index += escaped.length;
        continue;
      }
    }

    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const char = String.fromCodePoint(codePoint);
    tokens.push({
      text: char,
      width: getCharDisplayWidth(char),
      sgrState: 'none',
    });
    index += char.length;
  }

  return tokens;
}

function truncateByDisplayWidth(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (getDisplayWidth(value) <= maxWidth) {
    return value;
  }

  const ellipsis = '…';
  if (maxWidth <= getDisplayWidth(ellipsis)) {
    return ellipsis;
  }

  const maxBodyWidth = maxWidth - getDisplayWidth(ellipsis);
  let width = 0;
  let result = '';
  let styleOpen = false;
  for (const token of tokenizeDisplayValue(value)) {
    if (token.width === 0) {
      result += token.text;
      if (token.sgrState === 'set') {
        styleOpen = true;
      } else if (token.sgrState === 'reset') {
        styleOpen = false;
      }
      continue;
    }

    if (width + token.width > maxBodyWidth) {
      break;
    }
    width += token.width;
    result += token.text;
  }

  if (styleOpen) {
    return `${result}${ellipsis}${RESET}`;
  }

  return `${result}${ellipsis}`;
}

/**
 * 実行中にユーザー入力を受け取り steer へ渡す
 */
export function createInteractiveInputController(
  options: CreateInteractiveInputControllerOptions
): InteractiveInputController {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const prompt = options.prompt ?? 'melos> ';
  const fixedInputArea = options.fixedInputArea === true;
  const feedbackClearDelayMs = options.feedbackClearDelayMs ?? DEFAULT_FEEDBACK_CLEAR_DELAY_MS;

  let started = false;
  let lineBuffer = '';
  let inputLine = '';
  let skippingEscapeSequence = false;
  let escapeSequenceIsCSI = false;
  let skipNextLineFeed = false;
  let queue: Promise<void> = Promise.resolve();
  let promptVisible = false;
  let rawModeEnabled = false;
  let internalWrite = false;
  let originalWrite: ((chunk: unknown, ...args: unknown[]) => boolean) | null = null;
  let feedbackClearTimer: ReturnType<typeof setTimeout> | null = null;

  const getColumns = () => output.columns ?? process.stderr.columns ?? DEFAULT_TERMINAL_COLUMNS;
  const getRows = () => Math.max(
    output.rows ?? process.stderr.rows ?? DEFAULT_TERMINAL_ROWS,
    3
  );

  const writeDirect = (text: string) => {
    if (originalWrite) {
      internalWrite = true;
      try {
        originalWrite(text);
      } finally {
        internalWrite = false;
      }
      return;
    }
    output.write(text);
  };

  const renderFixedLine = (row: number, text: string) => {
    const rendered = truncateByDisplayWidth(text, getColumns());
    writeDirect('\x1b7');
    writeDirect(`\x1b[${Math.max(1, row)};1H\x1b[2K`);
    if (rendered.length > 0) {
      writeDirect(rendered);
    }
    writeDirect('\x1b8');
  };

  const renderFixedPrompt = () => {
    renderFixedLine(getRows(), `${DIM}${prompt}${RESET}${inputLine}`);
    promptVisible = true;
  };

  const clearFeedbackClearTimer = () => {
    if (!feedbackClearTimer) {
      return;
    }
    clearTimeout(feedbackClearTimer);
    feedbackClearTimer = null;
  };

  const scheduleFeedbackClear = () => {
    if (!fixedInputArea) {
      return;
    }
    clearFeedbackClearTimer();
    feedbackClearTimer = setTimeout(() => {
      feedbackClearTimer = null;
      if (!started) {
        return;
      }
      clearFeedbackLine();
      refreshPrompt();
    }, feedbackClearDelayMs);
  };

  const previewInstruction = (instruction: string): string => {
    const normalized = instruction.replace(/\s+/g, ' ').trim();
    return truncateByDisplayWidth(normalized, 48);
  };

  const renderFeedback = (text: string, color: string, autoClear: boolean = true) => {
    if (fixedInputArea) {
      renderFixedLine(getRows() - 1, `${color}${text}${RESET}`);
      if (autoClear) {
        scheduleFeedbackClear();
      } else {
        clearFeedbackClearTimer();
      }
      return;
    }
    writeDirect(`${color}${text}${RESET}\n`);
  };

  const printPrompt = () => {
    if (!started || promptVisible) {
      return;
    }
    if (fixedInputArea) {
      renderFixedPrompt();
      return;
    }
    writeDirect(`${DIM}${prompt}${RESET}`);
    promptVisible = true;
  };

  const clearPromptLine = () => {
    if (fixedInputArea) {
      renderFixedLine(getRows(), '');
      promptVisible = false;
      return;
    }
    writeDirect('\x1b[2K\r');
    promptVisible = false;
  };

  const clearFeedbackLine = () => {
    if (!fixedInputArea) {
      return;
    }
    clearFeedbackClearTimer();
    renderFixedLine(getRows() - 1, '');
  };

  const refreshPrompt = () => {
    if (!started) {
      return;
    }
    promptVisible = false;
    printPrompt();
  };

  const wrapOutputWrite = () => {
    if (fixedInputArea) {
      return;
    }
    if (originalWrite) {
      return;
    }

    originalWrite = output.write.bind(output) as (
      chunk: unknown,
      ...args: unknown[]
    ) => boolean;

    output.write = ((chunk: unknown, ...args: unknown[]) => {
      if (started && !internalWrite && promptVisible) {
        // 外部ログを書き出す前に入力プロンプト行を消す
        writeDirect('\x1b[2K\r');
      }
      const result = originalWrite!(chunk, ...args);
      if (!started || internalWrite) {
        return result;
      }

      let text = '';
      if (typeof chunk === 'string') {
        text = chunk;
      } else if (chunk instanceof Buffer) {
        text = chunk.toString('utf8');
      }

      if (text.includes('\n')) {
        refreshPrompt();
      }
      return result;
    }) as typeof output.write;
  };

  const restoreOutputWrite = () => {
    if (!originalWrite) {
      return;
    }
    output.write = originalWrite as typeof output.write;
    originalWrite = null;
  };

  const submitInstruction = async (instruction: string): Promise<void> => {
    const text = instruction.trim();
    if (text.length === 0) {
      inputLine = '';
      printPrompt();
      return;
    }

    inputLine = '';
    clearPromptLine();
    const result = await options.onSubmit(text);
    const preview = previewInstruction(text);
    if (result.status === 'accepted') {
      renderFeedback(`[steer] 送信しました: "${preview}"`, CYAN);
    } else if (result.status === 'answered') {
      renderFeedback(`[answer] 回答を送信しました: ${result.answer}`, CYAN);
    } else if (result.status === 'queued') {
      renderFeedback(
        `[steer] 保留 (${result.queuedCount}件): "${preview}"。次回 Manager(Codex) 開始時に送信します`,
        CYAN
      );
    } else if (result.status === 'unsupported') {
      renderFeedback(`[steer] 現在のモデルでは steer 非対応です: "${preview}"`, YELLOW);
    } else if (result.status === 'unavailable') {
      renderFeedback(`[steer] 実行中ターンがありません: "${preview}"`, YELLOW);
    } else {
      renderFeedback(`[steer] 送信失敗: "${preview}" (${result.message})`, RED, false);
    }
    refreshPrompt();
  };

  const queueSubmission = (instruction: string) => {
    queue = queue.then(() => submitInstruction(instruction)).catch((error) => {
      clearPromptLine();
      const message = error instanceof Error ? error.message : String(error);
      renderFeedback(`[steer] 送信失敗: ${message}`, RED);
      refreshPrompt();
    });
  };

  const handleLineData = (chunk: Buffer | string) => {
    if (!started) {
      return;
    }

    const textChunk = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const normalized = textChunk.replace(/\u0003/g, '');
    if (normalized.length === 0) {
      return;
    }

    lineBuffer += normalized;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      queueSubmission(line);
    }
  };

  const handleFixedData = (chunk: Buffer | string) => {
    if (!started) {
      return;
    }

    const textChunk = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const normalized = textChunk.replace(/\u0003/g, '');
    if (normalized.length === 0) {
      return;
    }

    for (const char of normalized) {
      if (skippingEscapeSequence) {
        if (!escapeSequenceIsCSI && char === '[') {
          escapeSequenceIsCSI = true;
          continue;
        }

        if (!escapeSequenceIsCSI) {
          skippingEscapeSequence = false;
          continue;
        }

        if (char >= '@' && char <= '~' && char !== '[') {
          skippingEscapeSequence = false;
          escapeSequenceIsCSI = false;
        }
        continue;
      }

      if (char === '\u001b') {
        skippingEscapeSequence = true;
        escapeSequenceIsCSI = false;
        continue;
      }

      if (char === '\r') {
        skipNextLineFeed = true;
        queueSubmission(inputLine);
        inputLine = '';
        continue;
      }

      if (char === '\n') {
        if (skipNextLineFeed) {
          skipNextLineFeed = false;
          continue;
        }
        queueSubmission(inputLine);
        inputLine = '';
        continue;
      }

      skipNextLineFeed = false;

      if (char === '\u007f' || char === '\b') {
        inputLine = Array.from(inputLine).slice(0, -1).join('');
        refreshPrompt();
        continue;
      }

      if (char < ' ') {
        continue;
      }

      inputLine += char;
      refreshPrompt();
    }
  };

  const setRawMode = (enabled: boolean) => {
    if (typeof input.setRawMode === 'function' && input.isTTY === true) {
      input.setRawMode(enabled);
      rawModeEnabled = enabled;
    }
  };

  const start = () => {
    if (started) {
      return;
    }
    started = true;
    if (fixedInputArea) {
      setRawMode(true);
      clearFeedbackLine();
    }
    wrapOutputWrite();
    writeDirect(
      `${DIM}実行中入力: ${prompt}<instruction> で steer/質問回答を送信できます（Claude Worker中はManagerへ保留して引き渡し）${RESET}\n`
    );
    printPrompt();
    input.on('data', fixedInputArea ? handleFixedData : handleLineData);
  };

  const stop = () => {
    if (!started) {
      return;
    }
    started = false;
    clearFeedbackClearTimer();
    input.removeListener('data', fixedInputArea ? handleFixedData : handleLineData);
    if (rawModeEnabled) {
      setRawMode(false);
    }
    if (fixedInputArea) {
      clearFeedbackLine();
      clearPromptLine();
    }
    restoreOutputWrite();
    if (!fixedInputArea) {
      output.write('\n');
    }
  };

  return {
    start,
    stop,
  };
}
