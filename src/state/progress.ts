import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * 実行モード
 */
export type ExecutionMode = 'default' | 'review-only' | 'ci-fix-only' | 'task-only';

/**
 * PROGRESS.md のヘッダー情報
 */
export interface ProgressHeader {
  /** 実行モード */
  mode: ExecutionMode;
  /** 開始日時 */
  started: string;
  /** 最大イテレーション数 */
  maxIterations: number;
}

/**
 * イテレーションエントリ
 */
export interface IterationEntry {
  /** イテレーション番号 */
  iteration: number;
  /** 日付 */
  date: string;
  /** 内容（マークダウン形式） */
  content: string;
}

/**
 * PROGRESS.md の構造
 */
export interface Progress {
  /** ヘッダー情報 */
  header: ProgressHeader;
  /** イテレーションエントリのリスト */
  entries: IterationEntry[];
  /** Codebase Patterns セクション（オプション） */
  codebasePatterns?: string;
}

/**
 * モード表示名のマッピング
 */
const MODE_DISPLAY_NAMES: Record<ExecutionMode, string> = {
  default: 'Default (Task → Review → CI)',
  'review-only': 'Review Only',
  'ci-fix-only': 'CI Fix Only',
  'task-only': 'Task Only',
};

/**
 * 表示名からモードを取得
 */
function parseModeFromDisplay(display: string): ExecutionMode {
  const lower = display.toLowerCase();
  if (lower.includes('review only') || lower.includes('review-only')) {
    return 'review-only';
  }
  if (lower.includes('ci fix only') || lower.includes('ci-fix-only')) {
    return 'ci-fix-only';
  }
  if (lower.includes('task only') || lower.includes('task-only')) {
    return 'task-only';
  }
  return 'default';
}

/**
 * PROGRESS.md が存在するか確認
 */
export function progressExists(path: string): boolean {
  return existsSync(path);
}

/**
 * PROGRESS.md を読み込んでパースする
 * @throws {Error} ファイルが存在しない場合
 */
export async function loadProgress(path: string): Promise<Progress> {
  if (!progressExists(path)) {
    throw new Error(`PROGRESS.md not found: ${path}`);
  }

  const content = await readFile(path, 'utf-8');
  return parseProgress(content);
}

/**
 * PROGRESS.md の内容をパースする
 */
export function parseProgress(content: string): Progress {
  const lines = content.split('\n');

  // ヘッダーをパース
  const header = parseHeader(lines);

  // イテレーションエントリをパース
  const entries = parseIterations(lines);

  // Codebase Patterns セクションをパース
  const codebasePatterns = parseCodebasePatterns(lines);

  return {
    header,
    entries,
    codebasePatterns,
  };
}

/**
 * ヘッダー部分をパース
 */
function parseHeader(lines: string[]): ProgressHeader {
  let mode: ExecutionMode = 'default';
  let started = '';
  let maxIterations = 30;

  for (const line of lines) {
    if (line.startsWith('**Mode**:')) {
      const modeStr = line.replace('**Mode**:', '').trim();
      mode = parseModeFromDisplay(modeStr);
    } else if (line.startsWith('**Started**:')) {
      started = line.replace('**Started**:', '').trim();
    } else if (line.startsWith('**Max iterations**:')) {
      const numStr = line.replace('**Max iterations**:', '').trim();
      maxIterations = parseInt(numStr, 10) || 30;
    }
  }

  return { mode, started, maxIterations };
}

/**
 * イテレーションエントリをパース
 */
function parseIterations(lines: string[]): IterationEntry[] {
  const entries: IterationEntry[] = [];
  let currentEntry: IterationEntry | null = null;
  let contentLines: string[] = [];
  let inProgressLog = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Progress Log セクションの開始を検出
    if (line.startsWith('## Progress Log')) {
      inProgressLog = true;
      continue;
    }

    // Codebase Patterns セクションで Progress Log を終了
    if (line.startsWith('## Codebase Patterns')) {
      if (currentEntry && contentLines.length > 0) {
        currentEntry.content = contentLines.join('\n').trim();
        entries.push(currentEntry);
        currentEntry = null; // 重複防止
      }
      break;
    }

    if (!inProgressLog) {
      continue;
    }

    // イテレーションヘッダーを検出（### Iteration N (YYYY-MM-DD)）
    const iterationMatch = line.match(
      /^### Iteration (\d+)(?: \((\d{4}-\d{2}-\d{2})\))?/
    );
    if (iterationMatch) {
      // 前のエントリを保存
      if (currentEntry && contentLines.length > 0) {
        currentEntry.content = contentLines.join('\n').trim();
        entries.push(currentEntry);
      }

      // 新しいエントリを開始
      currentEntry = {
        iteration: parseInt(iterationMatch[1], 10),
        date: iterationMatch[2] || '',
        content: '',
      };
      contentLines = [];
      continue;
    }

    // 他の H2 セクションで Progress Log を終了
    if (line.startsWith('## ') && !line.startsWith('## Progress Log')) {
      if (currentEntry && contentLines.length > 0) {
        currentEntry.content = contentLines.join('\n').trim();
        entries.push(currentEntry);
        currentEntry = null; // 重複防止
      }
      break;
    }

    // コンテンツを収集
    if (currentEntry) {
      contentLines.push(line);
    }
  }

  // 最後のエントリを保存
  if (currentEntry && contentLines.length > 0) {
    currentEntry.content = contentLines.join('\n').trim();
    entries.push(currentEntry);
  }

  return entries;
}

