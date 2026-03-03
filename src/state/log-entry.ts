export type LogActor = 'planning' | 'manager' | 'worker' | 'validator' | 'system' | 'idle';

export interface UnifiedLogEntry {
  timestamp: string;
  actor: LogActor;
  kind: string;
  message: string;
  detailLines?: string[];
}

