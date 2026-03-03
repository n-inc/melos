import type { TUIView, MissionControlState, ViewPort } from './tui-views.js';
import { splitColumns, drawBox } from './tui-layout.js';

function statusIcon(status: string): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'in_progress':
      return '●';
    case 'failed':
      return '✗';
    case 'skipped':
      return '⦿';
    default:
      return '○';
  }
}

function wrapByCharCount(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const out: string[] = [];
  for (let index = 0; index < text.length; index += maxChars) {
    out.push(text.slice(index, index + maxChars));
  }
  return out;
}

export const overviewView: TUIView = {
  id: 'overview',
  render(viewport: ViewPort, state: MissionControlState): string[] {
    const activeMilestone = state.milestones.find((milestone) => milestone.id === state.activeMilestoneId) ?? null;
    const activeFeature = activeMilestone?.features.find((feature) => feature.id === state.activeFeatureId) ?? null;
    const activeFeatureLabel = activeFeature
      ? `${activeFeature.id} ${activeFeature.description}`
      : '-';

    const expectedBehaviorLines = activeFeature
      ? wrapByCharCount(activeFeature.description, 42)
      : ['-'];
    const leftLines = [
      'Active Feature',
      `${statusIcon(activeFeature?.status ?? 'pending')} ${activeFeatureLabel}`,
      '',
      `Milestone: ${activeMilestone ? `${activeMilestone.id} ${activeMilestone.title}` : '-'}`,
      `State: ${state.missionState}`,
      `Activity: ${state.activity}`,
      `Progress: ${state.progressLabel}`,
      `Branch: ${state.activeBranch ?? '-'}`,
      '',
      'Expected Behavior',
      ...expectedBehaviorLines.map((line) => `  ${line}`),
    ];

    const maxFeatureRows = Math.max(4, Math.min(6, viewport.height - 16));
    const featureLines = state.milestones.flatMap((milestone) => {
      const rows: string[] = [];
      rows.push(`${statusIcon(milestone.status)} ${milestone.id} ${milestone.title}`);
      for (const feature of milestone.features) {
        const marker = feature.id === state.activeFeatureId ? '>' : ' ';
        rows.push(`${marker}${statusIcon(feature.status)} ${feature.id} ${feature.description}`);
      }
      return rows;
    }).slice(-maxFeatureRows);

    const maxProgressRows = Math.max(3, Math.min(7, viewport.height - 17));
    const progressLines = state.progressLog
      .slice(-maxProgressRows)
      .map((entry) => `${entry.timestamp.slice(11, 19)} ${entry.message}`);
    if (progressLines.length === 0) {
      progressLines.push(state.activity || 'No events yet');
    }

    const rightLines = [
      'Features',
      ...(featureLines.length > 0 ? featureLines : ['-']),
      '',
      'Progress Log (mission events)',
      ...progressLines,
    ];

    const main = splitColumns(leftLines, rightLines, viewport.width, 0.57);

    return drawBox('Overview', main, viewport.width);
  },
};
