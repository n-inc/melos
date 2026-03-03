import { jest } from '@jest/globals';
import { createSignalController } from '../../cli.js';

describe('createSignalController', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('aborts mission on first SIGINT and sets exit code', () => {
    const abort = jest.fn();
    const stopUI = jest.fn();
    const setExitCode = jest.fn();
    const exitNow = jest.fn();
    const write = jest.fn();

    const controller = createSignalController({
      abort,
      stopUI,
      setExitCode,
      exitNow,
      write,
      forceExitAfterMs: 500,
    });

    controller.handle('SIGINT');

    expect(controller.getExitCode()).toBe(130);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(setExitCode).toHaveBeenCalledWith(130);
    expect(stopUI).not.toHaveBeenCalled();
    expect(exitNow).not.toHaveBeenCalled();
  });

  it('forces immediate exit on second signal', () => {
    const abort = jest.fn();
    const stopUI = jest.fn();
    const setExitCode = jest.fn();
    const exitNow = jest.fn();
    const write = jest.fn();

    const controller = createSignalController({
      abort,
      stopUI,
      setExitCode,
      exitNow,
      write,
      forceExitAfterMs: 500,
    });

    controller.handle('SIGINT');
    controller.handle('SIGINT');

    expect(abort).toHaveBeenCalledTimes(1);
    expect(stopUI).toHaveBeenCalledTimes(1);
    expect(exitNow).toHaveBeenCalledWith(130);
  });

  it('forces exit when abort does not complete within timeout', () => {
    const abort = jest.fn();
    const stopUI = jest.fn();
    const setExitCode = jest.fn();
    const exitNow = jest.fn();
    const write = jest.fn();

    const controller = createSignalController({
      abort,
      stopUI,
      setExitCode,
      exitNow,
      write,
      forceExitAfterMs: 500,
    });

    controller.handle('SIGINT');
    jest.advanceTimersByTime(500);

    expect(stopUI).toHaveBeenCalledTimes(1);
    expect(exitNow).toHaveBeenCalledWith(130);
  });

  it('cancels force-exit timer when cleared', () => {
    const abort = jest.fn();
    const stopUI = jest.fn();
    const setExitCode = jest.fn();
    const exitNow = jest.fn();
    const write = jest.fn();

    const controller = createSignalController({
      abort,
      stopUI,
      setExitCode,
      exitNow,
      write,
      forceExitAfterMs: 500,
    });

    controller.handle('SIGINT');
    controller.clear();
    jest.advanceTimersByTime(1000);

    expect(exitNow).not.toHaveBeenCalled();
  });
});
