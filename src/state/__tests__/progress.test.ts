import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  progressExists,
  loadProgress,
  saveProgress,
  parseProgress,
  serializeProgress,
  initializeProgress,
  addIteration,
  getCurrentIteration,
  addCodebasePattern,
  updateObjective,
  addLearning,
  addOpenQuestion,
  type Progress,
  type ExecutionMode,
} from '../progress.js';

describe('progress', () => {
  let tempDir: string;
  let progressPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'marathon-progress-test-'));
    progressPath = join(tempDir, 'PROGRESS.md');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('progressExists', () => {
    it('returns false when file does not exist', () => {
      expect(progressExists(progressPath)).toBe(false);
    });

    it('returns true when file exists', async () => {
      await writeFile(progressPath, '# Test');
      expect(progressExists(progressPath)).toBe(true);
    });
  });

  describe('parseProgress', () => {
    it('parses header correctly', () => {
      const content = `# Marathon Progress: DEFAULT

**Mode**: Default (Task → Review → PR)
**Started**: 2026-01-17 16:15
**Max iterations**: 30

## Progress Log
`;

      const progress = parseProgress(content);

      expect(progress.header.mode).toBe('default');
      expect(progress.header.started).toBe('2026-01-17 16:15');
      expect(progress.header.maxIterations).toBe(30);
    });

    it('parses CI fix only mode correctly', () => {
      const content = `# Marathon Progress: CI-FIX-ONLY

**Mode**: CI Fix Only
**Started**: 2026-01-17 10:00
**Max iterations**: 5

## Progress Log
`;

      const progress = parseProgress(content);
      expect(progress.header.mode).toBe('ci-fix-only');
    });

    it('parses task only mode correctly', () => {
      const content = `# Marathon Progress: TASK-ONLY

**Mode**: Task Only
**Started**: 2026-01-17 10:00
**Max iterations**: 30

## Progress Log
`;

      const progress = parseProgress(content);
      expect(progress.header.mode).toBe('task-only');
    });

    it('parses review only mode correctly', () => {
      const content = `# Marathon Progress: REVIEW-ONLY

**Mode**: Review Only
**Started**: 2026-01-17 10:00
**Max iterations**: 5

## Progress Log
`;

      const progress = parseProgress(content);
      expect(progress.header.mode).toBe('review-only');
    });

    it('parses iteration entries correctly', () => {
      const content = `# Marathon Progress: DEFAULT

**Mode**: Default (Task → Review → PR)
**Started**: 2026-01-17 16:15
**Max iterations**: 30

## Progress Log

### Iteration 1 (2026-01-17)

**Task 1: Setup**

- Created initial structure
- Added dependencies

### Iteration 2 (2026-01-17)

**Task 2: Implementation**

- Implemented feature X
`;

      const progress = parseProgress(content);

      expect(progress.entries).toHaveLength(2);
      expect(progress.entries[0].iteration).toBe(1);
      expect(progress.entries[0].date).toBe('2026-01-17');
      expect(progress.entries[0].content).toContain('**Task 1: Setup**');
      expect(progress.entries[1].iteration).toBe(2);
      expect(progress.entries[1].content).toContain('**Task 2: Implementation**');
    });

    it('parses codebase patterns correctly', () => {
      const content = `# Marathon Progress: DEFAULT

**Mode**: Default (Task → Review → PR)
**Started**: 2026-01-17 16:15
**Max iterations**: 30

## Progress Log

### Iteration 1 (2026-01-17)

- Did something

## Codebase Patterns

実装中に発見したパターンを記録。

### 発見したパターン
- [2026-01-17] ESM モジュール形式を使用
- [2026-01-17] Jest は ESM 対応
`;

      const progress = parseProgress(content);

      expect(progress.codebasePatterns).toContain('実装中に発見したパターン');
      expect(progress.codebasePatterns).toContain('ESM モジュール形式を使用');
    });

    it('handles missing codebase patterns section', () => {
      const content = `# Marathon Progress: DEFAULT

**Mode**: Default (Task → Review → PR)
**Started**: 2026-01-17 16:15
**Max iterations**: 30

## Progress Log

### Iteration 1 (2026-01-17)

- Did something
`;

      const progress = parseProgress(content);
      expect(progress.codebasePatterns).toBeUndefined();
    });

    it('parses current objective correctly', () => {
      const content = `# Marathon Progress: DEFAULT

**Mode**: Default (Task → Review → PR)
**Started**: 2026-01-17 16:15
**Max iterations**: 30

## Current Objective

- Marathon v0.2.2 の安定化と機能拡張

## Progress Log

### Iteration 1 (2026-01-17)

- Did something
`;

      const progress = parseProgress(content);
      expect(progress.currentObjective).toBe(
        '- Marathon v0.2.2 の安定化と機能拡張'
      );
    });

    it('parses learnings correctly', () => {
      const content = `# Marathon Progress: DEFAULT

**Mode**: Default (Task → Review → PR)
**Started**: 2026-01-17 16:15
**Max iterations**: 30

## Progress Log

### Iteration 1 (2026-01-17)

- Did something

## Learnings

- Codex の filterCodexOutput で ANSI コードを strip しないと Promise 検出に失敗
- Display width ベースで truncate しないと日本語でレイアウト崩れ
`;

      const progress = parseProgress(content);
      expect(progress.learnings).toContain('Codex の filterCodexOutput');
      expect(progress.learnings).toContain('Display width ベース');
    });

    it('parses open questions / risks correctly', () => {
      const content = `# Marathon Progress: DEFAULT

**Mode**: Default (Task → Review → PR)
**Started**: 2026-01-17 16:15
**Max iterations**: 30

## Progress Log

### Iteration 1 (2026-01-17)

- Did something

## Open Questions / Risks

- リファクタリング後のパフォーマンス検証が必要
- エラーハンドリングのカバレッジ向上
`;

      const progress = parseProgress(content);
      expect(progress.openQuestionsRisks).toContain('リファクタリング後');
      expect(progress.openQuestionsRisks).toContain('エラーハンドリング');
    });

    it('parses all new sections together', () => {
      const content = `# Marathon Progress: DEFAULT

**Mode**: Default (Task → Review → PR)
**Started**: 2026-01-17 16:15
**Max iterations**: 30

## Current Objective

- Marathon v0.2.2 の安定化

## Progress Log

### Iteration 1 (2026-01-17)

- タスク実行

## Codebase Patterns

- **エントリーポイント**: src/index.ts

## Learnings

- 学んだこと1

## Open Questions / Risks

- リスク1
`;

      const progress = parseProgress(content);

      expect(progress.currentObjective).toBe('- Marathon v0.2.2 の安定化');
      expect(progress.codebasePatterns).toContain('エントリーポイント');
      expect(progress.learnings).toBe('- 学んだこと1');
      expect(progress.openQuestionsRisks).toBe('- リスク1');
    });
  });

  describe('serializeProgress', () => {
    it('serializes progress correctly', () => {
      const progress: Progress = {
        header: {
          mode: 'default',
          started: '2026-01-17 16:15',
          maxIterations: 30,
        },
        entries: [
          {
            iteration: 1,
            date: '2026-01-17',
            content: '**Task 1**: Done',
          },
        ],
        codebasePatterns: '### 発見したパターン\n- Pattern 1',
      };

      const content = serializeProgress(progress);

      expect(content).toContain('# Marathon Progress: DEFAULT');
      expect(content).toContain('**Mode**: Default');
      expect(content).toContain('**Started**: 2026-01-17 16:15');
      expect(content).toContain('**Max iterations**: 30');
      expect(content).toContain('### Iteration 1 (2026-01-17)');
      expect(content).toContain('**Task 1**: Done');
      expect(content).toContain('## Codebase Patterns');
      expect(content).toContain('Pattern 1');
    });

    it('handles empty entries', () => {
      const progress: Progress = {
        header: {
          mode: 'ci-fix-only',
          started: '2026-01-17 10:00',
          maxIterations: 5,
        },
        entries: [],
      };

      const content = serializeProgress(progress);

      expect(content).toContain('# Marathon Progress: CI-FIX-ONLY');
      expect(content).toContain('## Progress Log');
      expect(content).not.toContain('## Codebase Patterns');
    });

    it('serializes current objective correctly', () => {
      const progress: Progress = {
        header: {
          mode: 'default',
          started: '2026-01-17 16:15',
          maxIterations: 30,
        },
        entries: [],
        currentObjective: '- Marathon v0.2.2 の安定化',
      };

      const content = serializeProgress(progress);

      expect(content).toContain('## Current Objective');
      expect(content).toContain('- Marathon v0.2.2 の安定化');
      // Current Objective should appear before Progress Log
      const objectiveIndex = content.indexOf('## Current Objective');
      const progressLogIndex = content.indexOf('## Progress Log');
      expect(objectiveIndex).toBeLessThan(progressLogIndex);
    });

    it('serializes learnings correctly', () => {
      const progress: Progress = {
        header: {
          mode: 'default',
          started: '2026-01-17 16:15',
          maxIterations: 30,
        },
        entries: [],
        learnings: '- 学んだこと1\n- 学んだこと2',
      };

      const content = serializeProgress(progress);

      expect(content).toContain('## Learnings');
      expect(content).toContain('- 学んだこと1');
      expect(content).toContain('- 学んだこと2');
    });

    it('serializes open questions / risks correctly', () => {
      const progress: Progress = {
        header: {
          mode: 'default',
          started: '2026-01-17 16:15',
          maxIterations: 30,
        },
        entries: [],
        openQuestionsRisks: '- リスク1',
      };

      const content = serializeProgress(progress);

      expect(content).toContain('## Open Questions / Risks');
      expect(content).toContain('- リスク1');
    });

    it('serializes sections in correct order', () => {
      const progress: Progress = {
        header: {
          mode: 'default',
          started: '2026-01-17 16:15',
          maxIterations: 30,
        },
        entries: [{ iteration: 1, date: '2026-01-17', content: 'test' }],
        codebasePatterns: '- Pattern 1',
        currentObjective: '- Objective',
        learnings: '- Learning',
        openQuestionsRisks: '- Risk',
      };

      const content = serializeProgress(progress);

      // Verify order: Current Objective -> Progress Log -> Codebase Patterns -> Learnings -> Open Questions
      const objectiveIndex = content.indexOf('## Current Objective');
      const progressLogIndex = content.indexOf('## Progress Log');
      const patternsIndex = content.indexOf('## Codebase Patterns');
      const learningsIndex = content.indexOf('## Learnings');
      const risksIndex = content.indexOf('## Open Questions / Risks');

      expect(objectiveIndex).toBeLessThan(progressLogIndex);
      expect(progressLogIndex).toBeLessThan(patternsIndex);
      expect(patternsIndex).toBeLessThan(learningsIndex);
      expect(learningsIndex).toBeLessThan(risksIndex);
    });
  });

  describe('loadProgress and saveProgress', () => {
    it('throws error when file does not exist', async () => {
      await expect(loadProgress(progressPath)).rejects.toThrow(
        'PROGRESS.md not found'
      );
    });

    it('saves and loads progress correctly', async () => {
      const original: Progress = {
        header: {
          mode: 'default',
          started: '2026-01-17 16:15',
          maxIterations: 30,
        },
        entries: [
          {
            iteration: 1,
            date: '2026-01-17',
            content: 'Test content',
          },
        ],
        codebasePatterns: '### 発見したパターン\n- Test pattern',
      };

      await saveProgress(progressPath, original);
      const loaded = await loadProgress(progressPath);

      expect(loaded.header.mode).toBe(original.header.mode);
      expect(loaded.header.started).toBe(original.header.started);
      expect(loaded.header.maxIterations).toBe(original.header.maxIterations);
      expect(loaded.entries).toHaveLength(1);
      expect(loaded.entries[0].iteration).toBe(1);
      expect(loaded.codebasePatterns).toContain('Test pattern');
    });
  });

  describe('initializeProgress', () => {
    it('creates new progress file with correct structure', async () => {
      const mode: ExecutionMode = 'default';
      const maxIterations = 50;

      const progress = await initializeProgress(progressPath, mode, maxIterations);

      expect(progress.header.mode).toBe('default');
      expect(progress.header.maxIterations).toBe(50);
      expect(progress.header.started).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(progress.entries).toHaveLength(0);

      // ファイルが作成されていることを確認
      const content = await readFile(progressPath, 'utf-8');
      expect(content).toContain('# Marathon Progress: DEFAULT');
    });

    it('creates ci-fix-only mode correctly', async () => {
      const progress = await initializeProgress(progressPath, 'ci-fix-only', 5);

      expect(progress.header.mode).toBe('ci-fix-only');
      expect(progress.header.maxIterations).toBe(5);
    });

    it('creates task-only mode correctly', async () => {
      const progress = await initializeProgress(progressPath, 'task-only', 30);

      expect(progress.header.mode).toBe('task-only');
      expect(progress.header.maxIterations).toBe(30);
    });

    it('creates review-only mode correctly', async () => {
      const progress = await initializeProgress(progressPath, 'review-only', 5);

      expect(progress.header.mode).toBe('review-only');
      expect(progress.header.maxIterations).toBe(5);
    });
  });

  describe('addIteration', () => {
    it('adds first iteration correctly', async () => {
      await initializeProgress(progressPath, 'default', 30);

      const progress = await addIteration(progressPath, '**Task 1**: Completed');

      expect(progress.entries).toHaveLength(1);
      expect(progress.entries[0].iteration).toBe(1);
      expect(progress.entries[0].content).toBe('**Task 1**: Completed');
      expect(progress.entries[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('adds subsequent iterations with incrementing numbers', async () => {
      await initializeProgress(progressPath, 'default', 30);
      await addIteration(progressPath, 'First');
      await addIteration(progressPath, 'Second');
      const progress = await addIteration(progressPath, 'Third');

      expect(progress.entries).toHaveLength(3);
      expect(progress.entries[0].iteration).toBe(1);
      expect(progress.entries[1].iteration).toBe(2);
      expect(progress.entries[2].iteration).toBe(3);
    });
  });

  describe('getCurrentIteration', () => {
    it('returns 0 for empty entries', () => {
      const progress: Progress = {
        header: { mode: 'default', started: '', maxIterations: 30 },
        entries: [],
      };

      expect(getCurrentIteration(progress)).toBe(0);
    });

    it('returns highest iteration number', () => {
      const progress: Progress = {
        header: { mode: 'default', started: '', maxIterations: 30 },
        entries: [
          { iteration: 1, date: '', content: '' },
          { iteration: 3, date: '', content: '' },
          { iteration: 2, date: '', content: '' },
        ],
      };

      expect(getCurrentIteration(progress)).toBe(3);
    });
  });

  describe('addCodebasePattern', () => {
    it('creates codebase patterns section if not exists', async () => {
      await initializeProgress(progressPath, 'default', 30);

      const progress = await addCodebasePattern(progressPath, 'ESM modules are used');

      expect(progress.codebasePatterns).toContain('実装中に発見したパターン');
      expect(progress.codebasePatterns).toContain('ESM modules are used');
    });

    it('adds pattern to existing section', async () => {
      // Create progress with existing patterns
      const initial: Progress = {
        header: { mode: 'default', started: '2026-01-17 10:00', maxIterations: 30 },
        entries: [],
        codebasePatterns: `実装中に発見したパターンを記録。

### 発見したパターン
- [2026-01-16] Existing pattern`,
      };
      await saveProgress(progressPath, initial);

      const progress = await addCodebasePattern(progressPath, 'New pattern');

      expect(progress.codebasePatterns).toContain('Existing pattern');
      expect(progress.codebasePatterns).toContain('New pattern');
    });
  });

  describe('updateObjective', () => {
    it('sets current objective', async () => {
      await initializeProgress(progressPath, 'default', 30);

      const progress = await updateObjective(progressPath, '- Marathon v0.2.2 の安定化');

      expect(progress.currentObjective).toBe('- Marathon v0.2.2 の安定化');
    });

    it('updates existing objective', async () => {
      await initializeProgress(progressPath, 'default', 30);
      await updateObjective(progressPath, '- 古い目標');

      const progress = await updateObjective(progressPath, '- 新しい目標');

      expect(progress.currentObjective).toBe('- 新しい目標');
    });
  });

  describe('addLearning', () => {
    it('adds first learning', async () => {
      await initializeProgress(progressPath, 'default', 30);

      const progress = await addLearning(progressPath, '学んだこと1');

      expect(progress.learnings).toBe('- 学んだこと1');
    });

    it('appends to existing learnings', async () => {
      await initializeProgress(progressPath, 'default', 30);
      await addLearning(progressPath, '学んだこと1');

      const progress = await addLearning(progressPath, '学んだこと2');

      expect(progress.learnings).toBe('- 学んだこと1\n- 学んだこと2');
    });
  });

  describe('addOpenQuestion', () => {
    it('adds first open question', async () => {
      await initializeProgress(progressPath, 'default', 30);

      const progress = await addOpenQuestion(progressPath, 'リスク1');

      expect(progress.openQuestionsRisks).toBe('- リスク1');
    });

    it('appends to existing questions', async () => {
      await initializeProgress(progressPath, 'default', 30);
      await addOpenQuestion(progressPath, 'リスク1');

      const progress = await addOpenQuestion(progressPath, 'リスク2');

      expect(progress.openQuestionsRisks).toBe('- リスク1\n- リスク2');
    });
  });
});
