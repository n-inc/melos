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
    worker: 'gpt-5.4',
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
    currentActor: 'worker',
    logEntries: [
      { timestamp: '2026-02-28T08:59:58.000Z', actor: 'planning', kind: 'PLAN_CREATED', message: 'manager-marker-v1' },
      { timestamp: '2026-02-28T09:00:00.000Z', actor: 'worker', kind: 'INFO', message: 'worker-marker-v1' },
    ],
    milestones: [
      {
        id: 'm1',
        title: 'Core',
        status: 'in_progress',
        features: [
          { id: 'm1-f1', description: 'parser', status: 'in_progress', attempts: 1 },
        ],
      },
    ],
    progressLog: [
      { timestamp: '2026-02-28T09:00:00.000Z', message: 'progress-marker-v1' },
    ],
    managerLog: [
      { timestamp: '2026-02-28T08:59:58.000Z', message: 'planning: manager-marker-v1' },
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
        model: 'gpt-5.4',
        log: [{ timestamp: '2026-02-28T09:00:00.000Z', actor: 'worker', kind: 'INFO', message: 'worker-marker-v1' }],
      },
    ],
    modelAssignments: {
      planner: { role: 'planner', engine: 'claude', model: 'opus', effort: 'max' },
      worker: { role: 'worker', engine: 'codex', model: 'gpt-5.4', effort: 'high' },
      validator: { role: 'validator', engine: 'codex', model: 'gpt-5.4', effort: 'high' },
      research: { role: 'research', engine: 'claude', model: 'opus', effort: 'max' },
    },
    tokenUsage: {
      total: { input: 100, output: 50, cached: 20, cost: 0.01 },
      byRole: {
        worker: { model: 'gpt-5.4', input: 100, output: 50, cached: 20, cost: 0.01 },
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
  const onSetActiveFeatureModel = jest.fn();
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
    onSetActiveFeatureModel,
    screen: () => screen.snapshot(),
  };
}

