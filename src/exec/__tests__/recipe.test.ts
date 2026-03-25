import { createRoute, createRuntimeRoute } from '../recipe.js';

describe('exec recipe defaults', () => {
  it('fills in runtime route defaults for omitted artifact paths', () => {
    const route = createRuntimeRoute({
      prompt: 'Implement the task',
      run: { engine: 'auto' },
      evaluate: () => ({ ok: true, status: 'pass', summary: 'done', metrics: {} }),
      policy: () => ({ kind: 'stop', success: true }),
      review: {},
      report: {},
    });

    expect(route.review).toEqual({ path: '.melos/review-result.json' });
    expect(route.report).toEqual({ path: '.melos/final-report.json', stdout: true });
  });

  it('fills in declarative route defaults for omitted artifact paths', () => {
    const route = createRoute({
      task: 'Implement the task',
      run: { engine: 'auto' },
      review: {},
      report: { stdout: false },
    });

    expect(route.review).toEqual({ path: '.melos/review-result.json' });
    expect(route.report).toEqual({ path: '.melos/final-report.json', stdout: false });
  });

  it('fills in report defaults when runtime route omits report entirely', () => {
    const route = createRuntimeRoute({
      prompt: 'Implement the task',
      run: { engine: 'auto' },
      evaluate: () => ({ ok: true, status: 'pass', summary: 'done', metrics: {} }),
      policy: () => ({ kind: 'stop', success: true }),
    });

    expect(route.report).toEqual({ path: '.melos/final-report.json', stdout: true });
  });

  it('fills in report defaults when declarative route omits report entirely', () => {
    const route = createRoute({
      task: 'Implement the task',
      run: { engine: 'auto' },
    });

    expect(route.report).toEqual({ path: '.melos/final-report.json', stdout: true });
  });
});
