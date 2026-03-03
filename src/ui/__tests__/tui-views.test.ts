import { overviewView } from '../tui-overview.js';
import { featuresView } from '../tui-features.js';
import { workersView } from '../tui-workers.js';
import { modelsView } from '../tui-models.js';
import { prdView } from '../tui-prd.js';
import { taskView } from '../tui-task.js';
import type { MissionControlState } from '../tui-views.js';

function createState(): MissionControlState {
  return {
    missionId: 'auth',
    missionTitle: 'Auth mission',
    missionState: 'running',
    activity: 'Running m2-f3...',
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
    managerLog: [
      { timestamp: '2026-02-28T11:59:50.000Z', message: 'planning: Read PRD.md' },
      { timestamp: '2026-02-28T11:59:51.000Z', message: 'planning: Generated milestones' },
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
      planner: { role: 'planner', engine: 'claude', model: 'opus', effort: 'max' },
      worker: { role: 'worker', engine: 'codex', model: 'gpt-5.3-codex', effort: 'high' },
      validator: { role: 'validator', engine: 'codex', model: 'gpt-5.3-codex', effort: 'high' },
      research: { role: 'research', engine: 'claude', model: 'opus', effort: 'max' },
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
    expect(lines).toContain('Active Feature');
    expect(lines).toContain('Features');
    expect(lines).toContain('Progress Log');
    expect(lines).not.toContain('Active Worker');
    expect(lines).not.toContain('Execute npm test -- auth');
  });

  it('renders overview fallback message when progress log is empty', () => {
    const state = createState();
    state.progressLog = [];
    state.missionState = 'planning';
    state.activity = 'Planning mission from PRD.md...';
    const lines = overviewView.render({ width: 100, height: 24 }, state).join('\n');
    expect(lines).toContain('Progress Log (mission events)');
    expect(lines).toContain('Planning mission from PRD.md...');
  });

  it('renders PRD view', () => {
    const state = createState();
    state.prdPreviewLines = ['# PRD Heading', 'Implement persona LP pages'];
    const lines = prdView.render({ width: 100, height: 24 }, state).join('\n');
    expect(lines).toContain('PRD');
    expect(lines).toContain('Line 1-2 / 2');
    expect(lines).toContain('# PRD Heading');
  });

  it('renders TASK view', () => {
    const state = createState();
    state.taskPreviewLines = ['# Structured TASK View', '[x] m1 Core [done]', '```json', '{', '  "state": "running"', '}'];
    const lines = taskView.render({ width: 100, height: 24 }, state).join('\n');
    expect(lines).toContain('TASK');
    expect(lines).toContain('# Structured TASK View');
    expect(lines).toContain('[x] m1 Core [done]');
    expect(lines).toContain('"state": "running"');
  });

  it('wraps long preview lines in PRD view', () => {
    const state = createState();
    state.prdPreviewLines = [
      'This is a very long preview line that should wrap instead of being heavily truncated in docs panel rendering.',
    ];
    const lines = prdView.render({ width: 70, height: 20 }, state).join('\n');
    expect(lines).toContain('This is a very long preview line');
    expect(lines).toContain('heavily truncated in docs panel rendering.');
  });

  it('supports scroll offset in TASK view', () => {
    const state = createState();
    state.taskPreviewLines = Array.from({ length: 40 }, (_, idx) => `line-${idx + 1}`);
    const top = taskView.render({ width: 80, height: 20 }, state, { scrollOffset: 0 }).join('\n');
    const scrolled = taskView.render({ width: 80, height: 20 }, state, { scrollOffset: 10 }).join('\n');
    expect(top).toContain('line-1');
    expect(scrolled).toContain('line-11');
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
    expect(lines).toContain('Active Worker');
    expect(lines).toContain('Manager Log Stream');
    expect(lines).toContain('Worker Log Stream');
    expect(lines).toContain('planning: Generated milestones');
    expect(lines).toContain('m2-f3');
    expect(lines).toContain('Execute npm test -- auth');
  });

  it('renders waiting message when worker has no structured logs yet', () => {
    const state = createState();
    state.workerRuns = [
      {
        id: 8,
        type: 'implement',
        featureId: 'm2-f4',
        milestoneId: 'm2',
        status: 'running',
        durationLabel: '0m 09s',
        engine: 'codex',
        model: 'gpt-5.3-codex',
        log: [],
      },
    ];
    state.activity = 'Worker executing m2-f4...';
    const lines = workersView.render({ width: 100, height: 24 }, state).join('\n');
    expect(lines).toContain('No structured worker events yet.');
    expect(lines).toContain('Current activity: Worker executing m2-f4...');
  });

  it('renders models view assignments', () => {
    const lines = modelsView.render({ width: 100, height: 24 }, createState()).join('\n');
    expect(lines).toContain('Models');
    expect(lines).toContain('planner');
    expect(lines).toContain('gpt-5.3-codex');
    expect(lines).toContain('Effort');
    expect(lines).toContain('max');
    expect(lines).toContain('high');
    expect(lines).toContain('1 Planner');
    expect(lines).toContain('4 Research');
  });

});
