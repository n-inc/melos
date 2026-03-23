import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { RecipeDefinition } from './recipe.js';

export interface ResolvedRecipeSource {
  path: string;
  cleanup?: () => void;
  fromStdin: boolean;
}

export async function readRecipeStdin(input: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export function resolveRecipePath(recipePath: string, cwd: string): string {
  if (recipePath === '-') {
    throw new Error('stdin recipe path must be resolved with resolveRecipeSource()');
  }

  const absolutePath = isAbsolute(recipePath) ? recipePath : resolve(cwd, recipePath);
  if (extname(absolutePath) !== '.ts') {
    throw new Error(`--recipe は .ts ファイルを指定してください: ${recipePath}`);
  }
  return absolutePath;
}

export async function resolveRecipeSource(options: {
  recipePath: string;
  cwd: string;
  stdinText?: string;
  stdin?: NodeJS.ReadableStream;
}): Promise<ResolvedRecipeSource> {
  if (options.recipePath !== '-') {
    return {
      path: resolveRecipePath(options.recipePath, options.cwd),
      fromStdin: false,
    };
  }

  const sourceText = options.stdinText ?? await readRecipeStdin(options.stdin);
  if (sourceText.trim().length === 0) {
    throw new Error('stdin から recipe を読み込めませんでした');
  }

  const dir = mkdtempSync(join(tmpdir(), 'melos-exec-recipe-'));
  const tempPath = join(dir, 'stdin-recipe.ts');
  writeFileSync(tempPath, sourceText, 'utf-8');
  return {
    path: tempPath,
    fromStdin: true,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function loadRecipeModule(recipePath: string): Promise<RecipeDefinition> {
  const fileUrl = pathToFileURL(recipePath);
  fileUrl.searchParams.set('t', String(Date.now()));

  let imported: unknown;
  try {
    imported = await import(fileUrl.href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`recipe module の import に失敗しました: ${message}`);
  }

  const recipe = (imported as { default?: RecipeDefinition }).default;
  if (!recipe) {
    throw new Error('recipe module に default export がありません');
  }
  if (typeof recipe !== 'object') {
    throw new Error('recipe module の default export が不正です');
  }
  if (!('run' in recipe) || !('evaluate' in recipe) || !('policy' in recipe) || !('prompt' in recipe)) {
    throw new Error('recipe module の default export が recipe shape を満たしていません');
  }
  return recipe;
}

export function readRecipeFile(recipePath: string): string {
  return readFileSync(recipePath, 'utf-8');
}
