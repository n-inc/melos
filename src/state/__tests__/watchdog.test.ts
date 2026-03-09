import { jest } from '@jest/globals';

import { Watchdog } from '../watchdog.js';

describe('state/watchdog', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires once per stuck episode and re-arms after touch', () => {
    jest.useFakeTimers();

    const callback = jest.fn();
    const watchdog = new Watchdog({
      timeoutMs: 100,
      checkIntervalMs: 25,
    });
    watchdog.onStuck(callback);
    watchdog.start();

    jest.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(200);
    expect(callback).toHaveBeenCalledTimes(1);

    watchdog.touch();
    jest.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(2);

    watchdog.stop();
  });
});
