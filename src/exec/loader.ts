import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeRuntimeRecipe, type RecipeDefinition, type RuntimeRecipeInput } from './recipe.js';

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
    throw new Error('stdin route path must be resolved with resolveRouteSource()');
  }

  const absolutePath = isAbsolute(recipePath) ? recipePath : resolve(cwd, recipePath);
  if (extname(absolutePath) !== '.ts') {
    throw new Error(`--route は .ts ファイルを指定してください: ${recipePath}`);
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
    throw new Error('stdin から route を読み込めませんでした');
  }

  const dir = mkdtempSync(join(tmpdir(), 'melos-run-route-'));
  const tempPath = join(dir, 'stdin-route.ts');
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
    throw new Error(`route module の import に失敗しました: ${message}`);
  }

  const recipe = (imported as { default?: RecipeDefinition }).default;
  if (!recipe) {
    throw new Error('route module に default export がありません');
  }
  if (typeof recipe !== 'object') {
    throw new Error('route module の default export が不正です');
  }
  if (!('apiVersion' in recipe) || (recipe as { apiVersion?: unknown }).apiVersion !== 2) {
    throw new Error('route module は createRoute() で生成してください (apiVersion=2 required)');
  }
  if (!('run' in recipe) || !('evaluate' in recipe) || !('policy' in recipe) || !('prompt' in recipe)) {
    throw new Error('route module の default export が runtime route shape を満たしていません');
  }
  return normalizeRuntimeRecipe(recipe as RuntimeRecipeInput);
}

export function readRecipeFile(recipePath: string): string {
  return readFileSync(recipePath, 'utf-8');
}

export type ResolvedRouteSource = ResolvedRecipeSource;

export async function readRouteStdin(input: NodeJS.ReadableStream = process.stdin): Promise<string> {
  return readRecipeStdin(input);
}

export function resolveRoutePath(routePath: string, cwd: string): string {
  return resolveRecipePath(routePath, cwd);
}

export async function resolveRouteSource(options: {
  routePath: string;
  cwd: string;
  stdinText?: string;
  stdin?: NodeJS.ReadableStream;
}): Promise<ResolvedRouteSource> {
  return resolveRecipeSource({
    recipePath: options.routePath,
    cwd: options.cwd,
    stdinText: options.stdinText,
    stdin: options.stdin,
  });
}

export async function loadRouteModule(routePath: string): Promise<RecipeDefinition> {
  return loadRecipeModule(routePath);
}

export function readRouteFile(routePath: string): string {
  return readRecipeFile(routePath);
}
