import { jest } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkerAgent } from '../worker.js';
import { createMissionPlan } from '../../state/mission.js';

function createTestPlan() {
  return createMissionPlan({
    missionId: 'mission-test',
    goal: 'Sample goal',
    milestones: [
      {
        id: 'm1',
        title: 'M1',
        description: 'desc',
        order: 1,
        status: 'pending',
        validationContract: {
          staticChecks: [
            {
              id: 'typecheck',
              description: 'Typecheck',
              type: 'auto:typecheck',
              command: 'npm run typecheck',
              passed: false,
              failureCount: 0,
            },
          ],
          testSuites: [
            {
              id: 'test',
              description: 'Jest',
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
            description: 'feature',
            status: 'pending',
            attempts: 0,
            model: 'codex',
            checks: [{ text: 'feature check' }],
          },
          {
            id: 'm1-f2',
            description: 'feature 2',
            status: 'pending',
            attempts: 0,
            model: 'codex',
          },
        ],
      },
    ],
  });
}

function createRunInput(overrides: Partial<Parameters<WorkerAgent['run']>[0]> = {}): Parameters<WorkerAgent['run']>[0] {
  const plan = createTestPlan();
  const milestone = overrides.milestone ?? plan.milestones[0];
  const feature = overrides.feature ?? milestone.features[0];

  return {
    iteration: 1,
    missionPlan: plan,
    milestone,
    feature,
    prd: '# PRD',
    briefing: 'brief',
    currentBranch: 'test',
    baseBranch: 'main',
    ...overrides,
  };
}

describe('WorkerAgent', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parses worker report from json output', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4',
    });

    const codexExecute = jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
      .mockResolvedValue({
        success: true,
        output: `\`\`\`json\n${JSON.stringify({
          status: 'SUCCESS',
          summary: 'feature implemented',
          warnings: [],
          filesChanged: [{ path: 'src/a.ts', additions: 12, deletions: 1 }],
          validation: {
            testsRun: true,
            testsPassed: 3,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: ['learn'],
          requestsHelp: false,
        })}\n\`\`\``,
        exitCode: 0,
      });

    const result = await agent.run(createRunInput());

    expect(result.type).toBe('success');
    expect(result.report.summary).toContain('feature implemented');
    expect(result.report.featureId).toBe('m1-f1');
    expect(codexExecute).toHaveBeenCalled();
  });

  it('builds the worker prompt from prompts/worker.md and commit context', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4',
    });
    const codexExecute = jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
      .mockResolvedValue({
        success: true,
        output: '```json\n{"status":"SUCCESS","summary":"ok","filesChanged":[],"validation":{"testsRun":false,"testsPassed":0,"testsFailed":0,"lintPassed":true,"typecheckPassed":true},"checks":[],"learnings":[],"requestsHelp":false}\n```',
        exitCode: 0,
      });

    await agent.run(createRunInput());

    const prompt = String(codexExecute.mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('# Worker Agent - Feature Executor');
    expect(prompt).toContain('git-commit');
    expect(prompt).toContain('.claude/skills/git-commit/SKILL.md');
    expect(prompt).toContain('git-commit スキル');
    expect(prompt).toContain('git status --porcelain');
    expect(prompt).toContain('git diff --staged');
    expect(prompt).toContain('## ランタイムコンテキスト');
    expect(prompt).toContain('## 保護されたランタイムファイル');
    expect(prompt).toContain('## バリデーション境界');
    expect(prompt).toContain('TASK.json は編集しない。');
    expect(prompt).toContain('`.melos/state.json`、`.melos/validations/*`、`.melos/reviews/*` は編集しない。');
    expect(prompt).toContain('マイルストーンレベルのバリデーションと専用 QA はオーケストレーターが管理する下流ステップ');
    expect(prompt).not.toContain('## Milestone Validation Checks');
    expect(prompt).not.toContain('## Milestone Validation Commands');
    expect(prompt).not.toContain('## Dedicated QA Handoff');
    expect(prompt).toContain('`BLOCKED` は人手の介入が必要で、Melos が自動では前進できない場合にだけ使う');
    expect(prompt).toContain('`requestsHelp` は、人手の介入が必要で自動実行を止めるべきときだけ `true` にする');
    expect(prompt).toContain('ミッションゴール: Sample goal');
  });

  it('builds a dedicated qa prompt and enables js_repl for browser qa', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4',
    });
    const codexExecute = jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
      .mockResolvedValue({
        success: true,
        output: '```json\n{"status":"SUCCESS","summary":"qa done","filesChanged":[],"validation":{"testsRun":false,"testsPassed":0,"testsFailed":0,"lintPassed":false,"typecheckPassed":false},"checks":[{"checkId":"m1-qa-1","passed":true,"runner":"playwright-interactive","screenshotPath":"artifacts/screenshots/hero.png"}],"warnings":[],"learnings":[],"requestsHelp":false}\n```',
        exitCode: 0,
      });

    const plan = createMissionPlan({
      missionId: 'qa-test',
      goal: 'QA goal',
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
            qaChecks: [
              {
                id: 'm1-qa-1',
                description: 'Verify hero',
                type: 'browser',
                requiredRunner: 'playwright-interactive',
                requiredArtifacts: ['screenshot'],
                evidenceMode: 'before_after',
                reproduceBefore: true,
                passed: false,
                failureCount: 0,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement feature',
              cwd: 'frontend/apps/web',
              status: 'done',
              attempts: 1,
              model: 'codex-latest',
            },
          ],
        },
      ],
    });

    const milestone = plan.milestones[0]!;
    const qaFeature = milestone.features.at(-1)!;

    await agent.run({
      iteration: 1,
      missionPlan: plan,
      milestone,
      feature: qaFeature,
      prd: '# PRD',
      briefing: 'qa briefing',
      currentBranch: 'melos/qa-test/mission',
      baseBranch: 'main',
    });

    const prompt = String(codexExecute.mock.calls[0]?.[0] ?? '');
    const options = codexExecute.mock.calls[0]?.[1] as { enabledFeatures?: string[] } | undefined;
    expect(qaFeature.kind).toBe('qa');
    expect(prompt).toContain('## QA モード');
    expect(prompt).toContain('## QA チェック');
    expect(prompt).toContain('## 保護されたランタイムファイル');
    expect(prompt).toContain('playwright-interactive');
    expect(prompt).toContain('evidenceMode=before_after');
    expect(prompt).toContain('reproduceBefore=true');
    expect(prompt).not.toContain('## コミットワークフロー');
    expect(options?.enabledFeatures).toEqual(['js_repl']);
  });

  it('uses claude with git-new-pull-request prompt for pull_request features', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4',
      claudeModel: 'claude-latest',
    });
    const claudeExecute = jest.spyOn((agent as unknown as {
      claudeEngine: { execute: (...args: unknown[]) => Promise<unknown> };
    }).claudeEngine, 'execute').mockResolvedValue({
      success: true,
      output: '```json\n{"status":"SUCCESS","summary":"pr updated","warnings":[],"filesChanged":[],"validation":{"testsRun":false,"testsPassed":0,"testsFailed":0,"lintPassed":true,"typecheckPassed":true},"checks":[],"pullRequest":{"number":12,"url":"https://github.com/example/repo/pull/12","title":"feat: update","baseBranch":"main","headBranch":"melos/mission-test/mission","draft":false,"action":"updated"},"learnings":[],"requestsHelp":false}\n```',
      exitCode: 0,
    });

    const result = await agent.run(createRunInput({
      feature: {
        id: 'm1-f-pr',
        description: 'Create or update GitHub pull request',
        kind: 'pull_request',
        status: 'pending',
        attempts: 0,
        model: 'claude-latest',
      },
      currentBranch: 'melos/mission-test/mission',
      baseBranch: 'main',
    }));

    const prompt = String(claudeExecute.mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('# Pull Request Worker');
    expect(prompt).toContain('.claude/skills/git-new-pull-request/SKILL.md');
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('gh pr edit');
    expect(result.report.pullRequest).toMatchObject({
      number: 12,
      action: 'updated',
      headBranch: 'melos/mission-test/mission',
    });
  });

  it('uses claude post-pr prompt and parses follow-up metadata without nested melos execution', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4',
      claudeModel: 'claude-latest',
    });
    const claudeExecute = jest.spyOn((agent as unknown as {
      claudeEngine: { execute: (...args: unknown[]) => Promise<unknown> };
    }).claudeEngine, 'execute').mockResolvedValue({
      success: true,
      output: `\`\`\`json\n${JSON.stringify({
        status: 'SUCCESS',
        summary: 'follow-up complete',
        warnings: ['ignored off-target feedback: already addressed upstream'],
        filesChanged: [],
        validation: {
          testsRun: true,
          testsPassed: 2,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: [],
        pullRequest: {
          number: 12,
          url: 'https://github.com/example/repo/pull/12',
          title: 'feat: update',
          baseBranch: 'main',
          headBranch: 'melos/mission-test/mission',
          draft: false,
          action: 'updated',
        },
        pullRequestFollowUp: {
          handledFeedbackIds: ['PRRC_1', 'PRRC_2'],
          lastExternalActivityAt: '2026-03-07T09:00:00.000Z',
          quietUntil: '2026-03-07T09:30:00.000Z',
        },
        learnings: [],
        requestsHelp: false,
      })}\n\`\`\``,
      exitCode: 0,
    });

    const result = await agent.run(createRunInput({
      feature: {
        id: 'm1-f-followup',
        description: 'Wait for PR feedback and fix actionable issues',
        kind: 'pr_followup',
        status: 'pending',
        attempts: 0,
        model: 'claude-latest',
      },
      currentBranch: 'melos/mission-test/mission',
      baseBranch: 'main',
    }));

    const prompt = String(claudeExecute.mock.calls[0]?.[0] ?? '');
    expect(prompt).toContain('# Post-PR Follow-up Worker');
    expect(prompt).toContain('.claude/skills/melos-ci-fix-loop/SKILL.md');
    expect(prompt).toContain('.claude/skills/git-commit/SKILL.md');
    expect(prompt).not.toContain('npx melos --ci-fix-only');
    expect(result.report.pullRequestFollowUp).toEqual({
      handledFeedbackIds: ['PRRC_1', 'PRRC_2'],
      lastExternalActivityAt: '2026-03-07T09:00:00.000Z',
      quietUntil: '2026-03-07T09:30:00.000Z',
    });
    expect(result.report.warnings).toEqual(['ignored off-target feedback: already addressed upstream']);
  });

  it('includes feature cwd in prompt and engine options', async () => {
    const repoCwd = await mkdtemp(join(tmpdir(), 'melos-worker-cwd-'));
    try {
      await mkdir(join(repoCwd, '.claude', 'skills', 'git-commit'), { recursive: true });
      await mkdir(join(repoCwd, '.claude', 'skills', 'git-new-pull-request'), { recursive: true });
      await mkdir(join(repoCwd, '.claude', 'skills', 'melos-ci-fix-loop'), { recursive: true });
      await writeFile(
        join(repoCwd, '.claude', 'skills', 'git-commit', 'SKILL.md'),
        '---\nname: git-commit\n---\n'
      );
      await writeFile(
        join(repoCwd, '.claude', 'skills', 'git-new-pull-request', 'SKILL.md'),
        '---\nname: git-new-pull-request\n---\n'
      );
      await writeFile(
        join(repoCwd, '.claude', 'skills', 'melos-ci-fix-loop', 'SKILL.md'),
        '---\nname: melos-ci-fix-loop\n---\n'
      );

      const agent = new WorkerAgent({
        cwd: repoCwd,
        promptsDir: join(process.cwd(), 'prompts'),
        model: 'gpt-5.4',
      });
      const codexExecute = jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
        .mockResolvedValue({
          success: true,
          output: '```json\n{"status":"SUCCESS","summary":"ok","warnings":[],"filesChanged":[],"validation":{"testsRun":false,"testsPassed":0,"testsFailed":0,"lintPassed":true,"typecheckPassed":true},"checks":[],"learnings":[],"requestsHelp":false}\n```',
          exitCode: 0,
        });

      const plan = createTestPlan();
      const milestone = plan.milestones[0];
      const feature = {
        ...milestone.features[0],
        cwd: 'frontend/apps/web',
      };

      await agent.run(createRunInput({
        missionPlan: plan,
        milestone,
        feature,
      }));

      const prompt = String(codexExecute.mock.calls[0]?.[0] ?? '');
      const options = codexExecute.mock.calls[0]?.[1] as { cwd?: string } | undefined;
      expect(prompt).toContain(`実行 cwd: ${join(repoCwd, 'frontend/apps/web')}`);
      expect(options?.cwd).toBe(join(repoCwd, 'frontend/apps/web'));
    } finally {
      await rm(repoCwd, { recursive: true, force: true });
    }
  });

  it('loads worker prompt from a custom promptsDir', async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), 'melos-worker-prompts-'));
    try {
      await writeFile(
        join(promptsDir, 'worker.md'),
        '# Custom Worker Prompt\n\nUse this custom prompt.'
      );

      const agent = new WorkerAgent({
        cwd: process.cwd(),
        promptsDir,
        model: 'gpt-5.4',
      });
      const codexExecute = jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
        .mockResolvedValue({
          success: true,
          output: '```json\n{"status":"SUCCESS","summary":"ok","filesChanged":[],"validation":{"testsRun":false,"testsPassed":0,"testsFailed":0,"lintPassed":true,"typecheckPassed":true},"checks":[],"learnings":[],"requestsHelp":false}\n```',
          exitCode: 0,
        });

      await agent.run(createRunInput());

      const prompt = String(codexExecute.mock.calls[0]?.[0] ?? '');
      expect(prompt).toContain('# Custom Worker Prompt');
      expect(prompt).toContain('Use this custom prompt.');
    } finally {
      await rm(promptsDir, { recursive: true, force: true });
    }
  });

  it('fails when the worker prompt file is missing', async () => {
    const promptsDir = await mkdtemp(join(tmpdir(), 'melos-worker-missing-'));
    try {
      const agent = new WorkerAgent({
        cwd: process.cwd(),
        promptsDir,
        model: 'gpt-5.4',
      });

      await expect(agent.run(createRunInput())).rejects.toThrow(
        `Prompt file not found: ${join(promptsDir, 'worker.md')}`
      );
    } finally {
      await rm(promptsDir, { recursive: true, force: true });
    }
  });

  it('fails with a clear error when a required skill is missing', async () => {
    const repoCwd = await mkdtemp(join(tmpdir(), 'melos-worker-skill-missing-'));
    const promptsDir = await mkdtemp(join(tmpdir(), 'melos-worker-prompts-'));
    try {
      await writeFile(
        join(promptsDir, 'worker.md'),
        '# Custom Worker Prompt\n\nUse this custom prompt.'
      );

      const agent = new WorkerAgent({
        cwd: repoCwd,
        promptsDir,
        model: 'gpt-5.4',
      });

      await expect(agent.run(createRunInput())).rejects.toThrow(
        `Required skill not found: git-commit (${join(repoCwd, '.claude', 'skills', 'git-commit', 'SKILL.md')})`
      );
    } finally {
      await rm(promptsDir, { recursive: true, force: true });
      await rm(repoCwd, { recursive: true, force: true });
    }
  });

  it('reuses codex thread across multiple features in the same mission', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4',
    });
    const codexExecute = jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
      .mockResolvedValue({
        success: true,
        output: '```json\n{"status":"SUCCESS","summary":"ok","filesChanged":[],"validation":{"testsRun":false,"testsPassed":0,"testsFailed":0,"lintPassed":true,"typecheckPassed":true},"checks":[],"learnings":[],"requestsHelp":false}\n```',
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
      model: 'gpt-5.4',
    });
    const codexExecute = jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
      .mockResolvedValue({
        success: true,
        output: '```json\n{"status":"SUCCESS","summary":"ok","filesChanged":[],"validation":{"testsRun":false,"testsPassed":0,"testsFailed":0,"lintPassed":true,"typecheckPassed":true},"checks":[],"learnings":[],"requestsHelp":false}\n```',
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

  it('falls back to opus when claude worker model is set to codex family', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4',
      claudeModel: 'gpt-5.4',
    });
    const claudeExecute = jest.spyOn((agent as unknown as { claudeEngine: { execute: (...args: unknown[]) => Promise<unknown> } }).claudeEngine, 'execute')
      .mockResolvedValue({
        success: true,
        output: `\`\`\`json\n${JSON.stringify({
          status: 'SUCCESS',
          summary: 'claude task complete',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: false,
            testsPassed: 0,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
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
              description: 'design feature',
              status: 'pending',
              attempts: 0,
              model: 'claude',
            },
          ],
        },
      ],
    });

    await agent.run({
      iteration: 1,
      missionPlan: plan,
      milestone: plan.milestones[0],
      feature: plan.milestones[0].features[0],
      prd: '# PRD',
    });

    const options = claudeExecute.mock.calls[0]?.[1] as { model?: string } | undefined;
    expect(options?.model).toBe('opus');
  });

  it('builds the product review prompt with checkpoint result requirements and js_repl enabled', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4',
    });
    const codexExecute = jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
      .mockResolvedValue({
        success: true,
        output: '```json\n{"status":"SUCCESS","summary":"product review passed","warnings":[],"findings":[],"artifacts":[],"checkpointResults":[],"requestsHelp":false}\n```',
        exitCode: 0,
      });

    const plan = createMissionPlan({
      missionId: 'product-review-test',
      goal: 'Run final product review',
      productReviewContract: {
        target: 'http://127.0.0.1:${PORT}',
        preconditions: ['js_repl enabled', 'playwright importable'],
        checkpoints: [
          {
            id: 'root-dispatcher',
            description: 'Verify root dispatcher',
            visual: true,
            evidenceMode: 'single',
          },
          {
            id: 'seo-head-signals',
            description: 'Verify SEO head signals',
            visual: false,
            evidenceMode: 'single',
          },
        ],
        artifactsDir: 'artifacts/screenshots',
      },
      milestones: [
        {
          id: 'm3',
          title: 'Final Review',
          description: 'Run final product review',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm3-f1',
              description: 'Run final product review',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 1,
              scopedReviewCheckpointIds: ['root-dispatcher'],
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
          ],
        },
      ],
    });

    const milestone = plan.milestones[0]!;
    const feature = milestone.features[0]!;
    await agent.run({
      iteration: 1,
      missionPlan: plan,
      milestone,
      feature,
      prd: '# PRD',
      briefing: 'product review briefing',
      currentBranch: 'main',
      baseBranch: 'main',
    });

    const prompt = String(codexExecute.mock.calls[0]?.[0] ?? '');
    const options = codexExecute.mock.calls[0]?.[1] as { enabledFeatures?: string[] } | undefined;
    expect(prompt).toContain('ブラウザレビューが実際に実行された場合、契約チェックポイントごとに1つの `checkpointResults` エントリを必ず返す。');
    expect(prompt).toContain('すべてのビジュアルチェックポイントについて、少なくとも1つの `after` スクリーンショットをキャプチャし');
    expect(prompt).toContain('すべてのスクリーンショット/ビデオに対応する `checkpointId` と `phase` を含める');
    expect(prompt).toContain('`checkpointResults` を省略するのは、レビュー開始前に `BLOCKED` を返す場合のみ。');
    expect(prompt).toContain('root-dispatcher');
    expect(prompt).not.toContain('Verify SEO head signals');
    expect(options?.enabledFeatures).toEqual(['js_repl']);
  });

  it('normalizes repo-root startup contracts for product review execution', async () => {
    const repoCwd = await mkdtemp(join(tmpdir(), 'melos-product-review-root-'));
    try {
      await mkdir(join(repoCwd, '.claude', 'skills', 'git-commit'), { recursive: true });
      await writeFile(join(repoCwd, '.claude', 'skills', 'git-commit', 'SKILL.md'), '---\nname: git-commit\n---\n');

      const agent = new WorkerAgent({
        cwd: repoCwd,
        promptsDir: join(process.cwd(), 'prompts'),
        model: 'gpt-5.4',
      });
      const codexExecute = jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
        .mockResolvedValue({
          success: true,
          output: '```json\n{"status":"SUCCESS","summary":"product review passed","warnings":[],"findings":[],"artifacts":[],"checkpointResults":[],"requestsHelp":false}\n```',
          exitCode: 0,
        });

      const plan = createMissionPlan({
        missionId: 'product-review-root-contract',
        goal: 'Run final product review',
        productReviewContract: {
          cwd: 'frontend/apps/web',
          target: 'http://127.0.0.1:$(cat ../../.port 2>/dev/null || echo ${CONDUCTOR_PORT:-8000})',
          startup: [{ command: 'make dev-watch' }],
          preconditions: [
            'repo root の .port もしくは CONDUCTOR_PORT で nginx 入口 URL を解決できること',
          ],
          checkpoints: [
            {
              id: 'hub',
              description: 'Verify learn hub',
              visual: true,
              evidenceMode: 'single',
            },
          ],
          artifactsDir: 'artifacts/screenshots/learn',
        },
        milestones: [
          {
            id: 'm4',
            title: 'Final Review',
            description: 'Run final product review',
            order: 1,
            status: 'pending',
            validationContract: {
              staticChecks: [],
              testSuites: [],
            },
            features: [
              {
                id: 'm4-f1',
                description: 'Run final product review',
                kind: 'review',
                reviewType: 'product',
                reviewGeneration: 1,
                status: 'pending',
                attempts: 0,
                model: 'codex-latest',
              },
            ],
          },
        ],
      });

      await agent.run({
        iteration: 1,
        missionPlan: plan,
        milestone: plan.milestones[0],
        feature: plan.milestones[0].features[0],
        prd: '# PRD',
        briefing: 'product review briefing',
        currentBranch: 'main',
        baseBranch: 'main',
      });

      const prompt = String(codexExecute.mock.calls[0]?.[0] ?? '');
      const options = codexExecute.mock.calls[0]?.[1] as { cwd?: string } | undefined;
      expect(prompt).toContain(`実行 cwd: ${repoCwd}`);
      expect(prompt).toContain('"target": "http://127.0.0.1:$(cat .port 2>/dev/null || echo ${CONDUCTOR_PORT:-8000})"');
      expect(options?.cwd).toBe(repoCwd);
    } finally {
      await rm(repoCwd, { recursive: true, force: true });
    }
  });

  it('synthesizes review artifacts from checkpoint result paths when the model omits artifacts', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4',
    });
    jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
      .mockResolvedValue({
        success: true,
        output: `\`\`\`json\n${JSON.stringify({
          status: 'SUCCESS',
          summary: 'product review passed',
          warnings: [],
          findings: [],
          artifacts: [],
          checkpointResults: [
            {
              checkpointId: 'root-dispatcher',
              passed: true,
              afterObserved: 'redirect landed on /en',
              afterScreenshotPath: 'artifacts/screenshots/root-dispatcher-after.png',
            },
          ],
          requestsHelp: false,
        })}\n\`\`\``,
        exitCode: 0,
      });

    const plan = createMissionPlan({
      missionId: 'product-review-artifact-synthesis',
      goal: 'Run final product review',
      productReviewContract: {
        target: 'http://127.0.0.1:${PORT}',
        preconditions: ['js_repl enabled', 'playwright importable'],
        checkpoints: [
          {
            id: 'root-dispatcher',
            description: 'Verify root dispatcher',
            visual: true,
            evidenceMode: 'single',
          },
        ],
        artifactsDir: 'artifacts/screenshots',
      },
      milestones: [
        {
          id: 'm3',
          title: 'Final Review',
          description: 'Run final product review',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm3-f1',
              description: 'Run final product review',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
          ],
        },
      ],
    });

    const result = await agent.run({
      iteration: 1,
      missionPlan: plan,
      milestone: plan.milestones[0],
      feature: plan.milestones[0].features[0],
      prd: '# PRD',
      briefing: 'product review briefing',
      currentBranch: 'main',
      baseBranch: 'main',
    });

    expect(result.type).toBe('success');
    expect(result.report.review?.checkpointResults).toEqual([
      expect.objectContaining({
        checkpointId: 'root-dispatcher',
        afterScreenshotPath: 'artifacts/screenshots/root-dispatcher-after.png',
      }),
    ]);
    expect(result.report.review?.artifacts).toEqual([
      expect.objectContaining({
        kind: 'screenshot',
        checkpointId: 'root-dispatcher',
        phase: 'after',
        path: 'artifacts/screenshots/root-dispatcher-after.png',
      }),
    ]);
  });

  it('normalizes warnings and structured validation checks from worker output', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4',
    });
    jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
      .mockResolvedValue({
        success: true,
        output: `\`\`\`json\n${JSON.stringify({
          status: 'SUCCESS',
          resultKind: 'verified_existing',
          changeScope: 'gitignored',
          problemKeys: ['qa-evidence-capture'],
          summary: 'ok',
          warnings: [' fallback used ', '', 1],
          filesChanged: [],
          validation: {
            testsRun: false,
            testsPassed: 0,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [
            {
              checkId: 'manual-qa',
              passed: false,
              warning: 'user confirmation still required',
              failure: {
                summary: 'manual qa failed',
                affectedFiles: ['src/app.ts', 42],
                errorMessages: ['screen mismatch', 99],
              },
            },
            {
              checkId: 'browser-qa',
              passed: true,
              runner: 'playwright-interactive',
              screenshotPath: 'artifacts/screenshots/browser.png',
              videoUrl: 'https://example.com/session.webm',
            },
            {
              checkId: '',
              passed: true,
            },
          ],
          learnings: [],
          requestsHelp: false,
        })}\n\`\`\``,
        exitCode: 0,
      });

    const result = await agent.run(createRunInput());

    expect(result.report.resultKind).toBe('verified_existing');
    expect(result.report.changeScope).toBe('gitignored');
    expect(result.report.problemKeys).toEqual(['qa-evidence-capture']);
    expect(result.report.warnings).toEqual(['fallback used']);
    expect(result.report.checks).toEqual([
      {
        checkId: 'manual-qa',
        passed: false,
        warning: 'user confirmation still required',
        failure: {
          summary: 'manual qa failed',
          affectedFiles: ['src/app.ts'],
          errorMessages: ['screen mismatch'],
          rootCause: undefined,
        },
      },
      {
        checkId: 'browser-qa',
        passed: true,
        runner: 'playwright-interactive',
        screenshotPath: 'artifacts/screenshots/browser.png',
        videoUrl: 'https://example.com/session.webm',
      },
    ]);
  });

  it('fails implementation features when structured JSON report is missing', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4',
    });
    jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
      .mockResolvedValue({
        success: true,
        output: 'implemented changes but forgot the json block',
        exitCode: 0,
      });

    const result = await agent.run(createRunInput());

    expect(result.type).toBe('failed');
    expect(result.report.status).toBe('FAILED');
    expect(result.report.requestsHelp).toBe(true);
    expect(result.report.summary).toContain('structured JSON report');
  });

  it('returns a structured BLOCKED report when a product review does not return JSON', async () => {
    const agent = new WorkerAgent({
      cwd: process.cwd(),
      promptsDir: 'prompts',
      model: 'gpt-5.4',
    });
    jest.spyOn((agent as unknown as { engine: { execute: (...args: unknown[]) => Promise<unknown> } }).engine, 'execute')
      .mockResolvedValue({
        success: false,
        output: '',
        error: 'Timed out while waiting for turn completion',
        exitCode: 1,
      });

    const plan = createMissionPlan({
      missionId: 'product-review-timeout',
      goal: 'Run final product review',
      productReviewContract: {
        target: 'http://127.0.0.1:${PORT}',
        preconditions: ['js_repl enabled', 'playwright importable'],
        checkpoints: [
          {
            id: 'root-dispatcher',
            description: 'Verify root dispatcher',
            visual: true,
          },
        ],
        artifactsDir: 'artifacts/screenshots',
      },
      milestones: [
        {
          id: 'm3',
          title: 'Final Review',
          description: 'Run final product review',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm3-f1',
              description: 'Run final product review',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
          ],
        },
      ],
    });

    const milestone = plan.milestones[0]!;
    const feature = milestone.features[0]!;
    const result = await agent.run({
      iteration: 1,
      missionPlan: plan,
      milestone,
      feature,
      prd: '# PRD',
      briefing: 'product review briefing',
      currentBranch: 'main',
      baseBranch: 'main',
    });

    expect(result.type).toBe('blocked');
    expect(result.report.status).toBe('BLOCKED');
    expect(result.report.requestsHelp).toBe(true);
    expect(result.report.summary).toContain('Timed out while waiting for turn completion');
    expect(result.report.review?.findings).toEqual([
      expect.objectContaining({
        id: 'product-review-blocked',
        trackingKey: 'product-review-blocked',
        summary: 'Product review is blocked',
      }),
    ]);
    expect(result.report.warnings).toContain('review engine error: Timed out while waiting for turn completion');
  });
});
