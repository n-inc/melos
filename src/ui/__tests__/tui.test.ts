import { PassThrough } from 'node:stream';

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
      planner: { role: 'planner', engine: 'claude', model: 'opus' },
      worker: { role: 'worker', engine: 'codex', model: 'gpt-5.3-codex' },
      validator: { role: 'validator', engine: 'claude', model: 'sonnet' },
      research: { role: 'research', engine: 'claude', model: 'sonnet' },
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
    expect(rendered).toContain('Auth system');
  });
});
