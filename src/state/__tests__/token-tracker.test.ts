import { TokenTracker } from '../token-tracker.js';

describe('state/token-tracker', () => {
  it('aggregates usage by role and estimates cost', () => {
    const tracker = new TokenTracker();

    tracker.record({
      role: 'planner',
      model: 'opus',
      input: 2000,
      output: 1000,
      cached: 500,
    });

    tracker.record({
      role: 'worker',
      model: 'gpt-5.3-codex',
      input: 5000,
      output: 2000,
      cached: 1000,
    });

    tracker.record({
      role: 'worker',
      model: 'gpt-5.3-codex',
      input: 1000,
      output: 500,
      cached: 200,
    });

    const total = tracker.getTotal();
    expect(total.input).toBe(8000);
    expect(total.output).toBe(3500);
    expect(total.cached).toBe(1700);

    const byRole = tracker.getByRole();
    expect(byRole.worker?.input).toBe(6000);
    expect(byRole.worker?.output).toBe(2500);

    expect(tracker.getEstimatedCost()).toBeGreaterThan(0);
    expect(tracker.getSnapshot().total.cost).toBeGreaterThan(0);
  });
});
