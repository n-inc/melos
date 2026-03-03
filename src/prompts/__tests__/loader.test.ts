import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  substituteVariables,
  loadPromptRaw,
  loadPrompt,
  loadPromptFromPath,
  loadPromptFromPathWithVariables,
  promptExists,
  getPromptPath,
  getAvailablePromptTypes,
  getPromptType,
  type PromptVariables,
} from '../loader.js';

describe('loader.ts', () => {
  // テスト用の変数コンテキスト
  const testVariables: PromptVariables = {
    iteration: 5,
    maxIterations: 30,
    progressFile: 'PROGRESS.md',
    taskFile: 'TASK.json',
  };

  describe('substituteVariables', () => {
    it('replaces {ITERATION} placeholder', () => {
      const template = 'Iteration {ITERATION}';
      const result = substituteVariables(template, testVariables);
      expect(result).toBe('Iteration 5');
    });

    it('replaces {MAX_ITERATIONS} placeholder', () => {
      const template = 'Max: {MAX_ITERATIONS}';
      const result = substituteVariables(template, testVariables);
      expect(result).toBe('Max: 30');
    });

    it('replaces {PROGRESS_FILE} placeholder', () => {
      const template = 'Progress: {PROGRESS_FILE}';
      const result = substituteVariables(template, testVariables);
      expect(result).toBe('Progress: PROGRESS.md');
    });

    it('replaces {TASK_FILE} placeholder', () => {
      const template = 'TaskList: {TASK_FILE}';
      const result = substituteVariables(template, testVariables);
      expect(result).toBe('TaskList: TASK.json');
    });

    it('replaces multiple placeholders in one template', () => {
      const template =
        '## Iteration {ITERATION} / {MAX_ITERATIONS}\n\n**TaskList**: @{TASK_FILE}\n**Progress**: @{PROGRESS_FILE}';
      const result = substituteVariables(template, testVariables);
      expect(result).toBe(
        '## Iteration 5 / 30\n\n**TaskList**: @TASK.json\n**Progress**: @PROGRESS.md'
      );
    });

    it('replaces multiple occurrences of the same placeholder', () => {
      const template =
        '{ITERATION} is current, {ITERATION} again, max is {MAX_ITERATIONS}';
      const result = substituteVariables(template, testVariables);
      expect(result).toBe('5 is current, 5 again, max is 30');
    });

    it('returns unchanged text when no placeholders present', () => {
      const template = 'No placeholders here';
      const result = substituteVariables(template, testVariables);
      expect(result).toBe('No placeholders here');
    });

    it('handles empty string', () => {
      const template = '';
      const result = substituteVariables(template, testVariables);
      expect(result).toBe('');
    });

    it('replaces {CURRENT_TASK_ID} placeholder', () => {
      const template = 'Task: {CURRENT_TASK_ID}';
      const result = substituteVariables(template, {
        ...testVariables,
        currentTaskId: '8',
      });
      expect(result).toBe('Task: 8');
    });

    it('replaces {CURRENT_TASK_ID} with empty string when undefined', () => {
      const template = 'Task: {CURRENT_TASK_ID}';
      const result = substituteVariables(template, testVariables);
      expect(result).toBe('Task: ');
    });
  });

  describe('getAvailablePromptTypes', () => {
    it('returns all prompt types', () => {
      const types = getAvailablePromptTypes();
      expect(types).toHaveLength(6);
      expect(types).toContain('loop');
      expect(types).toContain('research');
      expect(types).toContain('verification');
      expect(types).toContain('review');
      expect(types).toContain('manager');
      expect(types).toContain('worker');
    });
  });

  describe('getPromptType', () => {
    it('returns loop for default mode', () => {
      expect(getPromptType('default')).toBe('loop');
    });

    it('returns loop for review-only mode', () => {
      expect(getPromptType('review-only')).toBe('loop');
    });

    it('returns loop for ci-fix-only mode', () => {
      expect(getPromptType('ci-fix-only')).toBe('loop');
    });

    it('returns loop for task-only mode', () => {
      expect(getPromptType('task-only')).toBe('loop');
    });
  });

  describe('promptExists', () => {
    it('returns true for existing prompt types', () => {
      // 既存のプロンプトファイルが存在することを確認
      expect(promptExists('loop')).toBe(true);
      expect(promptExists('research')).toBe(true);
    });
  });

  describe('getPromptPath', () => {
    it('returns path with correct extension', () => {
      const path = getPromptPath('loop');
      expect(path).toMatch(/loop\.md$/);
    });

    it('returns path in prompts directory', () => {
      const path = getPromptPath('review');
      expect(path).toContain('prompts');
      expect(path).toContain('review.md');
    });
  });

  describe('loadPromptRaw', () => {
    it('loads existing prompt file', async () => {
      const content = await loadPromptRaw('loop');
      // loop.md の内容を確認
      expect(content).toContain('{ITERATION}');
      expect(content).toContain('{MAX_ITERATIONS}');
      expect(content).toContain('{PROGRESS_FILE}');
    });

    it('throws error for non-existent prompt type (type system prevents this)', async () => {
      // TypeScriptの型システムが不正なプロンプトタイプを防ぐが、
      // ファイルが削除された場合のエラーハンドリングをテスト
      // この場合、実際のファイルパスを直接テストするためloadPromptFromPathを使用
      await expect(
        loadPromptFromPath('/non/existent/path/to/prompt.md')
      ).rejects.toThrow('Prompt file not found');
    });

    it('worker prompt enforces git-committer commit workflow', async () => {
      const content = await loadPromptRaw('worker');
      expect(content).toContain('git-committer');
      expect(content).toContain('type(scope): subject');
      expect(content).not.toMatch(/\bgit-commit\b/);
    });
  });

  describe('loadPrompt', () => {
    it('loads and substitutes variables', async () => {
      const content = await loadPrompt('loop', testVariables);
      // 変数が置換されていることを確認
      expect(content).toContain('5 / 30'); // {ITERATION} / {MAX_ITERATIONS}
      expect(content).toContain('PROGRESS.md');
      expect(content).not.toContain('{ITERATION}');
      expect(content).not.toContain('{MAX_ITERATIONS}');
    });
  });

  describe('loadPromptFromPath and loadPromptFromPathWithVariables', () => {
    let testDir: string;
    let promptPath: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `melos-prompt-test-${Date.now()}`);
      await mkdir(testDir, { recursive: true });
      promptPath = join(testDir, 'test-prompt.md');
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    it('loads prompt from custom path', async () => {
      const template = '## Test Prompt\n\nIteration: {ITERATION}';
      await writeFile(promptPath, template);

      const content = await loadPromptFromPath(promptPath);
      expect(content).toBe(template);
    });

    it('throws error when file does not exist', async () => {
      await expect(
        loadPromptFromPath(join(testDir, 'non-existent.md'))
      ).rejects.toThrow('Prompt file not found');
    });

    it('loads and substitutes variables from custom path', async () => {
      const template =
        '## Iteration {ITERATION} / {MAX_ITERATIONS}\n\nProgress: {PROGRESS_FILE}';
      await writeFile(promptPath, template);

      const content = await loadPromptFromPathWithVariables(
        promptPath,
        testVariables
      );
      expect(content).toBe('## Iteration 5 / 30\n\nProgress: PROGRESS.md');
    });
  });
});
