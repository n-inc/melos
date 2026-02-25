import { PassThrough } from 'node:stream';
import { createInteractiveInputController } from '../interactive.js';

describe('interactive input controller', () => {
  const wait = async (ms: number) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
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
    expect(rendered).toContain('[steer] 送信しました');
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
    expect(rendered).toContain('[steer] 送信しました');
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

    expect(rendered).toContain('受け付けました（保留: 2件）');
    expect(rendered).toContain('次回 Manager(Codex) 開始時に送信します');
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
});
