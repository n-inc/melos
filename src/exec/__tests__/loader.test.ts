import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadRecipeModule, resolveRecipePath, resolveRecipeSource } from '../loader.js';

describe('exec loader', () => {
  it('resolves recipe path relative to cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-'));
    expect(resolveRecipePath('recipes/sample.ts', cwd)).toBe(join(cwd, 'recipes/sample.ts'));
  });

  it('rejects non-ts recipe path', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-ext-'));
    expect(() => resolveRecipePath('recipe.js', cwd)).toThrow(/\.ts/);
  });

  it('writes stdin recipe to a temporary ts file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-stdin-'));
    const resolved = await resolveRecipeSource({
      recipePath: '-',
      cwd,
      stdinText: 'export default { prompt: "x" };\n',
    });

    expect(resolved.fromStdin).toBe(true);
    expect(resolved.path.endsWith('.ts')).toBe(true);
    resolved.cleanup?.();
  });

  it('fails when default export is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-module-'));
    const recipePath = join(cwd, 'recipe.mjs');
    writeFileSync(recipePath, 'export const value = 1;\n', 'utf-8');

    await expect(loadRecipeModule(recipePath)).rejects.toThrow(/default export/);
  });

  const itIfBun = spawnSync('bun', ['--version'], { encoding: 'utf-8' }).status === 0 ? it : it.skip;

  itIfBun('imports a ts recipe module through Bun-compatible dynamic import', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-bun-'));
    const recipePath = join(cwd, 'recipe.ts');
    writeFileSync(recipePath, `
      import { createRecipe } from ${JSON.stringify(join(process.cwd(), 'src/exec/index.ts'))};
      export default createRecipe({
        prompt: 'hello',
        context: [],
        run: { engine: 'codex' },
        evaluate: () => ({ ok: true, summary: 'ok' }),
        policy: () => ({ kind: 'stop', success: true }),
      });
    `, 'utf-8');

    const result = spawnSync('bun', ['-e', `
      const { loadRecipeModule } = await import(${JSON.stringify(join(process.cwd(), 'src/exec/loader.ts'))});
      const recipe = await loadRecipeModule(${JSON.stringify(recipePath)});
      process.stdout.write(recipe.prompt + "\\n");
    `], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });
});
