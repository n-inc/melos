import { jest } from '@jest/globals';

import { WorkerAgent } from '../worker.js';
import { createMissionPlan } from '../../state/mission.js';

describe('WorkerAgent', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parses worker report from json output', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.3-codex',
    });

    const codexExecute = jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
      .mockResolvedValue({
        success: true,
        output: `\`\`\`json\n${JSON.stringify({
          status: 'SUCCESS',
          summary: 'feature implemented',
          filesChanged: [{ path: 'src/a.ts', additions: 12, deletions: 1 }],
          validation: {
            testsRun: true,
            testsPassed: 3,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          discoveredFeatures: [],
          learnings: ['learn'],
          requestsHelp: false,
        })}\n\`\`\``,
        exitCode: 0,
      });

    const plan = createMissionPlan({
      goal: 'Sample goal',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'feature',
              status: 'pending',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
      ],
    });

    const milestone = plan.milestones[0];
    const feature = milestone.features[0];
    const result = await agent.run({
      iteration: 1,
      missionPlan: plan,
      milestone,
      feature,
      prd: '# PRD',
      briefing: 'brief',
      currentBranch: 'test',
      baseBranch: 'main',
    });

    expect(result.type).toBe('success');
    expect(result.report.summary).toContain('feature implemented');
    expect(result.report.featureId).toBe('m1-f1');
    expect(codexExecute).toHaveBeenCalled();
  });

  it('reuses codex thread across multiple features in the same mission', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.3-codex',
    });
    const codexExecute = jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
      .mockResolvedValue({
        success: true,
        output: '```json\n{"status":"SUCCESS","summary":"ok","filesChanged":[],"validation":{"testsRun":false,"testsPassed":0,"testsFailed":0,"lintPassed":true,"typecheckPassed":true},"checks":[],"discoveredFeatures":[],"learnings":[],"requestsHelp":false}\n```',
        exitCode: 0,
      });

    const plan = createMissionPlan({
      missionId: 'mission-alpha',
      goal: 'Sample goal',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            { id: 'm1-f1', description: 'feature 1', status: 'pending', attempts: 0, model: 'codex' },
            { id: 'm1-f2', description: 'feature 2', status: 'pending', attempts: 0, model: 'codex' },
          ],
        },
      ],
    });

    agent.setResumeSession('thr_shared', 'mission-alpha');
    const milestone = plan.milestones[0];

    await agent.run({
      iteration: 1,
      missionPlan: plan,
      milestone,
      feature: milestone.features[0],
      prd: '# PRD',
    });
    await agent.run({
      iteration: 2,
      missionPlan: plan,
      milestone,
      feature: milestone.features[1],
      prd: '# PRD',
    });

    expect(codexExecute).toHaveBeenCalledTimes(2);
    const firstOptions = codexExecute.mock.calls[0]?.[1] as { threadId?: string } | undefined;
    const secondOptions = codexExecute.mock.calls[1]?.[1] as { threadId?: string } | undefined;
    expect(firstOptions?.threadId).toBe('thr_shared');
    expect(secondOptions?.threadId).toBe('thr_shared');
  });

  it('does not reuse thread when mission scope differs', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.3-codex',
    });
    const codexExecute = jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
      .mockResolvedValue({
        success: true,
        output: '```json\n{"status":"SUCCESS","summary":"ok","filesChanged":[],"validation":{"testsRun":false,"testsPassed":0,"testsFailed":0,"lintPassed":true,"typecheckPassed":true},"checks":[],"discoveredFeatures":[],"learnings":[],"requestsHelp":false}\n```',
        exitCode: 0,
      });

    const plan = createMissionPlan({
      missionId: 'mission-beta',
      goal: 'Sample goal',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            { id: 'm1-f1', description: 'feature 1', status: 'pending', attempts: 0, model: 'codex' },
          ],
        },
      ],
    });

    agent.setResumeSession('thr_other', 'different-mission');
    await agent.run({
      iteration: 1,
      missionPlan: plan,
      milestone: plan.milestones[0],
      feature: plan.milestones[0].features[0],
      prd: '# PRD',
    });

    const options = codexExecute.mock.calls[0]?.[1] as { threadId?: string } | undefined;
    expect(options?.threadId).toBeUndefined();
  });
});
