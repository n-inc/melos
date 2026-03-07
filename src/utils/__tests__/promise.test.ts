import { describe, it, expect } from '@jest/globals';
import {
  detectPromise,
  getPromiseMessage,
  type PromiseType,
} from '../promise.js';

describe('promise detection', () => {
  describe('detectPromise', () => {
    describe('COMPLETE detection', () => {
      it('detects <promise>COMPLETE</promise> tag', () => {
        const output = 'Some output\n<promise>COMPLETE</promise>\nMore output';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('COMPLETE');
      });

      it('detects standalone COMPLETE at line start', () => {
        const output = 'Some output\nCOMPLETE\nMore output';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('COMPLETE');
      });

      it('detects COMPLETE at the very beginning', () => {
        const output = 'COMPLETE';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('COMPLETE');
      });

      it('does not detect COMPLETE in the middle of a line', () => {
        const output = 'Some COMPLETE output';
        const result = detectPromise(output);
        // Should not match because COMPLETE is not at line start
        expect(result.detected).toBe(false);
        expect(result.type).toBeNull();
      });
    });

    describe('TASK_DONE detection', () => {
      it('detects <promise>TASK_DONE</promise> tag', () => {
        const output = 'Some output\n<promise>TASK_DONE</promise>\nMore output';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('TASK_DONE');
      });

      it('detects standalone TASK_DONE at line start', () => {
        const output = 'Some output\nTASK_DONE\nMore output';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('TASK_DONE');
      });

      it('detects TASK_DONE at the very beginning', () => {
        const output = 'TASK_DONE';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('TASK_DONE');
      });

      it('does not detect TASK_DONE in the middle of a line', () => {
        const output = 'Some TASK_DONE output';
        const result = detectPromise(output);
        expect(result.detected).toBe(false);
        expect(result.type).toBeNull();
      });
    });

    describe('ESCALATE detection', () => {
      it('detects <promise>ESCALATE</promise> tag', () => {
        const output = 'Some output\n<promise>ESCALATE</promise>\nMore output';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('ESCALATE');
      });

      it('detects standalone ESCALATE at line start', () => {
        const output = 'Some output\nESCALATE\nMore output';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('ESCALATE');
      });

      it('detects ESCALATE at the very beginning', () => {
        const output = 'ESCALATE';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('ESCALATE');
      });

      it('does not detect ESCALATE in the middle of a line', () => {
        const output = 'Some ESCALATE output';
        const result = detectPromise(output);
        expect(result.detected).toBe(false);
        expect(result.type).toBeNull();
      });
    });

    describe('priority', () => {
      it('prioritizes ESCALATE over all others when present', () => {
        const output =
          '<promise>TASK_DONE</promise>\n<promise>COMPLETE</promise>\n<promise>ESCALATE</promise>';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('ESCALATE');
      });

      it('prioritizes ESCALATE over COMPLETE', () => {
        const output =
          '<promise>COMPLETE</promise>\n<promise>ESCALATE</promise>';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('ESCALATE');
      });

      it('prioritizes ESCALATE over TASK_DONE', () => {
        const output =
          '<promise>TASK_DONE</promise>\n<promise>ESCALATE</promise>';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('ESCALATE');
      });

      it('prioritizes COMPLETE over TASK_DONE when both present', () => {
        const output =
          '<promise>TASK_DONE</promise>\n<promise>COMPLETE</promise>';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('COMPLETE');
      });
    });

    describe('no detection', () => {
      it('returns false when no promise tag found', () => {
        const output = 'Some regular output without any promise';
        const result = detectPromise(output);
        expect(result.detected).toBe(false);
        expect(result.type).toBeNull();
      });

      it('returns false for empty string', () => {
        const result = detectPromise('');
        expect(result.detected).toBe(false);
        expect(result.type).toBeNull();
      });

      it('does not match partial tag <promise>COMPLETE', () => {
        const output = '<promise>COMPLETE';
        const result = detectPromise(output);
        expect(result.detected).toBe(false);
        expect(result.type).toBeNull();
      });

      it('matches COMPLETE at line start even with trailing </promise>', () => {
        // COMPLETE at the start of the string is a valid line start
        const output = 'COMPLETE\n</promise>';
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('COMPLETE');
      });

      it('does not match partial tag without line start', () => {
        // COMPLETE</promise> without newline is not at line start
        const output = 'prefix COMPLETE</promise>';
        const result = detectPromise(output);
        expect(result.detected).toBe(false);
        expect(result.type).toBeNull();
      });
    });

    describe('real-world outputs', () => {
      it('detects COMPLETE in typical claude output', () => {
        const output = `I have completed all the tasks successfully.

All verification steps have passed:
- Type check: ✅
- Tests: ✅
- Lint: ✅

<promise>COMPLETE</promise>`;
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('COMPLETE');
      });

      it('detects TASK_DONE in typical claude output', () => {
        const output = `Task 3 has been implemented:
- Created the new component
- Added tests
- Updated exports

Moving to next task.

<promise>TASK_DONE</promise>`;
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('TASK_DONE');
      });

      it('detects ESCALATE in typical claude output', () => {
        const output = `同じ問題で3回失敗しました。

**失敗箇所**: Task 2 - Stripe Webhook実装

**試行した内容と結果:**
1回目: stripe gemのWebhook検証メソッドを使用 → 失敗
2回目: request.raw_postで取得 → 失敗
3回目: ミドルウェアで保存 → 失敗

HANDOFF.md にエスカレーション詳細を記録しました。

<promise>ESCALATE</promise>`;
        const result = detectPromise(output);
        expect(result.detected).toBe(true);
        expect(result.type).toBe('ESCALATE');
      });
    });
  });

  describe('getPromiseMessage', () => {
    it('returns correct message for ESCALATE', () => {
      const message = getPromiseMessage('ESCALATE');
      expect(message).toBe('Human intervention required. Exiting loop.');
    });

    it('returns correct message for COMPLETE', () => {
      const message = getPromiseMessage('COMPLETE');
      expect(message).toBe('All tasks completed. Exiting loop.');
    });

    it('returns correct message for TASK_DONE', () => {
      const message = getPromiseMessage('TASK_DONE');
      expect(message).toBe('Task completed. Continuing to next iteration.');
    });

    it('returns correct message for null', () => {
      const message = getPromiseMessage(null);
      expect(message).toBe('No promise detected (possible interruption).');
    });

    it('returns correct message for undefined type', () => {
      const message = getPromiseMessage(undefined as unknown as PromiseType);
      expect(message).toBe('No promise detected (possible interruption).');
    });
  });
});
