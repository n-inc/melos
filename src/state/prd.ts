import { readFile } from 'node:fs/promises';

/**
 * PRD フロントマターの型定義
 */
export interface PrdFrontmatter {
  title?: string;
}

/**
 * YAML フロントマターをパースする（シンプルな実装）
 *
 * 外部ライブラリを使わず、title フィールドのみを抽出する
 */
function parseFrontmatter(content: string): PrdFrontmatter {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (!frontmatterMatch) {
    return {};
  }

  const yaml = frontmatterMatch[1];
  const result: PrdFrontmatter = {};

  // title: 行を探す
  const titleMatch = yaml.match(/^title:\s*(.+)$/m);
  if (titleMatch) {
    // クォートを除去
    result.title = titleMatch[1].trim().replace(/^["']|["']$/g, '');
  }

  return result;
}

/**
 * PRD.md のフロントマターを解析してタイトルを抽出
 *
 * @param prdPath PRDファイルのパス
 * @returns タイトル（フロントマターがない場合は null）
 */
export async function extractPrdTitle(prdPath: string): Promise<string | null> {
  try {
    const content = await readFile(prdPath, 'utf-8');
    const frontmatter = parseFrontmatter(content);
    return frontmatter.title ?? null;
  } catch {
    return null;
  }
}
