import {
  createGitStrategyState,
  setActiveBranch,
  updatePullRequestFollowUpState,
  updatePullRequestState,
} from '../git-strategy.js';

describe('state/git-strategy', () => {
  it('defaults validation commands to opt-in empty list', () => {
    const state = createGitStrategyState({
      missionId: 'auth',
      baseBranch: 'main',
      autoPush: false,
      preMergeValidation: true,
      validationCommands: [],
      pullRequestEnabled: false,
    });

    expect(state.config.validationCommands).toEqual([]);
  });

  it('tracks the active branch without feature branch lifecycle state', () => {
    let state = createGitStrategyState({
      missionId: 'auth',
      baseBranch: 'main',
      autoPush: false,
      preMergeValidation: true,
      validationCommands: ['npm test'],
      pullRequestEnabled: false,
    });

    state = setActiveBranch(state, 'feature/auth');
    expect(state.activeBranch).toBe('feature/auth');
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
