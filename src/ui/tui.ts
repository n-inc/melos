import { parseKey } from './tui-keymap.js';
import { truncateDisplay, padDisplay, getDisplayWidth, colorize, canUseColor } from './tui-ansi.js';
import type { MissionControlState, TUIView, ViewId } from './tui-views.js';
import type { ModelRole } from '../models/router.js';
import { overviewView } from './tui-overview.js';
import { featuresView } from './tui-features.js';
import { workersView } from './tui-workers.js';
import { modelsView } from './tui-models.js';
import { prdView } from './tui-prd.js';
import { taskView } from './tui-task.js';

export interface TUIOptions {
  plain?: boolean;
  headless?: boolean;
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

export type RuntimeUIMode = 'tui' | 'plain' | 'headless';

export interface RuntimeUIControls {
  onPause?: () => void;
  onResume?: () => void;
  onSteer?: (instruction: string) => void;
  onCycleModel?: (role: ModelRole) => void;
}

export interface RuntimeUI {
  mode: RuntimeUIMode;
  start: (session: SessionInfo, controls?: RuntimeUIControls) => void;
  updateState: (state: MissionControlState) => void;
  stop: () => void;
}

const DEFAULT_TERMINAL_COLUMNS = 100;
const DEFAULT_TERMINAL_ROWS = 32;
const VIEW_ORDER: ViewId[] = ['overview', 'features', 'workers', 'models', 'prd', 'task'];
const VIEW_MAP: Record<ViewId, TUIView> = {
  overview: overviewView,
  features: featuresView,
  workers: workersView,
  models: modelsView,
  prd: prdView,
  task: taskView,
};

function resolveModelHotkey(raw: string): ModelRole | null {
  switch (raw) {
    case '1':
      return 'planner';
    case '2':
      return 'worker';
    case '3':
      return 'validator';
    case '4':
      return 'research';
    default:
      return null;
  }
}

export function shouldUseTUI(options: TUIOptions, terminal: TerminalCapabilities): boolean {
  if (options.plain) {
    return false;
  }
  return terminal.stdinIsTTY && terminal.stdoutIsTTY && terminal.stderrIsTTY;
}

export function resolveRuntimeUIMode(options: TUIOptions, terminal: TerminalCapabilities): RuntimeUIMode {
  if (options.headless) {
    return 'headless';
  }
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
  let userChangedView = false;
  let session: SessionInfo | null = null;
  let state: MissionControlState | null = null;
  let previousFrame: string[] = [];
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let logSourceLock: 'auto' | 'worker' | 'manager' = 'auto';
  let secondaryVisible = true;
  let sourceSwitchNotice: string | null = null;
  const viewScroll: Record<ViewId, number> = {
    overview: 0,
    features: 0,
    workers: 0,
    models: 0,
    prd: 0,
    task: 0,
  };

  let rawModeEnabled = false;
  let inputResumed = false;
  let steerMode = false;
  let steerBuffer = '';
  const useColor = mode === 'tui' && canUseColor(output.isTTY === true);

  const getColumns = () => output.columns ?? process.stderr.columns ?? DEFAULT_TERMINAL_COLUMNS;
  const getRows = () => output.rows ?? process.stderr.rows ?? DEFAULT_TERMINAL_ROWS;

  const render = () => {
    if (!started || mode !== 'tui' || !session) {
      return;
    }

    const frame = state
      ? buildFrame(session, state, {
        width: getColumns(),
        height: getRows(),
        view: currentView,
        scrollOffset: viewScroll[currentView],
        steerMode,
        steerBuffer,
        logSourceLock,
        secondaryVisible,
        sourceSwitchNotice,
        useColor,
      })
      : buildInitializingFrame(session, {
      width: getColumns(),
      height: getRows(),
      steerMode,
      steerBuffer,
      useColor,
    });
    sourceSwitchNotice = null;

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

  const applyViewScrollAction = (actionType: string): boolean => {
    if (currentView !== 'prd' && currentView !== 'task' && currentView !== 'workers') {
      return false;
    }
    switch (actionType) {
      case 'cursor_up':
        viewScroll[currentView] = Math.max(0, viewScroll[currentView] - 1);
        return true;
      case 'cursor_down':
        viewScroll[currentView] = viewScroll[currentView] + 1;
        return true;
      case 'page_up':
        viewScroll[currentView] = Math.max(0, viewScroll[currentView] - 12);
        return true;
      case 'page_down':
      case 'select':
        viewScroll[currentView] = viewScroll[currentView] + 12;
        return true;
      case 'scroll_top':
        viewScroll[currentView] = 0;
        return true;
      case 'scroll_bottom':
        viewScroll[currentView] = Number.MAX_SAFE_INTEGER;
        return true;
      default:
        return false;
    }
  };

  const handleKeyChunk = (chunk: Buffer | string) => {
    const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (raw.length === 0) {
      return;
    }

    // 初回状態が届くまでは画面遷移キーを受け付けない（Ctrl+Cのみ許可）
    if (!state) {
      if (raw === '\u0003') {
        process.kill(process.pid, 'SIGINT');
      }
      return;
    }

    const inputLocked = Boolean(state?.pendingPrompt);
    if (inputLocked) {
      if (steerMode) {
        steerMode = false;
        steerBuffer = '';
        render();
      }
      if (raw === '\u0003') {
        process.kill(process.pid, 'SIGINT');
        return;
      }

      const role = resolveModelHotkey(raw);
      if (role) {
        controls.onCycleModel?.(role);
        return;
      }

      const action = parseKey(raw);
      switch (action.type) {
        case 'toggle_log_source': {
          const previous = logSourceLock;
          logSourceLock = previous === 'auto' ? 'worker' : previous === 'worker' ? 'manager' : 'auto';
          sourceSwitchNotice = `SWITCH: ${previous.toUpperCase()} -> ${logSourceLock.toUpperCase()} (manual lock)`;
          render();
          return;
        }
        case 'toggle_secondary':
          secondaryVisible = !secondaryVisible;
          render();
          return;
        case 'next_view': {
          const index = VIEW_ORDER.indexOf(currentView);
          currentView = VIEW_ORDER[(index + 1) % VIEW_ORDER.length];
          userChangedView = true;
          render();
          return;
        }
        case 'prev_view': {
          const index = VIEW_ORDER.indexOf(currentView);
          currentView = VIEW_ORDER[(index - 1 + VIEW_ORDER.length) % VIEW_ORDER.length];
          userChangedView = true;
          render();
          return;
        }
        case 'goto_view':
          if (action.view === 'models' || action.view === 'prd' || action.view === 'task') {
            currentView = action.view;
            userChangedView = true;
            render();
          }
          return;
        case 'cursor_up':
        case 'cursor_down':
        case 'page_up':
        case 'page_down':
        case 'scroll_top':
        case 'scroll_bottom':
        case 'select':
          if (applyViewScrollAction(action.type)) {
            render();
          }
          return;
        case 'overview':
          currentView = 'overview';
          userChangedView = true;
          render();
          return;
        default:
          return;
      }
      return;
    }

    if (!steerMode) {
      if (currentView === 'models') {
        const role = resolveModelHotkey(raw);
        if (role) {
          controls.onCycleModel?.(role);
          return;
        }
      }

      const action = parseKey(raw);
      switch (action.type) {
        case 'toggle_log_source': {
          const previous = logSourceLock;
          logSourceLock = previous === 'auto' ? 'worker' : previous === 'worker' ? 'manager' : 'auto';
          sourceSwitchNotice = `SWITCH: ${previous.toUpperCase()} -> ${logSourceLock.toUpperCase()} (manual lock)`;
          render();
          return;
        }
        case 'toggle_secondary':
          secondaryVisible = !secondaryVisible;
          render();
          return;
        case 'next_view': {
          const index = VIEW_ORDER.indexOf(currentView);
          currentView = VIEW_ORDER[(index + 1) % VIEW_ORDER.length];
          userChangedView = true;
          render();
          return;
        }
        case 'prev_view': {
          const index = VIEW_ORDER.indexOf(currentView);
          currentView = VIEW_ORDER[(index - 1 + VIEW_ORDER.length) % VIEW_ORDER.length];
          userChangedView = true;
          render();
          return;
        }
        case 'abort':
          process.kill(process.pid, 'SIGINT');
          return;
        case 'goto_view':
          currentView = action.view;
          userChangedView = true;
          render();
          return;
        case 'cursor_up':
        case 'cursor_down':
        case 'page_up':
        case 'page_down':
        case 'scroll_top':
        case 'scroll_bottom':
        case 'select':
          if (applyViewScrollAction(action.type)) {
            render();
          }
          return;
        case 'overview':
          currentView = 'overview';
          userChangedView = true;
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
    if (raw === '\u0003') {
      process.kill(process.pid, 'SIGINT');
      return;
    }

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
    currentView = 'overview';
    userChangedView = false;
    viewScroll.overview = 0;
    viewScroll.features = 0;
    viewScroll.workers = 0;
    viewScroll.models = 0;
    viewScroll.prd = 0;
    viewScroll.task = 0;

    if (mode === 'tui') {
      output.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
      previousFrame = [];
      logSourceLock = 'auto';
      secondaryVisible = true;
      sourceSwitchNotice = null;
      refreshTimer = setInterval(render, 1000);
      refreshTimer.unref();

      if (input.isTTY && typeof input.setRawMode === 'function') {
        input.setRawMode(true);
        rawModeEnabled = true;
      }
      input.on('data', handleKeyChunk);
      input.resume();
      inputResumed = true;
      render();
      return;
    }

    if (mode === 'plain') {
      refreshTimer = setInterval(refreshPlain, 3000);
      refreshTimer.unref();
    }
  };

  const updateState = (nextState: MissionControlState) => {
    const firstStateUpdate = state === null;
    state = nextState;
    if (firstStateUpdate) {
    currentView = 'overview';
    userChangedView = false;
    logSourceLock = 'auto';
    secondaryVisible = true;
    sourceSwitchNotice = null;
      viewScroll.overview = 0;
      viewScroll.features = 0;
      viewScroll.workers = 0;
      viewScroll.models = 0;
      viewScroll.prd = 0;
      viewScroll.task = 0;
    } else if (nextState.pendingPrompt) {
      if (currentView !== 'models' && currentView !== 'prd' && currentView !== 'task') {
        currentView = 'overview';
      }
    } else if (!userChangedView) {
      currentView = 'overview';
    }
    if (mode === 'tui') {
      render();
      return;
    }
    if (mode === 'plain') {
      refreshPlain();
    }
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
    if (inputResumed && typeof input.pause === 'function') {
      input.pause();
      inputResumed = false;
    }
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

export function renderTUIFrameForTest(input: {
  session: SessionInfo;
  state: MissionControlState | null;
  width: number;
  height: number;
  view: ViewId;
  scrollOffset?: number;
  steerMode?: boolean;
  steerBuffer?: string;
  logSourceLock?: 'auto' | 'worker' | 'manager';
  secondaryVisible?: boolean;
  sourceSwitchNotice?: string | null;
}): string[] {
  if (!input.state) {
    return buildInitializingFrame(input.session, {
      width: input.width,
      height: input.height,
      steerMode: input.steerMode === true,
      steerBuffer: input.steerBuffer ?? '',
      useColor: false,
    });
  }

  return buildFrame(input.session, input.state, {
    width: input.width,
    height: input.height,
    view: input.view,
    scrollOffset: input.scrollOffset ?? 0,
    steerMode: input.steerMode === true,
    steerBuffer: input.steerBuffer ?? '',
    logSourceLock: input.logSourceLock ?? 'auto',
    secondaryVisible: input.secondaryVisible ?? true,
    sourceSwitchNotice: input.sourceSwitchNotice ?? null,
    useColor: false,
  });
}

function buildFrame(
  session: SessionInfo,
  state: MissionControlState,
  options: {
    width: number;
    height: number;
    view: ViewId;
    scrollOffset: number;
    steerMode: boolean;
    steerBuffer: string;
    logSourceLock: 'auto' | 'worker' | 'manager';
    secondaryVisible: boolean;
    sourceSwitchNotice: string | null;
    useColor: boolean;
  }
): string[] {
  const width = Math.max(options.width, 60);
  const height = Math.max(options.height, 20);
  const contentHeight = height - 4;
  const usage = state.tokenUsage.total;

  const header = composeTwoSidedLine(
    `● Mission Control  ${state.missionTitle}`,
    `Time ${state.elapsedLabel}  Input ${usage.input}  Cached ${usage.cached}  Output ${usage.output}`,
    width
  );
  const actorSummary = composeActorSummary(state);
  const stateLabel = colorizeState(state.missionState.toUpperCase(), options.useColor);
  const status = truncateDisplay(
    `● ${stateLabel} ${renderProgressBar(state.progressPercent, Math.max(10, Math.min(30, width - 36)))} ${state.progressLabel}${actorSummary ? ` | ${actorSummary}` : ''}`,
    width
  );

  const view = VIEW_MAP[options.view];
  const contentLines = view.render(
    { width, height: contentHeight },
    state,
    {
      scrollOffset: options.scrollOffset,
      logSourceLock: options.logSourceLock,
      secondaryVisible: options.secondaryVisible,
      sourceSwitchNotice: options.sourceSwitchNotice,
      useColor: options.useColor,
    }
  );
  const clipped = contentLines.slice(0, contentHeight).map((line) => truncateDisplay(line, width));
  while (clipped.length < contentHeight) {
    clipped.push('');
  }

  const footer = truncateDisplay(
    state.pendingPrompt
      ? `入力待ち  ${state.pendingPrompt}`
      : options.view === 'models'
        ? `Tab Next  Shift+Tab Prev  F/W/M/D/T View  1 Planner 2 Worker 3 Validator 4 Research`
        : options.view === 'prd' || options.view === 'task'
          ? `Tab Next  Shift+Tab Prev  F/W/M/D/T View  ↑↓/PgUp/PgDn/Home/End Scroll  Enter=More`
          : options.view === 'workers'
            ? `Tab Next  Shift+Tab Prev  F/W/M/D/T View  ↑↓/PgUp/PgDn/Home/End Scroll  L Focus  P Pause  R Resume  Ctrl+G Steer`
            : `Tab Next  Shift+Tab Prev  F/W/M/D/T View  P Pause  R Resume  Ctrl+G Steer  Esc Overview`,
    width
  );

  const prompt = options.steerMode
    ? truncateDisplay(`[STEER MODE] melos> ${options.steerBuffer}`, width)
    : truncateDisplay(
      state.pendingPrompt
        ? `[INPUT] ${state.pendingPrompt}`
        : `melos> ${state.activity}  (Ctrl+G steer)`,
      width
    );

  return [
    padDisplay(header, width),
    padDisplay(status, width),
    ...clipped,
    padDisplay(footer, width),
    padDisplay(prompt, width),
  ];
}

function composeActorSummary(state: MissionControlState): string {
  if (state.currentActor === 'worker' && state.activeFeatureId) {
    return `WORKER ${state.activeFeatureId}`;
  }
  if (state.currentActor === 'manager' && state.activeFeatureId) {
    return `MANAGER briefing ${state.activeFeatureId}`;
  }
  if (state.currentActor === 'planning') {
    return 'PLANNING';
  }
  if (state.currentActor === 'validator' && state.activeMilestoneId) {
    return `VALIDATION ${state.activeMilestoneId}`;
  }
  return '';
}

function buildInitializingFrame(
  session: SessionInfo,
  options: {
    width: number;
    height: number;
    steerMode: boolean;
    steerBuffer: string;
    useColor: boolean;
  }
): string[] {
  const width = Math.max(options.width, 60);
  const height = Math.max(options.height, 20);
  const contentHeight = height - 4;

  const header = composeTwoSidedLine(
    `● Mission Control  ${session.missionTitle}`,
    'Time 0m 00s  Input 0  Cached 0  Output 0',
    width
  );
  const status = truncateDisplay(`● ${colorizeState('INITIALIZING', options.useColor)} [░░░░░░░░░░] 0/0 (0%)`, width);
  const lines = [
    'Initializing mission runtime...',
    '',
    'Waiting for first status update from orchestrator.',
    'This usually appears in a few seconds.',
    '',
    'If this does not change:',
    '1. Confirm PRD.md exists',
    '2. Confirm TASK.json is valid MissionPlan v2',
    '3. Press Ctrl+C to abort and re-run',
  ];
  const clipped = [...lines];
  while (clipped.length < contentHeight) {
    clipped.push('');
  }
  const footer = truncateDisplay('Ctrl+C Abort  Waiting for first state update...', width);
  const prompt = options.steerMode
    ? truncateDisplay(`[STEER MODE] melos> ${options.steerBuffer}`, width)
    : 'melos> initializing...';

  return [
    padDisplay(header, width),
    padDisplay(status, width),
    ...clipped.slice(0, contentHeight).map((line) => padDisplay(truncateDisplay(line, width), width)),
    padDisplay(footer, width),
    padDisplay(prompt, width),
  ];
}

function colorizeState(state: string, useColor: boolean): string {
  switch (state) {
    case 'RUNNING':
      return colorize(state, 'state_running', useColor);
    case 'PAUSED':
      return colorize(state, 'state_paused', useColor);
    case 'FAILED':
    case 'ABORTED':
      return colorize(state, 'state_failed', useColor);
    case 'AWAITING_APPROVAL':
      return colorize(state, 'state_awaiting', useColor);
    default:
      return state;
  }
}

function composeTwoSidedLine(left: string, right: string, width: number): string {
  const leftWidth = getDisplayWidth(left);
  const rightWidth = getDisplayWidth(right);
  if (leftWidth + 1 + rightWidth <= width) {
    return `${left}${' '.repeat(width - leftWidth - rightWidth)}${right}`;
  }
  return truncateDisplay(`${left}  ${right}`, width);
}

function renderProgressBar(progressPercent: number, width: number): string {
  const safeWidth = Math.max(6, width);
  const clamped = Math.max(0, Math.min(100, progressPercent));
  const filled = Math.round((safeWidth * clamped) / 100);
  return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, safeWidth - filled))}]`;
}
