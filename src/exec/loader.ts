import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import yaml from 'js-yaml';

import { normalizeRuntimeRecipe, type RecipeDefinition, type RuntimeRecipeInput } from './recipe.js';
import { loadYamlRoute } from './yaml-loader.js';

const SUPPORTED_EXTENSIONS = new Set(['.ts', '.yaml', '.yml']);

export interface ResolvedRouteSource {
  path: string;
  cleanup?: () => void;
  fromStdin: boolean;
}

function inferStdinRouteExtension(sourceText: string): '.ts' | '.yaml' {
  const trimmed = sourceText.trimStart();
  if (
    trimmed.startsWith('export ')
    || trimmed.startsWith('import ')
    || trimmed.startsWith('//')
    || trimmed.startsWith('/*')
  ) {
    return '.ts';
  }

  try {
    const parsed = yaml.load(sourceText);
    if (parsed != null && typeof parsed === 'object') {
      return '.yaml';
    }
  } catch {
    // Fall back to the TypeScript loader when the input is not valid YAML.
  }

  return '.ts';
}

export async function readRouteStdin(input: NodeJS.ReadableStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export function resolveRoutePath(routePath: string, cwd: string): string {
  if (routePath === '-') {
    throw new Error('stdin route path must be resolved with resolveRouteSource()');
  }

  const absolutePath = isAbsolute(routePath) ? routePath : resolve(cwd, routePath);
  const ext = extname(absolutePath);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`--route は .ts / .yaml / .yml ファイルを指定してください: ${routePath}`);
  }
  return absolutePath;
}

export async function resolveRouteSource(options: {
  routePath: string;
  cwd: string;
  stdinText?: string;
  stdin?: NodeJS.ReadableStream;
}): Promise<ResolvedRouteSource> {
  if (options.routePath !== '-') {
    return {
      path: resolveRoutePath(options.routePath, options.cwd),
      fromStdin: false,
    };
  }

  const sourceText = options.stdinText ?? await readRouteStdin(options.stdin);
  if (sourceText.trim().length === 0) {
    throw new Error('stdin から route を読み込めませんでした');
  }

  const dir = mkdtempSync(join(tmpdir(), 'melos-run-route-'));
  const tempPath = join(dir, `stdin-route${inferStdinRouteExtension(sourceText)}`);
  writeFileSync(tempPath, sourceText, 'utf-8');
  return {
    path: tempPath,
    fromStdin: true,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function isYamlFile(routePath: string): boolean {
  const ext = extname(routePath);
  return ext === '.yaml' || ext === '.yml';
}

export async function loadRouteModule(routePath: string): Promise<RecipeDefinition> {
  if (isYamlFile(routePath)) {
    return loadYamlRoute(routePath);
  }

  const fileUrl = pathToFileURL(routePath);
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
  if (!('run' in recipe) || !('workflow' in recipe)) {
    throw new Error('route module の default export が runtime route shape を満たしていません');
  }
  return normalizeRuntimeRecipe(recipe as RuntimeRecipeInput);
}

export function readRouteFile(routePath: string): string {
  return readFileSync(routePath, 'utf-8');
}
