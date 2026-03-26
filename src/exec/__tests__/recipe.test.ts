import { compileRecipeConfig } from '../compiler.js';
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
            on: { pass: 'stop' },
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
            on: { pass: 'stop' },
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
            on: { pass: 'stop' },
          },
        },
      },
    })).toThrow(/workflow\.start/i);
  });

  it('rejects validated phases without fail transitions', () => {
    expect(() => createRoute({
      run: { engine: 'auto' },
      workflow: {
        start: 'review',
        phases: {
          review: {
            task: 'Review the work',
            validate: {
              llm: ['States that the review is complete'],
            },
            on: {
              pass: 'stop',
            },
          },
        },
      },
    })).toThrow(/phase .*on\.fail/i);
  });

  it('rejects phases without pass transitions', () => {
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
    })).toThrow(/phase .*on\.pass/i);
  });

  it('rejects legacy next transitions in route config', () => {
    expect(() => compileRecipeConfig({
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
    } as never)).toThrow(/next .*removed/i);
  });

  it('rejects legacy top-level validation fields in route config', () => {
    expect(() => compileRecipeConfig({
      run: { engine: 'auto' },
      workflow: {
        start: 'review',
        phases: {
          review: {
            task: 'Review the work',
            pass: ['States that the review is complete'],
            on: {
              pass: 'stop',
              fail: 'stop',
            },
          },
        },
      },
    } as never)).toThrow(/validate/i);
  });

  it('compiles validated phases into loop-aware runtime phases', () => {
    const route = createRoute({
      run: { engine: 'auto' },
      workflow: {
        start: 'review',
        phases: {
          review: {
            task: 'Review the work',
            validate: {
              shell: ['npm test'],
              llm: ['States that the review is complete'],
            },
            on: {
              pass: 'stop',
              fail: 'repeat',
            },
          },
        },
      },
    });

    expect(route.workflow.phases.review.on).toEqual({
      pass: 'stop',
      fail: 'repeat',
    });
    expect(route.workflow.phases.review.next).toBeUndefined();
    expect(route.workflow.phases.review.loop).toEqual({ name: 'review' });
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
              fail: 'stop',
            },
          },
        },
      },
    })).toThrow(/evaluate and policy/i);
  });
});