describe('ui/tui runtime screen contract', () => {
  it('keeps logs in correct regions across view switches', async () => {
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
    expect(h.screen()).toContain('NOW RUNNING');
    expect(h.screen()).toContain('manager-marker-v1');
    expect(h.screen()).toContain('worker-marker-v1');

    h.ui.updateState(createState({
      progressLog: [{ timestamp: '2026-02-28T09:00:10.000Z', message: 'progress-marker-v2' }],
      managerLog: [{ timestamp: '2026-02-28T09:00:11.000Z', message: 'planning: manager-marker-v2' }],
      logEntries: [
        { timestamp: '2026-02-28T09:00:10.000Z', actor: 'manager', kind: 'INFO', message: 'manager-marker-v2' },
        { timestamp: '2026-02-28T09:00:12.000Z', actor: 'worker', kind: 'INFO', message: 'worker-marker-v2' },
      ],
      workerRuns: [{
        id: 1,
        type: 'implement',
        featureId: 'm1-f1',
        milestoneId: 'm1',
        status: 'running',
        durationLabel: '0m 16s',
        engine: 'codex',
        model: 'gpt-5.4',
        log: [{ timestamp: '2026-02-28T09:00:12.000Z', actor: 'worker', kind: 'INFO', message: 'worker-marker-v2' }],
      }],
    }));
    expect(h.screen()).toContain('manager-marker-v2');
    expect(h.screen()).toContain('worker-marker-v2');

    h.input.write('\u001b');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(h.screen()).toContain('Overview');
    expect(h.screen()).toContain('progress-marker-v2');
    expect(h.screen()).not.toContain('worker-marker-v2');

    h.ui.stop();
  });

  it('pending input allows task/models navigation and tab, but blocks run controls', () => {
    const h = createHarness();
    h.ui.start(createSession(), {
      onPause: h.onPause,
      onResume: h.onResume,
      onSteer: h.onSteer,
      onCycleModel: h.onCycleModel,
    });
    h.ui.updateState(createState());
    h.input.write('W');
    expect(h.screen()).toContain('NOW RUNNING');

    h.ui.updateState(createState({
      missionState: 'awaiting_approval',
      pendingPrompt: '承認待ち: y=承認 / Ctrl+C=中止',
    }));
    expect(h.screen()).toContain('Overview');
    expect(h.screen()).toContain('入力待ち');
    expect(h.screen()).toContain('[INPUT] 承認待ち: y=承認 / Ctrl+C=中止');

    h.input.write('M');
    expect(h.screen()).toContain('Models');

    h.input.write('2');
    h.input.write('T');
    expect(h.screen()).toContain('TASK');
    h.input.write('\t');
    h.input.write('W');
    h.input.write('D');
    h.input.write('p');
    h.input.write('r');
    expect(h.screen()).toContain('PRD');
    expect(h.screen()).not.toContain('NOW RUNNING  WORKER');
    expect(h.onPause).not.toHaveBeenCalled();
    expect(h.onResume).not.toHaveBeenCalled();
    expect(h.onCycleModel).toHaveBeenCalledWith('worker');

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

    h.input.write('D');
    h.input.write('W');
    h.input.write('\t');
    h.ui.updateState(createState());
    expect(h.screen()).toContain('Overview');
    expect(h.screen()).not.toContain('PRD');
    expect(h.screen()).not.toContain('NOW RUNNING  WORKER');

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

  it('routes C/A/U keys to feature model selection only in features/task view', () => {
    const h = createHarness();
    h.ui.start(createSession(), {
      onSetActiveFeatureModel: h.onSetActiveFeatureModel,
    });
    h.ui.updateState(createState());

    h.input.write('F');
    h.input.write('C');
    h.input.write('A');
    h.input.write('U');
    h.input.write('M');
    h.input.write('C');
    h.ui.stop();

    expect(h.onSetActiveFeatureModel).toHaveBeenNthCalledWith(1, 'codex-latest');
    expect(h.onSetActiveFeatureModel).toHaveBeenNthCalledWith(2, 'claude-latest');
    expect(h.onSetActiveFeatureModel).toHaveBeenNthCalledWith(3, null);
    expect(h.onSetActiveFeatureModel).toHaveBeenCalledTimes(3);
  });

  it('supports scrolling in TASK view (including pending input)', () => {
    const h = createHarness();
    h.ui.start(createSession());
    h.ui.updateState(createState({
      taskPreviewLines: Array.from({ length: 80 }, (_, idx) => `task-line-${idx + 1}`),
    }));

    h.input.write('T');
    expect(h.screen()).toContain('TASK');
    expect(h.screen()).toContain('Line 1-');

    h.input.write('\u001b[B');
    expect(h.screen()).toContain('Line 2-');
    h.input.write('\u001b[6~');
    expect(h.screen()).toContain('Line 14-');
    h.input.write('\u001b[F');
    expect(h.screen()).toContain('Line 62-80 / 80');
    h.input.write('\u001b[H');
    expect(h.screen()).toContain('Line 1-');

    h.ui.updateState(createState({
      missionState: 'awaiting_approval',
      pendingPrompt: '承認待ち: y=承認 / Ctrl+C=中止',
      taskPreviewLines: Array.from({ length: 80 }, (_, idx) => `task-line-${idx + 1}`),
    }));
    h.input.write('\u001b[B');
    expect(h.screen()).toContain('Line 2-');

    h.ui.stop();
  });

  it('supports scroll keys when escape sequences are split or combined in one chunk', () => {
    const h = createHarness();
    h.ui.start(createSession());
    h.ui.updateState(createState({
      taskPreviewLines: Array.from({ length: 80 }, (_, idx) => `task-line-${idx + 1}`),
    }));

    h.input.write('T');
    expect(h.screen()).toContain('Line 1-');

    // split chunk: ESC + [B
    h.input.write('\u001b');
    h.input.write('[B');
    expect(h.screen()).toContain('Line 2-');

    // combined chunk: down + down
    h.input.write('\u001b[B\u001b[B');
    expect(h.screen()).toContain('Line 4-');

    h.ui.stop();
  });

  it('supports split escape scrolling in workers log view', () => {
    const h = createHarness();
    h.ui.start(createSession());
    h.ui.updateState(createState({
      logEntries: Array.from({ length: 40 }, (_, idx) => ({
        timestamp: `2026-02-28T09:00:${String(idx % 60).padStart(2, '0')}.000Z`,
        actor: 'worker',
        kind: 'INFO',
        message: `worker-log-${idx + 1}`,
      })),
    }));

    h.input.write('W');
    expect(h.screen()).toContain('worker-log-1');

    h.input.write('\u001b');
    h.input.write('[B');
    expect(h.screen()).toContain('Lines 2-');

    h.input.write('\u001b[6~');
    expect(h.screen()).toContain('Lines 14-');

    h.ui.stop();
  });
});
