import { renderTUIFrameForTest, type SessionInfo } from '../tui.js';
import type { MissionControlState } from '../tui-views.js';

function createSession(): SessionInfo {
  return {
    version: '0.8.0',
    missionId: 'mission',
    missionTitle: 'テキスト統計ユーティリティの追加',
    planner: 'opus',
    worker: 'gpt-5.4',
  };
}

function createState(): MissionControlState {
  return {
    missionId: 'mission',
    missionTitle: 'テキスト統計ユーティリティの追加',
    missionState: 'running',
    activity: 'Running m1-f2...',
    elapsedLabel: '5m 42s',
    progressLabel: '2/4 (50%)',
    progressPercent: 50,
    activeMilestoneId: 'm1',
    activeFeatureId: 'm1-f2',
    activeBranch: 'melos/mission/m1-f2',
    currentActor: 'worker',
    logEntries: [
      { timestamp: '2026-02-28T09:00:00.000Z', actor: 'planning', kind: 'PLAN_CREATED', message: 'milestones=2 features=4' },
      { timestamp: '2026-02-28T09:00:10.000Z', actor: 'worker', kind: 'READ', message: 'src/parser.ts' },
      { timestamp: '2026-02-28T09:00:11.000Z', actor: 'worker', kind: 'BASH', message: 'npm test -- parser' },
    ],
    milestones: [
      {
        id: 'm1',
        title: 'Core',
        status: 'in_progress',
        features: [
          { id: 'm1-f1', description: 'Read files', status: 'done', attempts: 1 },
          { id: 'm1-f2', description: 'Implement parser and CLI options', status: 'in_progress', attempts: 2 },
        ],
        qaChecks: [
          {
            id: 'm1-qa-overview',
            description: 'Capture before screenshot to artifacts/screenshots/m1-qa-overview-before.png before the first repo-tracked file edit, then capture after screenshot to artifacts/screenshots/m1-qa-overview-after.png for the updated parser panel.',
            passed: false,
            failureCount: 0,
            requiredRunner: 'playwright-interactive',
            requiredArtifacts: ['screenshot'],
          },
        ],
      },
      {
        id: 'm2',
        title: 'Validation',
        status: 'pending',
        features: [
          { id: 'm2-f1', description: 'Run validations', status: 'pending', attempts: 0 },
        ],
      },
    ],
    progressLog: [
      { timestamp: '2026-02-28T09:00:00.000Z', message: 'mission run started' },
      { timestamp: '2026-02-28T09:00:05.000Z', message: 'Planning mission...' },
      { timestamp: '2026-02-28T09:00:10.000Z', message: 'worker #1 started' },
    ],
    workerRuns: [
      {
        id: 1,
        type: 'implement',
        featureId: 'm1-f2',
        milestoneId: 'm1',
        status: 'running',
        durationLabel: '1m 12s',
        engine: 'codex',
        model: 'gpt-5.4',
        log: [
          { timestamp: '2026-02-28T09:00:10.000Z', actor: 'worker', kind: 'READ', message: 'src/parser.ts' },
          { timestamp: '2026-02-28T09:00:11.000Z', actor: 'worker', kind: 'BASH', message: 'npm test -- parser' },
        ],
      },
    ],
    modelAssignments: {
      planner: { role: 'planner', engine: 'claude', model: 'opus', effort: 'max' },
      worker: { role: 'worker', engine: 'codex', model: 'gpt-5.4', effort: 'high' },
    },
  };
}

describe('ui/tui visual snapshots', () => {
  it('initializing frame snapshot', () => {
    const frame = renderTUIFrameForTest({
      session: createSession(),
      state: null,
      width: 100,
      height: 30,
      view: 'overview',
    });
    expect(frame.join('\n')).toMatchSnapshot();
  });

  it('overview frame snapshot', () => {
    const frame = renderTUIFrameForTest({
      session: createSession(),
      state: createState(),
      width: 100,
      height: 30,
      view: 'overview',
    });
    expect(frame.join('\n')).toMatchSnapshot();
  });

  it('workers frame snapshot', () => {
    const frame = renderTUIFrameForTest({
      session: createSession(),
      state: createState(),
      width: 100,
      height: 30,
      view: 'workers',
    });
    expect(frame.join('\n')).toMatchSnapshot();
  });

  it('awaiting approval frame snapshot (input required)', () => {
    const frame = renderTUIFrameForTest({
      session: createSession(),
      state: {
        ...createState(),
        missionState: 'awaiting_approval',
        pendingPrompt: '承認待ち: y=承認 / Ctrl+C=中止',
      },
      width: 100,
      height: 30,
      view: 'overview',
    });
    expect(frame.join('\n')).toMatchSnapshot();
  });

  it('narrow terminal snapshot (80x24)', () => {
    const frame = renderTUIFrameForTest({
      session: createSession(),
      state: createState(),
      width: 80,
      height: 24,
      view: 'overview',
    });
    expect(frame.join('\n')).toMatchSnapshot();
  });
});
