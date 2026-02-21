import {
  createProgram,
  resolveExecutionMode,
  resolveManagerModel,
  resolveMaxIterations,
  resolveWorkerModel,
} from '../../cli.js';
import type { MelosConfig } from '../../config/index.js';

describe('CLI model resolution', () => {
  describe('resolveManagerModel', () => {
    it('uses top-level codex model for Manager', () => {
      const config: MelosConfig = {
        model: 'gpt-5.3-codex',
      };

      expect(resolveManagerModel({}, config)).toBe('gpt-5.3-codex');
    });

    it('prioritizes CLI model over manager-specific model', () => {
      const config: MelosConfig = {
        manager: { model: 'sonnet' },
      };

      expect(resolveManagerModel({ model: 'gpt-5.3-codex' }, config)).toBe('gpt-5.3-codex');
    });

    it('accepts non-codex model from top-level', () => {
      const config: MelosConfig = {
        model: 'opus',
      };

      expect(resolveManagerModel({}, config)).toBe('opus');
    });
  });

  describe('resolveWorkerModel', () => {
    it('uses top-level codex model for Worker', () => {
      const config: MelosConfig = {
        model: 'gpt-5.3-codex',
      };

      expect(resolveWorkerModel({}, config)).toBe('gpt-5.3-codex');
    });

    it('falls back to worker-specific model when CLI model is claude-only', () => {
      const config: MelosConfig = {
        worker: { model: 'gpt-5.3-codex' },
      };

      expect(resolveWorkerModel({ model: 'sonnet' }, config)).toBe('gpt-5.3-codex');
    });

    it('treats claude-only model names case-insensitively', () => {
      const config: MelosConfig = {
        worker: { model: 'gpt-5.3-codex' },
      };

      expect(resolveWorkerModel({ model: 'OPUS' }, config)).toBe('gpt-5.3-codex');
    });
  });

  describe('review-only option resolution', () => {
    it('registers --review-only option on root command and run subcommand', () => {
      const program = createProgram();
      const rootHasOption = program.options.some((option) => option.long === '--review-only');
      const runCommand = program.commands.find((command) => command.name() === 'run');
      const runHasOption = runCommand?.options.some(
        (option) => option.long === '--review-only'
      );

      expect(rootHasOption).toBe(true);
      expect(runHasOption).toBe(true);
    });

    it('resolves review-only execution mode and mode-specific max iterations', () => {
      const executionMode = resolveExecutionMode({ reviewOnly: true });
      expect(executionMode).toBe('review-only');
      expect(resolveMaxIterations({}, {}, executionMode)).toBe(10);
    });

    it('uses explicit maxIterations and config maxIterations over mode defaults', () => {
      expect(resolveMaxIterations({ maxIterations: 7 }, { maxIterations: 25 }, 'review-only')).toBe(7);
      expect(resolveMaxIterations({}, { maxIterations: 25 }, 'review-only')).toBe(25);
      expect(resolveMaxIterations({}, {}, 'default')).toBe(30);
    });
  });
});
