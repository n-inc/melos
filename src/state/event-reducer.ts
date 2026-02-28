import type { MissionPlan } from './mission.js';
import type { MissionEvent } from './events.js';
import type { GitStrategyState } from './git-strategy.js';
import type { TokenUsageSnapshot } from './token-tracker.js';

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
  log: string[];
}

export interface MissionKernelState {
  missionPlan: MissionPlan | null;
  iteration: number;
  workerRuns: WorkerRunState[];
  progressLog: Array<{ timestamp: string; message: string }>;
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
    case 'mission_resumed':
      return appendProgress(state, event.timestamp, String(event.payload.message ?? event.type));

    case 'plan_created':
    case 'plan_updated': {
      const missionPlan = (event.payload.plan as MissionPlan | undefined) ?? state.missionPlan;
      return {
        ...appendProgress(state, event.timestamp, event.type),
        missionPlan,
        iteration: event.iteration,
      };
    }

    case 'iteration_started':
    case 'iteration_completed':
      return {
        ...appendProgress(state, event.timestamp, `${event.type} #${event.iteration}`),
        iteration: event.iteration,
      };

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

      return {
        ...state,
        activeWorkerRunId: id,
        workerRuns: [...state.workerRuns, run],
        progressLog: appendLog(state.progressLog, event.timestamp, `worker #${id} started`),
      };
    }

    case 'worker_checkpoint':
    case 'command_executed': {
      const message = asString(event.payload.message) ?? asString(event.payload.command) ?? event.type;
      return {
        ...state,
        workerRuns: state.workerRuns.map((run) => {
          if (run.id !== state.activeWorkerRunId) {
            return run;
          }
          return {
            ...run,
            log: [...run.log, message],
          };
        }),
        progressLog: appendLog(state.progressLog, event.timestamp, message),
      };
    }

    case 'worker_finished':
    case 'worker_error': {
      const success = event.type === 'worker_finished';
      const activeRunId = Number(event.payload.runId ?? state.activeWorkerRunId);
      return {
        ...state,
        activeWorkerRunId: null,
        workerRuns: state.workerRuns.map((run) => {
          if (run.id !== activeRunId) {
            return run;
          }
          return {
            ...run,
            status: success ? 'done' : 'failed',
            endedAt: event.timestamp,
            log: event.payload.message
              ? [...run.log, String(event.payload.message)]
              : run.log,
          };
        }),
        progressLog: appendLog(
          state.progressLog,
          event.timestamp,
          success ? `worker #${activeRunId} finished` : `worker #${activeRunId} failed`
        ),
      };
    }

    case 'branch_created':
    case 'branch_merged':
    case 'branch_abandoned':
    case 'validation_result':
    case 'token_usage':
    case 'mission_completed':
    case 'mission_failed':
    case 'mission_interrupted':
    case 'user_steer':
    case 'user_answer':
    case 'escalation_created':
    case 'escalation_answered':
    case 'error':
      return appendProgress(state, event.timestamp, `${event.type}: ${stringifyPayload(event.payload)}`);

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
