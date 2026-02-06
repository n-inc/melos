import { CodexEngine } from '../codex.js';

describe('CodexEngine', () => {
  describe('filterCodexOutput', () => {
    let engine: CodexEngine;

    beforeEach(() => {
      engine = new CodexEngine();
    });

    // Access private method for testing
    const callFilterCodexOutput = (
      engine: CodexEngine,
      output: string
    ): string => {
      return (engine as unknown as { filterCodexOutput: (o: string) => string }).filterCodexOutput(output);
    };

    it('extracts the last codex block', () => {
      const output = `some preamble
codex
first block content
line 2
codex
second block content
final line`;

      const result = callFilterCodexOutput(engine, output);
      expect(result).toBe('second block content\nfinal line');
    });

    it('extracts single codex block', () => {
      const output = `preamble
codex
block content
more content`;

      const result = callFilterCodexOutput(engine, output);
      expect(result).toBe('block content\nmore content');
    });

    it('returns raw output when no codex marker is present (fallback)', () => {
      const output = `This is output without any markers
It has multiple lines
But no codex marker at all`;

      const result = callFilterCodexOutput(engine, output);
      expect(result).toBe(output);
    });

    it('returns raw output for empty string (fallback)', () => {
      const result = callFilterCodexOutput(engine, '');
      expect(result).toBe('');
    });

    it('returns raw output when codex appears as part of another word (fallback)', () => {
      const output = `codex-cli is a tool
mycodex command
codex_output here`;

      const result = callFilterCodexOutput(engine, output);
      expect(result).toBe(output);
    });

    it('handles empty block after codex marker', () => {
      const output = `preamble
codex`;

      const result = callFilterCodexOutput(engine, output);
      expect(result).toBe('');
    });
  });

  describe('filterCodexStderr', () => {
    let engine: CodexEngine;

    beforeEach(() => {
      engine = new CodexEngine();
    });

    // Access private method for testing
    const callFilterCodexStderr = (
      engine: CodexEngine,
      stderr: string
    ): string => {
      return (engine as unknown as { filterCodexStderr: (s: string) => string }).filterCodexStderr(stderr);
    };

    it('removes known noisy codex stderr lines', () => {
      const stderr = `mcp startup: no servers
2026-02-06T02:37:11.398715Z ERROR codex_core::rollout::list: state db missing rollout path for thread 019c2271-403c-7f23-ada9-f63811207110
real error message`;

      const result = callFilterCodexStderr(engine, stderr);
      expect(result).toBe('real error message');
    });

    it('returns empty string when stderr contains only known noise', () => {
      const stderr = `mcp startup: no servers
2026-02-06T02:37:11.398715Z ERROR codex_core::rollout::list: state db missing rollout path for thread 019c2271-403c-7f23-ada9-f63811207110`;

      const result = callFilterCodexStderr(engine, stderr);
      expect(result).toBe('');
    });

    it('keeps other codex_core errors', () => {
      const stderr = '2026-02-06T02:37:11.398715Z ERROR codex_core::auth: token expired';

      const result = callFilterCodexStderr(engine, stderr);
      expect(result).toBe(stderr);
    });

    it('removes known noisy lines even when ANSI escapes are present', () => {
      const stderr =
        '\x1b[31m2026-02-06T02:37:11.398715Z ERROR codex_core::rollout::list: state db missing rollout path for thread 019c2271-403c-7f23-ada9-f63811207110\x1b[0m';

      const result = callFilterCodexStderr(engine, stderr);
      expect(result).toBe('');
    });
  });
});
