import type { TUIView, MissionControlState, ViewPort } from './tui-views.js';
import { drawBox } from './tui-layout.js';
import { getDisplayWidth } from './tui-ansi.js';

function wrapByWidth(text: string, maxWidth: number): string[] {
  if (maxWidth <= 4 || getDisplayWidth(text) <= maxWidth) {
    return [text];
  }
  const out: string[] = [];
  let rest = text;
  while (getDisplayWidth(rest) > maxWidth) {
    let cut = Math.min(rest.length, maxWidth);
    while (cut > 0 && getDisplayWidth(rest.slice(0, cut)) > maxWidth) {
      cut -= 1;
    }
    if (cut <= 0) {
      break;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) {
    out.push(rest);
  }
  return out.length > 0 ? out : [text];
}

export const prdView: TUIView = {
  id: 'prd',
  render(viewport: ViewPort, state: MissionControlState, context?: { scrollOffset?: number }): string[] {
    const source = state.prdPreviewLines ?? ['(PRD preview not loaded)'];
    const contentWidth = Math.max(20, viewport.width - 8);
    const wrapped = source.flatMap((line) => wrapByWidth(line, contentWidth));
    const scrollOffset = Math.max(0, context?.scrollOffset ?? 0);
    const bodyHeight = Math.max(4, viewport.height - 7);
    const maxOffset = Math.max(0, wrapped.length - bodyHeight);
    const safeOffset = Math.min(scrollOffset, maxOffset);
    const visible = wrapped.slice(safeOffset, safeOffset + bodyHeight);

    const body: string[] = [
      `Line ${Math.min(wrapped.length, safeOffset + 1)}-${Math.min(wrapped.length, safeOffset + visible.length)} / ${wrapped.length}`,
      '',
      ...visible,
    ];
    if (safeOffset > 0) {
      body.splice(2, 0, '↑ more');
    }
    if (safeOffset + visible.length < wrapped.length) {
      body.push('↓ more');
    }

    return drawBox('PRD', body, viewport.width);
  },
};
