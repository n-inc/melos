import type { TUIView, MissionControlState, ViewPort } from './tui-views.js';
import { splitColumns, drawBox } from './tui-layout.js';

export const overviewView: TUIView = {
  id: 'overview',
  render(viewport: ViewPort, state: MissionControlState): string[] {
    const activeMilestone = state.milestones.find((milestone) => milestone.id === state.activeMilestoneId) ?? null;
    const activeFeature = activeMilestone?.features.find((feature) => feature.id === state.activeFeatureId) ?? null;
    const latestWorker = state.workerRuns[state.workerRuns.length - 1];

    const leftLines = [
      `Mission: ${state.missionTitle}`,
      `State: ${state.missionState}`,
      `Progress: ${state.progressLabel}`,
      `Milestone: ${activeMilestone ? `${activeMilestone.id} ${activeMilestone.title}` : '-'}`,
      `Feature: ${activeFeature ? `${activeFeature.id} ${activeFeature.description}` : '-'}`,
      `Branch: ${state.activeBranch ?? '-'}`,
    ];

    const rightLines = [
      'Recent Log',
      ...state.progressLog.slice(-8).map((entry) => `${entry.timestamp.slice(11, 19)} ${entry.message}`),
    ];

    const main = splitColumns(leftLines, rightLines, viewport.width, 0.5);

    const workerLines = latestWorker
      ? [
        `Worker #${latestWorker.id} ${latestWorker.status} ${latestWorker.durationLabel}`,
        ...latestWorker.log.slice(-5),
      ]
      : ['No worker run yet'];

    const boxed = drawBox('Overview', main, viewport.width);
    const workerBox = drawBox('Active Worker', workerLines, viewport.width);
    return [...boxed, '', ...workerBox];
  },
};
