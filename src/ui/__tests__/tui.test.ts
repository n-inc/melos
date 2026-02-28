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
    worker: 'gpt-5.3-codex',
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
    milestones: [
      {
        id: 'm1',
        title: 'Core',
        status: 'in_progress',
        order: 1,
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
        model: 'gpt-5.3-codex',
        log: ['read src/a.ts'],
      },
    ],
    modelAssignments: {
      planner: { role: 'planner', engine: 'claude', model: 'opus', effort: 'max' },
      worker: { role: 'worker', engine: 'codex', model: 'gpt-5.3-codex', effort: 'high' },
      validator: { role: 'validator', engine: 'codex', model: 'gpt-5.3-codex', effort: 'high' },
      research: { role: 'research', engine: 'claude', model: 'opus', effort: 'max' },
    },
    tokenUsage: {
      total: { input: 100, output: 50, cached: 20, cost: 0.01 },
      byRole: {
        worker: { model: 'gpt-5.3-codex', input: 100, output: 50, cached: 20, cost: 0.01 },
      },
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
    expect(rendered).toContain('Tab Next  Shift+Tab Prev  F/W/M/C View  P Pause  R Resume  Ctrl+G Steer  Esc Overview');
    expect(rendered).toContain('Overview');
    expect(rendered).not.toContain('Worker Log Stream');
    expect(rendered).toContain('melos> Running m1-f1...  (Ctrl+G steer)');
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
    expect(rendered).not.toContain('Worker Log Stream');

    input.write('W');
    ui.stop();

    expect(rendered).toContain('Workers');
    expect(rendered).toContain('Worker Log Stream');
  });

  it('locks hotkeys while pending input is active', () => {
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
    const ui = createRuntimeUI(
      'tui',
      output as unknown as NodeJS.WriteStream,
      input as unknown as NodeJS.ReadStream
    );
    ui.start(createSessionInfo(), { onResume });
    ui.updateState({
      ...createState(),
      missionState: 'awaiting_approval',
      pendingPrompt: 'Awaiting approval (single key): y=approve / n=regenerate / e=edit / Ctrl+C=abort',
    });

    input.write('W');
    input.write('r');
    ui.stop();

    expect(onResume).not.toHaveBeenCalled();
    expect(rendered).toContain('Input Required');
    expect(rendered).toContain('[INPUT] Awaiting approval (single key)');
    expect(rendered).not.toContain('Worker Log Stream');
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
    input.write('C');
    expect(rendered).toContain('Costs');

    ui.updateState({
      ...createState(),
      missionState: 'awaiting_approval',
      pendingPrompt: 'Awaiting approval (single key): y=approve / n=regenerate / e=edit / Ctrl+C=abort',
    });
    ui.stop();

    expect(rendered).toContain('Overview');
    expect(rendered).toContain('Input Required');
  });
});
