import { PassThrough } from 'node:stream';
import { jest } from '@jest/globals';

import {
  createRuntimeUI,
  resolveRuntimeUIMode,
  shouldUseTUI,
  type SessionInfo,
} from '../tui.js';
import type { MissionControlState } from '../tui-views.js';

function createSessionInfo(): SessionInfo {
  return {
    version: '0.8.0',
    missionId: 'auth',
    missionTitle: 'Auth system',
    planner: 'opus',
    worker: 'gpt-5.4',
  };
}

function createState(): MissionControlState {
  return {
    missionId: 'auth',
    missionTitle: 'Auth system',
    missionState: 'running',
    activity: 'Running m1-f1...',
    elapsedLabel: '1m 30s',
    progressLabel: '1/3 (33%)',
    progressPercent: 33,
    activeMilestoneId: 'm1',
    activeFeatureId: 'm1-f1',
    activeBranch: 'melos/auth/m1-f1',
    currentActor: 'worker',
    logEntries: [
      { timestamp: new Date().toISOString(), actor: 'worker', kind: 'READ', message: 'src/a.ts' },
    ],
    milestones: [
      {
        id: 'm1',
        title: 'Core',
        status: 'in_progress',
        features: [
          { id: 'm1-f1', description: 'feature', status: 'in_progress', attempts: 1 },
        ],
      },
    ],
    progressLog: [{ timestamp: new Date().toISOString(), message: 'started' }],
    workerRuns: [
      {
        id: 1,
        type: 'implement',
        featureId: 'm1-f1',
        milestoneId: 'm1',
        status: 'running',
        durationLabel: '0m 10s',
        engine: 'codex',
        model: 'gpt-5.4',
        log: [{ timestamp: new Date().toISOString(), actor: 'worker', kind: 'READ', message: 'src/a.ts' }],
      },
    ],
    modelAssignments: {
      planner: { role: 'planner', engine: 'claude', model: 'opus', effort: 'max' },
      worker: { role: 'worker', engine: 'codex', model: 'gpt-5.4', effort: 'xhigh' },
      validator: { role: 'validator', engine: 'codex', model: 'gpt-5.4', effort: 'xhigh' },
      research: { role: 'research', engine: 'claude', model: 'opus', effort: 'max' },
    },
  };
}

