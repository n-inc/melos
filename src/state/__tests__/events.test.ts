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
});
