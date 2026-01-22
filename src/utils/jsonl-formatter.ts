/**
 * JSONL Formatter for Claude Code stream-json output
 *
 * Claude Code の --output-format stream-json 出力をパースし、
 * 人間が読みやすい形式でフォーマットする。
 */

/** ANSI カラーコード */
const COLORS = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
} as const;

/** Todo アイテムの型 */
interface TodoItem {
  content: string;
  status: string;
}

/** ツール使用ブロックの型 */
interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
}

/** テキストブロックの型 */
interface TextBlock {
  type: 'text';
  text: string;
}

/** ツール結果ブロックの型 */
interface ToolResultBlock {
  type: 'tool_result';
  content: string;
}

/** コンテンツブロックの型 */
type ContentBlock = ToolUseBlock | TextBlock | ToolResultBlock;

/** メッセージの型 */
interface Message {
  content?: ContentBlock[];
}

/** ストリームイベントの型 */
interface StreamEvent {
  type: string;
  message?: Message;
}

/**
 * 文字列を指定長に切り詰める
 */
function truncate(str: string, maxLen: number): string {
  if (!str) return '';
  const cleaned = str.replace(/\n/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 3) + '...';
}

/** diff 表示の設定 */
const DIFF_CONFIG = {
  maxLines: 10,
  maxLineLength: 80,
} as const;

/**
 * 行を切り詰める（diff 表示用）
 */
function truncateLine(line: string, maxLen: number): string {
  if (line.length <= maxLen) return line;
  return line.slice(0, maxLen - 3) + '...';
}

/**
 * Edit/Write ツールの差分を色付きでフォーマットする
 *
 * @param oldStr 削除されるテキスト（Edit の場合）
 * @param newStr 追加されるテキスト
 * @returns 差分行の配列
 */
function formatDiff(oldStr: string | null, newStr: string): string[] {
  const results: string[] = [];
  const { maxLines, maxLineLength } = DIFF_CONFIG;

  // 削除行（Edit の場合のみ）
  if (oldStr) {
    const oldLines = oldStr.split('\n');
    const showOldLines = oldLines.slice(0, maxLines);
    for (const line of showOldLines) {
      const truncated = truncateLine(line, maxLineLength);
      results.push(`${COLORS.red}  - ${truncated}${COLORS.reset}`);
    }
    if (oldLines.length > maxLines) {
      results.push(
        `${COLORS.dim}  ...（残り${oldLines.length - maxLines}行）${COLORS.reset}`
      );
    }
  }

  // 追加行
  const newLines = newStr.split('\n');
  const showNewLines = newLines.slice(0, maxLines);
  for (const line of showNewLines) {
    const truncated = truncateLine(line, maxLineLength);
    results.push(`${COLORS.green}  + ${truncated}${COLORS.reset}`);
  }
  if (newLines.length > maxLines) {
    results.push(
      `${COLORS.dim}  ...（残り${newLines.length - maxLines}行）${COLORS.reset}`
    );
  }

  return results;
}

/**
 * Todo リストをフォーマットする
 */
function formatTodos(todos: unknown): string {
  if (!Array.isArray(todos)) return '';

  const items = todos as TodoItem[];
  const summary = items
    .slice(0, 3)
    .map((t) => {
      const status = t.status === 'completed' ? '[x]' : '[ ]';
      return `${status} ${truncate(t.content, 40)}`;
    })
    .join(', ');

  if (items.length > 3) {
    return `${summary} (+${items.length - 3} more)`;
  }
  return summary;
}

/**
 * ツール使用をフォーマットする
 */
function formatToolUse(block: ToolUseBlock): string[] {
  const { name, input } = block;
  let summary = '';
  let diffLines: string[] = [];

  switch (name) {
    case 'Bash':
      summary = truncate(input.command as string, 120);
      break;
    case 'Read':
      summary = input.file_path as string;
      break;
    case 'Write':
      summary = `${input.file_path} (${(input.content as string)?.length || 0} chars)`;
      if (input.content) {
        diffLines = formatDiff(null, input.content as string);
      }
      break;
    case 'Edit':
      summary = input.file_path as string;
      if (input.old_string !== undefined && input.new_string !== undefined) {
        diffLines = formatDiff(
          input.old_string as string,
          input.new_string as string
        );
      }
      break;
    case 'Glob':
      summary = `${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
      break;
    case 'Grep':
      summary = truncate(input.pattern as string, 80);
      break;
    case 'TodoWrite':
      summary = formatTodos(input.todos);
      break;
    case 'Task':
      summary = truncate(input.description as string, 80);
      break;
    default:
      summary = truncate(JSON.stringify(input), 80);
  }

  const header = `${COLORS.yellow}TOOL[${name}]: ${summary}${COLORS.reset}`;
  return [header, ...diffLines];
}

/**
 * ストリームイベントをフォーマットする
 *
 * @param event パース済みのJSONイベント
 * @returns フォーマットされた文字列の配列、または表示不要の場合は空配列
 */
export function formatStreamEvent(event: unknown): string[] {
  if (!event || typeof event !== 'object') return [];

  const e = event as StreamEvent;

  // assistant メッセージ（テキスト出力またはツール呼び出し）
  if (e.type === 'assistant' && e.message?.content) {
    for (const block of e.message.content) {
      if (block.type === 'text') {
        const text = truncate((block as TextBlock).text, 200);
        if (text) {
          return [`${COLORS.green}CLAUDE: ${text}${COLORS.reset}`];
        }
      }
      if (block.type === 'tool_use') {
        return formatToolUse(block as ToolUseBlock);
      }
    }
  }

  // ツール結果
  if (e.type === 'user' && e.message?.content) {
    for (const block of e.message.content) {
      if (block.type === 'tool_result') {
        const content = truncate((block as ToolResultBlock).content, 100);
        return [`${COLORS.cyan}RESULT: ${content}${COLORS.reset}`];
      }
    }
  }

  // セッション完了
  if (e.type === 'result') {
    return [`${COLORS.magenta}SESSION COMPLETE${COLORS.reset}`];
  }

  return [];
}

/**
 * JSONL ストリームを処理するためのバッファクラス
 *
 * チャンクで受け取ったデータを行単位でパースする
 */
export class JsonlBuffer {
  private buffer = '';

  /**
   * データチャンクを追加し、完全な行をパースして返す
   */
  processChunk(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');

    // 最後の不完全な行はバッファに残す
    this.buffer = lines.pop() || '';

    const results: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        const formatted = formatStreamEvent(event);
        results.push(...formatted);
      } catch {
        // JSON以外の行は無視
      }
    }

    return results;
  }

  /**
   * バッファに残っているデータを処理する（ストリーム終了時）
   */
  flush(): string[] {
    if (!this.buffer.trim()) return [];

    try {
      const event = JSON.parse(this.buffer.trim());
      const formatted = formatStreamEvent(event);
      this.buffer = '';
      return formatted;
    } catch {
      this.buffer = '';
      return [];
    }
  }
}
