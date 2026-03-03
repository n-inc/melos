import type { TUIView, MissionControlState, ViewPort } from './tui-views.js';
import { drawBox } from './tui-layout.js';
import { getDisplayWidth } from './tui-ansi.js';

function wrapByWidth(text: string, maxWidth: number): string[] {
  if (maxWidth <= 4 || getDisplayWidth(text) <= maxWidth) {
    return [text];
  }
  const chunks: string[] = [];
  let rest = text;
  while (getDisplayWidth(rest) > maxWidth) {
    let cut = Math.min(rest.length, maxWidth);
    while (cut > 0 && getDisplayWidth(rest.slice(0, cut)) > maxWidth) {
      cut -= 1;
    }
    if (cut <= 0) {
      break;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks.length > 0 ? chunks : [text];
}

export const docsView: TUIView = {
  id: 'docs',
  render(viewport: ViewPort, state: MissionControlState): string[] {
    const contentWidth = Math.max(20, viewport.width - 8);
    const prdSource = state.prdPreviewLines ?? ['(PRD preview not loaded)'];
    const taskSource = state.taskPreviewLines ?? ['(TASK preview not loaded)'];
    const prdLines = prdSource.flatMap((line) => wrapByWidth(line, contentWidth));
    const taskLines = taskSource.flatMap((line) => wrapByWidth(line, contentWidth));

    const bodyRows = Math.max(8, viewport.height - 6);
    const sectionPadding = 4; // headers and blank lines
    const half = Math.max(3, Math.floor((bodyRows - sectionPadding) / 2));
    const prdVisible = prdLines.slice(0, half);
    const taskVisible = taskLines.slice(0, bodyRows - sectionPadding - prdVisible.length);

    const body: string[] = [
      'PRD.md Preview',
      ...prdVisible,
    ];
    if (prdLines.length > prdVisible.length) {
      body.push(`... +${prdLines.length - prdVisible.length} lines`);
    }
    body.push('');
    body.push('TASK.json Preview');
    body.push(...taskVisible);
    if (taskLines.length > taskVisible.length) {
      body.push(`... +${taskLines.length - taskVisible.length} lines`);
    }

    return drawBox('Docs', body, viewport.width);
  },
};
