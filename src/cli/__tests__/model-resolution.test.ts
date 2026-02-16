import { resolveManagerModel, resolveWorkerModel } from '../../cli.js';
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
});
