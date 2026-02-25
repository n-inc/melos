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
}

const DIM = '\x1b[2m';
const CYAN = '\x1b[0;36m';
const YELLOW = '\x1b[1;33m';
const RED = '\x1b[0;31m';
const RESET = '\x1b[0m';

/**
 * 実行中にユーザー入力を受け取り steer へ渡す
 */
export function createInteractiveInputController(
  options: CreateInteractiveInputControllerOptions
): InteractiveInputController {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const prompt = options.prompt ?? 'melos> ';

  let started = false;
  let buffer = '';
  let queue: Promise<void> = Promise.resolve();
  let promptVisible = false;
  let internalWrite = false;
  let originalWrite: ((chunk: unknown, ...args: unknown[]) => boolean) | null = null;

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

  const printPrompt = () => {
    if (!started || promptVisible) {
      return;
    }
    writeDirect(`${DIM}${prompt}${RESET}`);
    promptVisible = true;
  };

  const clearPromptLine = () => {
    writeDirect('\x1b[2K\r');
    promptVisible = false;
  };

  const refreshPrompt = () => {
    if (!started) {
      return;
    }
    promptVisible = false;
    printPrompt();
  };

  const wrapOutputWrite = () => {
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
      printPrompt();
      return;
    }

    clearPromptLine();
    const result = await options.onSubmit(text);
    if (result.status === 'accepted') {
      writeDirect(`${CYAN}[steer] 送信しました${RESET}\n`);
    } else if (result.status === 'answered') {
      writeDirect(`${CYAN}[answer] 回答を送信しました: ${result.answer}${RESET}\n`);
    } else if (result.status === 'queued') {
      writeDirect(
        `${CYAN}[steer] 受け付けました（保留: ${result.queuedCount}件）。次回 Manager(Codex) 開始時に送信します${RESET}\n`
      );
    } else if (result.status === 'unsupported') {
      writeDirect(`${YELLOW}[steer] 現在のモデルでは steer 非対応です${RESET}\n`);
    } else if (result.status === 'unavailable') {
      writeDirect(`${YELLOW}[steer] 実行中ターンがありません${RESET}\n`);
    } else {
      writeDirect(`${RED}[steer] 送信失敗: ${result.message}${RESET}\n`);
    }
    refreshPrompt();
  };

  const handleData = (chunk: Buffer | string) => {
    if (!started) {
      return;
    }

    const textChunk = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const normalized = textChunk.replace(/\u0003/g, '');
    if (normalized.length === 0) {
      return;
    }

    buffer += normalized;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      queue = queue.then(() => submitInstruction(line)).catch((error) => {
        clearPromptLine();
        const message = error instanceof Error ? error.message : String(error);
        writeDirect(`${RED}[steer] 送信失敗: ${message}${RESET}\n`);
        refreshPrompt();
      });
    }
  };

  const start = () => {
    if (started) {
      return;
    }
    started = true;
    wrapOutputWrite();
    writeDirect(
      `${DIM}実行中入力: ${prompt}<instruction> で steer/質問回答を送信できます（Claude Worker中はManagerへ保留して引き渡し）${RESET}\n`
    );
    printPrompt();
    input.on('data', handleData);
  };

  const stop = () => {
    if (!started) {
      return;
    }
    started = false;
    input.removeListener('data', handleData);
    restoreOutputWrite();
    output.write('\n');
  };

  return {
    start,
    stop,
  };
}
