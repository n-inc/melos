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
          discoveredFeatures: [],
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
        output: '```json\n{"status":"SUCCESS","summary":"ok","filesChanged":[],"validation":{"testsRun":false,"testsPassed":0,"testsFailed":0,"lintPassed":true,"typecheckPassed":true},"checks":[],"discoveredFeatures":[],"learnings":[],"requestsHelp":false}\n```',
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
    expect(prompt).toContain('Mission goal: Sample goal');
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
          output: '```json\n{"status":"SUCCESS","summary":"ok","warnings":[],"filesChanged":[],"validation":{"testsRun":false,"testsPassed":0,"testsFailed":0,"lintPassed":true,"typecheckPassed":true},"checks":[],"discoveredFeatures":[],"learnings":[],"requestsHelp":false}\n```',
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
          output: '```json\n{"status":"SUCCESS","summary":"ok","filesChanged":[],"validation":{"testsRun":false,"testsPassed":0,"testsFailed":0,"lintPassed":true,"typecheckPassed":true},"checks":[],"discoveredFeatures":[],"learnings":[],"requestsHelp":false}\n```',
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
      model: 'gpt-5.4',
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
          discoveredFeatures: [],
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
          discoveredFeatures: [],
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

  it('normalizes discoveredFeatures when worker returns string entries', async () => {
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
          discoveredFeatures: [
            'Add FAQ copy for students',
            { description: 'Tune hero message match', priority: 'high', rationale: 'Improve CTR' },
            '',
          ],
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
              description: 'feature',
              status: 'pending',
              attempts: 0,
              model: 'codex',
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
    });

    expect(result.report.discoveredFeatures).toEqual([
      { description: 'Add FAQ copy for students', priority: 'medium' },
      { description: 'Tune hero message match', priority: 'high', rationale: 'Improve CTR' },
    ]);
  });
});
