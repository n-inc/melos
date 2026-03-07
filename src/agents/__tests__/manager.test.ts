import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';

import { ManagerAgent } from '../manager.js';
import { createMissionPlan } from '../../state/mission.js';

describe('ManagerAgent', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('routes planner model gpt-5.4 to codex engine', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4',
    });
    const agentAny = agent as unknown as {
      codexEngine: {
        execute: (...args: unknown[]) => Promise<{
          success: boolean;
          output: string;
          exitCode: number;
        }>;
      };
      claudeEngine: {
        execute: (...args: unknown[]) => Promise<unknown>;
      };
    };
    const codexExecute = jest.spyOn(agentAny.codexEngine, 'execute').mockResolvedValue({
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
              qaChecks: [],
            },
            features: [{ id: 'm1-f1', description: 'Implement auth', model: 'codex' }],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });
    const claudeExecute = jest.spyOn(agentAny.claudeEngine, 'execute');

    const plan = await agent.generateMissionPlan({
      missionId: 'auth',
      prd: '# Auth system',
    });

    expect(plan.mission.goal).toBe('Auth system');
    expect(codexExecute).toHaveBeenCalled();
    expect(claudeExecute).not.toHaveBeenCalled();
  });

  it('builds feature briefing locally without invoking engines', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
    });
    const agentAny = agent as unknown as {
      codexEngine: {
        execute: (...args: unknown[]) => Promise<unknown>;
      };
      claudeEngine: {
        execute: (...args: unknown[]) => Promise<unknown>;
      };
    };
    const codexExecute = jest.spyOn(agentAny.codexEngine, 'execute');
    const claudeExecute = jest.spyOn(agentAny.claudeEngine, 'execute');

    const missionPlan = createMissionPlan({
      missionId: 'student-lp',
      goal: 'studentPageContent を source of truth にして persona 導線を統一する',
      constraints: ['No backward compatibility layer'],
      successCriteria: ['Persona pages are routed from the unified source'],
      milestones: [
        {
          id: 'm1',
          title: 'Persona migration',
          description: '既存 persona page を統合ルートへ移行する',
          status: 'in_progress',
          validationContract: {
            staticChecks: [
              {
                id: 'typecheck',
                description: 'Typecheck must pass',
                type: 'auto:typecheck',
                command: 'npm run typecheck',
                passed: false,
                failureCount: 0,
              },
            ],
            testSuites: [
              {
                id: 'test',
                description: 'Tests must pass',
                type: 'auto:test',
                command: 'npm test',
                passed: false,
                failureCount: 0,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'student persona route を hard cutover で移行する',
              checks: [{ text: 'studentPageContent を source of truth に保つ', type: 'product' }],
              status: 'in_progress',
              attempts: 1,
            },
          ],
        },
      ],
      state: 'running',
    });
    const milestone = missionPlan.milestones[0]!;
    const feature = milestone.features[0]!;

    const briefing = await agent.generateFeatureBriefing({
      iteration: 1,
      maxIterations: 3,
      missionPlan,
      activeMilestone: milestone,
      activeFeature: feature,
      prd: '',
      latestValidationReport: null,
      latestWorkerReport: null,
    });

    expect(briefing).toContain('## Objective');
    expect(briefing).toContain('## Constraints');
    expect(briefing).toContain('## Validation focus');
    expect(briefing).toContain('## Risks');
    expect(briefing).toContain('source of truth は TASK.json');
    expect(briefing).toContain('npm run typecheck');
    expect(briefing).toContain('PRD が読み込めていない');
    expect(codexExecute).not.toHaveBeenCalled();
    expect(claudeExecute).not.toHaveBeenCalled();
  });

  it('generates mission plan from model output', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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

    expect(plan.version).toBe(3);
    expect(plan.mission.goal).toBe('Auth system');
    expect(plan.milestones[0]?.id).toBe('m1');
    expect(plan.milestones[0]?.features[0]?.id).toBe('m1-f1');
    expect(mockExecute).toHaveBeenCalled();
  });

  it('synthesizes a dedicated qa feature from qaChecks in planner output', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
        goal: 'Students LP',
        constraints: ['No backward compatibility'],
        successCriteria: ['QA can be executed'],
        milestones: [
          {
            id: 'm1',
            title: 'Implement',
            description: 'Ship UI',
            validationContract: {
              staticChecks: [],
              testSuites: [],
              qaChecks: [
                {
                  id: 'm1-qa-1',
                  description: 'Verify Students LP hero',
                  type: 'browser',
                  requiredRunner: 'playwright-interactive',
                  requiredArtifacts: ['screenshot'],
                },
              ],
            },
            features: [{ id: 'm1-f1', description: 'Implement UI', model: 'codex-latest', cwd: 'frontend/apps/web' }],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });

    const plan = await agent.generateMissionPlan({
      missionId: 'students-lp',
      prd: '# Students LP',
    });

    expect(plan.milestones[0]?.validationContract.qaChecks).toHaveLength(1);
    expect(plan.milestones[0]?.features.at(-1)).toMatchObject({
      kind: 'qa',
      model: 'codex-latest',
      cwd: 'frontend/apps/web',
    });
  });

  it('appends post-pr follow-up milestone when automation is enabled', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
      pullRequestAutomationEnabled: true,
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
            features: [{ id: 'm1-f1', description: 'Implement auth', model: 'codex' }],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });

    const plan = await agent.generateMissionPlan({
      missionId: 'auth',
      prd: '# Auth system',
    });

    expect(plan.milestones.at(-1)).toMatchObject({
      title: 'Post-PR Follow-up',
      features: [
        expect.objectContaining({
          kind: 'pull_request',
          model: 'claude-latest',
        }),
        expect.objectContaining({
          kind: 'pr_followup',
          model: 'claude-latest',
        }),
      ],
    });
  });

  it('normalizes hardcoded local dev ports in validation commands', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
        goal: 'Students LP',
        constraints: ['Use repo standard local URL resolution'],
        successCriteria: ['Smoke command uses repo port'],
        milestones: [
          {
            id: 'm1',
            title: 'QA',
            description: 'Run smoke',
            validationContract: {
              staticChecks: [],
              testSuites: [
                {
                  id: 'lp-smoke',
                  description: 'Run LP smoke',
                  type: 'auto:test',
                  command: 'bash -lc \'PORT=8000 pnpm dev && curl http://127.0.0.1:8000 && next dev -p 8000\'',
                },
              ],
            },
            features: [{ id: 'm1-f1', description: 'Verify QA flow', model: 'codex' }],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });

    const plan = await agent.generateMissionPlan({
      missionId: 'students-lp',
      prd: '# Students LP\n\nUse `.port` / `CONDUCTOR_PORT` for local URLs.',
    });

    expect(plan.milestones[0]?.validationContract.testSuites[0]?.command).toBe(
      'bash -lc \'PORT=$(cat .port 2>/dev/null || echo ${CONDUCTOR_PORT:-8000}) pnpm dev && curl http://127.0.0.1:$PORT && next dev -p $PORT\''
    );
  });

  it('returns follow-up features from fallback when model output is invalid', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
    expect(followUps[0]?.trackingKey).toBe('jest-failed');
  });

  it('groups fallback follow-up features by shared root cause', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
          checkId: 'typecheck',
          passed: false,
          failure: {
            summary: 'Typecheck failed',
            affectedFiles: ['src/a.ts'],
            errorMessages: ['error'],
            rootCause: 'shared ts config mismatch',
          },
        },
        {
          checkId: 'unit-test',
          passed: false,
          failure: {
            summary: 'Unit test failed',
            affectedFiles: ['src/b.ts'],
            errorMessages: ['error'],
            rootCause: 'shared ts config mismatch',
          },
        },
      ],
      missionPlan: await agent.generateMissionPlan({
        missionId: 'sample',
        prd: '# Sample',
      }),
    });

    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.trackingKey).toBe('shared-ts-config-mismatch');
    expect(followUps[0]?.description).toContain('shared ts config mismatch');
  });

  it('fills missing follow-up descriptions from tracking data and merges duplicates', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
      output: `\`\`\`json\n${JSON.stringify([
        {
          trackingKey: 'shared-jest-root-cause',
          priority: 'medium',
          affectedChecks: ['jest'],
          rationale: 'First draft',
        },
        {
          description: 'Resolve flaky jest setup',
          trackingKey: 'shared-jest-root-cause',
          priority: 'high',
          affectedChecks: ['jest', 'lint'],
          rationale: 'More specific',
        },
      ])}\n\`\`\``,
      exitCode: 0,
    });

    const followUps = await agent.generateFollowUpFeatures({
      milestoneId: 'm1',
      failures: [
        {
          checkId: 'jest',
          passed: false,
          failure: {
            summary: 'Jest failed',
            affectedFiles: ['src/a.ts'],
            errorMessages: ['error'],
            rootCause: 'shared jest root cause',
          },
        },
        {
          checkId: 'lint',
          passed: false,
          failure: {
            summary: 'Lint failed',
            affectedFiles: ['src/b.ts'],
            errorMessages: ['error'],
          },
        },
      ],
      missionPlan: await agent.generateMissionPlan({
        missionId: 'sample',
        prd: '# Sample',
      }),
    });

    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toEqual({
      description: 'Resolve flaky jest setup',
      trackingKey: 'shared-jest-root-cause',
      priority: 'high',
      affectedChecks: ['jest', 'lint'],
      rationale: 'More specific',
      model: 'codex-latest',
    });
  });

  it('requests planning output in the same language as PRD', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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

  it('caps planning prompt size before sending it to the model', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-manager-planning-budget-'));
    mkdirSync(join(cwd, 'src'), { recursive: true });
    for (let index = 0; index < 300; index += 1) {
      writeFileSync(
        join(cwd, 'src', `feature-${String(index).padStart(3, '0')}.ts`),
        [
          `export const feature${index} = 'students';`,
          `export const notes${index} = '${'copy '.repeat(120)}';`,
        ].join('\n'),
        'utf-8'
      );
    }

    const agent = new ManagerAgent({
      cwd,
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
        goal: 'Student LP',
        constraints: ['No backward compatibility'],
        successCriteria: ['Plan is valid'],
        milestones: [
          {
            id: 'm1',
            title: 'Planning',
            description: 'Plan the work',
            validationContract: { staticChecks: [], testSuites: [] },
            features: [{ id: 'm1-f1', description: 'Implement student LP', model: 'codex' }],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });

    await agent.generateMissionPlan({
      missionId: 'planning-budget',
      prd: `# Student LP\n\n${'students '.repeat(40_000)}`,
    });

    const prompt = String(executeSpy.mock.calls[0]?.[0] ?? '');
    expect(prompt.length).toBeLessThanOrEqual(220_000);
    expect(prompt).toContain('planner prompt budget');
  });

  it('falls back missing feature description in plan output', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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

    expect(plan.milestones[0]?.features[0]?.description).toBe('Feature m1-f1');
  });

  it('falls back in Japanese and emits fallback reason when PRD is Japanese', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
      prd: [
        '## ペルソナ別LPの実装',
        '- ForPageLayout を実装する',
        '- ページルーティングを追加する',
        '## SEO',
        '- JSON-LD を追加する',
        '- canonical / og を設定する',
      ].join('\n'),
      onAppServerEvent: (method, params) => {
        events.push({ method, params });
      },
    });

    expect(plan.mission.goal).toBe('ペルソナ別LPの実装');
    expect(plan.milestones.length).toBeGreaterThanOrEqual(2);
    expect(plan.milestones[0]?.features[0]?.description).toContain('ForPageLayout');
    expect(events.some((event) => event.method === 'manager/fallback')).toBe(true);
  });

  it('includes planner output preview in fallback event when execution fails', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
      output: "There's an issue with the selected model (gpt-5.4). It may not exist or you may not have access to it.",
      error: 'Process exited with code 1',
      exitCode: 1,
    });

    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    await agent.generateMissionPlan({
      missionId: 'planner-failure-preview',
      prd: '# Sample mission',
      onAppServerEvent: (method, params) => {
        if (method === 'manager/fallback' && params && typeof params === 'object') {
          events.push({ method, params: params as Record<string, unknown> });
        }
      },
    });

    const fallback = events[0]?.params;
    expect(fallback?.reason).toBe('planner engine execution failed');
    expect(fallback?.error).toBe('Process exited with code 1');
    expect(String(fallback?.outputPreview ?? '')).toContain('selected model (gpt-5.4)');
    expect(String(fallback?.detail ?? '')).toContain('output:');
  });

  it('parses mission JSON between explicit markers even with noisy text', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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

  it('accepts planner output in MissionPlan-like shape with mission object and tasks alias', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
      output: JSON.stringify({
        version: 2,
        mission: {
          goal: 'ペルソナLP実装',
          constraints: ['後方互換なし'],
          successCriteria: ['テスト通過'],
        },
        milestones: [
          {
            id: 'm1',
            title: '基盤',
            description: '共通土台',
            tasks: [
              { id: 'm1-f1', title: 'ルーティング実装', model: 'codex' },
            ],
          },
        ],
      }),
      exitCode: 0,
    });

    const plan = await agent.generateMissionPlan({
      missionId: 'mission-shape',
      prd: '## ペルソナLP実装',
    });

    expect(plan.mission.goal).toBe('ペルソナLP実装');
    expect(plan.milestones[0]?.features[0]?.description).toBe('ルーティング実装');
  });

  it('adds phase-based sizing guidance to planning prompt', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
        goal: 'Auth system',
        constraints: ['No backward compatibility'],
        successCriteria: ['Tests pass'],
        milestones: [
          {
            id: 'm1',
            title: 'Core',
            description: 'Implement core',
            validationContract: { staticChecks: [], testSuites: [] },
            features: [{ id: 'm1-f1', description: 'Implement auth', model: 'codex' }],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });

    await agent.generateMissionPlan({
      missionId: 'size-guidance',
      prd: '# Auth system',
    });

    const prompt = String(executeSpy.mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('Prefer 2-3 milestones (phases)');
    expect(prompt).toContain('For large implementations, keep phase count compact but allow sufficient features');
    expect(prompt).toContain('Default feature model is codex-latest');
    expect(prompt).toContain('Use model "claude-latest" only when the primary deliverable is a user-visible UI change in the rendered surface.');
    expect(prompt).toContain('Do not use "claude-latest" for React/runtime/hooks/providers/contexts/types/dependencies/tests/config/build/tooling tasks');
  });

  it('forces claude for Japanese UI repair tasks even when planner returns codex', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
        goal: 'LP refresh',
        constraints: ['No backward compatibility'],
        successCriteria: ['Tests pass'],
        milestones: [
          {
            id: 'm1',
            title: 'UI',
            description: 'Refresh landing page UI',
            validationContract: { staticChecks: [], testSuites: [] },
            features: [{ id: 'm1-f1', description: 'LPのレイアウトを修正する', model: 'codex' }],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });

    const plan = await agent.generateMissionPlan({
      missionId: 'ui-repair',
      prd: '# LP refresh',
    });

    expect(plan.milestones[0]?.features[0]?.model).toBe('claude-latest');
  });

  it('forces codex for infra tasks even when planner returns claude and the description includes ui paths', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
        goal: 'Frontend cleanup',
        constraints: ['No backward compatibility'],
        successCriteria: ['Tests pass'],
        milestones: [
          {
            id: 'm1',
            title: 'Infra',
            description: 'Tighten frontend infrastructure',
            validationContract: { staticChecks: [], testSuites: [] },
            features: [
              {
                id: 'm1-f1',
                description: 'React と JSX の型解決を editor package 基準で統一し、shared/ui 由来コンポーネントを JSX で再び安全に扱えるようにする',
                model: 'claude-latest',
              },
              {
                id: 'm1-f2',
                description: 'Vitest 実行時の React 単一ランタイム保証を追加し、web app から参照する editor/ui/shared の hook 実行を安定化する',
                model: 'claude-latest',
              },
            ],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });

    const plan = await agent.generateMissionPlan({
      missionId: 'frontend-infra',
      prd: '# Frontend infra cleanup',
    });

    expect(plan.milestones[0]?.features[0]?.model).toBe('codex-latest');
    expect(plan.milestones[0]?.features[1]?.model).toBe('codex-latest');
  });

  it('embeds repository context and asks planner to inspect related files before planning', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-manager-planning-context-'));
    mkdirSync(join(cwd, 'src', 'auth'), { recursive: true });
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: 'planning-context-app',
      scripts: {
        test: 'vitest',
        typecheck: 'tsc --noEmit',
      },
      dependencies: {
        react: '^19.0.0',
        vite: '^6.0.0',
      },
    }, null, 2));
    writeFileSync(join(cwd, 'src', 'auth', 'session.ts'), [
      'export function createSession() {',
      "  return 'session';",
      '}',
    ].join('\n'));

    const agent = new ManagerAgent({
      cwd,
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
        goal: 'Auth session planning',
        constraints: ['No backward compatibility'],
        successCriteria: ['Tests pass'],
        milestones: [
          {
            id: 'm1',
            title: 'Core',
            description: 'Implement auth session',
            validationContract: { staticChecks: [], testSuites: [] },
            features: [{ id: 'm1-f1', description: 'Implement auth session flow', model: 'codex' }],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });

    await agent.generateMissionPlan({
      missionId: 'planning-context',
      prd: '# Auth Session\n\nImplement auth session flow.',
    });

    const prompt = String(executeSpy.mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('You must inspect the repository before finalizing the plan.');
    expect(prompt).toContain('Files already reviewed by system and required for planning coverage:');
    expect(prompt).toContain('Repository Context (coverage-oriented, pre-read by system):');
    expect(prompt).toContain('Package name: planning-context-app');
    expect(prompt).toContain('Framework hints: react, vite');
    expect(prompt).toContain('src/auth/session.ts');
  });

  it('prefers explicit path references over generic keyword filename matches during planning', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-manager-explicit-paths-'));
    mkdirSync(join(cwd, 'frontend', 'apps', 'web', 'src', 'page_contents', 'features'), { recursive: true });
    mkdirSync(join(cwd, 'api', 'app', 'services', 'assistant_messages'), { recursive: true });
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: 'explicit-path-app',
      scripts: {
        test: 'vitest',
      },
    }, null, 2));
    writeFileSync(
      join(cwd, 'frontend', 'apps', 'web', 'src', 'page_contents', 'features', 'ReviewPage.tsx'),
      'export const ReviewPage = () => null;\n'
    );
    writeFileSync(
      join(cwd, 'api', 'app', 'services', 'assistant_messages', 'agentic_completion_handler.rb'),
      'class AgenticCompletionHandler; end\n'
    );

    const agent = new ManagerAgent({
      cwd,
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
        goal: 'Student LP',
        constraints: ['No backward compatibility'],
        successCriteria: ['Plan is valid'],
        milestones: [
          {
            id: 'm1',
            title: 'Core',
            description: 'Implement student LP',
            validationContract: { staticChecks: [], testSuites: [] },
            features: [{ id: 'm1-f1', description: 'Update review page', model: 'codex' }],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });

    await agent.generateMissionPlan({
      missionId: 'explicit-paths',
      prd: [
        '# Student LP',
        'Assistant demo theme is important.',
        'Review should match the persona.',
        'Local evidence:',
        '- `frontend/apps/web/src/page_contents/features/ReviewPage.tsx`',
      ].join('\n'),
    });

    const prompt = String(executeSpy.mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('frontend/apps/web/src/page_contents/features/ReviewPage.tsx');
    expect(prompt).not.toContain('api/app/services/assistant_messages/agentic_completion_handler.rb');
  });

  it('excludes binary files from planning coverage context even when filenames match PRD keywords', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-manager-binary-context-'));
    mkdirSync(join(cwd, 'frontend', 'assets'), { recursive: true });
    mkdirSync(join(cwd, 'src', 'auth'), { recursive: true });
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: 'binary-context-app',
      scripts: {
        test: 'vitest',
      },
    }, null, 2));
    writeFileSync(join(cwd, 'src', 'auth', 'session.ts'), 'export const session = true;\n');
    writeFileSync(
      join(cwd, 'frontend', 'assets', 'auth-diagram.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03])
    );

    const agent = new ManagerAgent({
      cwd,
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
        goal: 'Auth session planning',
        constraints: ['No backward compatibility'],
        successCriteria: ['Tests pass'],
        milestones: [
          {
            id: 'm1',
            title: 'Core',
            description: 'Implement auth session',
            validationContract: { staticChecks: [], testSuites: [] },
            features: [{ id: 'm1-f1', description: 'Implement auth session flow', model: 'codex' }],
          },
        ],
      })}\n\`\`\``,
      exitCode: 0,
    });

    await agent.generateMissionPlan({
      missionId: 'binary-context',
      prd: '# Auth Session\n\nImplement auth session flow.',
    });

    const prompt = String(executeSpy.mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('src/auth/session.ts');
    expect(prompt).not.toContain('frontend/assets/auth-diagram.png');
    expect(prompt.includes('\u0000')).toBe(false);
  });

  it('coarsens overly fragmented milestone features without hard total cap', async () => {
    const agent = new ManagerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4-codex',
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
    const oversizedMilestones = Array.from({ length: 3 }, (_, milestoneIdx) => ({
      id: `m${milestoneIdx + 1}`,
      title: `Milestone ${milestoneIdx + 1}`,
      description: `Description ${milestoneIdx + 1}`,
      validationContract: { staticChecks: [], testSuites: [] },
      features: Array.from({ length: 6 }, (_, featureIdx) => ({
        id: `m${milestoneIdx + 1}-f${featureIdx + 1}`,
        description: `Feature ${milestoneIdx + 1}-${featureIdx + 1}`,
        model: 'codex',
      })),
    }));
    jest.spyOn(agentAny.codexEngine, 'execute').mockResolvedValue({
      success: true,
      output: `\`\`\`json\n${JSON.stringify({
        goal: 'Large mission',
        constraints: ['No backward compatibility'],
        successCriteria: ['All validations pass'],
        milestones: oversizedMilestones,
      })}\n\`\`\``,
      exitCode: 0,
    });

    const plan = await agent.generateMissionPlan({
      missionId: 'coarsen-plan',
      prd: '# Large mission',
    });

    expect(plan.milestones).toHaveLength(4);
    expect(plan.milestones.slice(0, 3).every((milestone) => milestone.features.length <= 5)).toBe(true);
    expect(plan.milestones[3]?.title).toBe('Final Review');
  });
});
