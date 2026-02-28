import { PassThrough } from 'node:stream';

import { readLine } from '../orchestrator.js';

describe('orchestrator readLine', () => {
  it('resolves immediately for single-key approval in raw mode', async () => {
    const input = new PassThrough();
    const promise = readLine(input as unknown as NodeJS.ReadStream);

    input.write('y');
    await expect(promise).resolves.toBe('y');
  });

  it('resolves immediately for single-key regenerate in raw mode', async () => {
    const input = new PassThrough();
    const promise = readLine(input as unknown as NodeJS.ReadStream);

    input.write('N');
    await expect(promise).resolves.toBe('N');
  });

  it('resolves when carriage return is received (raw mode Enter)', async () => {
    const input = new PassThrough();
    const promise = readLine(input as unknown as NodeJS.ReadStream);

    input.write('y\r');
    await expect(promise).resolves.toBe('y');
  });

  it('resolves when line feed is received', async () => {
    const input = new PassThrough();
    const promise = readLine(input as unknown as NodeJS.ReadStream);

    input.write('edit\n');
    await expect(promise).resolves.toBe('edit');
  });

  it('resolves with control-c marker when Ctrl+C is pressed', async () => {
    const input = new PassThrough();
    const promise = readLine(input as unknown as NodeJS.ReadStream);

    input.write('\u0003');
    await expect(promise).resolves.toBe('\u0003');
  });
});