/**
 * Codebase Patterns セクションをパース
 */
function parseCodebasePatterns(lines: string[]): string | undefined {
  const startIndex = lines.findIndex((line) =>
    line.startsWith('## Codebase Patterns')
  );
  if (startIndex === -1) {
    return undefined;
  }

  const contentLines: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    // 次の H2 セクションで終了
    if (line.startsWith('## ') && !line.startsWith('## Codebase Patterns')) {
      break;
    }
    contentLines.push(line);
  }

  const content = contentLines.join('\n').trim();
  return content || undefined;
}

/**
 * PROGRESS.md を保存する
 */
export async function saveProgress(
  path: string,
  progress: Progress
): Promise<void> {
  const content = serializeProgress(progress);
  await writeFile(path, content, 'utf-8');
}

/**
 * Progress オブジェクトをマークダウン形式にシリアライズ
 */
export function serializeProgress(progress: Progress): string {
  const lines: string[] = [];

  // タイトル
  lines.push(`# Marathon Progress: ${progress.header.mode.toUpperCase()}`);
  lines.push('');

  // ヘッダー情報
  lines.push(`**Mode**: ${MODE_DISPLAY_NAMES[progress.header.mode]}`);
  lines.push(`**Started**: ${progress.header.started}`);
  lines.push(`**Max iterations**: ${progress.header.maxIterations}`);
  lines.push('');

  // Progress Log セクション
  lines.push('## Progress Log');
  lines.push('');

  for (const entry of progress.entries) {
    const dateStr = entry.date ? ` (${entry.date})` : '';
    lines.push(`### Iteration ${entry.iteration}${dateStr}`);
    lines.push('');
    if (entry.content) {
      lines.push(entry.content);
      lines.push('');
    }
  }

  // Codebase Patterns セクション
  if (progress.codebasePatterns) {
    lines.push('## Codebase Patterns');
    lines.push('');
    lines.push(progress.codebasePatterns);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 新しい PROGRESS.md を初期化する
 */
export async function initializeProgress(
  path: string,
  mode: ExecutionMode,
  maxIterations: number
): Promise<Progress> {
  const now = new Date();
  const started = formatDateTime(now);

  const progress: Progress = {
    header: {
      mode,
      started,
      maxIterations,
    },
    entries: [],
  };

  await saveProgress(path, progress);
  return progress;
}

/**
 * 新しいイテレーションエントリを追加する
 */
export async function addIteration(
  path: string,
  content: string
): Promise<Progress> {
  const progress = await loadProgress(path);

  const now = new Date();
  const date = formatDate(now);

  const nextIteration =
    progress.entries.length > 0
      ? Math.max(...progress.entries.map((e) => e.iteration)) + 1
      : 1;

  progress.entries.push({
    iteration: nextIteration,
    date,
    content,
  });

  await saveProgress(path, progress);
  return progress;
}

/**
 * 現在のイテレーション番号を取得する
 */
export function getCurrentIteration(progress: Progress): number {
  if (progress.entries.length === 0) {
    return 0;
  }
  return Math.max(...progress.entries.map((e) => e.iteration));
}

/**
 * Codebase Patterns にパターンを追加する
 */
export async function addCodebasePattern(
  path: string,
  pattern: string
): Promise<Progress> {
  const progress = await loadProgress(path);

  const now = new Date();
  const date = formatDate(now);
  const patternLine = `- [${date}] ${pattern}`;

  if (!progress.codebasePatterns) {
    progress.codebasePatterns = `実装中に発見したパターンを記録。後続イテレーションで参照される。

### 発見したパターン
${patternLine}`;
  } else if (progress.codebasePatterns.includes('### 発見したパターン')) {
    // 既存のパターンセクションに追加
    progress.codebasePatterns = progress.codebasePatterns.replace(
      '### 発見したパターン',
      `### 発見したパターン\n${patternLine}`
    );
  } else {
    // パターンセクションがない場合は末尾に追加
    progress.codebasePatterns += `\n\n### 発見したパターン\n${patternLine}`;
  }

  await saveProgress(path, progress);
  return progress;
}

/**
 * 日時をフォーマット（YYYY-MM-DD HH:MM）
 */
function formatDateTime(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * 日付をフォーマット（YYYY-MM-DD）
 */
function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
