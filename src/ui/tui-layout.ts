import { getDisplayWidth, padDisplay, truncateDisplay } from './tui-ansi.js';

export function drawBox(title: string, lines: string[], width: number): string[] {
  const safeWidth = Math.max(width, 12);
  const top = `╔${'═'.repeat(safeWidth - 2)}╗`;
  const bottom = `╚${'═'.repeat(safeWidth - 2)}╝`;
  const titleLine = `║ ${truncateDisplay(title, safeWidth - 4)}${' '.repeat(Math.max(0, safeWidth - 3 - getDisplayWidth(title)))}║`;

  const body = lines.map((line) => `║ ${padDisplay(truncateDisplay(line, safeWidth - 4), safeWidth - 4)} ║`);
  return [top, titleLine, ...body, bottom];
}

export function splitColumns(
  left: string[],
  right: string[],
  totalWidth: number,
  ratio: number = 0.5
): string[] {
  const width = Math.max(totalWidth, 20);
  const leftWidth = Math.max(8, Math.floor((width - 3) * ratio));
  const rightWidth = Math.max(8, width - 3 - leftWidth);
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const l = truncateDisplay(left[i] ?? '', leftWidth);
    const r = truncateDisplay(right[i] ?? '', rightWidth);
    out.push(`${padDisplay(l, leftWidth)} │ ${padDisplay(r, rightWidth)}`);
  }
  return out;
}

export function drawTable(
  headers: string[],
  rows: string[][],
  widths: number[]
): string[] {
  const normalized = widths.map((width) => Math.max(width, 4));
  const headerLine = headers
    .map((header, index) => padDisplay(truncateDisplay(header, normalized[index]), normalized[index]))
    .join('  ');
  const divider = normalized.map((width) => '─'.repeat(width)).join('  ');
  const body = rows.map((row) => row
    .map((cell, index) => padDisplay(truncateDisplay(cell ?? '', normalized[index]), normalized[index]))
    .join('  '));

  return [headerLine, divider, ...body];
}
