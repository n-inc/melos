import {
  formatLearningsForProgress,
  upsertLearningsSection,
} from '../orchestrator.js';

describe('orchestrator.ts', () => {
  describe('formatLearningsForProgress', () => {
    it('formats learnings as date-prefixed bullet lines', () => {
      const result = formatLearningsForProgress('3', [
        'first learning',
        'second learning',
      ], '2026-02-16');

      expect(result).toBe(
        '- 2026-02-16 Task 3: first learning\n- 2026-02-16 Task 3: second learning'
      );
      expect(result).not.toContain('- [3]');
    });
  });

  describe('upsertLearningsSection', () => {
    it('appends to existing Learnings section', () => {
      const content = `# Progress Log

## Learnings

- 2026-02-15 Task 1: old learning

## Open Questions / Risks

- none
`;

      const updated = upsertLearningsSection(content, [
        '- 2026-02-16 Task 2: new learning',
      ]);

      expect(updated).toContain('## Learnings');
      expect(updated).toContain('- 2026-02-15 Task 1: old learning');
      expect(updated).toContain('- 2026-02-16 Task 2: new learning');
      expect(updated).toContain('## Open Questions / Risks');
      expect(updated).not.toContain('### Learnings (');
    });

    it('migrates legacy dated Learnings blocks into a single Learnings section', () => {
      const content = `# Progress Log

### Learnings (2026-02-15)
- [1] legacy one
- Task 1: legacy two

### Learnings (2026-02-16)
- [2] legacy three
`;

      const updated = upsertLearningsSection(content, [
        '- 2026-02-17 Task 3: new learning',
      ]);

      expect(updated).toContain('## Learnings');
      expect(updated).toContain('- 2026-02-15 Task 1: legacy one');
      expect(updated).toContain('- 2026-02-15 Task 1: legacy two');
      expect(updated).toContain('- 2026-02-16 Task 2: legacy three');
      expect(updated).toContain('- 2026-02-17 Task 3: new learning');
      expect(updated).not.toContain('### Learnings (2026-02-15)');
      expect(updated).not.toContain('### Learnings (2026-02-16)');
    });
  });
});
