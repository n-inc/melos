import { createRoute } from '../recipe.js';

describe('exec recipe defaults', () => {
  it('fills in runtime workflow defaults for omitted artifact paths and phase context', () => {
    const route = createRoute({
      run: { engine: 'auto' },
      workflow: {
        start: 'research',
        phases: {
          research: {
            task: 'Research the topic',
            next: 'stop',
          },
        },
      },
      report: {},
    });

    expect(route.workflow.phases.research.context).toEqual([]);
    expect(route.report).toEqual({ path: '.melos/final-report.json', stdout: true });
  });

  it('fills in declarative workflow defaults for omitted artifact paths and phase context', () => {
    const route = createRoute({
      run: { engine: 'auto' },
      workflow: {
        start: 'write',
        phases: {
          write: {
            task: 'Write the draft',
            next: 'stop',
          },
        },
      },
      report: { stdout: false },
    });

    expect(route.workflow.phases.write.context).toEqual([]);
    expect(route.report).toEqual({ path: '.melos/final-report.json', stdout: false });
  });

  it('rejects workflow routes with an unknown start phase', () => {
    expect(() => createRoute({
      run: { engine: 'auto' },
      workflow: {
        start: 'missing',
        phases: {
          review: {
            task: 'Review the work',
            next: 'stop',
          },
        },
      },
    })).toThrow(/workflow\.start/i);
  });

  it('rejects evaluator phases without transitions', () => {
    expect(() => createRoute({
      run: { engine: 'auto' },
      workflow: {
        start: 'review',
        phases: {
          review: {
            task: 'Review the work',
            pass: ['States that the review is complete'],
          },
        },
      },
    })).toThrow(/phase .*on/i);
  });

  it('rejects action phases without next', () => {
    expect(() => createRoute({
      run: { engine: 'auto' },
      workflow: {
        start: 'research',
        phases: {
          research: {
            task: 'Research the topic',
          },
        },
      },
    })).toThrow(/phase .*next/i);
  });

  it('rejects runtime phases that define evaluate without policy', () => {
    expect(() => createRoute({
      run: { engine: 'auto' },
      workflow: {
        start: 'review',
        phases: {
          review: {
            task: 'Review the work',
            evaluate: async () => ({
              ok: true,
              status: 'pass',
              summary: 'done',
              metrics: {},
            }),
            on: {
              pass: 'stop',
              fail: 'repeat',
            },
          },
        },
      },
    })).toThrow(/evaluate and policy/i);
  });
});
