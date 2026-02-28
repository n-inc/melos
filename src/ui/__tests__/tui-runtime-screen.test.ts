import { PassThrough } from 'node:stream';
import { jest } from '@jest/globals';

import { createRuntimeUI, type SessionInfo } from '../tui.js';
import type { MissionControlState } from '../tui-views.js';

function createSession(): SessionInfo {
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
    missionState: 'running',
    activity: 'Running m1-f1...',
    elapsedLabel: '1m 12s',
    progressLabel: '1/3 (33%)',
    progressPercent: 33,
    activeMilestoneId: 'm1',
    activeFeatureId: 'm1-f1',
    activeBranch: 'melos/mission/m1-f1',
    milestones: [
      {
        id: 'm1',
        title: 'Core',
        status: 'in_progress',
        order: 1,
        features: [
          { id: 'm1-f1', description: 'parser', status: 'in_progress', attempts: 1 },
        ],
      },
    ],
    progressLog: [
      { timestamp: '2026-02-28T09:00:00.000Z', message: 'progress-marker-v1' },
    ],
    workerRuns: [
      {
        id: 1,
        type: 'implement',
        featureId: 'm1-f1',
        milestoneId: 'm1',
        status: 'running',
        durationLabel: '0m 15s',
        engine: 'codex',
        model: 'gpt-5.3-codex',
        log: ['worker-marker-v1'],
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
  return {
    ...base,
    ...overrides,
    activity: overrides.activity ?? base.activity,
  };
}

class AnsiScreen {
  private readonly lines: string[] = [];
  private row = 1;
  private col = 1;
  private savedRow = 1;
  private savedCol = 1;

  apply(chunk: string): void {
    let i = 0;
    while (i < chunk.length) {
      const char = chunk[i];
      if (char !== '\x1b') {
        this.writeText(char);
        i++;
        continue;
      }

      if (chunk[i + 1] === '7') {
        this.savedRow = this.row;
        this.savedCol = this.col;
        i += 2;
        continue;
      }
      if (chunk[i + 1] === '8') {
        this.row = this.savedRow;
        this.col = this.savedCol;
        i += 2;
        continue;
      }

      if (chunk[i + 1] !== '[') {
        i += 1;
        continue;
      }

      const end = this.findCsiEnd(chunk, i + 2);
      if (end < 0) {
        break;
      }
      const body = chunk.slice(i + 2, end);
      const command = chunk[end];
      this.applyCsi(body, command);
      i = end + 1;
    }
  }

  snapshot(): string {
    const normalized = this.lines.map((line) => line.replace(/\s+$/g, ''));
    while (normalized.length > 0 && normalized[normalized.length - 1] === '') {
      normalized.pop();
    }
    return normalized.join('\n');
  }

  private findCsiEnd(text: string, from: number): number {
    for (let i = from; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) {
        return i;
      }
    }
    return -1;
  }

  private applyCsi(body: string, command: string): void {
    if (body.startsWith('?')) {
      return;
    }

    const params = body.length === 0
      ? []
      : body.split(';').map((part) => Number.parseInt(part, 10) || 0);

    if (command === 'H' || command === 'f') {
      this.row = Math.max(1, params[0] || 1);
      this.col = Math.max(1, params[1] || 1);
      return;
    }

    if (command === 'J') {
      const mode = params[0] ?? 0;
      if (mode === 2) {
        this.lines.length = 0;
        this.row = 1;
        this.col = 1;
      }
      return;
    }

    if (command === 'K') {
      const mode = params[0] ?? 0;
      if (mode === 2) {
        this.ensureLine(this.row);
        this.lines[this.row - 1] = '';
        this.col = 1;
      }
    }
  }

  private ensureLine(row: number): void {
    while (this.lines.length < row) {
      this.lines.push('');
    }
  }

  private writeText(text: string): void {
    if (text === '\n') {
      this.row++;
      this.col = 1;
      return;
    }
    if (text === '\r') {
      this.col = 1;
      return;
    }

    this.ensureLine(this.row);
    const current = this.lines[this.row - 1];
    const start = this.col - 1;
    const prefix = current.length >= start ? current.slice(0, start) : current.padEnd(start, ' ');
    const suffixStart = start + text.length;
    const suffix = current.length > suffixStart ? current.slice(suffixStart) : '';
    this.lines[this.row - 1] = `${prefix}${text}${suffix}`;
    this.col += text.length;
  }
}

function createHarness() {
  const output = new PassThrough();
  (output as unknown as { columns?: number }).columns = 100;
  (output as unknown as { rows?: number }).rows = 30;

  const screen = new AnsiScreen();
  output.on('data', (chunk: Buffer | string) => {
    screen.apply(chunk.toString());
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
    onPause,
    onResume,
    onSteer,
    onCycleModel,
    screen: () => screen.snapshot(),
  };
}

describe('ui/tui runtime screen contract', () => {
  it('keeps logs in correct regions across view switches', () => {
    const h = createHarness();
    h.ui.start(createSession(), {
      onPause: h.onPause,
      onResume: h.onResume,
      onSteer: h.onSteer,
      onCycleModel: h.onCycleModel,
    });
    h.ui.updateState(createState());

    expect(h.screen()).toContain('Overview');
    expect(h.screen()).toContain('progress-marker-v1');
    expect(h.screen()).not.toContain('worker-marker-v1');

    h.input.write('W');
    expect(h.screen()).toContain('Workers');
    expect(h.screen()).toContain('Worker Log Stream');
    expect(h.screen()).toContain('worker-marker-v1');

    h.ui.updateState(createState({
      progressLog: [{ timestamp: '2026-02-28T09:00:10.000Z', message: 'progress-marker-v2' }],
      workerRuns: [{
        id: 1,
        type: 'implement',
        featureId: 'm1-f1',
        milestoneId: 'm1',
        status: 'running',
        durationLabel: '0m 16s',
        engine: 'codex',
        model: 'gpt-5.3-codex',
        log: ['worker-marker-v2'],
      }],
    }));
    expect(h.screen()).toContain('worker-marker-v2');

    h.input.write('\u001b');
    expect(h.screen()).toContain('Overview');
    expect(h.screen()).toContain('progress-marker-v2');
    expect(h.screen()).not.toContain('worker-marker-v2');

    h.ui.stop();
  });

  it('locks navigation and control keys while pending input is active', () => {
    const h = createHarness();
    h.ui.start(createSession(), {
      onPause: h.onPause,
      onResume: h.onResume,
      onSteer: h.onSteer,
      onCycleModel: h.onCycleModel,
    });
    h.ui.updateState(createState());
    h.input.write('W');
    expect(h.screen()).toContain('Workers');

    h.ui.updateState(createState({
      missionState: 'awaiting_approval',
      pendingPrompt: 'Awaiting approval (single key): y=approve / n=regenerate / e=edit / Ctrl+C=abort',
    }));
    expect(h.screen()).toContain('Overview');
    expect(h.screen()).toContain('Input Required');
    expect(h.screen()).toContain('[INPUT] Awaiting approval (single key):');

    h.input.write('\t');
    h.input.write('W');
    h.input.write('C');
    h.input.write('p');
    h.input.write('r');
    expect(h.screen()).toContain('Overview');
    expect(h.screen()).not.toContain('Workers');
    expect(h.onPause).not.toHaveBeenCalled();
    expect(h.onResume).not.toHaveBeenCalled();

    h.ui.stop();
  });

  it('never leaves initializing in wrong view even if keys are pressed early', () => {
    const h = createHarness();
    h.ui.start(createSession(), {
      onPause: h.onPause,
      onResume: h.onResume,
      onSteer: h.onSteer,
      onCycleModel: h.onCycleModel,
    });
    expect(h.screen()).toContain('INITIALIZING');

    h.input.write('C');
    h.input.write('W');
    h.input.write('\t');
    h.ui.updateState(createState());
    expect(h.screen()).toContain('Overview');
    expect(h.screen()).not.toContain('Costs');
    expect(h.screen()).not.toContain('Workers');

    h.ui.stop();
  });

  it('cycles model role by number hotkeys only in models view', () => {
    const h = createHarness();
    h.ui.start(createSession(), {
      onCycleModel: h.onCycleModel,
    });
    h.ui.updateState(createState());

    h.input.write('1');
    expect(h.onCycleModel).not.toHaveBeenCalled();

    h.input.write('M');
    h.input.write('1');
    h.input.write('3');
    expect(h.onCycleModel).toHaveBeenNthCalledWith(1, 'planner');
    expect(h.onCycleModel).toHaveBeenNthCalledWith(2, 'validator');

    h.ui.stop();
  });
});
