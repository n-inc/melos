import { mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkReport,
  saveWorkReport,
  loadWorkReport,
  type WorkReport,
} from '../work-report.js';

describe('work-report.ts', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `melos-work-report-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('createWorkReport', () => {
    it('creates a SUCCESS WorkReport', () => {
      const report = createWorkReport({
        iteration: 1,
        taskId: 'task-1',
        status: 'SUCCESS',
        summary: 'Task completed successfully',
      });

      expect(report.iteration).toBe(1);
      expect(report.taskId).toBe('task-1');
      expect(report.status).toBe('SUCCESS');
      expect(report.summary).toBe('Task completed successfully');
      expect(report.filesChanged).toEqual([]);
      expect(report.verification.testsRun).toBe(false);
      expect(report.requestsHelp).toBe(false);
      expect(report.createdAt).toBeDefined();
    });

    it('creates a FAILED WorkReport with issues', () => {
      const report = createWorkReport({
        iteration: 2,
        taskId: 'task-2',
        status: 'FAILED',
        summary: 'Task failed due to error',
        issues: ['Error 1', 'Error 2'],
      });

      expect(report.status).toBe('FAILED');
      expect(report.issues).toEqual(['Error 1', 'Error 2']);
    });

    it('creates a BLOCKED WorkReport with help request', () => {
      const report = createWorkReport({
        iteration: 3,
        taskId: 'task-3',
        status: 'BLOCKED',
        summary: 'Need clarification',
        requestsHelp: true,
        helpReason: 'API credentials not available',
      });

      expect(report.status).toBe('BLOCKED');
      expect(report.requestsHelp).toBe(true);
      expect(report.helpReason).toBe('API credentials not available');
    });

    it('creates a WorkReport with file changes', () => {
      const report = createWorkReport({
        iteration: 1,
        taskId: 'task-1',
        status: 'SUCCESS',
        summary: 'Added new feature',
        filesChanged: [
          { path: 'src/feature.ts', additions: 100, deletions: 0 },
          { path: 'src/feature.test.ts', additions: 50, deletions: 0 },
        ],
      });

      expect(report.filesChanged).toHaveLength(2);
      expect(report.filesChanged[0].path).toBe('src/feature.ts');
      expect(report.filesChanged[0].additions).toBe(100);
    });

    it('creates a WorkReport with verification results', () => {
      const report = createWorkReport({
        iteration: 1,
        taskId: 'task-1',
        status: 'SUCCESS',
        summary: 'All tests pass',
        verification: {
          testsRun: true,
          testsPassed: 10,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
      });

      expect(report.verification.testsRun).toBe(true);
      expect(report.verification.testsPassed).toBe(10);
      expect(report.verification.testsFailed).toBe(0);
      expect(report.verification.lintPassed).toBe(true);
      expect(report.verification.typecheckPassed).toBe(true);
    });

    it('creates a WorkReport with success criteria results', () => {
      const report = createWorkReport({
        iteration: 1,
        taskId: 'task-1',
        status: 'PARTIAL',
        summary: 'Some criteria met',
        successCriteriaResults: [
          { criterion: 'Tests pass', passed: true },
          { criterion: 'Coverage > 80%', passed: false, note: 'Only 70%' },
        ],
      });

      expect(report.successCriteriaResults).toHaveLength(2);
      expect(report.successCriteriaResults[0].passed).toBe(true);
      expect(report.successCriteriaResults[1].passed).toBe(false);
      expect(report.successCriteriaResults[1].note).toBe('Only 70%');
    });

    it('creates a WorkReport with learnings', () => {
      const report = createWorkReport({
        iteration: 1,
        taskId: 'task-1',
        status: 'SUCCESS',
        summary: 'Learned something',
        learnings: ['Pattern A works better', 'Avoid approach B'],
      });

      expect(report.learnings).toEqual([
        'Pattern A works better',
        'Avoid approach B',
      ]);
    });
  });

  describe('saveWorkReport and loadWorkReport', () => {
    it('saves and loads a WorkReport', async () => {
      const report = createWorkReport({
        iteration: 1,
        taskId: 'task-1',
        status: 'SUCCESS',
        summary: 'Test report',
      });

      await saveWorkReport(testDir, report);

      const loaded = await loadWorkReport(testDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.taskId).toBe('task-1');
      expect(loaded!.status).toBe('SUCCESS');
    });

    it('returns null when no WorkReport exists', async () => {
      const loaded = await loadWorkReport(testDir);
      expect(loaded).toBeNull();
    });

    it('saves WorkReport as JSON file', async () => {
      const report = createWorkReport({
        iteration: 1,
        taskId: 'task-1',
        status: 'SUCCESS',
        summary: 'Test',
      });

      await saveWorkReport(testDir, report);

      const filePath = join(testDir, 'WORK_REPORT.json');
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.taskId).toBe('task-1');
      expect(parsed.status).toBe('SUCCESS');
    });
  });
});
