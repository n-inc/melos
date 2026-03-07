import type { MissionControlState, TUIView, ViewPort } from './tui-views.js';
import { drawBox, drawTable } from './tui-layout.js';
import { resolveDisplayModel } from '../models/registry.js';

export const modelsView: TUIView = {
  id: 'models',
  render(viewport: ViewPort, state: MissionControlState): string[] {
    const roles = Object.values(state.modelAssignments);
    const rows = roles.map((assignment) => [
      assignment.role,
      assignment.engine,
      resolveDisplayModel(assignment.model),
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
      '  1 Planner   2 Worker',
      'Press the number key to cycle model for each role.',
    ];

    return drawBox('Models', lines, viewport.width);
  },
};
