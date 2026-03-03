import { PassThrough } from 'node:stream';
import { jest } from '@jest/globals';

import { createRuntimeUI, type SessionInfo } from '../tui.js';
import { overviewView } from '../tui-overview.js';
import { featuresView } from '../tui-features.js';
import { workersView } from '../tui-workers.js';
import { modelsView } from '../tui-models.js';
import { prdView } from '../tui-prd.js';
import { taskView } from '../tui-task.js';
import { getDisplayWidth } from '../tui-ansi.js';
import type { MissionControlState, TUIView } from '../tui-views.js';

function createSessionInfo(): SessionInfo {
  return {
    version: '0.8.0',
    missionId: 'mission',
    missionTitle: 'テキスト統計ユーティリティの追加',
    planner: 'opus',
    worker: 'gpt-5.3-codex',
  };
}

function createState(overrides: Partial<MissionControlState> = {}): MissionControlState {
  const base: MissionControlState = {
    missionId: 'mission',
    missionTitle: 'テキスト統計ユーティリティの追加',
    missionState: 'planning',
    activity: 'Planning mission from PRD.md...',
    elapsedLabel: '0m 02s',
    progressLabel: '0/3 (0%)',
    progressPercent: 0,
    activeMilestoneId: 'm1',
    activeFeatureId: 'm1-f1',
    activeBranch: 'melos/mission/m1-f1',
    currentActor: 'worker',
    logEntries: [
      { timestamp: '2026-02-28T09:00:00.000Z', actor: 'planning', kind: 'PLAN_CREATED', message: 'mission run started' },
      { timestamp: '2026-02-28T09:00:01.000Z', actor: 'worker', kind: 'BASH', message: 'npm test -- parser' },
    ],
    milestones: [
      {
        id: 'm1',
        title: 'Core',
        status: 'in_progress',
        order: 1,
        features: [
          { id: 'm1-f1', description: 'Implement parser', status: 'in_progress', attempts: 1 },
          { id: 'm1-f2', description: 'Add tests', status: 'pending', attempts: 0 },
        ],
      },
      {
        id: 'm2',
        title: 'CLI',
        status: 'pending',
        order: 2,
        features: [
          { id: 'm2-f1', description: 'Command options', status: 'pending', attempts: 0 },
        ],
      },
    ],
    progressLog: [
      { timestamp: '2026-02-28T09:00:00.000Z', message: 'mission run started' },
      { timestamp: '2026-02-28T09:00:01.000Z', message: 'Planning mission...' },
    ],
    workerRuns: [
      {
        id: 1,
        type: 'implement',
        featureId: 'm1-f1',
        milestoneId: 'm1',
        status: 'running',
        durationLabel: '0m 35s',
        engine: 'codex',
        model: 'gpt-5.3-codex',
        log: [
          { timestamp: '2026-02-28T09:00:00.000Z', actor: 'worker', kind: 'READ', message: 'src/parser.ts' },
          { timestamp: '2026-02-28T09:00:01.000Z', actor: 'worker', kind: 'BASH', message: 'npm test -- parser' },
        ],
      },
    ],
    modelAssignments: {
      planner: { role: 'planner', engine: 'claude', model: 'opus', effort: 'max' },
      worker: { role: 'worker', engine: 'codex', model: 'gpt-5.3-codex', effort: 'high' },
      validator: { role: 'validator', engine: 'codex', model: 'gpt-5.3-codex', effort: 'high' },
      research: { role: 'research', engine: 'claude', model: 'opus', effort: 'max' },
    },
    tokenUsage: {
      total: { input: 1200, output: 900, cached: 300, cost: 0.02 },
      byRole: {
        planner: { model: 'opus', input: 400, output: 200, cached: 100, cost: 0.01 },
        worker: { model: 'gpt-5.3-codex', input: 800, output: 700, cached: 200, cost: 0.01 },
      },
    },
  };
  return {
    ...base,
    ...overrides,
    activity: overrides.activity ?? base.activity,
  };
}

function createHarness() {
  const output = new PassThrough();
  (output as unknown as { columns?: number }).columns = 100;
  (output as unknown as { rows?: number }).rows = 30;

  let rendered = '';
  output.on('data', (chunk: Buffer | string) => {
    rendered += chunk.toString();
  });

  const input = new PassThrough();
  (input as unknown as { isTTY?: boolean; setRawMode?: (enabled: boolean) => void }).isTTY = true;
  (input as unknown as { setRawMode?: (enabled: boolean) => void }).setRawMode = () => {
    // no-op
  };

  const onPause = jest.fn();
  const onResume = jest.fn();
  const onSteer = jest.fn();
  const onCycleModel = jest.fn();

  const ui = createRuntimeUI(
    'tui',
    output as unknown as NodeJS.WriteStream,
    input as unknown as NodeJS.ReadStream
  );

  return {
    ui,
    input,
    getRendered: () => rendered,
    onPause,
    onResume,
    onSteer,
    onCycleModel,
  };
}

