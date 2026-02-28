import { overviewView } from '../tui-overview.js';
import { featuresView } from '../tui-features.js';
import { workersView } from '../tui-workers.js';
import { modelsView } from '../tui-models.js';
import { costsView } from '../tui-costs.js';
import type { MissionControlState } from '../tui-views.js';

function createState(): MissionControlState {
  return {
    missionId: 'auth',
    missionTitle: 'Auth mission',
    missionState: 'running',
    elapsedLabel: '5m 42s',
    progressLabel: '3/5 (60%)',
    progressPercent: 60,
    activeMilestoneId: 'm2',
    activeFeatureId: 'm2-f3',
    activeBranch: 'melos/auth/m2-f3-auth-middleware',
    milestones: [
      {
        id: 'm1',
        title: 'Core',
        status: 'done',
        order: 1,
        features: [
          { id: 'm1-f1', description: 'User model', status: 'done', attempts: 1 },
        ],
      },
      {
        id: 'm2',
        title: 'Login API',
        status: 'in_progress',
        order: 2,
        features: [
          { id: 'm2-f1', description: 'POST /login', status: 'done', attempts: 1 },
          { id: 'm2-f2', description: 'POST /logout', status: 'done', attempts: 1 },
          { id: 'm2-f3', description: 'Auth middleware', status: 'in_progress', attempts: 2 },
          { id: 'm2-f4', description: 'Token refresh', status: 'pending', attempts: 0 },
        ],
      },
    ],
    progressLog: [
      { timestamp: '2026-02-28T12:00:00.000Z', message: 'worker #5 started' },
      { timestamp: '2026-02-28T12:00:10.000Z', message: 'npm test -- auth' },
    ],
    workerRuns: [
      {
        id: 5,
        type: 'implement',
        featureId: 'm2-f3',
        milestoneId: 'm2',
        status: 'running',
        durationLabel: '1m 12s',
        engine: 'codex',
        model: 'gpt-5.3-codex',
        log: ['Read src/middleware/auth.ts', 'Execute npm test -- auth'],
      },
    ],
    modelAssignments: {
      planner: { role: 'planner', engine: 'claude', model: 'opus' },
      worker: { role: 'worker', engine: 'codex', model: 'gpt-5.3-codex' },
      validator: { role: 'validator', engine: 'claude', model: 'sonnet' },
      research: { role: 'research', engine: 'claude', model: 'sonnet' },
    },
    tokenUsage: {
      total: { input: 12200, output: 7900, cached: 2450, cost: 0.23 },
      byRole: {
        planner: { model: 'opus', input: 4200, output: 2100, cached: 800, cost: 0.12 },
        worker: { model: 'gpt-5.3-codex', input: 6800, output: 5200, cached: 1200, cost: 0.08 },
      },
    },
  };
}

describe('ui/tui views', () => {
  it('renders overview view sections', () => {
    const lines = overviewView.render({ width: 100, height: 24 }, createState()).join('\n');
    expect(lines).toContain('Overview');
    expect(lines).toContain('Mission: Auth mission');
    expect(lines).toContain('Recent Log');
    expect(lines).toContain('Active Worker');
  });

  it('renders features view with active feature details', () => {
    const lines = featuresView.render({ width: 100, height: 24 }, createState()).join('\n');
    expect(lines).toContain('Features');
    expect(lines).toContain('m2 Login API');
    expect(lines).toContain('m2-f3 Auth middleware');
    expect(lines).toContain('Active Feature: m2-f3 Auth middleware');
  });

  it('renders workers view table and logs', () => {
    const lines = workersView.render({ width: 100, height: 24 }, createState()).join('\n');
    expect(lines).toContain('Workers');
    expect(lines).toContain('Worker Log');
    expect(lines).toContain('m2-f3');
    expect(lines).toContain('Execute npm test -- auth');
  });

  it('renders models view assignments', () => {
    const lines = modelsView.render({ width: 100, height: 24 }, createState()).join('\n');
    expect(lines).toContain('Models');
    expect(lines).toContain('planner');
    expect(lines).toContain('gpt-5.3-codex');
  });

  it('renders costs view totals', () => {
    const lines = costsView.render({ width: 100, height: 24 }, createState()).join('\n');
    expect(lines).toContain('Costs');
    expect(lines).toContain('Total');
    expect(lines).toContain('Estimated cost: $0.2300');
  });
});
