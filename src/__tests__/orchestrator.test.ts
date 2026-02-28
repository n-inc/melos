import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import { Orchestrator } from '../orchestrator.js';
import { ManagerAgent } from '../agents/manager.js';
import { WorkerAgent } from '../agents/worker.js';
import { createMissionPlan } from '../state/mission.js';

describe('Orchestrator v0.8', () => {
  it('runs mission state machine to completion', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Sample mission\n\nImplement feature.', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'sample',
      goal: 'Sample mission',
      constraints: ['No backward compatibility'],
      successCriteria: ['tests pass'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Build core',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement core feature',
              status: 'pending',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');
    jest.spyOn(WorkerAgent.prototype, 'run').mockResolvedValue({
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: 'm1',
        featureId: 'm1-f1',
        status: 'SUCCESS',
        summary: 'done',
        filesChanged: [],
        validation: {
          testsRun: true,
          testsPassed: 1,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: [],
        discoveredFeatures: [],
        learnings: [],
        requestsHelp: false,
        tokenUsage: {
          input: 100,
          output: 50,
          cached: 10,
        },
        createdAt: new Date().toISOString(),
      },
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 10,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(result.reason).toBe('completed');
  });
});
