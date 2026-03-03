import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLog } from '../events.js';
import { replayMissionEvents } from '../event-reducer.js';
import { saveSnapshot, loadSnapshot } from '../snapshot.js';

describe('event sourcing', () => {
  it('appends events and replays kernel state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-events-'));
    const log = new EventLog({ melosDir: dir });

    log.emit({
      type: 'mission_started',
      iteration: 0,
      agent: 'orchestrator',
      payload: { message: 'start' },
    });

    log.emit({
      type: 'worker_started',
      iteration: 1,
      agent: 'worker',
      payload: { runId: 1, type: 'implement', featureId: 'm1-f1' },
    });

    log.emit({
      type: 'worker_checkpoint',
      iteration: 1,
      agent: 'worker',
      payload: { message: 'read file' },
    });

    log.emit({
      type: 'worker_finished',
      iteration: 1,
      agent: 'worker',
      payload: { runId: 1, message: 'done' },
    });

    const events = log.readAll();
    expect(events).toHaveLength(4);
    expect(events[0]?.seq).toBe(1);
    expect(events[3]?.seq).toBe(4);

    const state = replayMissionEvents(events);
    expect(state.workerRuns).toHaveLength(1);
    expect(state.workerRuns[0]?.status).toBe('done');
    expect(state.workerRuns[0]?.log).toContain('read file');

    await saveSnapshot(dir, {
      seq: 4,
      savedAt: new Date().toISOString(),
      state: { kernel: state },
    });
    const snapshot = await loadSnapshot<{ kernel: typeof state }>(dir);
    expect(snapshot?.seq).toBe(4);
    expect(snapshot?.state.kernel.workerRuns[0]?.id).toBe(1);
  });

  it('reads only events after snapshot sequence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-events-after-'));
    const log = new EventLog({ melosDir: dir });

    log.emit({
      type: 'mission_started',
      iteration: 0,
      agent: 'orchestrator',
      payload: { message: 'start' },
    });
    log.emit({
      type: 'command_executed',
      iteration: 1,
      agent: 'system',
      payload: { command: 'echo before', exitCode: 0 },
    });
    log.emit({
      type: 'command_executed',
      iteration: 1,
      agent: 'system',
      payload: { command: 'echo after', exitCode: 0 },
    });

    const replay = log.readAfter(2);
    expect(replay).toHaveLength(1);
    expect(replay[0]?.payload.command).toBe('echo after');
  });

  it('projects manager and validation events into progress log messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-events-progress-'));
    const log = new EventLog({ melosDir: dir });

    log.emit({
      type: 'manager_started',
      iteration: 0,
      agent: 'manager',
      payload: { phase: 'planning', message: 'Planning mission...' },
    });
    log.emit({
      type: 'validation_started',
      iteration: 1,
      agent: 'orchestrator',
      payload: { milestoneId: 'm1' },
    });

    const state = replayMissionEvents(log.readAll());
    const messages = state.progressLog.map((entry) => entry.message);
    expect(messages).toContain('Planning mission...');
    expect(messages.some((message) => message.startsWith('validation_started:'))).toBe(true);
    expect(state.managerLog?.some((entry) => entry.message.includes('Planning mission...'))).toBe(true);
  });

  it('returns null snapshot when state.json does not exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-events-no-snapshot-'));
    const snapshot = await loadSnapshot(dir);
    expect(snapshot).toBeNull();
  });

  it('creates snapshot directory on save when missing', async () => {
    const dir = join(tmpdir(), `melos-events-save-${Date.now()}`);
    const state = replayMissionEvents([]);
    await saveSnapshot(dir, {
      seq: 1,
      savedAt: new Date().toISOString(),
      state: { kernel: state },
    });
    const snapshot = await loadSnapshot<{ kernel: typeof state }>(dir);
    expect(snapshot?.seq).toBe(1);
  });
});
