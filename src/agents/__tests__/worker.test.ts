import { jest } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    expect(prompt).toContain('git-committer');
    expect(prompt).toContain('type(scope): subject');
    expect(prompt).toContain('.claude/skills/git-committer/SKILL.md');
    expect(prompt).toContain('git status --porcelain');
    expect(prompt).toContain('git diff --staged');
    expect(prompt).toContain('## Runtime Context');
    expect(prompt).toContain('## Protected Runtime Files');
    expect(prompt).toContain('Never edit TASK.json.');
    expect(prompt).toContain('Never edit `.melos/state.json`, `.melos/validations/*`, or `.melos/reviews/*`.');
    expect(prompt).toContain('`BLOCKED` は人手の介入が必要で、Melos が自動では前進できない場合にだけ使う');
    expect(prompt).toContain('`requestsHelp` は、人手の介入が必要で自動実行を止めるべきときだけ `true` にする');
    expect(prompt).toContain('Mission goal: Sample goal');
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
    expect(prompt).toContain('## QA Mode');
    expect(prompt).toContain('## QA Checks');
    expect(prompt).toContain('## Protected Runtime Files');
    expect(prompt).toContain('playwright-interactive');
    expect(prompt).toContain('evidenceMode=before_after');
    expect(prompt).toContain('reproduceBefore=true');
    expect(prompt).not.toContain('## Commit Workflow');
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
    expect(prompt).toContain('.claude/skills/git-committer/SKILL.md');
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
      expect(prompt).toContain(`Execution cwd: ${join(repoCwd, 'frontend/apps/web')}`);
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
});
