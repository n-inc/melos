import type { MissionPlan } from './mission.js';
import type { MissionEvent } from './events.js';
import type { GitStrategyState } from './git-strategy.js';
import type { ReviewReport } from './review.js';
import type { ValidationEvidenceMap, ValidationReport } from './validation.js';
import { normalizeLogMessage, type LogActor, type UnifiedLogEntry } from './log-entry.js';

export interface WorkerRunState {
  id: number;
  type: 'implement' | 'validate' | 'review' | 'research';
  featureId?: string;
  milestoneId?: string;
  status: 'running' | 'done' | 'failed';
  engine?: 'claude' | 'codex';
  model?: string;
  startedAt: string;
  endedAt?: string;
  log: UnifiedLogEntry[];
}

export type RuntimeWarningSource = 'worker' | 'validation' | 'system';

export interface RuntimeWarningRecord {
  timestamp: string;
  iteration: number;
  source: RuntimeWarningSource;
  message: string;
  milestoneId?: string;
  featureId?: string;
  checkId?: string;
  seq?: number;
}

export interface FeatureRetryRecord {
  milestoneId: string;
  featureId: string;
  nextAttempt: number;
  dueAt: string;
  lastStatus: 'PARTIAL' | 'FAILED' | 'BLOCKED';
  reason: string;
  summary?: string;
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
  warnings?: RuntimeWarningRecord[];
  validationEvidence?: ValidationEvidenceMap;
  latestValidationReport?: ValidationReport | null;
  latestReviewReport?: ReviewReport | null;
  featureRetries?: FeatureRetryRecord[];
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
    warnings: [],
    validationEvidence: {},
    latestValidationReport: null,
    latestReviewReport: null,
    featureRetries: [],
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
        'INFO',
        event.seq
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
        kind,
        event.seq
      );
    }

    case 'plan_created':
    case 'plan_updated': {
      const missionPlan = (event.payload.plan as MissionPlan | undefined) ?? state.missionPlan;
      const message = `${event.type}`;
      return {
        ...appendUnifiedProgress(state, event.timestamp, message, 'planning', event.type.toUpperCase(), event.seq),
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
        event.type.toUpperCase(),
        event.seq
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
        'STARTED',
        event.seq
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
      const entry = createLogEntry(event.timestamp, actor, message, defaultKind, event.seq);

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
    case 'worker_partial':
    case 'worker_error': {
      const success = event.type === 'worker_finished';
      const partial = event.type === 'worker_partial';
      const activeRunId = Number(event.payload.runId ?? state.activeWorkerRunId);
      const completionMessage = success
        ? `worker #${activeRunId} finished`
        : partial
          ? `worker #${activeRunId} finished partially`
          : `worker #${activeRunId} failed`;
      const summary = asString(event.payload.message);
      const completionEntry = createLogEntry(
        event.timestamp,
        'worker',
        summary
          ? `[${success ? 'DONE' : partial ? 'WARN' : 'ERR'}] ${summary}`
          : `[${success ? 'DONE' : partial ? 'WARN' : 'ERR'}] ${completionMessage}`,
        success ? 'DONE' : partial ? 'WARN' : 'ERR',
        event.seq
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
            status: success ? 'done' : partial ? 'done' : 'failed',
            endedAt: event.timestamp,
            log: summary
              ? [...run.log, createLogEntry(
                event.timestamp,
                'worker',
                `[${success ? 'DONE' : partial ? 'WARN' : 'ERR'}] ${summary}`,
                success ? 'DONE' : partial ? 'WARN' : 'ERR',
                event.seq
              )]
              : run.log,
          };
        }),
      };
    }

    case 'review_started': {
      const reviewType = asString(event.payload.reviewType) ?? 'review';
      const generation = Number.isFinite(event.payload.generation)
        ? Math.max(1, Math.floor(Number(event.payload.generation)))
        : 1;
      const message = `${reviewType} review g${generation} started`;
      return appendUnifiedProgress(
        state,
        event.timestamp,
        message,
        'worker',
        'STARTED',
        event.seq
      );
    }

    case 'review_result': {
      const summary = asString(event.payload.summary) ?? 'review completed';
      const report = event.payload.report as ReviewReport | undefined;
      const passed = Boolean(event.payload.passed);
      const blockingFindingCount = Number.isFinite(event.payload.blockingFindingCount)
        ? Math.max(0, Math.floor(Number(event.payload.blockingFindingCount)))
        : 0;
      const suffix = passed
        ? 'passed'
        : `failed (${blockingFindingCount} blocking finding${blockingFindingCount === 1 ? '' : 's'})`;
      const next = appendUnifiedProgress(
        state,
        event.timestamp,
        `review_result: ${summary} [${suffix}]`,
        'worker',
        passed ? 'DONE' : 'WARN',
        event.seq
      );
      return {
        ...next,
        latestReviewReport: report ?? next.latestReviewReport ?? null,
      };
    }

    case 'warning_emitted': {
      const warning = runtimeWarningRecordFromEvent(event);
      if (!warning) {
        return state;
      }

      const actor = resolveActorFromWarningSource(warning.source);
      const next = appendUnifiedProgress(
        state,
        event.timestamp,
        formatRuntimeWarningRecord(warning),
        actor,
        'WARN',
        event.seq
      );
      return {
        ...next,
        warnings: appendWarning(next.warnings ?? state.warnings ?? [], warning),
      };
    }

    case 'branch_created':
    case 'branch_merged':
    case 'branch_abandoned':
    case 'validation_started':
    case 'validation_result':
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
      return appendUnifiedProgress(state, event.timestamp, message, actor, kind, event.seq);
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
  defaultKind: string,
  seq?: number
): MissionKernelState {
  const entry = createLogEntry(timestamp, actor, message, defaultKind, seq);
  const next = appendProgress(state, timestamp, extractProgressHeadline(message, entry.message));
  return appendUnifiedEntry(next, entry);
}

