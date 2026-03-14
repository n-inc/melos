import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';

import type { MissionKernelState } from './event-reducer.js';
import type { MissionPlan } from './mission.js';
import { loadMissionPlan } from './mission.js';
import { loadSnapshot } from './snapshot.js';

export interface ReconciledMissionPlanResult {
  missionPlan: MissionPlan | null;
  source: 'snapshot' | 'task' | 'none';
  taskPlan: MissionPlan | null;
  snapshotPlan: MissionPlan | null;
}

export async function loadReconciledMissionPlan(options: {
  missionFilePath: string;
  melosDir: string;
  strictTaskRead?: boolean;
}): Promise<ReconciledMissionPlanResult> {
  const { missionFilePath, melosDir, strictTaskRead = true } = options;

  let taskPlan: MissionPlan | null = null;
  let taskModifiedAt: number | null = null;
  if (existsSync(missionFilePath)) {
    try {
      taskPlan = await loadMissionPlan(missionFilePath);
      taskModifiedAt = (await stat(missionFilePath)).mtimeMs;
    } catch (error) {
      if (strictTaskRead) {
        throw error;
      }
    }
  }

  const snapshot = await loadSnapshot<{ kernel?: MissionKernelState }>(melosDir);
  const snapshotPlan = snapshot?.state?.kernel?.missionPlan ?? null;
  const snapshotSavedAt = parseSnapshotSavedAt(snapshot?.savedAt);

  if (snapshotPlan && shouldPreferSnapshot(snapshotSavedAt, taskModifiedAt)) {
    return {
      missionPlan: snapshotPlan,
      source: 'snapshot',
      taskPlan,
      snapshotPlan,
    };
  }

  if (taskPlan) {
    return {
      missionPlan: taskPlan,
      source: 'task',
      taskPlan,
      snapshotPlan,
    };
  }

  if (snapshotPlan) {
    return {
      missionPlan: snapshotPlan,
      source: 'snapshot',
      taskPlan,
      snapshotPlan,
    };
  }

  return {
    missionPlan: null,
    source: 'none',
    taskPlan: null,
    snapshotPlan: null,
  };
}

function parseSnapshotSavedAt(savedAt: string | undefined): number | null {
  if (!savedAt) {
    return null;
  }
  const parsed = Date.parse(savedAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldPreferSnapshot(snapshotSavedAt: number | null, taskModifiedAt: number | null): boolean {
  if (snapshotSavedAt === null) {
    return false;
  }
  if (taskModifiedAt === null) {
    return true;
  }
  return snapshotSavedAt >= taskModifiedAt;
}
