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
        const modelBadge = feature.requestedModel
          ? `R:${feature.effectiveModel ?? feature.requestedModel}`
          : feature.modelStateSource === 'effective'
            ? `D:${feature.effectiveModel ?? '-'}`
            : `U:${feature.effectiveModel ?? '-'}`;
        left.push(`  ${statusIcon(feature.status)} ${feature.id} [${modelBadge}] ${feature.description}`);
      }
      left.push('');
    }

    const activeMilestone = state.milestones.find((milestone) => milestone.id === state.activeMilestoneId) ?? null;
    const activeFeature = activeMilestone?.features.find((feature) => feature.id === state.activeFeatureId) ?? null;
    const recentLogLines = state.progressLog
      .slice(-6)
      .map((entry) => `${entry.timestamp.slice(11, 19)} ${entry.message}`);
    if (recentLogLines.length === 0) {
      recentLogLines.push(state.activity || 'No mission events yet');
    }

    const logModeLine = state.missionState === 'awaiting_approval'
      ? 'Log mode: history only (awaiting approval: press y)'
      : state.missionState === 'running'
        ? 'Log mode: worker stream in Workers view (W)'
        : 'Log mode: mission event history';

    const right = [
      'Details',
      `Active Milestone: ${activeMilestone ? `${activeMilestone.id} ${activeMilestone.title}` : '-'}`,
      `Active Feature: ${activeFeature ? `${activeFeature.id} ${activeFeature.description}` : '-'}`,
      `Requested Model: ${activeFeature?.requestedModel ?? '-'}`,
      `Effective Model: ${activeFeature ? `${activeFeature.effectiveModel ?? '-'} (source=${activeFeature.modelStateSource ?? 'default'})` : '-'}`,
      `Mission State: ${state.missionState}`,
      `Activity: ${state.activity}`,
      `Progress: ${state.progressLabel}`,
      '',
      'Recent Log (events)',
      logModeLine,
      ...recentLogLines,
      '',
      'Model badges: R=requested, U=unset, D=auto/defaulted',
      'Feature model keys: C=codex A=claude U=unset(active feature)',
      '',
      'Hint: Worker execution log is in Workers view (W).',
    ];

    const content = splitColumns(left, right, viewport.width, 0.56);
    return drawBox('Features', content, viewport.width);
  },
};
