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
});
