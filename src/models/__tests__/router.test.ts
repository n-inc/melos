import { ModelRouter } from '../router.js';

describe('models/router', () => {
  it('returns assignments and resolves engines', () => {
    const router = new ModelRouter({
      assignments: {
        planner: 'opus',
        worker: 'gpt-5.3-codex',
        validator: 'sonnet',
        research: 'haiku',
      },
      escalationPolicy: {
        enabled: true,
        maxEscalations: 2,
        chain: {
          haiku: 'sonnet',
          sonnet: 'opus',
        },
      },
    });

    const assignments = router.getAssignments();
    expect(assignments.planner.engine).toBe('claude');
    expect(assignments.worker.engine).toBe('codex');
    expect(router.resolveEngine('gpt-5.3-codex')).toBe('codex');
  });

  it('escalates model according to chain', () => {
    const router = new ModelRouter({
      assignments: {
        planner: 'haiku',
        worker: 'gpt-5.3-codex',
        validator: 'sonnet',
        research: 'sonnet',
      },
      escalationPolicy: {
        enabled: true,
        maxEscalations: 2,
        chain: {
          haiku: 'sonnet',
          sonnet: 'opus',
        },
      },
    });

    expect(router.escalate('planner')).toEqual({ escalated: true, newModel: 'sonnet' });
    expect(router.escalate('planner')).toEqual({ escalated: true, newModel: 'opus' });
    expect(router.escalate('planner')).toEqual({ escalated: false, newModel: 'opus' });
  });
});
