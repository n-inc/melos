import { formatLogStreamLines } from '../log-stream.js';

describe('ui/log-stream exploration summaries', () => {
  it('summarizes consecutive low-priority exploration logs into one entry', () => {
    const lines = formatLogStreamLines([
      {
        seq: 45,
        timestamp: '2026-03-03T10:27:33.000Z',
        actor: 'manager',
        kind: 'READ',
        message: '/repo/HANDOFF.md (120 lines)',
      },
      {
        seq: 46,
        timestamp: '2026-03-03T10:27:34.000Z',
        actor: 'manager',
        kind: 'READ',
        message: '/repo/TASK.json (240 lines)',
      },
      {
        seq: 47,
        timestamp: '2026-03-03T10:27:35.000Z',
        actor: 'manager',
        kind: 'READ',
        message: '/repo/PROGRESS.md',
      },
      {
        seq: 48,
        timestamp: '2026-03-03T10:27:36.000Z',
        actor: 'manager',
        kind: 'READ',
        message: '/repo/README.md (100 lines)',
      },
      {
        seq: 49,
        timestamp: '2026-03-03T10:27:37.000Z',
        actor: 'manager',
        kind: 'READ',
        message: '/repo/PRD.md',
      },
      {
        seq: 50,
        timestamp: '2026-03-03T10:27:38.000Z',
        actor: 'manager',
        kind: 'BASH',
        message: 'rg -n "studentPageContent|students\\.lp\\.e2e|\\[\\.\\.\\.slug\\]" src tests pages',
      },
      {
        seq: 50.5,
        timestamp: '2026-03-03T10:27:38.500Z',
        actor: 'manager',
        kind: 'DONE',
        message: 'exit=0 52ms',
      },
      {
        seq: 51,
        timestamp: '2026-03-03T10:27:39.000Z',
        actor: 'manager',
        kind: 'INFO',
        message: '120: studentPageContent.ts',
        detailLines: [
          '188: students.lp.e2e.ts',
          '201: [...slug].tsx',
        ],
      },
      {
        seq: 52,
        timestamp: '2026-03-03T10:27:40.000Z',
        actor: 'manager',
        kind: 'INFO',
        message: 'File does not exist. Note: your current working directory is /repo.',
      },
      {
        seq: 54,
        timestamp: '2026-03-03T10:27:42.000Z',
        actor: 'manager',
        kind: 'INFO',
        message: 'verbose tool output omitted (3797 chars)',
      },
      {
        seq: 55,
        timestamp: '2026-03-03T10:27:43.000Z',
        actor: 'manager',
        kind: 'BASH',
        message: 'npm test -- src/ui/__tests__/tui-views.test.ts --runInBand',
      },
      {
        seq: 56,
        timestamp: '2026-03-03T10:27:44.000Z',
        actor: 'manager',
        kind: 'WARN',
        message: '[worker] m1-f1: manual verification is still required',
      },
    ], {
      useColor: false,
      showSeq: true,
      showActor: true,
      summarizeExploration: true,
    });

    expect(lines).toContain('#0045 10:27:33 MANAGER    [EXPLORED] 5 files, 3 searches, 1 omitted output');
    expect(lines).toContain('  │ Read: HANDOFF.md, TASK.json, PROGRESS.md, README.md, PRD.md');
    expect(lines).toContain('  │ Search: studentPageContent, students.lp.e2e, [...slug]');
    expect(lines).toContain('  │ Notes: PRD.md missing');
    expect(lines).not.toContain('exit=0 52ms');
    expect(lines).not.toContain('120: studentPageContent.ts');
    expect(lines).toContain('#0055 10:27:43 MANAGER    [BASH] npm test -- src/ui/__tests__/tui-views.test.ts --runInBand');
    expect(lines).toContain('#0056 10:27:44 MANAGER    [WARN] [worker] m1-f1: manual verification is still required');
  });

  it('drops low-priority info-only groups instead of rendering empty summaries', () => {
    const lines = formatLogStreamLines([
      {
        seq: 1,
        timestamp: '2026-03-03T10:27:33.000Z',
        actor: 'manager',
        kind: 'INFO',
        message: 'No matches found',
      },
      {
        seq: 2,
        timestamp: '2026-03-03T10:27:34.000Z',
        actor: 'manager',
        kind: 'INFO',
        message: '> @n-inc/melos@0.8.0 typecheck > tsc --noEmit',
      },
      {
        seq: 3,
        timestamp: '2026-03-03T10:27:35.000Z',
        actor: 'manager',
        kind: 'BASH',
        message: 'npm test',
      },
    ], {
      useColor: false,
      showSeq: true,
      showActor: true,
      summarizeExploration: true,
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('LOG START: MANAGER');
    expect(lines[1]).toContain('[BASH] npm test');
  });
});
