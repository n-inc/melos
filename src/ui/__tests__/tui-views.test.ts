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
    currentActor: 'worker',
    logEntries: [
      { timestamp: '2026-02-28T11:59:50.000Z', actor: 'planning', kind: 'READ', message: 'PRD.md (3 lines)' },
      { timestamp: '2026-02-28T11:59:51.000Z', actor: 'planning', kind: 'PLAN_CREATED', message: 'milestones=2 features=4' },
      { timestamp: '2026-02-28T12:00:00.000Z', actor: 'worker', kind: 'READ', message: 'src/middleware/auth.ts' },
      { timestamp: '2026-02-28T12:00:10.000Z', actor: 'worker', kind: 'BASH', message: 'npm test -- auth' },
    ],
    milestones: [
      {
        id: 'm1',
        title: 'Core',
        status: 'done',
        features: [
          { id: 'm1-f1', description: 'User model', status: 'done', attempts: 1 },
        ],
      },
      {
        id: 'm2',
        title: 'Login API',
        status: 'in_progress',
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
        model: 'gpt-5.4',
        log: [
          { timestamp: '2026-02-28T12:00:00.000Z', actor: 'worker', kind: 'READ', message: 'src/middleware/auth.ts' },
          { timestamp: '2026-02-28T12:00:10.000Z', actor: 'worker', kind: 'BASH', message: 'npm test -- auth' },
        ],
      },
    ],
    modelAssignments: {
      planner: { role: 'planner', engine: 'claude', model: 'opus', effort: 'max' },
      worker: { role: 'worker', engine: 'codex', model: 'gpt-5.4', effort: 'xhigh' },
    },
  };
}

describe('ui/tui views', () => {
  it('renders overview view sections', () => {
    const lines = overviewView.render({ width: 100, height: 24 }, createState()).join('\n');
    expect(lines).toContain('Overview');
    expect(lines).toContain('MISSION SUMMARY');
    expect(lines).toContain('FEATURES');
    expect(lines).toContain('RECENT EVENTS');
    expect(lines).not.toContain('Active Worker');
    expect(lines).not.toContain('Execute npm test -- auth');
  });

  it('renders overview fallback message when progress log is empty', () => {
    const state = createState();
    state.progressLog = [];
    state.missionState = 'planning';
    state.activity = 'Planning mission from PRD.md...';
    const lines = overviewView.render({ width: 100, height: 24 }, state).join('\n');
    expect(lines).toContain('RECENT EVENTS');
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
    expect(lines).toContain('m2-f3 [U:-] Auth middleware');
    expect(lines).toContain('Active Feature: m2-f3 Auth middleware');
    expect(lines).toContain('Model: -');
    expect(lines).toContain('Model Source: default');
  });

  it('hides repetitive manager heartbeat lines in overview when richer events exist', () => {
    const state = createState();
    state.progressLog = [
      { timestamp: '2026-02-28T12:00:00.000Z', message: 'Manager started feature briefing for m1-f1' },
      { timestamp: '2026-02-28T12:00:05.000Z', message: 'Manager is preparing briefing for m1-f1 (5s elapsed)' },
      { timestamp: '2026-02-28T12:00:07.000Z', message: '[READ] /repo/TASK.json' },
      { timestamp: '2026-02-28T12:00:10.000Z', message: 'Manager is preparing briefing for m1-f1 (10s elapsed)' },
    ];

    const lines = overviewView.render({ width: 100, height: 24 }, state).join('\n');

    expect(lines).toContain('[READ] /repo/TASK.json');
    expect(lines).not.toContain('10s elapsed');
  });

  it('shows a single heartbeat in features view when no richer event exists yet', () => {
    const state = createState();
    state.progressLog = [
      { timestamp: '2026-02-28T12:00:05.000Z', message: 'Manager is preparing briefing for m1-f1 (5s elapsed)' },
      { timestamp: '2026-02-28T12:00:10.000Z', message: 'Manager is preparing briefing for m1-f1 (10s elapsed)' },
    ];

    const lines = featuresView.render({ width: 140, height: 24 }, state).join('\n');

    expect(lines).toContain('12:00:10 Manager is preparing briefing for m1-f1');
    expect(lines).not.toContain('5s elapsed');
  });

  it('renders workers view table and logs', () => {
    const lines = workersView.render({ width: 100, height: 24 }, createState()).join('\n');
    expect(lines).toContain('NOW RUNNING');
    expect(lines).toContain('SWITCH: PLANNING -> WORKER');
    expect(lines).toContain('[EXPLORED] 1 file');
    expect(lines).toContain('Read: auth.ts');
    expect(lines).toContain('m2-f3');
    expect(lines).toContain('[BASH] npm test -- auth');
  });

  it('supports scroll offset in workers view', () => {
    const state = createState();
    state.logEntries = Array.from({ length: 20 }, (_, index) => ({
      timestamp: `2026-02-28T12:00:${String(index).padStart(2, '0')}.000Z`,
      actor: 'worker' as const,
      kind: 'INFO',
      message: `line-${index + 1}`,
    }));
    const top = workersView.render({ width: 80, height: 10 }, state, { scrollOffset: 0 }).join('\n');
    const scrolled = workersView.render({ width: 80, height: 10 }, state, { scrollOffset: 8 }).join('\n');
    expect(top).toContain('line-1');
    expect(scrolled).toContain('line-9');
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
        model: 'gpt-5.4',
        log: [],
      },
    ];
    state.activity = 'Worker executing m2-f4...';
    state.logEntries = [];
    const lines = workersView.render({ width: 100, height: 24 }, state).join('\n');
    expect(lines).toContain('No logs yet. Waiting for next event...');
    expect(lines).toContain('NOW RUNNING  WORKER #8');
  });

  it('renders models view assignments', () => {
    const lines = modelsView.render({ width: 100, height: 24 }, createState()).join('\n');
    expect(lines).toContain('Models');
    expect(lines).toContain('planner');
    expect(lines).toContain('gpt-5.4');
    expect(lines).toContain('Effort');
    expect(lines).toContain('max');
    expect(lines).toContain('high');
    expect(lines).toContain('1 Planner');
    expect(lines).toContain('2 Worker');
  });

});
