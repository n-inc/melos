import { resolve } from 'node:path';
import type { Feature, MissionPlan } from './mission.js';

type ExecutionCwdInputs = {
  feature: Pick<Feature, 'cwd' | 'kind'>;
  missionPlan?: Pick<MissionPlan, 'productReviewContract'>;
};

export function resolveFeatureExecutionCwd(
  repoCwd: string,
  input: ExecutionCwdInputs
): string {
  if (typeof input.feature.cwd === 'string' && input.feature.cwd.trim().length > 0) {
    return resolve(repoCwd, input.feature.cwd);
  }

  if (input.feature.kind === 'review') {
    const reviewCwd = input.missionPlan?.productReviewContract?.cwd;
    if (typeof reviewCwd === 'string' && reviewCwd.trim().length > 0) {
      return resolve(repoCwd, reviewCwd);
    }
  }

  return repoCwd;
}
