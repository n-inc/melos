import type { MissionControlState, TUIView, ViewPort } from './tui-views.js';
import { drawBox, splitColumns } from './tui-layout.js';
import { resolveDisplayModel } from '../models/registry.js';
import { selectRecentProgressEntries } from './tui-progress.js';

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

function qaStatusIcon(passed: boolean, failureCount: number): string {
  if (passed) {
    return '✓';
  }
  if (failureCount > 0) {
    return '✗';
  }
  return '○';
}

export const featuresView: TUIView = {
  id: 'features',
  render(viewport: ViewPort, state: MissionControlState): string[] {
    const left: string[] = [];
    for (const milestone of state.milestones) {
      left.push(`${statusIcon(milestone.status)} ${milestone.id} ${milestone.title}`);
      for (const feature of milestone.features) {
        const modelBadge = feature.model
          ? `${feature.modelStateSource === 'default' ? 'D' : 'E'}:${resolveDisplayModel(feature.model)}`
          : 'U:-';
        left.push(`  ${statusIcon(feature.status)} ${feature.id} [${modelBadge}] ${feature.description}`);
      }
      left.push('');
    }

    const activeMilestone = state.milestones.find((milestone) => milestone.id === state.activeMilestoneId) ?? null;
    const activeFeature = activeMilestone?.features.find((feature) => feature.id === state.activeFeatureId) ?? null;
    const activeQaChecks = activeMilestone?.qaChecks ?? [];
    const qaPassed = activeQaChecks.filter((check) => check.passed).length;
    const qaFailed = activeQaChecks.filter((check) => !check.passed && check.failureCount > 0).length;
    const qaPending = activeQaChecks.length - qaPassed - qaFailed;
    const recentLogLines = selectRecentProgressEntries(state.progressLog, 6)
      .map((entry) => `${entry.timestamp.slice(11, 19)} ${entry.message}`);
    if (recentLogLines.length === 0) {
      recentLogLines.push(state.activity || 'No mission events yet');
    }

    const logModeLine = state.missionState === 'awaiting_approval'
      ? 'Log mode: history only (awaiting approval: press y)'
      : state.missionState === 'running'
        ? 'Log mode: worker stream in Workers view (W)'
        : 'Log mode: mission event history';

    const qaLines = activeQaChecks.length > 0
      ? activeQaChecks.flatMap((check) => {
        const runner = check.requiredRunner ?? '-';
        const artifacts = check.requiredArtifacts?.join('/') ?? '-';
        return [
          `${qaStatusIcon(check.passed, check.failureCount)} ${check.id} ${check.description}`,
          `   runner=${runner} artifacts=${artifacts}`,
        ];
      })
      : ['-'];

    const right = [
      'Details',
      `Active Milestone: ${activeMilestone ? `${activeMilestone.id} ${activeMilestone.title}` : '-'}`,
      `Active Feature: ${activeFeature ? `${activeFeature.id} ${activeFeature.description}` : '-'}`,
      `Model: ${activeFeature?.model ? resolveDisplayModel(activeFeature.model) : '-'}`,
      `Model Source: ${activeFeature?.modelStateSource ?? 'default'}`,
      `QA Summary: ${activeQaChecks.length > 0 ? `${qaPassed}/${activeQaChecks.length} passed, ${qaFailed} failed, ${qaPending} pending` : '-'}`,
      `Mission State: ${state.missionState}`,
      `Activity: ${state.activity}`,
      `Progress: ${state.progressLabel}`,
      '',
      'QA Checks',
      ...qaLines,
      '',
      'Recent Log (events)',
      logModeLine,
      ...recentLogLines,
      '',
      'Model badges: E=explicit, D=defaulted, U=unset',
      'Feature model keys: C=gpt-5.4 [Latest] A=claude-opus-4.6 [Latest] U=unset(active feature)',
      '',
      'Hint: Worker execution log is in Workers view (W).',
    ];

    const content = splitColumns(left, right, viewport.width, 0.56);
    return drawBox('Features', content, viewport.width);
  },
};
