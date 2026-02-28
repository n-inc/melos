import { parseKey } from './tui-keymap.js';
import { truncateDisplay, padDisplay } from './tui-ansi.js';
import type { MissionControlState, TUIView, ViewId } from './tui-views.js';
import { overviewView } from './tui-overview.js';
import { featuresView } from './tui-features.js';
import { workersView } from './tui-workers.js';
import { modelsView } from './tui-models.js';
import { costsView } from './tui-costs.js';

export interface TUIOptions {
  plain?: boolean;
}

export interface TerminalCapabilities {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
}

export interface SessionInfo {
  version: string;
  missionId: string;
  missionTitle: string;
  planner: string;
  worker: string;
}

export type RuntimeUIMode = 'tui' | 'plain';

export interface RuntimeUIControls {
  onPause?: () => void;
  onResume?: () => void;
  onSteer?: (instruction: string) => void;
}

export interface RuntimeUI {
  mode: RuntimeUIMode;
  start: (session: SessionInfo, controls?: RuntimeUIControls) => void;
  updateState: (state: MissionControlState) => void;
  stop: () => void;
}

const DEFAULT_TERMINAL_COLUMNS = 100;
const DEFAULT_TERMINAL_ROWS = 32;
const VIEW_ORDER: ViewId[] = ['overview', 'features', 'workers', 'models', 'costs'];
const VIEW_MAP: Record<ViewId, TUIView> = {
  overview: overviewView,
  features: featuresView,
  workers: workersView,
  models: modelsView,
  costs: costsView,
};

export function shouldUseTUI(options: TUIOptions, terminal: TerminalCapabilities): boolean {
  if (options.plain) {
    return false;
  }
  return terminal.stdinIsTTY && terminal.stdoutIsTTY && terminal.stderrIsTTY;
}

export function resolveRuntimeUIMode(options: TUIOptions, terminal: TerminalCapabilities): RuntimeUIMode {
  return shouldUseTUI(options, terminal) ? 'tui' : 'plain';
}

