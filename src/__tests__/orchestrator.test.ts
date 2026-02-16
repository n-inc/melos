import {
  buildFollowupPlanTasks,
  formatLearningsForProgress,
  getReviewTasksToAdd,
  shouldBlockCompletion,
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

  describe('buildFollowupPlanTasks', () => {
    it('returns empty array when discovered tasks are empty', () => {
      const result = buildFollowupPlanTasks([], 'task-1', []);
      expect(result).toEqual([]);
    });

    it('groups low/medium tasks by relatedTaskId and separates high tasks', () => {
      const plan = [
        { id: 'task-1', description: 'base', passes: false },
        { id: 'task-1-followup-1', description: 'existing follow-up', passes: false },
      ];

      const result = buildFollowupPlanTasks(plan, 'task-1', [
        {
          description: '重大な決済エラー',
          priority: 'high',
          relatedTaskId: 'task-payment',
        },
        {
          description: '文言の不一致',
          priority: 'low',
          relatedTaskId: 'task-1',
        },
        {
          description: 'ボタン位置のずれ',
          priority: 'medium',
          relatedTaskId: 'task-1',
        },
        {
          description: '設定画面の表示崩れ',
          priority: 'low',
          relatedTaskId: 'task-settings',
        },
      ]);

      expect(result).toHaveLength(3);
      expect(result.map((task) => task.id)).toEqual([
        'task-1-followup-2',
        'task-1-followup-3',
        'task-1-followup-4',
      ]);
      expect(result[0].description).toContain('重大な決済エラー');
      expect(result[1].description).toContain('軽微な不整合 2 件をまとめて対応');
      expect(result[2].description).toContain('設定画面の表示崩れ');
      expect(result.every((task) => task.passes === false)).toBe(true);
    });
  });

  describe('shouldBlockCompletion', () => {
    it('does not block when plan is null', () => {
      expect(shouldBlockCompletion(null)).toEqual({
        blocked: false,
        pendingTaskIds: [],
        pendingReviewTaskIds: [],
      });
    });

    it('blocks completion when there are pending implementation tasks', () => {
      const result = shouldBlockCompletion([
        { id: '1', description: 'impl', passes: false },
      ]);

      expect(result.blocked).toBe(true);
      expect(result.pendingTaskIds).toEqual(['1']);
      expect(result.pendingReviewTaskIds).toEqual([]);
    });

    it('blocks completion and reports pending review tasks separately', () => {
      const result = shouldBlockCompletion([
        { id: '1', description: 'impl', passes: true },
        {
          id: 'review-product-g1',
          description: 'product review',
          passes: false,
          reviewType: 'product',
          reviewGeneration: 1,
        },
      ]);

      expect(result.blocked).toBe(true);
      expect(result.pendingTaskIds).toEqual(['review-product-g1']);
      expect(result.pendingReviewTaskIds).toEqual(['review-product-g1']);
    });
  });

  describe('getReviewTasksToAdd', () => {
    it('returns empty when PRD does not exist', () => {
      const result = getReviewTasksToAdd(
        [{ id: '1', description: 'impl', passes: true }],
        false
      );
      expect(result).toEqual([]);
    });

    it('returns product/code review tasks when implementation tasks are complete', () => {
      const result = getReviewTasksToAdd(
        [{ id: '1', description: 'impl', passes: true }],
        true
      );

      expect(result).toHaveLength(2);
      expect(result.map((task) => task.reviewType)).toEqual(['product', 'code']);
    });
  });
});
