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

  it('requests planning output in the same language as PRD', async () => {
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
    const executeSpy = jest.spyOn(agentAny.codexEngine, 'execute').mockResolvedValue({
      success: true,
      output: `\`\`\`json\n${JSON.stringify({
        goal: '認証機能',
        constraints: ['後方互換なし'],
        successCriteria: ['テスト通過'],
        milestones: [
          {
            id: 'm1',
            title: '実装',
            description: '基本実装',
            validationContract: { staticChecks: [], testSuites: [] },
            features: [{ id: 'm1-f1', description: '実装する', model: 'codex' }],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });

    await agent.generateMissionPlan({
      missionId: 'lang-check',
      prd: '## 日本語PRD\n\n詳細を記載',
    });

    const prompt = String(executeSpy.mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('All natural language fields must be written in Japanese.');
    expect(prompt).toContain('BEGIN_MISSION_PLAN_JSON');
    expect(prompt).toContain('END_MISSION_PLAN_JSON');
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

  it('falls back in Japanese and emits fallback reason when PRD is Japanese', async () => {
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
      output: 'invalid planning response',
      exitCode: 0,
    });

    const events: Array<{ method: string; params: unknown }> = [];
    const plan = await agent.generateMissionPlan({
      missionId: 'ja-fallback',
      prd: '## ペルソナ別LPの実装\n\n要件を実装する。',
      onAppServerEvent: (method, params) => {
        events.push({ method, params });
      },
    });

    expect(plan.mission.goal).toBe('ペルソナ別LPの実装');
    expect(plan.milestones[0]?.title).toBe('コア実装');
    expect(plan.milestones[0]?.features[0]?.description).toBe('PRD の要求スコープを実装する');
    expect(events.some((event) => event.method === 'manager/fallback')).toBe(true);
  });

  it('parses mission JSON between explicit markers even with noisy text', async () => {
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
      output: [
        'planning note: {not-json}',
        'BEGIN_MISSION_PLAN_JSON',
        JSON.stringify({
          goal: 'ペルソナLP実装',
          constraints: ['後方互換は不要'],
          successCriteria: ['検証を通過'],
          milestones: [
            {
              id: 'm1',
              title: '基盤',
              description: '共通実装',
              validationContract: {
                staticChecks: [{ id: 'typecheck', description: '型チェック', type: 'auto:typecheck', command: 'npm run typecheck' }],
                testSuites: [{ id: 'test', description: 'テスト', type: 'auto:test', command: 'npm test' }],
              },
              features: [{ id: 'm1-f1', description: 'ルーティング実装', model: 'codex' }],
            },
          ],
        }),
        'END_MISSION_PLAN_JSON',
        'trailing text }',
      ].join('\n'),
      exitCode: 0,
    });

    const plan = await agent.generateMissionPlan({
      missionId: 'marker-parse',
      prd: '## ペルソナLP',
    });

    expect(plan.mission.goal).toBe('ペルソナLP実装');
    expect(plan.milestones[0]?.id).toBe('m1');
    expect(plan.milestones[0]?.features[0]?.description).toBe('ルーティング実装');
  });
});
