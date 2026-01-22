import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * プロンプトの変数コンテキスト
 */
export interface PromptVariables {
  /** 現在のイテレーション番号 */
  iteration: number;
  /** 最大イテレーション数 */
  maxIterations: number;
  /** 進捗ファイルパス */
  progressFile: string;
  /** プランファイルパス */
  planFile: string;
}

/**
 * プロンプトタイプ
 */
export type PromptType = 'loop' | 'hitl-loop';

/**
 * プロンプトファイルのパスを取得
 */
function getPromptsDir(): string {
  // ESM で __dirname を取得
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // src/prompts/loader.ts -> prompts/
  return join(__dirname, '..', '..', 'prompts');
}

/**
 * プロンプトタイプからファイル名を取得
 */
function getPromptFileName(promptType: PromptType): string {
  return `${promptType}.md`;
}

/**
 * プロンプトファイルが存在するか確認
 */
export function promptExists(promptType: PromptType): boolean {
  const promptsDir = getPromptsDir();
  const filePath = join(promptsDir, getPromptFileName(promptType));
  return existsSync(filePath);
}

/**
 * プロンプトファイルのフルパスを取得
 */
export function getPromptPath(promptType: PromptType): string {
  const promptsDir = getPromptsDir();
  return join(promptsDir, getPromptFileName(promptType));
}

/**
 * 変数プレースホルダーを置換する
 *
 * プレースホルダー形式:
 * - {ITERATION} -> variables.iteration
 * - {MAX_ITERATIONS} -> variables.maxIterations
 * - {PROGRESS_FILE} -> variables.progressFile
 * - {PLAN_FILE} -> variables.planFile
 */
export function substituteVariables(
  template: string,
  variables: PromptVariables
): string {
  let result = template;

  result = result.replaceAll('{ITERATION}', String(variables.iteration));
  result = result.replaceAll(
    '{MAX_ITERATIONS}',
    String(variables.maxIterations)
  );
  result = result.replaceAll('{PROGRESS_FILE}', variables.progressFile);
  result = result.replaceAll('{PLAN_FILE}', variables.planFile);

  return result;
}

/**
 * プロンプトファイルを読み込む（変数置換なし）
 * @throws {Error} ファイルが存在しない場合
 */
export async function loadPromptRaw(promptType: PromptType): Promise<string> {
  const filePath = getPromptPath(promptType);

  if (!existsSync(filePath)) {
    throw new Error(`Prompt file not found: ${filePath}`);
  }

  return await readFile(filePath, 'utf-8');
}

/**
 * プロンプトファイルを読み込み、変数を置換する
 * @throws {Error} ファイルが存在しない場合
 */
export async function loadPrompt(
  promptType: PromptType,
  variables: PromptVariables
): Promise<string> {
  const template = await loadPromptRaw(promptType);
  return substituteVariables(template, variables);
}

/**
 * カスタムパスからプロンプトファイルを読み込む（変数置換なし）
 * @throws {Error} ファイルが存在しない場合
 */
export async function loadPromptFromPath(filePath: string): Promise<string> {
  if (!existsSync(filePath)) {
    throw new Error(`Prompt file not found: ${filePath}`);
  }

  return await readFile(filePath, 'utf-8');
}

/**
 * カスタムパスからプロンプトファイルを読み込み、変数を置換する
 * @throws {Error} ファイルが存在しない場合
 */
export async function loadPromptFromPathWithVariables(
  filePath: string,
  variables: PromptVariables
): Promise<string> {
  const template = await loadPromptFromPath(filePath);
  return substituteVariables(template, variables);
}

/**
 * 利用可能なすべてのプロンプトタイプを取得
 */
export function getAvailablePromptTypes(): PromptType[] {
  return ['loop', 'hitl-loop'];
}

/**
 * モードとHITLフラグからプロンプトタイプを決定
 * NOTE: モードに関係なく統一プロンプトを使用
 */
export function getPromptType(
  _mode: 'default' | 'review-only' | 'ci-fix-only' | 'task-only',
  hitl: boolean
): PromptType {
  return hitl ? 'hitl-loop' : 'loop';
}
