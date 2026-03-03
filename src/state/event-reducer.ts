import type { MissionPlan } from './mission.js';
import type { MissionEvent } from './events.js';
import type { GitStrategyState } from './git-strategy.js';
import type { TokenUsageSnapshot } from './token-tracker.js';
import type { LogActor, UnifiedLogEntry } from './log-entry.js';

export interface WorkerRunState {
  id: number;
  type: 'implement' | 'validate' | 'research';
  featureId?: string;
  milestoneId?: string;
  status: 'running' | 'done' | 'failed';
  engine?: 'claude' | 'codex';
  model?: string;
  startedAt: string;
  endedAt?: string;
  log: UnifiedLogEntry[];
}

export interface MissionKernelState {
  missionPlan: MissionPlan | null;
  iteration: number;
  workerRuns: WorkerRunState[];
  progressLog: Array<{ timestamp: string; message: string }>;
  managerLog?: Array<{ timestamp: string; message: string }>;
  logEntries: UnifiedLogEntry[];
  currentActor: LogActor;
  activeWorkerRunId: number | null;
  gitStrategy: GitStrategyState | null;
  tokenUsage: TokenUsageSnapshot;
}

export function createInitialKernelState(): MissionKernelState {
  return {
    missionPlan: null,
    iteration: 0,
    workerRuns: [],
    progressLog: [],
    managerLog: [],
    logEntries: [],
    currentActor: 'idle',
    activeWorkerRunId: null,
    gitStrategy: null,
    tokenUsage: {
      total: { input: 0, output: 0, cached: 0, cost: 0 },
      byRole: {},
    },
  };
}

export function reduceMissionEvent(
  state: MissionKernelState,
  event: MissionEvent
): MissionKernelState {
  switch (event.type) {
    case 'mission_started':
    case 'mission_resumed': {
      const message = String(event.payload.message ?? event.type);
      return appendUnifiedProgress(
        state,
        event.timestamp,
        message,
        'planning',
        'INFO'
      );
    }

    case 'manager_started':
    case 'manager_decision':
    case 'manager_error': {
      const message = String(event.payload.message ?? `${event.type}: ${stringifyPayload(event.payload)}`);
      const phase = asString(event.payload.phase);
      const actor: LogActor = phase === 'planning' ? 'planning' : 'manager';
      const kind = event.type === 'manager_error' ? 'ERR' : (event.type === 'manager_started' ? 'STARTED' : 'INFO');
      return appendManagerUnifiedProgress(
        state,
        event.timestamp,
        message,
        actor,
        kind
      );
    }

    case 'plan_created':
    case 'plan_updated': {
      const missionPlan = (event.payload.plan as MissionPlan | undefined) ?? state.missionPlan;
      const message = `${event.type}`;
      return {
        ...appendUnifiedProgress(state, event.timestamp, message, 'planning', event.type.toUpperCase()),
        missionPlan,
        iteration: event.iteration,
      };
    }

    case 'iteration_started':
    case 'iteration_completed': {
      const next = appendUnifiedProgress(
        state,
        event.timestamp,
        `${event.type} #${event.iteration}`,
        'system',
        event.type.toUpperCase()
      );
      return {
        ...next,
        iteration: event.iteration,
      };
    }

    case 'worker_started': {
      const id = Number(event.payload.runId ?? state.workerRuns.length + 1);
      const run: WorkerRunState = {
        id,
        type: (event.payload.type as WorkerRunState['type']) ?? 'implement',
        featureId: asString(event.payload.featureId),
        milestoneId: asString(event.payload.milestoneId),
        status: 'running',
        engine: event.payload.engine as WorkerRunState['engine'] | undefined,
        model: asString(event.payload.model),
        startedAt: event.timestamp,
        log: [],
      };

      const startSummary = `worker #${id} started`;
      const startEntry = createLogEntry(
        event.timestamp,
        'worker',
        `[STARTED] ${startSummary}`,
        'STARTED'
      );
      return {
        ...appendUnifiedEntry(
          {
            ...state,
            progressLog: appendLog(state.progressLog, event.timestamp, startSummary),
          },
          startEntry
        ),
        activeWorkerRunId: id,
        workerRuns: [...state.workerRuns, run],
      };
    }

    case 'worker_checkpoint':
    case 'command_executed': {
      const message = asString(event.payload.message) ?? asString(event.payload.command) ?? event.type;
      const actor = event.type === 'worker_checkpoint'
        ? 'worker'
        : (state.activeWorkerRunId ? 'worker' : 'system');
      const defaultKind = event.type === 'command_executed' ? 'BASH' : 'INFO';
      const entry = createLogEntry(event.timestamp, actor, message, defaultKind);

      const nextWorkerRuns = state.workerRuns.map((run) => {
        if (run.id !== state.activeWorkerRunId) {
          return run;
        }
        return {
          ...run,
          log: [...run.log, entry],
        };
      });

      return {
        ...appendUnifiedEntry(
          {
            ...state,
            workerRuns: nextWorkerRuns,
            progressLog: appendLog(state.progressLog, event.timestamp, message),
          },
          entry
        ),
      };
    }

    case 'worker_finished':
    case 'worker_error': {
      const success = event.type === 'worker_finished';
      const activeRunId = Number(event.payload.runId ?? state.activeWorkerRunId);
      const completionMessage = success ? `worker #${activeRunId} finished` : `worker #${activeRunId} failed`;
      const summary = asString(event.payload.message);
      const completionEntry = createLogEntry(
        event.timestamp,
        'worker',
        summary ? `[${success ? 'DONE' : 'ERR'}] ${summary}` : `[${success ? 'DONE' : 'ERR'}] ${completionMessage}`,
        success ? 'DONE' : 'ERR'
      );
      return {
        ...appendUnifiedEntry(
          {
            ...state,
            progressLog: appendLog(state.progressLog, event.timestamp, completionMessage),
          },
          completionEntry
        ),
        activeWorkerRunId: null,
        workerRuns: state.workerRuns.map((run) => {
          if (run.id !== activeRunId) {
            return run;
          }
          return {
            ...run,
            status: success ? 'done' : 'failed',
            endedAt: event.timestamp,
            log: summary
              ? [...run.log, createLogEntry(event.timestamp, 'worker', `[${success ? 'DONE' : 'ERR'}] ${summary}`, success ? 'DONE' : 'ERR')]
              : run.log,
          };
        }),
      };
    }

    case 'branch_created':
    case 'branch_merged':
    case 'branch_abandoned':
    case 'validation_started':
    case 'validation_result':
    case 'token_usage':
    case 'mission_completed':
    case 'mission_failed':
    case 'mission_interrupted':
    case 'user_steer':
    case 'user_answer':
    case 'escalation_created':
    case 'escalation_answered':
    case 'error': {
      const message = `${event.type}: ${stringifyPayload(event.payload)}`;
      const actor = resolveActorFromEvent(event);
      const kind = event.type.toUpperCase();
      return appendUnifiedProgress(state, event.timestamp, message, actor, kind);
    }

    default:
      return state;
  }
}

