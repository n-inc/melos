import type { TUIView, MissionControlState, ViewPort } from './tui-views.js';
import { drawBox, splitColumns } from './tui-layout.js';

function buildColumn(title: string, lines: string[]): string[] {
  return [
    title,
    '',
    ...(lines.length > 0 ? lines : ['(no preview available)']),
  ];
}

export const docsView: TUIView = {
  id: 'docs',
  render(viewport: ViewPort, state: MissionControlState): string[] {
    const prdLines = state.prdPreviewLines ?? ['(PRD preview not loaded)'];
    const taskLines = state.taskPreviewLines ?? ['(TASK preview not loaded)'];

    const body = splitColumns(
      buildColumn('PRD.md Preview', prdLines),
      buildColumn('TASK.json Preview', taskLines),
      viewport.width,
      0.5
    );

    return drawBox('Docs', body, viewport.width);
  },
};
