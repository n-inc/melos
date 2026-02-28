import type { MissionControlState, TUIView, ViewPort } from './tui-views.js';
import { drawBox, splitColumns } from './tui-layout.js';

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

export const featuresView: TUIView = {
  id: 'features',
  render(viewport: ViewPort, state: MissionControlState): string[] {
    const left: string[] = [];
    for (const milestone of state.milestones) {
      left.push(`${statusIcon(milestone.status)} ${milestone.id} ${milestone.title}`);
      for (const feature of milestone.features) {
        left.push(`  ${statusIcon(feature.status)} ${feature.id} ${feature.description}`);
      }
      left.push('');
    }

    const activeMilestone = state.milestones.find((milestone) => milestone.id === state.activeMilestoneId) ?? null;
    const activeFeature = activeMilestone?.features.find((feature) => feature.id === state.activeFeatureId) ?? null;

    const right = [
      'Details',
      `Active Milestone: ${activeMilestone ? `${activeMilestone.id} ${activeMilestone.title}` : '-'}`,
      `Active Feature: ${activeFeature ? `${activeFeature.id} ${activeFeature.description}` : '-'}`,
      `Mission State: ${state.missionState}`,
      `Progress: ${state.progressLabel}`,
    ];

    const content = splitColumns(left, right, viewport.width, 0.56);
    return drawBox('Features', content, viewport.width);
  },
};