describe('ui/tui v0.8', () => {
  it('detects tui availability from terminal capability', () => {
    expect(shouldUseTUI({ plain: false }, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
    })).toBe(true);

    expect(shouldUseTUI({ plain: true }, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
    })).toBe(false);
  });

  it('resolves runtime mode', () => {
    expect(resolveRuntimeUIMode({ headless: true }, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
    })).toBe('headless');

    expect(resolveRuntimeUIMode({ plain: false }, {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      stderrIsTTY: true,
    })).toBe('tui');

    expect(resolveRuntimeUIMode({ plain: false }, {
      stdinIsTTY: false,
      stdoutIsTTY: true,
      stderrIsTTY: true,
    })).toBe('plain');
  });

  it('renders frame and exits alternate screen', () => {
    const output = new PassThrough();
    (output as unknown as { columns?: number }).columns = 100;
    (output as unknown as { rows?: number }).rows = 30;

    let rendered = '';
    output.on('data', (chunk: Buffer | string) => {
      rendered += chunk.toString();
    });

    const input = new PassThrough();
    (input as unknown as { isTTY?: boolean }).isTTY = false;

    const ui = createRuntimeUI('tui', output as unknown as NodeJS.WriteStream, input as unknown as NodeJS.ReadStream);
    ui.start(createSessionInfo());
    ui.updateState(createState());
    ui.stop();

    expect(rendered).toContain('\x1b[?1049h');
    expect(rendered).toContain('\x1b[?1049l');
    expect(rendered).toContain('Mission Control');
    expect(rendered).toContain('Tab Next  Shift+Tab Prev  F/W/M/D/T View  P Pause  R Resume  Ctrl+G Steer  Esc Overview');
    expect(rendered).toContain('Overview');
    expect(rendered).not.toContain('SWITCH:');
    expect(rendered).toContain('melos> Running m1-f1...  (Ctrl+G steer)');
  });

  it('keeps silent output in headless runtime mode', () => {
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk: Buffer | string) => {
      rendered += chunk.toString();
    });

    const input = new PassThrough();
    const ui = createRuntimeUI('headless', output as unknown as NodeJS.WriteStream, input as unknown as NodeJS.ReadStream);
    ui.start(createSessionInfo());
    ui.updateState(createState());
    ui.stop();

    expect(rendered).toBe('');
  });

  it('appends only new log entries in plain runtime mode', () => {
    const output = new PassThrough();
    let rendered = '';
    output.on('data', (chunk: Buffer | string) => {
      rendered += chunk.toString();
    });

    const input = new PassThrough();
    const ui = createRuntimeUI('plain', output as unknown as NodeJS.WriteStream, input as unknown as NodeJS.ReadStream);
    ui.start(createSessionInfo());

    ui.updateState({
      ...createState(),
      logEntries: [
        {
          seq: 1,
          timestamp: '2026-03-03T00:00:00.000Z',
          actor: 'planning',
          kind: 'WRITE',
          message: 'src/auth.ts (+1 -1)',
          detailLines: ['@@ -1,3 +1,3 @@', '-const oldMode = true;', '+const newMode = true;'],
        },
      ],
      currentActor: 'planning',
    });

    ui.updateState({
      ...createState(),
      logEntries: [
        {
          seq: 1,
          timestamp: '2026-03-03T00:00:00.000Z',
          actor: 'planning',
          kind: 'WRITE',
          message: 'src/auth.ts (+1 -1)',
          detailLines: ['@@ -1,3 +1,3 @@', '-const oldMode = true;', '+const newMode = true;'],
        },
        {
          seq: 2,
          timestamp: '2026-03-03T00:00:02.000Z',
          actor: 'worker',
          kind: 'BASH',
          message: 'npm test -- auth',
        },
      ],
      currentActor: 'worker',
      activity: 'Running m1-f1 tests...',
    });

    ui.stop();

    expect(rendered).toContain('[melos] Auth system');
    expect(rendered).toContain('state=running progress=1/3 (33%) active=m1-f1 branch=melos/auth/m1-f1 actor=planning');
    expect(rendered).toContain('LOG START: PLANNING');
    expect(rendered).toContain('[WRITE] src/auth.ts (+1 -1)');
    expect(rendered).toContain('│ @@ -1,3 +1,3 @@');
    expect(rendered).toContain('SWITCH: PLANNING -> WORKER');
    expect(rendered).toContain('[BASH] npm test -- auth');
    expect(rendered.match(/src\/auth\.ts \(\+1 -1\)/g)).toHaveLength(1);
  });

  it('pauses stdin stream on stop to avoid hanging process', () => {
    const output = new PassThrough();
    (output as unknown as { columns?: number }).columns = 100;
    (output as unknown as { rows?: number }).rows = 30;

    const input = new PassThrough();
    (input as unknown as { isTTY?: boolean; setRawMode?: (enabled: boolean) => void }).isTTY = true;
    (input as unknown as { setRawMode?: (enabled: boolean) => void }).setRawMode = () => {
      // no-op
    };
    const pauseSpy = jest.spyOn(input, 'pause');

    const ui = createRuntimeUI('tui', output as unknown as NodeJS.WriteStream, input as unknown as NodeJS.ReadStream);
    ui.start(createSessionInfo());
    ui.updateState(createState());
    ui.stop();

    expect(pauseSpy).toHaveBeenCalled();
    pauseSpy.mockRestore();
  });

  it('renders explicit initializing frame before first state update', () => {
    const output = new PassThrough();
    (output as unknown as { columns?: number }).columns = 100;
    (output as unknown as { rows?: number }).rows = 30;

    let rendered = '';
    output.on('data', (chunk: Buffer | string) => {
      rendered += chunk.toString();
    });

    const input = new PassThrough();
    (input as unknown as { isTTY?: boolean }).isTTY = false;

    const ui = createRuntimeUI('tui', output as unknown as NodeJS.WriteStream, input as unknown as NodeJS.ReadStream);
    ui.start(createSessionInfo());
    ui.stop();

    expect(rendered).toContain('INITIALIZING');
    expect(rendered).toContain('Waiting for first status update from orchestrator');
    expect(rendered).toContain('Ctrl+C Abort');
  });

  it('forwards key actions to runtime controls (pause/resume/steer)', () => {
    const output = new PassThrough();
    (output as unknown as { columns?: number }).columns = 100;
    (output as unknown as { rows?: number }).rows = 30;

    const input = new PassThrough();
    (input as unknown as { isTTY?: boolean; setRawMode?: (enabled: boolean) => void }).isTTY = true;
    (input as unknown as { setRawMode?: (enabled: boolean) => void }).setRawMode = () => {
      // no-op
    };

    const onPause = jest.fn();
    const onResume = jest.fn();
    const onSteer = jest.fn();

    const ui = createRuntimeUI(
      'tui',
      output as unknown as NodeJS.WriteStream,
      input as unknown as NodeJS.ReadStream
    );

    ui.start(createSessionInfo(), {
      onPause,
      onResume,
      onSteer,
    });
    ui.updateState(createState());

    input.write('p');
    input.write('r');
    input.write('\u0007');
    input.write('skip m1-f1');
    input.write('\n');

    ui.stop();

    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onSteer).toHaveBeenCalledWith('skip m1-f1');
  });

  it('maps Ctrl+C to SIGINT in raw mode', () => {
    const output = new PassThrough();
    (output as unknown as { columns?: number }).columns = 100;
    (output as unknown as { rows?: number }).rows = 30;

    const input = new PassThrough();
    (input as unknown as { isTTY?: boolean; setRawMode?: (enabled: boolean) => void }).isTTY = true;
    (input as unknown as { setRawMode?: (enabled: boolean) => void }).setRawMode = () => {
      // no-op
    };

    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);

    const ui = createRuntimeUI(
      'tui',
      output as unknown as NodeJS.WriteStream,
      input as unknown as NodeJS.ReadStream
    );
    ui.start(createSessionInfo());
    ui.updateState(createState());

    input.write('\u0003');
    ui.stop();

    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT');
    killSpy.mockRestore();
  });

  it('switches to workers view only when W is pressed', () => {
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

    const ui = createRuntimeUI(
      'tui',
      output as unknown as NodeJS.WriteStream,
      input as unknown as NodeJS.ReadStream
    );
    ui.start(createSessionInfo());
    ui.updateState(createState());
    expect(rendered).not.toContain('NOW RUNNING  WORKER');

    input.write('W');
    ui.stop();

    expect(rendered).toContain('NOW RUNNING  WORKER');
    expect(rendered).toContain('[READ] src/a.ts');
  });

  it('pending input allows task/models navigation, but blocks run controls', () => {
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

    const onResume = jest.fn();
    const onCycleModel = jest.fn();
    const ui = createRuntimeUI(
      'tui',
      output as unknown as NodeJS.WriteStream,
      input as unknown as NodeJS.ReadStream
    );
    ui.start(createSessionInfo(), { onResume, onCycleModel });
    ui.updateState({
      ...createState(),
      missionState: 'awaiting_approval',
      pendingPrompt: '承認待ち: y=承認 / Ctrl+C=中止',
    });

    input.write('M');
    input.write('2');
    input.write('T');
    input.write('\t');
    input.write('W');
    input.write('r');
    ui.stop();

    expect(onResume).not.toHaveBeenCalled();
    expect(onCycleModel).toHaveBeenCalledWith('worker');
    expect(rendered).toContain('入力待ち');
    expect(rendered).toContain('[INPUT] 承認待ち: y=承認 / Ctrl+C=中止');
    expect(rendered).not.toContain('NOW RUNNING  WORKER');
    expect(rendered).toContain('TASK');
  });

  it('forces overview when pending input becomes active', () => {
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

    const ui = createRuntimeUI(
      'tui',
      output as unknown as NodeJS.WriteStream,
      input as unknown as NodeJS.ReadStream
    );
    ui.start(createSessionInfo());
    ui.updateState(createState());
    input.write('D');
    expect(rendered).toContain('PRD');

    ui.updateState({
      ...createState(),
      missionState: 'awaiting_approval',
      pendingPrompt: '承認待ち: y=承認 / Ctrl+C=中止',
    });
    ui.stop();

    expect(rendered).toContain('Overview');
    expect(rendered).toContain('入力待ち');
  });

  it('keeps models view during pending input when user switched to models', () => {
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

    const ui = createRuntimeUI(
      'tui',
      output as unknown as NodeJS.WriteStream,
      input as unknown as NodeJS.ReadStream
    );
    ui.start(createSessionInfo());
    ui.updateState(createState());
    input.write('M');
    expect(rendered).toContain('Models');

    ui.updateState({
      ...createState(),
      missionState: 'awaiting_approval',
      pendingPrompt: '承認待ち: y=承認 / Ctrl+C=中止',
    });
    ui.stop();

    expect(rendered).toContain('Models');
    expect(rendered).toContain('入力待ち');
  });
});
