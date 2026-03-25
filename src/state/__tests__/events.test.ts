import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventLog } from '../events.js';

describe('state/events', () => {
  it('appends run events with monotonically increasing seq', () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-events-'));
    const log = new EventLog({ melosDir: dir });

    log.emit({
      type: 'run_started',
      iteration: 0,
      payload: { mode: 'prompt' },
    });
    log.emit({
      type: 'decision_made',
      iteration: 1,
      payload: { kind: 'continue' },
    });

    const events = log.readAll();
    expect(events).toHaveLength(2);
    expect(events[0]?.seq).toBe(1);
    expect(events[1]?.seq).toBe(2);
    expect(events[0]?.agent).toBe('system');
  });

  it('reads only events after the given seq', () => {
    const dir = mkdtempSync(join(tmpdir(), 'melos-events-after-'));
    const log = new EventLog({ melosDir: dir });

    log.emit({
      type: 'run_started',
      iteration: 0,
      payload: { mode: 'route' },
    });
    log.emit({
      type: 'route_loaded',
      iteration: 0,
      payload: { path: '/tmp/route.ts' },
    });
    log.emit({
      type: 'run_completed',
      iteration: 1,
      payload: { summary: 'done' },
    });

    const replay = log.readAfter(2);
    expect(replay).toHaveLength(1);
    expect(replay[0]?.type).toBe('run_completed');
  });
});
