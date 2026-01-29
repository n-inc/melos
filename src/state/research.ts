import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

const MELOS_DIR = '.melos';
const RESEARCH_DIR = 'research';

/**
 * .melos/research/ ディレクトリのパスを取得
 */
export function getResearchDir(cwd: string): string {
  return join(cwd, MELOS_DIR, RESEARCH_DIR);
}

/**
 * .melos/research/ ディレクトリを初期化
 * ディレクトリがなければ作成
 */
export function initializeResearchFolder(cwd: string): void {
  const melosDir = join(cwd, MELOS_DIR);
  const researchDir = getResearchDir(cwd);

  if (!existsSync(melosDir)) {
    mkdirSync(melosDir, { recursive: true });
  }

  if (!existsSync(researchDir)) {
    mkdirSync(researchDir, { recursive: true });
  }
}

/**
 * トピック名をサニタイズ（英数字、ハイフン、アンダースコアのみ）
 */
function sanitizeTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-');
}

/**
 * 調査結果をトピック名で保存
 * @param cwd 作業ディレクトリ
 * @param topic トピック名（例: "auth-flow", "api-design"）
 * @param content マークダウン形式の調査内容
 */
export async function saveResearch(
  cwd: string,
  topic: string,
  content: string
): Promise<string> {
  initializeResearchFolder(cwd);

  const sanitizedTopic = sanitizeTopic(topic);
  const filePath = join(getResearchDir(cwd), `${sanitizedTopic}.md`);
  await writeFile(filePath, content, 'utf-8');

  return filePath;
}

/**
 * 調査結果を読み込み
 * @param cwd 作業ディレクトリ
 * @param topic トピック名
 * @returns 調査内容（存在しない場合はnull）
 */
export async function loadResearch(
  cwd: string,
  topic: string
): Promise<string | null> {
  const sanitizedTopic = sanitizeTopic(topic);
  const filePath = join(getResearchDir(cwd), `${sanitizedTopic}.md`);

  if (!existsSync(filePath)) {
    return null;
  }

  return readFile(filePath, 'utf-8');
}

/**
 * 全てのresearchトピック一覧を取得
 */
export async function listResearchTopics(cwd: string): Promise<string[]> {
  const researchDir = getResearchDir(cwd);

  if (!existsSync(researchDir)) {
    return [];
  }

  const files = await readdir(researchDir);
  return files
    .filter((f) => f.endsWith('.md'))
    .map((f) => basename(f, '.md'));
}

/**
 * PROGRESS.md用の参照形式を生成
 * @param topic トピック名
 * @param summary 要旨（1-2行）
 */
export function formatResearchReference(topic: string, summary: string): string {
  const sanitizedTopic = sanitizeTopic(topic);
  return `- ${summary}\n  - 詳細: .melos/research/${sanitizedTopic}.md`;
}
