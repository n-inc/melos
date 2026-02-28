const ANSI_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|[@-Z\\-_])/g;

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
  let out = '';
  for (const char of stripAnsi(value)) {
    const charWidth = getCharWidth(char);
    if (width + charWidth > bodyWidth) {
      break;
    }
    out += char;
    width += charWidth;
  }
  return `${out}${ellipsis}`;
}

export function padDisplay(value: string, width: number): string {
  const displayWidth = getDisplayWidth(value);
  if (displayWidth >= width) {
    return value;
  }
  return `${value}${' '.repeat(width - displayWidth)}`;
}
