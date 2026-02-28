import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeWithOptions } from '../../cli.js';
import { createMissionPlan, loadMissionPlan, saveMissionPlan } from '../../state/mission.js';

describe('cli run artifacts', () => {
  let rootDir: string;
  let previousCwd: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'melos-run-artifacts-'));
    previousCwd = process.cwd();
    process.chdir(rootDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('produces consistent mission artifacts and logs on successful run', async () => {
    const prdPath = join(rootDir, 'PRD.md');
    const taskPath = join(rootDir, 'TASK.json');
    const melosDir = join(rootDir, '.melos');
    writeFileSync(prdPath, '# Artifact validation mission\n', 'utf-8');

    const mission = createMissionPlan({
      missionId: 'artifact-validation',
      goal: 'Artifact validation mission',
      constraints: ['No backward compatibility layer'],
      successCriteria: ['Mission completed'],
      state: 'running',
      milestones: [
        {
          id: 'm1',
          title: 'Completed scope',
          description: 'already done',
          status: 'done',
          order: 1,
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'done',
              status: 'done',
              attempts: 1,
              model: 'codex',
            },
          ],
        },
      ],
    });
    await saveMissionPlan(taskPath, mission);

    await executeWithOptions(
      {
        plain: true,
        dryRun: true,
        autoApprove: true,
      },
      { resume: false }
    );

    const savedMission = await loadMissionPlan(taskPath);
    expect(savedMission.state).toBe('completed');

    const handoffPath = join(rootDir, 'HANDOFF.md');
    expect(existsSync(handoffPath)).toBe(true);
    const handoff = readFileSync(handoffPath, 'utf-8');
    expect(handoff).toContain('# Melos Mission Handoff');
    expect(handoff).toContain('Artifact validation mission');
    expect(handoff).toContain('m1-f1');

    const eventsPath = join(melosDir, 'events.jsonl');
    expect(existsSync(eventsPath)).toBe(true);
    const eventTypes = readFileSync(eventsPath, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type?: string })
      .map((event) => event.type ?? '');
    expect(eventTypes).toContain('mission_started');
    expect(eventTypes).toContain('mission_completed');
    expect(eventTypes).toContain('snapshot_created');

    const snapshotPath = join(melosDir, 'state.json');
    expect(existsSync(snapshotPath)).toBe(true);
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as {
      state?: { kernel?: { progressLog?: Array<{ message?: string }> } };
    };
    const progressMessages = snapshot.state?.kernel?.progressLog?.map((entry) => entry.message ?? '') ?? [];
    expect(progressMessages.some((message) => message.includes('mission run started'))).toBe(true);
    expect(progressMessages.some((message) => message.includes('mission_completed'))).toBe(true);

    const runPath = join(melosDir, 'RUN.json');
    expect(existsSync(runPath)).toBe(false);
  });
});