export function replayMissionEvents(events: MissionEvent[]): MissionKernelState {
  let state = createInitialKernelState();
  for (const event of events.sort((a, b) => a.seq - b.seq)) {
    state = reduceMissionEvent(state, event);
  }
  return state;
}

function appendProgress(
  state: MissionKernelState,
  timestamp: string,
  message: string
): MissionKernelState {
  return {
    ...state,
    progressLog: appendLog(state.progressLog, timestamp, message),
  };
}

function appendManagerProgress(
  state: MissionKernelState,
  timestamp: string,
  message: string
): MissionKernelState {
  const next = appendProgress(state, timestamp, message);
  return {
    ...next,
    managerLog: appendLog(next.managerLog ?? [], timestamp, message),
  };
}

function appendUnifiedProgress(
  state: MissionKernelState,
  timestamp: string,
  message: string,
  actor: LogActor,
  defaultKind: string
): MissionKernelState {
  const next = appendProgress(state, timestamp, message);
  return appendUnifiedEntry(next, createLogEntry(timestamp, actor, message, defaultKind));
}

function appendManagerUnifiedProgress(
  state: MissionKernelState,
  timestamp: string,
  message: string,
  actor: LogActor,
  defaultKind: string
): MissionKernelState {
  const next = appendManagerProgress(state, timestamp, message);
  return appendUnifiedEntry(next, createLogEntry(timestamp, actor, message, defaultKind));
}

function appendLog(
  logs: Array<{ timestamp: string; message: string }>,
  timestamp: string,
  message: string
): Array<{ timestamp: string; message: string }> {
  const next = [...logs, { timestamp, message }];
  if (next.length > 500) {
    return next.slice(next.length - 500);
  }
  return next;
}

function appendUnifiedEntry(
  state: MissionKernelState,
  entry: UnifiedLogEntry
): MissionKernelState {
  const existingEntries = Array.isArray(state.logEntries) ? state.logEntries : [];
  const nextEntries = [...existingEntries, entry];
  const logEntries = nextEntries.length > 1200 ? nextEntries.slice(nextEntries.length - 1200) : nextEntries;
  return {
    ...state,
    logEntries,
    currentActor: entry.actor === 'system' ? (state.currentActor ?? 'idle') : entry.actor,
  };
}

function createLogEntry(
  timestamp: string,
  actor: LogActor,
  rawMessage: string,
  defaultKind: string
): UnifiedLogEntry {
  const lines = rawMessage
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ''))
    .filter((line) => line.length > 0);
  const first = lines[0] ?? '';
  const parsed = parseKindAndMessage(first, defaultKind);
  const detailLines = lines.length > 1 ? limitDetailLines(lines.slice(1)) : undefined;
  return {
    timestamp,
    actor,
    kind: parsed.kind,
    message: parsed.message,
    detailLines,
  };
}

function parseKindAndMessage(firstLine: string, defaultKind: string): { kind: string; message: string } {
  const tagged = firstLine.match(/^\[([A-Z0-9_]+)\]\s*(.*)$/);
  if (tagged) {
    const kind = tagged[1];
    const message = tagged[2] && tagged[2].trim().length > 0 ? tagged[2].trim() : kind;
    return { kind, message };
  }
  const cleanMessage = firstLine.trim();
  return {
    kind: defaultKind,
    message: cleanMessage.length > 0 ? cleanMessage : defaultKind,
  };
}

function stringifyPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return '[payload]';
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolveActorFromEvent(event: MissionEvent): LogActor {
  if (event.type.startsWith('validation_')) {
    return 'validator';
  }
  if (event.type.startsWith('manager_')) {
    return 'manager';
  }
  if (event.type.startsWith('worker_')) {
    return 'worker';
  }
  if (event.type.startsWith('plan_')) {
    return 'planning';
  }
  if (event.agent === 'manager') {
    return 'manager';
  }
  if (event.agent === 'worker') {
    return 'worker';
  }
  return 'system';
}

function limitDetailLines(lines: string[]): string[] {
  const clipped = lines
    .slice(0, 3)
    .map((line) => (line.length > 180 ? `${line.slice(0, 177)}...` : line));
  if (lines.length > 3) {
    clipped.push(`... +${lines.length - 3} more lines`);
  }
  return clipped;
}
