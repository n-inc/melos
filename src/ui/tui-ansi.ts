const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const ANSI_PREFIX_PATTERN = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/;
const ANSI_RESET = '\x1b[0m';

export type ColorToken =
  | 'state_running'
  | 'state_paused'
  | 'state_failed'
  | 'state_awaiting'
  | 'kind_read'
  | 'kind_write'
  | 'kind_bash'
  | 'kind_done'
  | 'kind_err'
  | 'kind_info'
  | 'kind_switch'
  | 'label_dim';

const COLOR_CODE: Record<ColorToken, string> = {
  state_running: '\x1b[32m',
  state_paused: '\x1b[33m',
  state_failed: '\x1b[31m',
  state_awaiting: '\x1b[36m',
  kind_read: '\x1b[36m',
  kind_write: '\x1b[33m',
  kind_bash: '\x1b[34m',
  kind_done: '\x1b[32m',
  kind_err: '\x1b[31m',
  kind_info: '\x1b[2m',
  kind_switch: '\x1b[35m',
  label_dim: '\x1b[2m',
};

export function canUseColor(isTTY = true): boolean {
  if (!isTTY) {
    return false;
  }
  return process.env.NO_COLOR === undefined;
}

export function colorize(value: string, token: ColorToken, enabled: boolean): string {
  if (!enabled || value.length === 0) {
    return value;
  }
  return `${COLOR_CODE[token]}${value}${ANSI_RESET}`;
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

export function getCharWidth(char: string): number {
  const code = char.charCodeAt(0);
  if (
    (code >= 0x3000 && code <= 0x9fff)
    || (code >= 0xff00 && code <= 0xffef)
  ) {
    return 2;
  }
  return 1;
}

export function getDisplayWidth(value: string): number {
  let width = 0;
  for (const char of stripAnsi(value)) {
    width += getCharWidth(char);
  }
  return width;
}

export function truncateDisplay(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (getDisplayWidth(value) <= maxWidth) {
    return value;
  }

  const ellipsis = '…';
  if (maxWidth <= getDisplayWidth(ellipsis)) {
    return ellipsis;
  }

  const bodyWidth = maxWidth - getDisplayWidth(ellipsis);
  let width = 0;
  let index = 0;
  let out = '';
  let hasAnsi = false;

  while (index < value.length) {
    if (value[index] === '\x1b') {
      const ansiMatch = value.slice(index).match(ANSI_PREFIX_PATTERN);
      if (ansiMatch) {
        out += ansiMatch[0];
        index += ansiMatch[0].length;
        hasAnsi = true;
        continue;
      }
    }

    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const char = String.fromCodePoint(codePoint);
    const charWidth = getCharWidth(char);
    if (width + charWidth > bodyWidth) {
      break;
    }
    out += char;
    width += charWidth;
    index += codePoint > 0xffff ? 2 : 1;
  }

  const base = `${out}${ellipsis}`;
  return hasAnsi ? `${base}${ANSI_RESET}` : base;
}

export function padDisplay(value: string, width: number): string {
  const displayWidth = getDisplayWidth(value);
  if (displayWidth >= width) {
    return value;
  }
  return `${value}${' '.repeat(width - displayWidth)}`;
}

export function wrapPlainDisplay(value: string, maxWidth: number): string[] {
  if (maxWidth <= 0) {
    return [''];
  }

  const lines: string[] = [];
  const sourceLines = value.split(/\r?\n/);
  for (const sourceLine of sourceLines) {
    if (sourceLine.length === 0) {
      lines.push('');
      continue;
    }

    let chunk = '';
    let chunkWidth = 0;
    for (const char of sourceLine) {
      const charWidth = getCharWidth(char);
      if (chunkWidth + charWidth > maxWidth && chunk.length > 0) {
        lines.push(chunk);
        chunk = char;
        chunkWidth = charWidth;
      } else {
        chunk += char;
        chunkWidth += charWidth;
      }
    }
    if (chunk.length > 0) {
      lines.push(chunk);
    }
  }

  return lines.length > 0 ? lines : [''];
}
