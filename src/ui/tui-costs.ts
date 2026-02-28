import type { MissionControlState, TUIView, ViewPort } from './tui-views.js';
import { drawBox, drawTable } from './tui-layout.js';

export const costsView: TUIView = {
  id: 'costs',
  render(viewport: ViewPort, state: MissionControlState): string[] {
    const byRoleRows = Object.entries(state.tokenUsage.byRole).map(([role, usage]) => [
      role,
      String(usage.input),
      String(usage.output),
      String(usage.cached),
      `$${usage.cost.toFixed(4)}`,
    ]);

    const table = drawTable(
      ['Role', 'Input', 'Output', 'Cached', 'Cost'],
      byRoleRows,
      [12, 10, 10, 10, 10]
    );

    const total = state.tokenUsage.total;
    const footer = [
      `Total input: ${total.input}`,
      `Total output: ${total.output}`,
      `Total cached: ${total.cached}`,
      `Estimated cost: $${total.cost.toFixed(4)}`,
    ];

    return [
      ...drawBox('Costs', table, viewport.width),
      '',
      ...drawBox('Total', footer, viewport.width),
    ];
  },
};
