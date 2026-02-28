import { PassThrough } from 'node:stream';
import { createInteractiveInputController } from '../interactive.js';

describe('interactive input controller', () => {
  const wait = async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  };
  const stripAnsi = (value: string) => value.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g, '');
  const hasDanglingEscape = (value: string) => {
    const cleaned = value.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g, '');
    return cleaned.includes('\x1b');
  };
  const getLastFixedLineRender = (rendered: string, row: number): string | null => {
    const pattern = new RegExp(`\\x1b\\[${row};1H\\x1b\\[2K([\\s\\S]*?)\\x1b8`, 'g');
    let match: RegExpExecArray | null = null;
    let last: string | null = null;
    while ((match = pattern.exec(rendered)) !== null) {
      last = match[1] ?? '';
    }
    return last;
  };

  it('submits input lines and prints accepted status', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received: string[] = [];
    let rendered = '';
    output.on('data', (chunk: Buffer | string) => {
      rendered += chunk.toString();
    });

    const controller = createInteractiveInputController({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onSubmit: async (instruction) => {
        received.push(instruction);
        return { status: 'accepted' };
      },
    });

    controller.start();
    input.write('  use vitest  \n');
    await wait(10);
    controller.stop();

    expect(received).toEqual(['use vitest']);
    expect(rendered).toContain('melos>');
    expect(rendered).toContain('[steer] 送信しました: "use vitest"');
  });

  it('uses stdout by default and prints interactive hint', async () => {
    const input = new PassThrough();
    let rendered = '';
    const originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: Buffer | string) => {
      rendered += chunk.toString();
      return true;
    }) as typeof process.stdout.write;

    try {
      const controller = createInteractiveInputController({
        input: input as unknown as NodeJS.ReadStream,
        onSubmit: async () => ({ status: 'accepted' }),
      });

      controller.start();
      input.write('send note\n');
      await wait(10);
      controller.stop();
    } finally {
      process.stdout.write = originalStdoutWrite;
    }

    expect(rendered).toContain('実行中入力:');
    expect(rendered).toContain('Claude Worker中はManagerへ保留して引き渡し');
    expect(rendered).toContain('[steer] 送信しました: "send note"');
  });

  it('prints unavailable status when no active turn', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk: Buffer | string) => {
      rendered += chunk.toString();
    });

    const controller = createInteractiveInputController({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onSubmit: async () => ({ status: 'unavailable' }),
    });

    controller.start();
    input.write('hello\n');
    await wait(10);
    controller.stop();

    expect(rendered).toContain('実行中ターンがありません');
    expect(rendered).toContain('"hello"');
  });

  it('prints queued status when steer is deferred', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk: Buffer | string) => {
      rendered += chunk.toString();
    });

    const controller = createInteractiveInputController({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onSubmit: async () => ({ status: 'queued', queuedCount: 2, target: 'manager-codex' }),
    });

    controller.start();
    input.write('keep this\n');
    await wait(10);
    controller.stop();

    expect(rendered).toContain('保留 (2件)');
    expect(rendered).toContain('"keep this"');
    expect(rendered).toContain('次回 Manager(Codex) 開始時に送信します');
  });

  it('prints answered status when escalation answer is submitted', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk: Buffer | string) => {
      rendered += chunk.toString();
    });

    const controller = createInteractiveInputController({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onSubmit: async () => ({ status: 'answered', answer: 'JWT (推奨)' }),
    });

    controller.start();
    input.write('1\n');
    await wait(10);
    controller.stop();

    expect(rendered).toContain('[answer] 回答を送信しました: JWT (推奨)');
  });

  it('prints error status when submit result is error', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk: Buffer | string) => {
      rendered += chunk.toString();
    });

    const controller = createInteractiveInputController({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onSubmit: async () => ({ status: 'error', message: '選択肢は 1〜3 で入力してください' }),
    });

    controller.start();
    input.write('9\n');
    await wait(10);
    controller.stop();

    expect(rendered).toContain('[steer] 送信失敗: "9" (選択肢は 1〜3 で入力してください)');
  });

  it('reprints prompt after external log output', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk: Buffer | string) => {
      rendered += chunk.toString();
    });

    const controller = createInteractiveInputController({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      onSubmit: async () => ({ status: 'accepted' }),
    });

    controller.start();
    output.write('external log line\n');
    await wait(220);
    controller.stop();

    const promptMatches = rendered.match(/melos> /g) ?? [];
    expect(promptMatches.length).toBeGreaterThanOrEqual(2);
    expect(rendered).toContain('external log line');
  });

  it('fixed input area で矢印キーが A/B として入力されない', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received: string[] = [];
    let rendered = '';
    output.on('data', (chunk: Buffer | string) => {
      rendered += chunk.toString();
    });

    const controller = createInteractiveInputController({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      fixedInputArea: true,
      onSubmit: async (instruction) => {
        received.push(instruction);
        return { status: 'accepted' };
      },
    });

    controller.start();
    input.write('\u001b[A');
    input.write('\u001b[B');
    input.write('next action\n');
    await wait(10);
    controller.stop();

    expect(received).toEqual(['next action']);
    expect(rendered).not.toContain('AB');
  });

  it('fixed input area でも送信内容をフィードバックに表示する', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk: Buffer | string) => {
      rendered += chunk.toString();
    });

    const controller = createInteractiveInputController({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
      fixedInputArea: true,
      feedbackClearDelayMs: 10,
      onSubmit: async () => ({ status: 'accepted' }),
    });

    controller.start();
    input.write('deploy api\n');
    await wait(20);
    controller.stop();

    expect(rendered).toContain('[steer] 送信しました: "deploy api"');
  });

  it('fixed input area で ANSI を含む入力行を狭幅で安全に切り詰める', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ttyOutput = output as unknown as NodeJS.WriteStream & {
      columns?: number;
      rows?: number;
    };
    ttyOutput.columns = 10;
    ttyOutput.rows = 4;

    let rendered = '';
    output.on('data', (chunk: Buffer | string) => {
      rendered += chunk.toString();
    });

    const controller = createInteractiveInputController({
      input: input as unknown as NodeJS.ReadStream,
      output: ttyOutput as unknown as NodeJS.WriteStream,
      fixedInputArea: true,
      onSubmit: async () => ({ status: 'accepted' }),
    });

    controller.start();
    input.write('abcdefghijklmnopqrstuvwxyz');
    await wait(20);

    const promptLine = getLastFixedLineRender(rendered, 4);
    controller.stop();

    expect(promptLine).not.toBeNull();
    expect(hasDanglingEscape(promptLine ?? '')).toBe(false);

    const plainPromptLine = stripAnsi(promptLine ?? '');
    expect(plainPromptLine.length).toBeLessThanOrEqual(10);
    expect(plainPromptLine).toContain('melos>');
    expect(plainPromptLine.endsWith('…')).toBe(true);
  });
});
