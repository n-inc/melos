import type { MissionControlState, TUIView, ViewPort } from './tui-views.js';
import { drawBox, drawTable } from './tui-layout.js';

export const modelsView: TUIView = {
  id: 'models',
  render(viewport: ViewPort, state: MissionControlState): string[] {
    const roles = Object.values(state.modelAssignments);
    const rows = roles.map((assignment) => [
      assignment.role,
      assignment.engine,
      assignment.model,
      assignment.effort,
    ]);

    const table = drawTable(
      ['Role', 'Engine', 'Model', 'Effort'],
      rows,
      [12, 10, 28, 10]
    );

    return drawBox('Models', table, viewport.width);
  },
};