describe('ui/tui contract', () => {
  it('shows initializing view immediately and then overview on first state', () => {
    const h = createHarness();
    h.ui.start(createSessionInfo(), {
      onPause: h.onPause,
      onResume: h.onResume,
      onSteer: h.onSteer,
      onCycleModel: h.onCycleModel,
    });
    expect(h.getRendered()).toContain('INITIALIZING');
    expect(h.getRendered()).toContain('Waiting for first status update from orchestrator');

    h.ui.updateState(createState());
    h.ui.stop();

    const rendered = h.getRendered();
    expect(rendered).toContain('Overview');
    expect(rendered).not.toContain('NOW RUNNING  WORKER');
  });

  it('supports full view navigation contract (Tab/Shift+Tab/F/W/M/D/T/Esc)', () => {
    const h = createHarness();
    h.ui.start(createSessionInfo(), {
      onPause: h.onPause,
      onResume: h.onResume,
      onSteer: h.onSteer,
      onCycleModel: h.onCycleModel,
    });
    h.ui.updateState(createState());

    h.input.write('\t');
    expect(h.getRendered()).toContain('Features');

    h.input.write('\t');
    expect(h.getRendered()).toContain('NOW RUNNING');

    h.input.write('\u001b[Z');
    expect(h.getRendered()).toContain('Features');

    h.input.write('W');
    expect(h.getRendered()).toContain('NOW RUNNING');

    h.input.write('M');
    expect(h.getRendered()).toContain('Models');

    h.input.write('D');
    expect(h.getRendered()).toContain('PRD');

    h.input.write('T');
    expect(h.getRendered()).toContain('TASK');

    h.input.write('\u001b');
    h.ui.stop();

    expect(h.getRendered()).toContain('Overview');
  });

  it('ignores view keys before first state update', () => {
    const h = createHarness();
    h.ui.start(createSessionInfo(), {
      onPause: h.onPause,
      onResume: h.onResume,
      onSteer: h.onSteer,
      onCycleModel: h.onCycleModel,
    });
    expect(h.getRendered()).toContain('INITIALIZING');

    h.input.write('D');
    h.input.write('W');
    h.ui.updateState(createState());
    h.ui.stop();

    expect(h.getRendered()).toContain('Overview');
    expect(h.getRendered()).not.toContain('NOW RUNNING  WORKER');
  });

  it('shows worker logs only in workers view', () => {
    const h = createHarness();
    h.ui.start(createSessionInfo());
    h.ui.updateState(createState());
    expect(h.getRendered()).not.toContain('NOW RUNNING  WORKER');

    h.input.write('W');
    h.ui.stop();
    expect(h.getRendered()).toContain('NOW RUNNING  WORKER');
    expect(h.getRendered()).toContain('[BASH] npm test -- parser');
  });

  it('routes runtime log updates to the correct view sections', () => {
    const h = createHarness();
    h.ui.start(createSessionInfo());
    h.ui.updateState(createState({
      progressLog: [
        { timestamp: '2026-02-28T09:00:00.000Z', message: 'progress only marker' },
      ],
      logEntries: [
        { timestamp: '2026-02-28T09:00:00.000Z', actor: 'worker', kind: 'INFO', message: 'worker-only-log-marker' },
      ],
      workerRuns: [
        {
          id: 1,
          type: 'implement',
          featureId: 'm1-f1',
          milestoneId: 'm1',
          status: 'running',
          durationLabel: '0m 35s',
          engine: 'codex',
          model: 'gpt-5.3-codex',
          log: [{ timestamp: '2026-02-28T09:00:00.000Z', actor: 'worker', kind: 'INFO', message: 'worker-only-log-marker' }],
        },
      ],
    }));
    expect(h.getRendered()).toContain('progress only marker');
    expect(h.getRendered()).not.toContain('worker-only-log-marker');

    h.input.write('W');
    h.ui.stop();

    expect(h.getRendered()).toContain('worker-only-log-marker');
  });

  it('keeps showing overview while worker log grows, until W is pressed', () => {
    const h = createHarness();
    h.ui.start(createSessionInfo());
    h.ui.updateState(createState({
      workerRuns: [
        {
          id: 1,
          type: 'implement',
          featureId: 'm1-f1',
          milestoneId: 'm1',
          status: 'running',
          durationLabel: '0m 35s',
          engine: 'codex',
          model: 'gpt-5.3-codex',
          log: [{ timestamp: '2026-02-28T09:00:00.000Z', actor: 'worker', kind: 'INFO', message: 'worker-log-v1' }],
        },
      ],
      logEntries: [{ timestamp: '2026-02-28T09:00:00.000Z', actor: 'worker', kind: 'INFO', message: 'worker-log-v1' }],
    }));
    expect(h.getRendered()).not.toContain('worker-log-v1');

    h.ui.updateState(createState({
      workerRuns: [
        {
          id: 1,
          type: 'implement',
          featureId: 'm1-f1',
          milestoneId: 'm1',
          status: 'running',
          durationLabel: '0m 40s',
          engine: 'codex',
          model: 'gpt-5.3-codex',
          log: [
            { timestamp: '2026-02-28T09:00:00.000Z', actor: 'worker', kind: 'INFO', message: 'worker-log-v1' },
            { timestamp: '2026-02-28T09:00:02.000Z', actor: 'worker', kind: 'INFO', message: 'worker-log-v2' },
          ],
        },
      ],
      logEntries: [
        { timestamp: '2026-02-28T09:00:00.000Z', actor: 'worker', kind: 'INFO', message: 'worker-log-v1' },
        { timestamp: '2026-02-28T09:00:02.000Z', actor: 'worker', kind: 'INFO', message: 'worker-log-v2' },
      ],
    }));
    expect(h.getRendered()).not.toContain('worker-log-v2');

    h.input.write('W');
    h.ui.stop();

    expect(h.getRendered()).toContain('worker-log-v2');
  });

  it('pending input allows PRD/TASK navigation and model switching, but blocks run controls', () => {
    const h = createHarness();
    h.ui.start(createSessionInfo(), {
      onPause: h.onPause,
      onResume: h.onResume,
      onSteer: h.onSteer,
      onCycleModel: h.onCycleModel,
    });
    h.ui.updateState(createState());

    h.input.write('D');
    expect(h.getRendered()).toContain('PRD');

    h.ui.updateState(createState({
      missionState: 'awaiting_approval',
      pendingPrompt: '承認待ち: y=承認 / Ctrl+C=中止',
    }));
    expect(h.getRendered()).toContain('Overview');
    expect(h.getRendered()).toContain('入力待ち');
    expect(h.getRendered()).toContain('[INPUT] 承認待ち: y=承認 / Ctrl+C=中止');

    h.input.write('M');
    expect(h.getRendered()).toContain('Models');

    h.input.write('2');
    h.input.write('T');
    expect(h.getRendered()).toContain('TASK');
    h.input.write('\t');
    h.input.write('W');
    h.input.write('p');
    h.input.write('r');
    h.ui.stop();

    expect(h.getRendered()).not.toContain('NOW RUNNING  WORKER');
    expect(h.onPause).not.toHaveBeenCalled();
    expect(h.onResume).not.toHaveBeenCalled();
    expect(h.onCycleModel).toHaveBeenCalledWith('worker');
  });

  it('cycles models from models view with number keys', () => {
    const h = createHarness();
    h.ui.start(createSessionInfo(), {
      onCycleModel: h.onCycleModel,
    });
    h.ui.updateState(createState());

    h.input.write('M');
    h.input.write('1');
    h.input.write('2');
    h.input.write('3');
    h.input.write('4');
    h.ui.stop();

    expect(h.onCycleModel).toHaveBeenNthCalledWith(1, 'planner');
    expect(h.onCycleModel).toHaveBeenNthCalledWith(2, 'worker');
    expect(h.onCycleModel).toHaveBeenNthCalledWith(3, 'validator');
    expect(h.onCycleModel).toHaveBeenNthCalledWith(4, 'research');
  });

  it('cancels steer mode when pending prompt starts', () => {
    const h = createHarness();
    h.ui.start(createSessionInfo(), {
      onSteer: h.onSteer,
    });
    h.ui.updateState(createState());

    h.input.write('\u0007');
    h.input.write('skip m1-f1');
    expect(h.getRendered()).toContain('[STEER MODE]');

    h.ui.updateState(createState({
      missionState: 'awaiting_approval',
      pendingPrompt: '承認待ち: y=承認 / Ctrl+C=中止',
    }));

    const rendered = h.getRendered();
    expect(rendered).toContain('入力待ち  承認待ち: y=承認 / Ctrl+C=中止');
    expect(rendered.lastIndexOf('入力待ち')).toBeGreaterThan(rendered.lastIndexOf('[STEER MODE]'));

    h.input.write('\n');
    h.ui.stop();
    expect(h.onSteer).not.toHaveBeenCalled();
  });

  it('supports steer, pause/resume, and ctrl+c in normal mode', () => {
    const h = createHarness();
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    h.ui.start(createSessionInfo(), {
      onPause: h.onPause,
      onResume: h.onResume,
      onSteer: h.onSteer,
    });
    h.ui.updateState(createState());

    h.input.write('p');
    h.input.write('r');
    h.input.write('\u0007');
    h.input.write('skip m1-f1');
    h.input.write('\n');
    h.input.write('\u0003');
    h.ui.stop();

    expect(h.onPause).toHaveBeenCalledTimes(1);
    expect(h.onResume).toHaveBeenCalledTimes(1);
    expect(h.onSteer).toHaveBeenCalledWith('skip m1-f1');
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT');
    killSpy.mockRestore();
  });
});

describe('ui/view layout contract', () => {
  const views: TUIView[] = [overviewView, featuresView, workersView, modelsView, prdView, taskView];
  it('keeps every rendered line within viewport width (80x24)', () => {
    const state = createState();
    for (const view of views) {
      const lines = view.render({ width: 80, height: 24 }, state);
      for (const line of lines) {
        expect(getDisplayWidth(line)).toBeLessThanOrEqual(80);
      }
    }
  });
});
