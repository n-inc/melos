import type { TUIView, MissionControlState, ViewPort } from './tui-views.js';
import { drawBox, drawTable } from './tui-layout.js';

export const workersView: TUIView = {
  id: 'workers',
  render(viewport: ViewPort, state: MissionControlState): string[] {
    const recentRuns = state.workerRuns.slice(-12);
    const rows = recentRuns.map((run) => [
      String(run.id),
      run.type,
      run.featureId ?? run.milestoneId ?? '-',
      run.status,
      run.durationLabel,
      run.engine ? `${run.engine}/${run.model ?? '-'}` : (run.model ?? '-'),
    ]);

    const table = drawTable(
      ['#', 'Type', 'Target', 'Status', 'Duration', 'Engine/Model'],
      rows,
      [3, 10, 22, 10, 10, 28]
    );

    const selected = state.workerRuns[state.workerRuns.length - 1];
    const activeWorkerLines = selected
      ? [
        `#${selected.id} ${selected.status} ${selected.durationLabel}`,
        `Type: ${selected.type}`,
        `Target: ${selected.featureId ?? selected.milestoneId ?? '-'}`,
        `Engine: ${selected.engine ?? '-'}`,
        `Model: ${selected.model ?? '-'}`,
      ]
      : ['No active worker'];

    const maxLogLines = Math.max(8, viewport.height - 16);
    const logLines = selected
      ? selected.log.slice(-maxLogLines)
      : ['No worker logs. Press W while mission is running.'];

    return [
      ...drawBox('Workers', table, viewport.width),
      '',
      ...drawBox('Active Worker', activeWorkerLines, viewport.width),
      '',
      ...drawBox('Worker Log Stream', logLines, viewport.width),
    ];
  },
};
