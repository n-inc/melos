import {
  createMissionBranchName,
  createFeatureBranchName,
  createGitStrategyState,
  registerFeatureBranch,
  updatePullRequestFollowUpState,
  updatePullRequestState,
  updateFeatureBranchStatus,
} from '../git-strategy.js';

describe('state/git-strategy', () => {
  it('creates feature branch names with melos prefix', () => {
    const branch = createFeatureBranchName('auth', 'm1-f1', 'User model + migration');
    expect(branch.startsWith('melos/auth/')).toBe(true);
    expect(branch).toContain('m1-f1-user-model-migration');
  });

  it('creates safe branch names even when feature description is missing', () => {
    const branch = createFeatureBranchName(
      'auth',
      'm1-f1',
      undefined as unknown as string
    );
    expect(branch).toBe('melos/auth/m1-f1-no-description');
  });

  it('creates mission branch names with a dedicated suffix', () => {
    expect(createMissionBranchName('auth')).toBe('melos/auth/mission');
  });

  it('tracks branch lifecycle', () => {
    let state = createGitStrategyState({
      missionId: 'auth',
      baseBranch: 'main',
      autoPush: false,
      preMergeValidation: true,
      validationCommands: ['npm test'],
      pullRequestEnabled: false,
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

  it('stores pull request metadata and follow-up progress', () => {
    let state = createGitStrategyState({
      missionId: 'auth',
      baseBranch: 'main',
      autoPush: false,
      preMergeValidation: true,
      validationCommands: ['npm test'],
      pullRequestEnabled: true,
    });

    state = updatePullRequestState(state, {
      number: 42,
      url: 'https://github.com/example/repo/pull/42',
      title: 'feat: auth',
      baseBranch: 'main',
      headBranch: 'melos/auth/mission',
      draft: false,
      action: 'created',
    });
    state = updatePullRequestFollowUpState(state, {
      handledFeedbackIds: ['PRRC_1', 'PRRC_2', 'PRRC_1'],
      lastExternalActivityAt: '2026-03-07T00:00:00.000Z',
      quietUntil: '2026-03-07T00:30:00.000Z',
    });

    expect(state.pullRequest).toMatchObject({
      number: 42,
      url: 'https://github.com/example/repo/pull/42',
      action: 'created',
    });
    expect(state.handledFeedbackIds).toEqual(['PRRC_1', 'PRRC_2']);
    expect(state.quietUntil).toBe('2026-03-07T00:30:00.000Z');
  });
});