function appendManagerUnifiedProgress(
  state: MissionKernelState,
  timestamp: string,
  message: string,
  actor: LogActor,
  defaultKind: string,
  seq?: number
): MissionKernelState {
  const entry = createLogEntry(timestamp, actor, message, defaultKind, seq);
  const next = appendManagerProgress(state, timestamp, extractProgressHeadline(message, entry.message));
  return appendUnifiedEntry(next, entry);
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
  defaultKind: string,
  seq?: number
): UnifiedLogEntry {
  const parsed = normalizeLogMessage(rawMessage, defaultKind);
  return {
    seq,
    timestamp,
    actor,
    kind: parsed.kind,
    message: parsed.message,
    detailLines: parsed.detailLines,
  };
}

function extractProgressHeadline(rawMessage: string, fallback: string): string {
  const first = rawMessage
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ''))
    .find((line) => line.trim().length > 0);
  return first?.trim() || fallback;
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

function resolveActorFromWarningSource(source: RuntimeWarningSource): LogActor {
  if (source === 'validation') {
    return 'validator';
  }
  if (source === 'worker') {
    return 'worker';
  }
  return 'system';
}

function appendWarning(
  warnings: RuntimeWarningRecord[],
  warning: RuntimeWarningRecord
): RuntimeWarningRecord[] {
  const next = [...warnings, warning];
  if (next.length > 200) {
    return next.slice(next.length - 200);
  }
  return next;
}

function resolveActorFromEvent(event: MissionEvent): LogActor {
  if (event.type.startsWith('validation_')) {
    return 'validator';
  }
  if (event.type.startsWith('review_')) {
    return 'worker';
  }
  if (event.type === 'warning_emitted') {
    return resolveActorFromWarningSource(
      runtimeWarningRecordFromEvent(event)?.source ?? 'system'
    );
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

export function runtimeWarningRecordFromEvent(event: MissionEvent): RuntimeWarningRecord | null {
  if (event.type !== 'warning_emitted') {
    return null;
  }

  return normalizeRuntimeWarningRecord({
    timestamp: event.timestamp,
    iteration: event.iteration,
    seq: event.seq,
    ...event.payload,
  });
}

export function normalizeRuntimeWarningRecord(value: unknown): RuntimeWarningRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  if (message.length === 0) {
    return null;
  }

  const source = record.source === 'worker' || record.source === 'validation' || record.source === 'system'
    ? record.source
    : 'system';

  return {
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString(),
    iteration: typeof record.iteration === 'number' ? Math.max(0, Math.floor(record.iteration)) : 0,
    source,
    message,
    milestoneId: asString(record.milestoneId),
    featureId: asString(record.featureId),
    checkId: asString(record.checkId),
    seq: typeof record.seq === 'number' ? record.seq : undefined,
  };
}

export function formatRuntimeWarningRecord(warning: RuntimeWarningRecord): string {
  const scope = formatRuntimeWarningScope(warning);
  if (scope) {
    return `[${warning.source}] ${scope}: ${warning.message}`;
  }
  return `[${warning.source}] ${warning.message}`;
}

function formatRuntimeWarningScope(warning: RuntimeWarningRecord): string {
  const parts: string[] = [];
  if (warning.featureId) {
    parts.push(warning.featureId);
  } else if (warning.milestoneId) {
    parts.push(warning.milestoneId);
  }
  if (warning.checkId) {
    parts.push(warning.checkId);
  }
  return parts.join('/');
}
