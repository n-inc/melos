import type { TUIView, MissionControlState, ViewPort } from './tui-views.js';
import { drawBox, drawTable } from './tui-layout.js';

export const workersView: TUIView = {
  id: 'workers',
  render(viewport: ViewPort, state: MissionControlState): string[] {
    const rows = state.workerRuns.slice(-12).map((run) => [
      String(run.id),
      run.type,
      run.featureId ?? run.milestoneId ?? '-',
      run.status,
      run.durationLabel,
      run.model ?? '-',
    ]);

    const table = drawTable(
      ['#', 'Type', 'Target', 'Status', 'Duration', 'Model'],
      rows,
      [3, 10, 22, 10, 10, 18]
    );

    const selected = state.workerRuns[state.workerRuns.length - 1];
    const logLines = selected
      ? [`Worker #${selected.id} log`, ...selected.log.slice(-10)]
      : ['No worker logs'];

    return [
      ...drawBox('Workers', table, viewport.width),
      '',
      ...drawBox('Worker Log', logLines, viewport.width),
    ];
  },
};
