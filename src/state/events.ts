import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type MissionEventType =
  | 'run_started' | 'route_loaded' | 'iteration_started' | 'context_built' | 'engine_finished'
  | 'evaluation_finished' | 'decision_made' | 'checkpoint_created' | 'commit_created'
  | 'rollback_applied' | 'report_generated' | 'warning_emitted'
  | 'run_asked' | 'user_answer' | 'run_completed' | 'run_failed';

export interface MissionEventBase {
  seq: number;
  type: MissionEventType;
  timestamp: string;
  iteration: number;
  agent: 'system' | null;
}

export type MissionEvent = MissionEventBase & { payload: Record<string, unknown> };

export interface EventLogOptions {
  melosDir: string;
  fileName?: string;
}

export class EventLog {
  private readonly filePath: string;
  private seq: number;

  constructor(options: EventLogOptions) {
    mkdirSync(options.melosDir, { recursive: true });
    this.filePath = join(options.melosDir, options.fileName ?? 'events.jsonl');
    this.seq = this.bootstrapSeq();
  }

  emit(params: {
    type: MissionEventType;
    iteration: number;
    agent?: MissionEventBase['agent'];
    payload?: Record<string, unknown>;
    timestamp?: string;
  }): MissionEvent {
    const event: MissionEvent = {
      seq: ++this.seq,
      type: params.type,
      timestamp: params.timestamp ?? new Date().toISOString(),
      iteration: Math.max(0, Math.floor(params.iteration)),
      agent: params.agent ?? 'system',
      payload: params.payload ?? {},
    };

    appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf-8');
    return event;
  }

  readAll(): MissionEvent[] {
    if (!existsSync(this.filePath)) {
      return [];
    }

    const lines = readFileSync(this.filePath, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const events: MissionEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as MissionEvent;
        if (typeof parsed.seq === 'number' && typeof parsed.type === 'string') {
          events.push(parsed);
        }
      } catch {
        // skip malformed event line
      }
    }
    return events;
  }

  readAfter(seq: number): MissionEvent[] {
    return this.readAll().filter((event) => event.seq > seq);
  }

  getCurrentSeq(): number {
    return this.seq;
  }

  getPath(): string {
    return this.filePath;
  }

  private bootstrapSeq(): number {
    const events = this.readAll();
    return events.length === 0 ? 0 : events[events.length - 1].seq;
  }
}
