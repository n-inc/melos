import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';

import {
  formatElapsed,
  createProgressBar,
  createColoredProgressBar,
  createSpinner,
} from '../display.js';

describe('display.ts', () => {
  describe('formatElapsed', () => {
    test('秒のみの場合', () => {
      const now = new Date();
      const thirtySecondsAgo = new Date(now.getTime() - 30 * 1000);

      const result = formatElapsed(thirtySecondsAgo);

      expect(result).toBe('0m 30s');
    });

    test('分と秒の場合', () => {
      const now = new Date();
      const twoMinutesAgo = new Date(now.getTime() - 125 * 1000); // 2分5秒

      const result = formatElapsed(twoMinutesAgo);

      expect(result).toBe('2m 05s');
    });

    test('ISO文字列を受け付ける', () => {
      const now = new Date();
      const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);

      const result = formatElapsed(oneMinuteAgo.toISOString());

      expect(result).toBe('1m 00s');
    });
  });

  describe('createProgressBar', () => {
    test('0% の場合すべて空白', () => {
      const bar = createProgressBar(0, 10, 10);
      expect(bar).toBe('░░░░░░░░░░');
    });

    test('50% の場合半分が埋まる', () => {
      const bar = createProgressBar(5, 10, 10);
      expect(bar).toBe('█████░░░░░');
    });

    test('100% の場合すべて埋まる', () => {
      const bar = createProgressBar(10, 10, 10);
      expect(bar).toBe('██████████');
    });

    test('total が 0 の場合すべて空白', () => {
      const bar = createProgressBar(0, 0, 10);
      expect(bar).toBe('░░░░░░░░░░');
    });

    test('current が total を超える場合 100% として扱う', () => {
      const bar = createProgressBar(15, 10, 10);
      expect(bar).toBe('██████████');
    });

    test('デフォルト幅は 20', () => {
      const bar = createProgressBar(5, 10);
      expect(bar.length).toBe(20);
    });
  });

  describe('createColoredProgressBar', () => {
    // ANSIコードを除去するヘルパー
    const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, '');

    test('0% の場合は赤色で空のバー', () => {
      const bar = createColoredProgressBar(0, 10, 10);
      const plain = stripAnsi(bar);
      expect(plain).toBe('░░░░░░░░░░');
      // ANSIコードが含まれていることを確認
      expect(bar).toContain('\x1b[');
    });

    test('33% 以下は赤色', () => {
      const bar = createColoredProgressBar(3, 10, 10);
      // 赤色コード \x1b[0;31m が含まれる
      expect(bar).toContain('\x1b[0;31m');
    });

    test('34-66% は黄色', () => {
      const bar = createColoredProgressBar(5, 10, 10);
      // 黄色コード \x1b[1;33m が含まれる
      expect(bar).toContain('\x1b[1;33m');
    });

    test('67% 以上は緑色', () => {
      const bar = createColoredProgressBar(8, 10, 10);
      // 明るい緑色コード \x1b[1;32m が含まれる
      expect(bar).toContain('\x1b[1;32m');
    });

    test('100% の場合すべて埋まる', () => {
      const bar = createColoredProgressBar(10, 10, 10);
      const plain = stripAnsi(bar);
      expect(plain).toBe('██████████');
    });

    test('total が 0 の場合はDIMで空のバー', () => {
      const bar = createColoredProgressBar(0, 0, 10);
      const plain = stripAnsi(bar);
      expect(plain).toBe('░░░░░░░░░░');
      // DIMコード \x1b[2m が含まれる
      expect(bar).toContain('\x1b[2m');
    });

    test('デフォルト幅は 12', () => {
      const bar = createColoredProgressBar(5, 10);
      const plain = stripAnsi(bar);
      expect(plain.length).toBe(12);
    });
  });

  describe('createSpinner', () => {
    let stderrOutput: string[];
    let originalWrite: typeof process.stderr.write;

    beforeEach(() => {
      stderrOutput = [];
      originalWrite = process.stderr.write;
      process.stderr.write = ((chunk: string) => {
        stderrOutput.push(chunk);
        return true;
      }) as typeof process.stderr.write;
    });

    afterEach(() => {
      process.stderr.write = originalWrite;
    });

    test('スピナーを作成して停止できる', async () => {
      const spinner = createSpinner('テスト中...');

      // スピナーが動作していることを確認
      expect(stderrOutput.length).toBeGreaterThan(0);

      spinner.stop();

      // 停止後は行がクリアされる
      const lastOutput = stderrOutput[stderrOutput.length - 1];
      expect(lastOutput).toContain('\r');
    });

    test('succeed でチェックマークを表示', () => {
      const spinner = createSpinner('処理中...');
      spinner.succeed('完了しました');

      const output = stderrOutput.join('');
      expect(output).toContain('✓');
      expect(output).toContain('完了しました');
    });

    test('fail でエラーマークを表示', () => {
      const spinner = createSpinner('処理中...');
      spinner.fail('失敗しました');

      const output = stderrOutput.join('');
      expect(output).toContain('✗');
      expect(output).toContain('失敗しました');
    });
  });
});
