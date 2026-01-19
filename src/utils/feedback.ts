import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * フィードバックループの種類
 */
export type FeedbackLoopType = 'frontend' | 'backend';

/**
 * 検出されたフィードバックループの結果
 */
export interface FeedbackLoops {
  frontend: boolean;
  backend: boolean;
}

/**
 * フロントエンド関連のキーワード（大文字小文字を区別しない）
 */
const FRONTEND_KEYWORDS = [
  'frontend',
  'react',
  'component',
  'tsx',
  'jsx',
  'next\\.?js',
  'ui',
  'page',
];

/**
 * バックエンド関連のキーワード（大文字小文字を区別しない）
 */
const BACKEND_KEYWORDS = [
  'api',
  'rails',
  'ruby',
  'controller',
  'model',
  'migration',
  'service',
  'graphql',
  'rspec',
];

/**
 * フロントエンド検出用の正規表現
 */
const FRONTEND_PATTERN = new RegExp(FRONTEND_KEYWORDS.join('|'), 'i');

/**
 * バックエンド検出用の正規表現
 */
const BACKEND_PATTERN = new RegExp(BACKEND_KEYWORDS.join('|'), 'i');

/**
 * コンテンツからフィードバックループの種類を検出する
 */
export function detectFromContent(content: string): FeedbackLoops {
  const frontend = FRONTEND_PATTERN.test(content);
  const backend = BACKEND_PATTERN.test(content);

  // 何も検出されなければ両方を対象とする
  if (!frontend && !backend) {
    return { frontend: true, backend: true };
  }

  return { frontend, backend };
}

/**
 * git diff からフィードバックループを検出する
 * @param baseBranch ベースブランチ（デフォルト: main）
 * @param cwd 作業ディレクトリ
 */
export function detectFromGitDiff(
  baseBranch: string = 'main',
  cwd?: string
): FeedbackLoops {
  // spawnSync を使用して配列形式で引数を渡し、コマンドインジェクションを防止
  const result = spawnSync('git', ['diff', baseBranch, '--name-only'], {
    encoding: 'utf-8',
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.status !== 0 || result.error) {
    // git diff が失敗した場合は両方を対象とする
    return { frontend: true, backend: true };
  }

  return detectFromContent(result.stdout || '');
}

/**
 * PLAN.json ファイルからフィードバックループを検出する
 */
export async function detectFromPlanFile(
  planPath: string
): Promise<FeedbackLoops> {
  if (!existsSync(planPath)) {
    return { frontend: true, backend: true };
  }

  try {
    const content = await readFile(planPath, 'utf-8');
    return detectFromContent(content);
  } catch {
    return { frontend: true, backend: true };
  }
}

/**
 * フィードバックループを検出する（PLAN.json 優先、なければ git diff）
 */
export async function detectFeedbackLoops(
  planPath?: string,
  baseBranch: string = 'main',
  cwd?: string
): Promise<FeedbackLoops> {
  // PLAN.json があればそちらを優先
  if (planPath && existsSync(planPath)) {
    return detectFromPlanFile(planPath);
  }

  // なければ git diff から検出
  return detectFromGitDiff(baseBranch, cwd);
}

/**
 * フィードバック指示文字列を構築する
 */
export function buildFeedbackInstructions(loops: FeedbackLoops): string {
  const instructions: string[] = [];

  if (loops.frontend) {
    instructions.push(
      '   - Frontend: `cd frontend && yarn typecheck && yarn lint`'
    );
  }

  if (loops.backend) {
    instructions.push(
      '   - Backend: `cd api && bundle exec rubocop --format simple`'
    );
  }

  return instructions.join('\n');
}
