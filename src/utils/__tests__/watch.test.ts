import { describe, it, expect, jest } from '@jest/globals';
import type { FSWatcher } from 'node:fs';

import type { Plan } from '../../state/plan.js';
import type { Orchestrator, OrchestratorConfig } from '../../orchestrator.js';
import { watchPlanFile } from '../../watch.js';

describe('watchPlanFile', () => {
  it('should start orchestrator when new pending tasks are added', async () => {
    const initialPlan: Plan = [
      {
        id: '1',
        description: 'done task',
        passes: true,
      },
    ];
    const updatedPlan: Plan = [
      ...initialPlan,
      {
        id: '2',
        description: 'new task',
        passes: false,
      },
    ];

    let loadPlanCallCount = 0;
    const loadPlan = jest.fn(async (_path: string): Promise<Plan> => {
      loadPlanCallCount++;
      if (loadPlanCallCount === 1) {
        return initialPlan;
      }
      return updatedPlan;
    });

    const run = jest.fn(async () => ({
      success: true,
      completedIterations: 1,
      reason: 'complete' as const,
    }));
    const abort = jest.fn(() => {});
    const createOrchestrator = jest.fn((_config: OrchestratorConfig) => ({
      run,
      abort,
    } as unknown as Orchestrator));

    // Use a wrapper object to store callback
    const callbackRef: { current: (() => void) | null } = { current: null };
    const close = jest.fn(() => {});
    const createWatcher = jest.fn((path: string, listener: () => void): FSWatcher => {
      callbackRef.current = listener;
      return { close } as unknown as FSWatcher;
    });

    const logger = {
      info: jest.fn(() => {}),
      warn: jest.fn(() => {}),
      error: jest.fn(() => {}),
    };

    const watchPromise = watchPlanFile(
      { engine: 'claude', maxIterations: 30 },
      {
        cwd: '/tmp/melos',
        loadPlan,
        createWatcher,
        createOrchestrator,
        logger,
        debounceMs: 0,
      }
    );

    // Wait for initial setup
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(createWatcher).toHaveBeenCalledTimes(1);

    // Trigger file change
    const callback = callbackRef.current;
    if (callback) {
      callback();
    }

    // Wait for debounce and async operations
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(createOrchestrator).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);

    process.emit('SIGINT');
    await watchPromise;

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('should not start new orchestrator loop after cleanup even with pendingRun', async () => {
    const initialPlan: Plan = [
      {
        id: '1',
        description: 'done task',
        passes: true,
      },
    ];
    const updatedPlan: Plan = [
      ...initialPlan,
      {
        id: '2',
        description: 'new task',
        passes: false,
      },
    ];

    let loadPlanCallCount = 0;
    const loadPlan = jest.fn(async (_path: string): Promise<Plan> => {
      loadPlanCallCount++;
      if (loadPlanCallCount === 1) {
        return initialPlan;
      }
      return updatedPlan;
    });

    let runResolve: (() => void) | null = null;
    const run = jest.fn(async () => {
      // Wait to be resolved externally, simulating long-running operation
      await new Promise<void>(resolve => {
        runResolve = resolve;
      });
      return {
        success: true,
        completedIterations: 1,
        reason: 'complete' as const,
      };
    });
    const abort = jest.fn(() => {
      // When abort is called, resolve the run promise
      if (runResolve) {
        runResolve();
      }
    });
    const createOrchestrator = jest.fn((_config: OrchestratorConfig) => ({
      run,
      abort,
    } as unknown as Orchestrator));

    const callbackRef: { current: (() => void) | null } = { current: null };
    const close = jest.fn(() => {});
    const createWatcher = jest.fn((path: string, listener: () => void): FSWatcher => {
      callbackRef.current = listener;
      return { close } as unknown as FSWatcher;
    });

    const logger = {
      info: jest.fn(() => {}),
      warn: jest.fn(() => {}),
      error: jest.fn(() => {}),
    };

    const watchPromise = watchPlanFile(
      { engine: 'claude', maxIterations: 30 },
      {
        cwd: '/tmp/melos',
        loadPlan,
        createWatcher,
        createOrchestrator,
        logger,
        debounceMs: 0,
      }
    );

    // Wait for initial setup
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(createWatcher).toHaveBeenCalledTimes(1);

    // Trigger file change to start orchestrator
    const callback = callbackRef.current;
    if (callback) {
      callback();
    }

    // Wait for orchestrator to start running
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(createOrchestrator).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);

    // While orchestrator is running, trigger another file change (sets pendingRun = true)
    if (callback) {
      callback();
    }
    await new Promise(resolve => setTimeout(resolve, 10));

    // Now simulate Ctrl+C - this sets closed = true and calls abort()
    process.emit('SIGINT');

    // Wait for everything to settle
    await watchPromise;

    // The orchestrator should only have been created once
    // Even though pendingRun was true, closed flag should prevent recursive handleRun
    expect(createOrchestrator).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
