import {
  createFeatureBranchName,
  createGitStrategyState,
  registerFeatureBranch,
  updateFeatureBranchStatus,
} from '../git-strategy.js';

describe('state/git-strategy', () => {
  it('creates feature branch names with melos prefix', () => {
    const branch = createFeatureBranchName('auth', 'm1-f1', 'User model + migration');
    expect(branch.startsWith('melos/auth/')).toBe(true);
    expect(branch).toContain('m1-f1-user-model-migration');
  });

  it('tracks branch lifecycle', () => {
    let state = createGitStrategyState({
      missionId: 'auth',
      baseBranch: 'main',
      autoPush: false,
      preMergeValidation: true,
      validationCommands: ['npm test'],
    });

    state = registerFeatureBranch(state, {
      name: 'melos/auth/m1-f1-user-model',
      taskId: 'm1-f1',
      baseCommitHash: 'abc1234',
    });

    expect(state.activeBranch).toBe('melos/auth/m1-f1-user-model');
    expect(state.branches[0]?.status).toBe('active');

    state = updateFeatureBranchStatus(state, 'melos/auth/m1-f1-user-model', 'ready', {
      commitHash: 'def5678',
    });
    expect(state.branches[0]?.status).toBe('ready');
    expect(state.branches[0]?.commits).toContain('def5678');

    state = updateFeatureBranchStatus(state, 'melos/auth/m1-f1-user-model', 'merged');
    expect(state.branches[0]?.status).toBe('merged');
  });
});
