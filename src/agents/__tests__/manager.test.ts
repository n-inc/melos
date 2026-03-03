import { jest } from '@jest/globals';

import { ManagerAgent } from '../manager.js';

describe('ManagerAgent', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates mission plan from model output', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.3-codex',
    });
    const agentAny = agent as unknown as {
      codexEngine: {
        execute: (...args: unknown[]) => Promise<{
          success: boolean;
          output: string;
          exitCode: number;
        }>;
      };
    };
    const mockExecute = jest.spyOn(agentAny.codexEngine, 'execute').mockResolvedValue({
      success: true,
      output: `\`\`\`json\n${JSON.stringify({
        goal: 'Auth system',
        constraints: ['No backward compatibility'],
        successCriteria: ['Tests pass'],
        milestones: [
          {
            id: 'm1',
            title: 'Core',
            description: 'Implement core',
            validationContract: {
              staticChecks: [{ id: 'typecheck', description: 'Typecheck', type: 'auto:typecheck', command: 'npm run typecheck' }],
              testSuites: [{ id: 'test', description: 'Tests', type: 'auto:test', command: 'npm test' }],
            },
            features: [{ id: 'm1-f1', description: 'Implement auth', model: 'codex' }],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });

    const plan = await agent.generateMissionPlan({
      missionId: 'auth',
      prd: '# Auth system',
      approvalMethod: 'auto',
      prdFile: 'PRD.md',
    });

    expect(plan.version).toBe(2);
    expect(plan.mission.goal).toBe('Auth system');
    expect(plan.milestones[0]?.id).toBe('m1');
    expect(plan.milestones[0]?.features[0]?.id).toBe('m1-f1');
    expect(mockExecute).toHaveBeenCalled();
  });

  it('returns follow-up features from fallback when model output is invalid', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.3-codex',
    });
    const agentAny = agent as unknown as {
      codexEngine: {
        execute: (...args: unknown[]) => Promise<{
          success: boolean;
          output: string;
          error?: string;
          exitCode: number;
        }>;
      };
    };
    jest.spyOn(agentAny.codexEngine, 'execute').mockResolvedValue({
      success: false,
      output: '',
      error: 'failed',
      exitCode: 1,
    });

    const followUps = await agent.generateFollowUpFeatures({
      milestoneId: 'm1',
      failures: [
        {
          checkId: 'test',
          passed: false,
          failure: {
            summary: 'Jest failed',
            affectedFiles: ['src/a.ts'],
            errorMessages: ['error'],
          },
        },
      ],
      missionPlan: await agent.generateMissionPlan({
        missionId: 'sample',
        prd: '# Sample',
      }),
    });

    expect(followUps.length).toBeGreaterThan(0);
    expect(followUps[0]?.description).toContain('Jest');
  });

  it('falls back missing feature description in plan output', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.3-codex',
    });
    const agentAny = agent as unknown as {
      codexEngine: {
        execute: (...args: unknown[]) => Promise<{
          success: boolean;
          output: string;
          exitCode: number;
        }>;
      };
    };
    jest.spyOn(agentAny.codexEngine, 'execute').mockResolvedValue({
      success: true,
      output: `\`\`\`json\n${JSON.stringify({
        goal: 'Auth system',
        constraints: ['No backward compatibility'],
        successCriteria: ['Tests pass'],
        milestones: [
          {
            id: 'm1',
            title: 'Core',
            description: 'Implement core',
            validationContract: {
              staticChecks: [],
              testSuites: [],
            },
            features: [{ id: 'm1-f1', model: 'codex' }],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });

    const plan = await agent.generateMissionPlan({
      missionId: 'auth',
      prd: '# Auth system',
      approvalMethod: 'auto',
      prdFile: 'PRD.md',
    });

    expect(plan.milestones[0]?.features[0]?.description).toBe('No description provided');
  });
});
