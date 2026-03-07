import type { TUIView, MissionControlState, ViewPort } from './tui-views.js';
import { splitColumns, drawBox } from './tui-layout.js';
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

function qaStatusIcon(passed: boolean, failureCount: number): string {
  if (passed) {
    return '✓';
  }
  if (failureCount > 0) {
    return '✗';
  }
  return '○';
}

export const overviewView: TUIView = {
  id: 'overview',
  render(viewport: ViewPort, state: MissionControlState): string[] {
    const activeMilestone = state.milestones.find((milestone) => milestone.id === state.activeMilestoneId) ?? null;
    const activeFeature = activeMilestone?.features.find((feature) => feature.id === state.activeFeatureId) ?? null;
    const activeQaChecks = activeMilestone?.qaChecks ?? [];
    const activeFeatureLabel = activeFeature
      ? `${activeFeature.id} ${activeFeature.description}`
      : '-';

    const summaryLine = (label: string, value: string): string => `${label.padEnd(10, ' ')} ${value}`;

    const expectedBehaviorLines = activeFeature
      ? wrapByCharCount(activeFeature.description, 42)
      : ['-'];
    const reviewSummaryLines = state.reviewStatus
      ? [
        summaryLine('Review', `${state.reviewStatus.reviewType} g${state.reviewStatus.generation}`),
        summaryLine('Findings', `${state.reviewStatus.blockingFindingCount}/${state.reviewStatus.latestFindingCount} blocking/total`),
        summaryLine('Review OK', state.reviewStatus.passed === null ? '-' : state.reviewStatus.passed ? 'yes' : 'no'),
      ]
      : [];
    const leftLines = [
      'MISSION SUMMARY',
      `${statusIcon(activeFeature?.status ?? 'pending')} ${activeFeatureLabel}`,
      '',
      summaryLine('Milestone', activeMilestone ? `${activeMilestone.id} ${activeMilestone.title}` : '-'),
      summaryLine('State', state.missionState),
      summaryLine('Activity', state.activity),
      summaryLine('Progress', state.progressLabel),
      summaryLine('Branch', state.activeBranch ?? '-'),
      ...reviewSummaryLines,
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
    const progressLines = selectRecentProgressEntries(state.progressLog, maxProgressRows)
      .map((entry) => `${entry.timestamp.slice(11, 19)} ${entry.message}`);
    if (progressLines.length === 0) {
      progressLines.push(state.activity || 'No events yet');
    }

    const qaPassed = activeQaChecks.filter((check) => check.passed).length;
    const qaFailed = activeQaChecks.filter((check) => !check.passed && check.failureCount > 0).length;
    const qaPending = activeQaChecks.length - qaPassed - qaFailed;
    const qaLines = activeQaChecks.length > 0
      ? [
        'QA CHECKS',
        `Summary: ${qaPassed}/${activeQaChecks.length} passed, ${qaFailed} failed, ${qaPending} pending`,
        ...activeQaChecks.slice(0, 3).map((check) => `${qaStatusIcon(check.passed, check.failureCount)} ${check.id} ${check.description}`),
        ...(activeQaChecks.length > 3 ? [`... +${activeQaChecks.length - 3} more`] : []),
        '',
      ]
      : [];

    const logModeLine = state.missionState === 'awaiting_approval'
      ? 'Approval pending (press y to start)'
      : state.missionState === 'running'
        ? 'Detailed logs are available in Logs view (W)'
        : 'Recent mission events';

    const rightLines = [
      'FEATURES',
      ...(featureLines.length > 0 ? featureLines : ['-']),
      '',
      ...qaLines,
      'RECENT EVENTS',
      logModeLine,
      ...progressLines,
    ];

    const main = splitColumns(leftLines, rightLines, viewport.width, 0.57);

    return drawBox('Overview', main, viewport.width);
  },
};
