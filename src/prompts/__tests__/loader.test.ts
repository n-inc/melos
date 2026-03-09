import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  getDefaultPromptsDir,
  loadPromptFromPath,
} from '../loader.js';

describe('loader.ts', () => {
  it('returns the bundled prompts directory', () => {
    const promptsDir = getDefaultPromptsDir();
    expect(basename(promptsDir)).toBe('prompts');
  });

  it('loads the bundled worker prompt from path', async () => {
    const promptsDir = getDefaultPromptsDir();
    const content = await loadPromptFromPath(join(promptsDir, 'worker.md'));
    expect(content).toContain('git-commit');
    expect(content).toContain('type(scope): subject');
  });

  it('loads the bundled final review prompts from path', async () => {
    const promptsDir = getDefaultPromptsDir();
    const product = await loadPromptFromPath(join(promptsDir, 'product-review.md'));
    const code = await loadPromptFromPath(join(promptsDir, 'code-review.md'));
    expect(product).toContain('Playwright');
    expect(code).toContain('P1');
  });

  describe('loadPromptFromPath', () => {
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

    it('loads a custom prompt file from path', async () => {
      const template = '# Custom Prompt\n\nUse this prompt.';
      await writeFile(promptPath, template);

      const content = await loadPromptFromPath(promptPath);
      expect(content).toBe(template);
    });

    it('throws when the prompt path does not exist', async () => {
      await expect(
        loadPromptFromPath(join(testDir, 'missing.md'))
      ).rejects.toThrow('Prompt file not found');
    });
  });
});
