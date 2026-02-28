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

    const lines = [
      ...table,
      '',
      'Change model:',
      '  1 Planner   2 Worker   3 Validator   4 Research',
      'Press the number key to cycle model for each role.',
    ];

    return drawBox('Models', lines, viewport.width);
  },
};