export function createRuntimeUI(
  mode: RuntimeUIMode,
  output: NodeJS.WriteStream = process.stderr,
  input: NodeJS.ReadStream = process.stdin
): RuntimeUI {
  let started = false;
  let controls: RuntimeUIControls = {};
  let currentView: ViewId = 'overview';
  let session: SessionInfo | null = null;
  let state: MissionControlState | null = null;
  let previousFrame: string[] = [];
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  let rawModeEnabled = false;
  let steerMode = false;
  let steerBuffer = '';

  const getColumns = () => output.columns ?? process.stderr.columns ?? DEFAULT_TERMINAL_COLUMNS;
  const getRows = () => output.rows ?? process.stderr.rows ?? DEFAULT_TERMINAL_ROWS;

  const render = () => {
    if (!started || mode !== 'tui' || !session || !state) {
      return;
    }

    const frame = buildFrame(session, state, {
      width: getColumns(),
      height: getRows(),
      view: currentView,
      steerMode,
      steerBuffer,
    });

    // Diff rendering: write only changed lines.
    output.write('\x1b7');
    for (let i = 0; i < frame.length; i++) {
      if (frame[i] === previousFrame[i]) {
        continue;
      }
      output.write(`\x1b[${i + 1};1H\x1b[2K${frame[i]}`);
    }
    output.write('\x1b8');
    previousFrame = frame;
  };

  const refreshPlain = () => {
    if (!started || mode !== 'plain' || !state) {
      return;
    }
    const lines = [
      `[melos] ${state.missionTitle}`,
      `state=${state.missionState} progress=${state.progressLabel} branch=${state.activeBranch ?? '-'}`,
      `active=${state.activeFeatureId ?? '-'} log=${state.progressLog[state.progressLog.length - 1]?.message ?? '-'}`,
    ];
    output.write(`${lines.join('\n')}\n`);
  };

  const handleKeyChunk = (chunk: Buffer | string) => {
    const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (raw.length === 0) {
      return;
    }

    if (!steerMode) {
      const action = parseKey(raw);
      switch (action.type) {
        case 'next_view': {
          const index = VIEW_ORDER.indexOf(currentView);
          currentView = VIEW_ORDER[(index + 1) % VIEW_ORDER.length];
          render();
          return;
        }
        case 'goto_view':
          currentView = action.view;
          render();
          return;
        case 'overview':
          currentView = 'overview';
          render();
          return;
        case 'pause':
          controls.onPause?.();
          return;
        case 'resume':
          controls.onResume?.();
          return;
        case 'steer_mode':
          steerMode = true;
          steerBuffer = '';
          render();
          return;
        default:
          return;
      }
    }

    // steer mode input handling
    if (raw === '\u001b') {
      steerMode = false;
      steerBuffer = '';
      render();
      return;
    }

    if (raw === '\r' || raw === '\n') {
      const instruction = steerBuffer.trim();
      if (instruction.length > 0) {
        controls.onSteer?.(instruction);
      }
      steerMode = false;
      steerBuffer = '';
      render();
      return;
    }

    if (raw === '\u007f') {
      steerBuffer = steerBuffer.slice(0, -1);
      render();
      return;
    }

    if (/^[\x20-\x7e\u3000-\u9fff]+$/u.test(raw)) {
      steerBuffer += raw;
      render();
    }
  };

  const start = (nextSession: SessionInfo, nextControls: RuntimeUIControls = {}) => {
    if (started) {
      return;
    }

    session = nextSession;
    controls = nextControls;
    started = true;

    if (mode === 'tui') {
      output.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
      previousFrame = [];
      refreshTimer = setInterval(render, 1000);
      refreshTimer.unref();

      if (input.isTTY && typeof input.setRawMode === 'function') {
        input.setRawMode(true);
        rawModeEnabled = true;
      }
      input.on('data', handleKeyChunk);
      input.resume();
      render();
      return;
    }

    refreshTimer = setInterval(refreshPlain, 3000);
    refreshTimer.unref();
  };

  const updateState = (nextState: MissionControlState) => {
    state = nextState;
    if (mode === 'tui') {
      render();
      return;
    }
    refreshPlain();
  };

  const stop = () => {
    if (!started) {
      return;
    }
    started = false;

    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }

    input.removeListener('data', handleKeyChunk);
    if (rawModeEnabled && input.isTTY && typeof input.setRawMode === 'function') {
      input.setRawMode(false);
      rawModeEnabled = false;
    }

    if (mode === 'tui') {
      output.write('\x1b[?25h\x1b[?1049l');
    }
  };

  return {
    mode,
    start,
    updateState,
    stop,
  };
}

function buildFrame(
  session: SessionInfo,
  state: MissionControlState,
  options: {
    width: number;
    height: number;
    view: ViewId;
    steerMode: boolean;
    steerBuffer: string;
  }
): string[] {
  const width = Math.max(options.width, 60);
  const height = Math.max(options.height, 20);
  const contentHeight = height - 3;

  const header = truncateDisplay(
    `Mission ${session.missionId} ${state.missionTitle}  ● ${state.missionState.toUpperCase()}  ${state.elapsedLabel}  ${state.progressLabel}`,
    width
  );

  const view = VIEW_MAP[options.view];
  const contentLines = view.render({ width, height: contentHeight }, state);
  const clipped = contentLines.slice(0, contentHeight).map((line) => truncateDisplay(line, width));
  while (clipped.length < contentHeight) {
    clipped.push('');
  }

  const footer = truncateDisplay(
    `Tab Next  F/W/M/C View  P Pause  R Resume  Ctrl+G Steer  Esc Overview`,
    width
  );

  const promptPrefix = options.steerMode ? '[STEER MODE] melos> ' : 'melos> ';
  const prompt = truncateDisplay(`${promptPrefix}${options.steerBuffer}`, width);

  return [
    padDisplay(header, width),
    ...clipped,
    padDisplay(footer, width),
    padDisplay(prompt, width),
  ];
}
