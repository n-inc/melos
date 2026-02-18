import {
  buildFollowupTaskEntries,
  buildManagerDecisionMessage,
  buildManagerRunMessage,
  buildWorkerFinishMessage,
  buildWorkerRunMessage,
  formatLearningsForProgress,
  formatTaskLabel,
  getReviewTasksToAdd,
  resolveTaskIdByDescription,
  resolveTaskIdForTaskList,
  resolveTaskIdWithFallback,
  shouldBlockCompletion,
  upsertLearningsSection,
} from '../orchestrator.js';
import type { TaskEntry } from '../state/task.js';
import type { WorkerResult, ManagerDecision } from '../agents/types.js';

describe('orchestrator.ts', () => {
  describe('display message helpers', () => {
    const baseTask: TaskEntry = {
      id: 'task-1',
      description: 'Implement login flow',
      passes: false,
    };

    function createWorkerResult(
      type: WorkerResult['type'],
      status: WorkerResult['report']['status'],
      summary: string
    ): WorkerResult {
      return {
        type,
        report: {
          iteration: 1,
          taskId: 'task-1',
          status,
          summary,
          filesChanged: [],
          verification: {
            testsRun: false,
            testsPassed: 0,
            testsFailed: 0,
            lintPassed: false,
            typecheckPassed: false,
          },
          successCriteriaResults: [],
          issues: [],
          discoveredTasks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: '2026-02-18T00:00:00Z',
        },
      };
    }

    it('formats task label with truncation', () => {
      const label = formatTaskLabel('task-1', 'A very long description that should be cut', 24);
      expect(label).toBe('[task-1] A very long ...');
    });

    it('formats japanese task label with display width truncation', () => {
      const label = formatTaskLabel(
        '4',
        '本修正に関連するレビュー/チャット/本文表示フローを横断的に回帰検証し、追跡する',
        24
      );
      expect(label.endsWith('...')).toBe(true);
      expect(label.startsWith('[4]')).toBe(true);
    });

    it('builds manager run message without previous report', () => {
      expect(buildManagerRunMessage(null)).toBe(
        'Manager 実行中: 初回判断で次アクションを決定中...'
      );
    });

    it('builds manager run message with previous report context', () => {
      const message = buildManagerRunMessage({
        iteration: 3,
        taskId: 'task-9',
        status: 'PARTIAL',
        summary: 'partial',
        filesChanged: [],
        verification: {
          testsRun: false,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: false,
          typecheckPassed: false,
        },
        successCriteriaResults: [],
        issues: [],
        discoveredTasks: [],
        learnings: [],
        requestsHelp: false,
        createdAt: '2026-02-18T00:00:00Z',
      });
      expect(message).toBe(
        'Manager 実行中: 前回 [task-9] (PARTIAL) を評価して次アクションを決定中...'
      );
    });

    it('builds manager decision messages for all decision types', () => {
      const dispatchDecision: ManagerDecision = {
        type: 'dispatch_task',
        taskId: 'task-1',
      };
      const escalateDecision: ManagerDecision = {
        type: 'escalate',
        escalation: {
          id: 'esc-1',
          type: 'QUESTION',
          context: 'task-1',
          question: 'question?',
          status: 'pending',
          createdAt: '2026-02-18T00:00:00Z',
        },
      };
      const completeDecision: ManagerDecision = {
        type: 'complete',
        handoffContent: 'done',
      };
      const errorDecision: ManagerDecision = {
        type: 'error',
        message: 'oops',
      };
      const reviewDecision: ManagerDecision = {
        type: 'review_complete',
        approved: false,
        feedback: 'needs more',
      };

      expect(buildManagerDecisionMessage(dispatchDecision, baseTask.description)).toContain(
        'Manager 決定: [task-1] Implement login flow を Worker に指示'
      );
      expect(buildManagerDecisionMessage(escalateDecision)).toBe(
        'Manager 決定: エスカレーション (QUESTION)'
      );
      expect(buildManagerDecisionMessage(completeDecision)).toBe(
        'Manager 決定: 完了判定'
      );
      expect(buildManagerDecisionMessage(errorDecision)).toBe(
        'Manager 決定: エラー'
      );
      expect(buildManagerDecisionMessage(reviewDecision)).toBe(
        'Manager 決定: レビュー継続'
      );
    });

    it('builds worker run message with task label', () => {
      expect(buildWorkerRunMessage(baseTask)).toBe(
        'Worker 実行中: [task-1] Implement login flow'
      );
    });

    it('builds worker finish message with summary fallback', () => {
      const result = createWorkerResult('failed', 'FAILED', '');
      expect(buildWorkerFinishMessage(baseTask, result)).toBe(
        'Worker 完了: [task-1] Implement login flow FAILED - summary unavailable'
      );
    });

    it('builds worker finish message for all statuses', () => {
      const successResult = createWorkerResult('success', 'SUCCESS', 'done');
      const partialResult = createWorkerResult('partial', 'PARTIAL', 'partial done');
      const blockedResult = createWorkerResult('blocked', 'BLOCKED', 'need credentials');
      const failedResult = createWorkerResult('failed', 'FAILED', 'test failed');

      expect(buildWorkerFinishMessage(baseTask, successResult)).toContain('SUCCESS - done');
      expect(buildWorkerFinishMessage(baseTask, partialResult)).toContain(
        'PARTIAL - partial done'
      );
      expect(buildWorkerFinishMessage(baseTask, blockedResult)).toContain(
        'BLOCKED - need credentials'
      );
      expect(buildWorkerFinishMessage(baseTask, failedResult)).toContain(
        'FAILED - test failed'
      );
    });
  });

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

  describe('buildFollowupTaskEntries', () => {
    it('returns empty array when discovered tasks are empty', () => {
      const result = buildFollowupTaskEntries([], 'task-1', []);
      expect(result).toEqual([]);
    });

    it('groups low/medium tasks by relatedTaskId and separates high tasks', () => {
      const plan = [
        { id: 'task-1', description: 'base', passes: false },
        { id: 'task-1-followup-1', description: 'existing follow-up', passes: false },
      ];

      const result = buildFollowupTaskEntries(plan, 'task-1', [
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

  describe('resolveTaskIdForTaskList', () => {
    it('returns exact match task id as-is', () => {
      const result = resolveTaskIdForTaskList(
        [{ id: 'task-10', description: 'impl', passes: false }],
        'task-10'
      );
      expect(result).toBe('task-10');
    });

    it('maps numeric id to task-prefixed id when uniquely matched', () => {
      const result = resolveTaskIdForTaskList(
        [{ id: 'task-10', description: 'impl', passes: false }],
        '10'
      );
      expect(result).toBe('task-10');
    });

    it('maps task-prefixed id to numeric id when uniquely matched', () => {
      const result = resolveTaskIdForTaskList(
        [{ id: '10', description: 'impl', passes: false }],
        'task-10'
      );
      expect(result).toBe('10');
    });

    it('keeps original id when mapping is ambiguous', () => {
      const result = resolveTaskIdForTaskList(
        [
          { id: '10', description: 'impl', passes: false },
          { id: 'task-10', description: 'impl prefixed', passes: false },
        ],
        '10'
      );
      expect(result).toBe('10');
    });

    it('keeps original id when no match is found', () => {
      const result = resolveTaskIdForTaskList(
        [{ id: 'task-11', description: 'impl', passes: false }],
        '10'
      );
      expect(result).toBe('10');
    });

    it('maps numeric id to zero-padded task id when uniquely matched', () => {
      const result = resolveTaskIdForTaskList(
        [{ id: 'task-013', description: 'impl', passes: false }],
        '13'
      );
      expect(result).toBe('task-013');
    });
  });

  describe('resolveTaskIdByDescription', () => {
    it('returns task id when description matches uniquely', () => {
      const result = resolveTaskIdByDescription(
        [{ id: 'task-13', description: 'Fix panel condition', passes: false }],
        'Fix panel condition'
      );
      expect(result).toBe('task-13');
    });

    it('returns null when description match is ambiguous', () => {
      const result = resolveTaskIdByDescription(
        [
          { id: 'task-13', description: 'Fix panel condition', passes: false },
          { id: 'task-14', description: 'Fix panel condition', passes: false },
        ],
        'Fix panel condition'
      );
      expect(result).toBeNull();
    });
  });

  describe('resolveTaskIdWithFallback', () => {
    it('resolves by fallback task id when primary task id is missing', () => {
      const result = resolveTaskIdWithFallback(
        [{ id: 'task-13', description: 'Fix panel condition', passes: false }],
        '13',
        'Fix panel condition',
        ['task-13']
      );
      expect(result).toBe('task-13');
    });

    it('resolves by task description when id aliases are missing', () => {
      const result = resolveTaskIdWithFallback(
        [{ id: 'release/13', description: 'Fix panel condition', passes: false }],
        '13',
        'Fix panel condition'
      );
      expect(result).toBe('release/13');
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
