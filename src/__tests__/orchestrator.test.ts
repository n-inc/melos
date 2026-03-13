import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { jest } from '@jest/globals';

import { Orchestrator } from '../orchestrator.js';
import { ManagerAgent, MissionPlanningError } from '../agents/manager.js';
import { WorkerAgent } from '../agents/worker.js';
import type { WorkerFeatureReport } from '../agents/types.js';
import { getDefaultPromptsDir } from '../prompts/index.js';
import { createMissionPlan, type MissionPlan, updateFeatureStatus } from '../state/mission.js';
import { createGitStrategyState } from '../state/git-strategy.js';
import type { ReviewReport } from '../state/review.js';
import type { ValidationCheckResult } from '../state/validation.js';
import type { MissionControlState } from '../ui/tui-views.js';

describe('Orchestrator v0.8', () => {
  beforeEach(() => {
    jest.spyOn(ManagerAgent.prototype, 'decideReviewDisposition').mockImplementation(async ({ findings }) =>
      findings.map((finding) => ({
        findingId: finding.id,
        decision: 'remediate',
        rationale: 'default test decision',
      }))
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

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
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => ({
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: input.milestone.id,
        featureId: input.feature.id,
        status: 'SUCCESS',
        summary: 'done',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: true,
          testsPassed: 1,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    }));

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

  it('creates a running quick mission plan when quick mode is enabled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-quick-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    const prdOverride = '# Quick launch mission\n\nExecute this PRD directly.';

    const planningSpy = jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan');
    const workerSpy = jest.spyOn(WorkerAgent.prototype, 'run');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 10,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: false,
      interactivePlanning: false,
      dryRun: true,
      quick: true,
      prdOverride,
      runIdentity: {
        runId: 'run_123',
        sourceTracker: 'github',
        sourceIssueId: '123',
        sourceIssueUrl: 'https://github.com/example/repo/issues/123',
        attempt: 2,
      },
      resume: false,
    });
    const quickPlanSpy = jest.spyOn(
      orchestrator as unknown as { createQuickMissionPlan: () => Promise<void> },
      'createQuickMissionPlan'
    );

    const result = await orchestrator.run();
    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        type: string;
        payload?: {
          quick?: boolean;
          plan?: MissionPlan;
          runIdentity?: { runId: string; sourceIssueId: string; attempt: number };
        };
      });
    const planCreated = events.find((event) => event.type === 'plan_created');

    expect(result.success).toBe(true);
    expect(quickPlanSpy).toHaveBeenCalled();
    expect(planningSpy).not.toHaveBeenCalled();
    expect(workerSpy).not.toHaveBeenCalled();
    expect(planCreated?.payload?.quick).toBe(true);
    expect(planCreated?.payload?.runIdentity).toMatchObject({
      runId: 'run_123',
      sourceIssueId: '123',
      attempt: 2,
    });
    expect(planCreated?.payload?.plan?.state).toBe('running');
    expect(planCreated?.payload?.plan?.milestones[0]?.features[0]?.description).toContain('Execute this PRD directly.');
  });

  it('runs final review gate before completion and saves review reports', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-final-review-pass-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Final review mission\n\nVerify the final sign-off flow.', 'utf-8');
    mkdirSync(join(cwd, 'artifacts', 'screenshots'), { recursive: true });
    writeFileSync(join(cwd, 'artifacts', 'screenshots', 'home.png'), 'png', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'final-review-pass',
      goal: 'Finish implementation only after final reviews pass',
      constraints: ['No backward compatibility'],
      successCriteria: ['product review passes', 'code review passes'],
      productReviewContract: {
        target: 'http://127.0.0.1:${PORT}',
        preconditions: ['js_repl enabled', 'playwright importable'],
        artifactsDir: 'artifacts/screenshots',
        checkpoints: [
          { id: 'hero', description: 'Hero flow satisfies the PRD', visual: true },
        ],
      },
      milestones: [
        {
          id: 'm1',
          title: 'Implementation',
          description: 'Build the feature',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement the feature',
              kind: 'implementation',
              status: 'pending',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
        {
          id: 'm2',
          title: 'Final Review',
          description: 'Run final product review and code review',
          order: 2,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm2-f1',
              description: 'Run final product review',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
            {
              id: 'm2-f2',
              description: 'Run final code review',
              kind: 'review',
              reviewType: 'code',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');
    const workerRun = jest.spyOn(WorkerAgent.prototype, 'run');
    workerRun
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: 'm1',
          featureId: 'm1-f1',
          status: 'SUCCESS',
          summary: 'implementation complete',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      })
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 2,
          milestoneId: 'm2',
          featureId: 'm2-f1',
          status: 'SUCCESS',
          summary: 'product review passed',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: false,
            testsPassed: 0,
            testsFailed: 0,
            lintPassed: false,
            typecheckPassed: false,
          },
          checks: [],
          review: {
            reviewType: 'product',
            generation: 1,
            passed: true,
            summary: 'product review passed',
            findings: [],
            artifacts: [
              { kind: 'screenshot', path: 'artifacts/screenshots/home.png', label: 'Home', checkpointId: 'hero', phase: 'after' },
            ],
            checkpointResults: [
              {
                checkpointId: 'hero',
                passed: true,
                afterObserved: 'Hero flow satisfies the PRD.',
                afterScreenshotPath: 'artifacts/screenshots/home.png',
              },
            ],
          },
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      })
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 3,
          milestoneId: 'm2',
          featureId: 'm2-f2',
          status: 'SUCCESS',
          summary: 'code review passed',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: false,
            testsPassed: 0,
            testsFailed: 0,
            lintPassed: false,
            typecheckPassed: false,
          },
          checks: [],
          review: {
            reviewType: 'code',
            generation: 1,
            passed: true,
            summary: 'code review passed',
            findings: [],
            artifacts: [],
          },
          learnings: [],
          requestsHelp: false,
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
    expect(workerRun.mock.calls.map(([input]) => input.feature.id)).toEqual(['m1-f1', 'm2-f1', 'm2-f2']);
    expect(existsSync(join(melosDir, 'reviews', 'm2-f1.json'))).toBe(true);
    expect(existsSync(join(melosDir, 'reviews', 'm2-f2.json'))).toBe(true);
  });

  it('adds remediation features and reruns final review after a product review failure', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-final-review-rerun-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Final review rerun mission\n', 'utf-8');
    mkdirSync(join(cwd, 'artifacts', 'screenshots'), { recursive: true });
    writeFileSync(join(cwd, 'artifacts', 'screenshots', 'checkout-after.png'), 'png', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'final-review-rerun',
      goal: 'Loop on final review findings until sign-off',
      constraints: ['No backward compatibility'],
      successCriteria: ['final review reruns after remediation'],
      productReviewContract: {
        target: 'http://127.0.0.1:${PORT}',
        preconditions: ['js_repl enabled', 'playwright importable'],
        checkpoints: [
          { id: 'checkout', description: 'Checkout flow satisfies the PRD', visual: true },
        ],
        artifactsDir: 'artifacts/screenshots',
      },
      milestones: [
        {
          id: 'm1',
          title: 'Implementation',
          description: 'Build the feature',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement the feature',
              kind: 'implementation',
              status: 'pending',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
        {
          id: 'm2',
          title: 'Final Review',
          description: 'Run final product review and code review',
          order: 2,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm2-f1',
              description: 'Run final product review',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
            {
              id: 'm2-f2',
              description: 'Run final code review',
              kind: 'review',
              reviewType: 'code',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');
    const reviewFollowUps = jest.spyOn(ManagerAgent.prototype, 'generateReviewFollowUpFeatures')
      .mockResolvedValue([
        {
          description: 'Fix the checkout flow to satisfy the PRD',
          trackingKey: 'checkout-flow',
          priority: 'high',
          rerunReviewTypes: ['product', 'code'],
          affectedProductCheckpoints: ['checkout'],
          model: 'codex-latest',
        },
      ]);
    const workerRun = jest.spyOn(WorkerAgent.prototype, 'run');
    workerRun
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: 'm1',
          featureId: 'm1-f1',
          status: 'SUCCESS',
          summary: 'implementation complete',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      })
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 2,
          milestoneId: 'm2',
          featureId: 'm2-f1',
          status: 'SUCCESS',
          summary: 'product review found blockers',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: false,
            testsPassed: 0,
            testsFailed: 0,
            lintPassed: false,
            typecheckPassed: false,
          },
          checks: [],
          review: {
            reviewType: 'product',
            generation: 1,
            passed: false,
            summary: 'product review found blockers',
            findings: [
              {
                id: 'product-finding-1',
                reviewType: 'product',
                priority: 'P2',
                summary: 'Checkout flow does not satisfy the PRD',
                rationale: 'The main product claim is still unmet.',
                trackingKey: 'checkout-flow',
                surface: 'checkout',
              },
            ],
            artifacts: [],
          },
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      })
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 3,
          milestoneId: 'm2',
          featureId: 'm2-f3',
          status: 'SUCCESS',
          summary: 'remediation complete',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      })
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 4,
          milestoneId: 'm2',
          featureId: 'm2-f4',
          status: 'SUCCESS',
          summary: 'product review passed after remediation',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: false,
            testsPassed: 0,
            testsFailed: 0,
            lintPassed: false,
            typecheckPassed: false,
          },
          checks: [],
          review: {
            reviewType: 'product',
            generation: 2,
            passed: true,
            summary: 'product review passed after remediation',
            findings: [],
            artifacts: [
              {
                kind: 'screenshot',
                path: 'artifacts/screenshots/checkout-after.png',
                checkpointId: 'checkout',
                phase: 'after',
              },
            ],
            checkpointResults: [
              {
                checkpointId: 'checkout',
                passed: true,
                afterObserved: 'Checkout now satisfies the PRD.',
                afterScreenshotPath: 'artifacts/screenshots/checkout-after.png',
              },
            ],
          },
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      })
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 5,
          milestoneId: 'm2',
          featureId: 'm2-f5',
          status: 'SUCCESS',
          summary: 'code review passed after remediation',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: false,
            testsPassed: 0,
            testsFailed: 0,
            lintPassed: false,
            typecheckPassed: false,
          },
          checks: [],
          review: {
            reviewType: 'code',
            generation: 2,
            passed: true,
            summary: 'code review passed after remediation',
            findings: [],
            artifacts: [],
          },
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 12,
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
    expect(reviewFollowUps).toHaveBeenCalledWith(expect.objectContaining({
      milestoneId: 'm2',
      reviewType: 'product',
      generation: 1,
    }));
    expect(workerRun.mock.calls.map(([input]) => input.feature.id)).toEqual(['m1-f1', 'm2-f1', 'm2-f3', 'm2-f4', 'm2-f5']);

    const persisted = JSON.parse(readFileSync(missionPath, 'utf-8')) as MissionPlan;
    const finalReviewMilestone = persisted.milestones.find((milestone) => milestone.id === 'm2');
    expect(finalReviewMilestone?.features.map((feature) => ({ id: feature.id, status: feature.status }))).toEqual([
      { id: 'm2-f1', status: 'done' },
      { id: 'm2-f2', status: 'skipped' },
      { id: 'm2-f3', status: 'done' },
      { id: 'm2-f4', status: 'done' },
      { id: 'm2-f5', status: 'done' },
    ]);
    expect(finalReviewMilestone?.features.find((reviewFeature) => reviewFeature.id === 'm2-f4')?.scopedReviewCheckpointIds).toEqual(['checkout']);
    expect(existsSync(join(melosDir, 'reviews', 'm2-f1.json'))).toBe(true);
    expect(existsSync(join(melosDir, 'reviews', 'm2-f4.json'))).toBe(true);
    expect(existsSync(join(melosDir, 'reviews', 'm2-f5.json'))).toBe(true);
  });

  it('reruns only code review when review follow-up does not request product rerun', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-code-only-rerun-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Code-only rerun mission\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'code-only-rerun',
      goal: 'Prefer code rerun unless manager asks for product rerun',
      constraints: ['No backward compatibility'],
      successCriteria: ['product rerun is added only when needed'],
      productReviewContract: {
        target: 'http://127.0.0.1:${PORT}',
        preconditions: ['js_repl enabled', 'playwright importable'],
        checkpoints: [
          { id: 'checkout', description: 'Checkout flow satisfies the PRD', visual: true },
          { id: 'seo-head-signals', description: 'SEO head signals match the PRD', visual: false },
        ],
        artifactsDir: 'artifacts/screenshots',
      },
      milestones: [
        {
          id: 'm1',
          title: 'Implementation',
          description: 'Build the feature',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement the feature',
              kind: 'implementation',
              status: 'pending',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
        {
          id: 'm2',
          title: 'Final Review',
          description: 'Run final product review and code review',
          order: 2,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm2-f1',
              description: 'Run final product review',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
            {
              id: 'm2-f2',
              description: 'Run final code review',
              kind: 'review',
              reviewType: 'code',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'planning',
    });
    writeFileSync(missionPath, `${JSON.stringify(planned, null, 2)}\n`, 'utf-8');

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');
    jest.spyOn(ManagerAgent.prototype, 'generateReviewFollowUpFeatures')
      .mockResolvedValue([
        {
          description: 'Fix the checkout tests and implementation',
          trackingKey: 'checkout-flow',
          priority: 'high',
          model: 'codex-latest',
        },
      ]);
    const workerRun = jest.spyOn(WorkerAgent.prototype, 'run');
    workerRun
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: 'm1',
          featureId: 'm1-f1',
          status: 'SUCCESS',
          summary: 'implementation complete',
          warnings: [],
          filesChanged: [],
          validation: { testsRun: true, testsPassed: 1, testsFailed: 0, lintPassed: true, typecheckPassed: true },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      })
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 2,
          milestoneId: 'm2',
          featureId: 'm2-f1',
          status: 'SUCCESS',
          summary: 'product review found blockers',
          warnings: [],
          filesChanged: [],
          validation: { testsRun: false, testsPassed: 0, testsFailed: 0, lintPassed: false, typecheckPassed: false },
          checks: [],
          review: {
            reviewType: 'product',
            generation: 1,
            passed: false,
            summary: 'product review found blockers',
            findings: [
              {
                id: 'product-finding-1',
                reviewType: 'product',
                priority: 'P2',
                summary: 'Checkout contract is broken',
                rationale: 'Fix is needed before sign-off.',
                trackingKey: 'checkout-flow',
                surface: 'checkout',
              },
            ],
            artifacts: [],
          },
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      })
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 3,
          milestoneId: 'm2',
          featureId: 'm2-f3',
          status: 'SUCCESS',
          summary: 'remediation complete',
          warnings: [],
          filesChanged: [],
          validation: { testsRun: true, testsPassed: 1, testsFailed: 0, lintPassed: true, typecheckPassed: true },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      })
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 4,
          milestoneId: 'm2',
          featureId: 'm2-f4',
          status: 'SUCCESS',
          summary: 'code review passed after remediation',
          warnings: [],
          filesChanged: [],
          validation: { testsRun: false, testsPassed: 0, testsFailed: 0, lintPassed: false, typecheckPassed: false },
          checks: [],
          review: {
            reviewType: 'code',
            generation: 2,
            passed: true,
            summary: 'code review passed after remediation',
            findings: [],
            artifacts: [],
          },
          learnings: [],
          requestsHelp: false,
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
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(workerRun.mock.calls.map(([input]) => input.feature.id)).toEqual(['m1-f1', 'm2-f1', 'm2-f3', 'm2-f4']);

    const persisted = JSON.parse(readFileSync(missionPath, 'utf-8')) as MissionPlan;
    const finalReviewMilestone = persisted.milestones.find((milestone) => milestone.id === 'm2');
    expect(finalReviewMilestone?.features.map((feature) => ({
      id: feature.id,
      reviewType: feature.reviewType,
      status: feature.status,
      scopedReviewCheckpointIds: feature.scopedReviewCheckpointIds,
    }))).toEqual([
      { id: 'm2-f1', reviewType: 'product', status: 'done', scopedReviewCheckpointIds: undefined },
      { id: 'm2-f2', reviewType: 'code', status: 'skipped', scopedReviewCheckpointIds: undefined },
      { id: 'm2-f3', reviewType: undefined, status: 'done', scopedReviewCheckpointIds: undefined },
      { id: 'm2-f4', reviewType: 'code', status: 'done', scopedReviewCheckpointIds: undefined },
    ]);
  });

  it('continues with remediation follow-ups when a product review returns BLOCKED with actionable findings', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-final-review-blocked-followup-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(melosDir, 'reviews'), { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Final review blocked follow-up mission\n', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const runningPlan = createMissionPlan({
      missionId: 'final-review-blocked-followup',
      goal: 'Continue after actionable blocked review',
      constraints: [],
      successCriteria: ['blocked reviews with actionable findings create remediation work instead of pausing'],
      milestones: [
        {
          id: 'm1',
          title: 'Final Review',
          description: 'Run final product review',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Run final product review',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 1,
              status: 'in_progress',
              attempts: 1,
              model: 'codex-latest',
            },
            {
              id: 'm1-f2',
              description: 'Run final code review',
              kind: 'review',
              reviewType: 'code',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'running',
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 8,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const reviewFollowUps = jest.spyOn(ManagerAgent.prototype, 'generateReviewFollowUpFeatures')
      .mockResolvedValue([
        {
          description: 'Restore ActionCable and ml runtime required for final review sign-off',
          trackingKey: 'product-review-runtime-missing-cable-and-ml',
          priority: 'high',
          model: 'codex-latest',
        },
      ]);
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      handleReviewFeatureResult: (
        milestone: MissionPlan['milestones'][number],
        feature: MissionPlan['milestones'][number]['features'][number],
        result: {
          type: 'blocked';
          report: WorkerFeatureReport;
        }
      ) => Promise<void>;
    };
    orchestratorAny.state.missionPlan = {
      ...runningPlan,
      activeMilestoneId: 'm1',
      activeFeatureId: 'm1-f1',
    };
    orchestratorAny.kernelState.missionPlan = orchestratorAny.state.missionPlan;

    const milestone = orchestratorAny.state.missionPlan.milestones[0]!;
    const feature = milestone.features[0]!;
    await orchestratorAny.handleReviewFeatureResult(milestone, feature, {
      type: 'blocked',
      report: {
        iteration: 1,
        milestoneId: 'm1',
        featureId: 'm1-f1',
        status: 'BLOCKED',
        summary: 'product review could not sign off due to missing runtime pieces',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: false,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: false,
          typecheckPassed: false,
        },
        checks: [],
        review: {
          reviewType: 'product',
          generation: 1,
          passed: false,
          summary: 'product review could not sign off due to missing runtime pieces',
          findings: [
            {
              id: 'product-review-blocked',
              reviewType: 'product',
              priority: 'P1',
              summary: 'Review runtime is incomplete',
              rationale: 'ActionCable and ml are unavailable so remaining AI features cannot be signed off',
              suggestedFix: 'Restore ActionCable and ml runtime required for final review sign-off',
              trackingKey: 'product-review-runtime-missing-cable-and-ml',
              surface: 'review-runtime',
            },
          ],
          artifacts: [],
        },
        learnings: [],
        requestsHelp: true,
        createdAt: new Date().toISOString(),
      },
    });

    const missionPlan = orchestratorAny.state.missionPlan!;
    expect(missionPlan.state).toBe('running');
    expect(missionPlan.activeMilestoneId).toBe('m1');
    expect(missionPlan.activeFeatureId).toBeNull();
    expect(
      missionPlan.milestones[0]?.features.map((item) => ({
        id: item.id,
        status: item.status,
        kind: item.kind,
        reviewType: item.reviewType,
        generation: item.reviewGeneration,
      }))
    ).toEqual([
      { id: 'm1-f1', status: 'done', kind: 'review', reviewType: 'product', generation: 1 },
      { id: 'm1-f2', status: 'skipped', kind: 'review', reviewType: 'code', generation: 1 },
      { id: 'm1-f3', status: 'pending', kind: 'review_remediation', reviewType: undefined, generation: undefined },
      { id: 'm1-f4', status: 'pending', kind: 'review', reviewType: 'product', generation: 2 },
      { id: 'm1-f5', status: 'pending', kind: 'review', reviewType: 'code', generation: 2 },
    ]);
    expect(missionPlan.milestones[0]?.features[2]?.trackingKey).toBe('product-review-runtime-missing-cable-and-ml');
    expect(reviewFollowUps).toHaveBeenCalledWith(expect.objectContaining({
      milestoneId: 'm1',
      reviewType: 'product',
      generation: 1,
    }));

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('"action":"review_blocked_auto_downgraded"');
    expect(events).toContain('"type":"task_added"');
    expect(events).not.toContain('"type":"mission_interrupted"');
  });

  it('pauses and emits mission_interrupted when a blocked review has no actionable findings', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-final-review-blocked-pause-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(melosDir, 'reviews'), { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Final review blocked pause mission\n', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const runningPlan = createMissionPlan({
      missionId: 'final-review-blocked-pause',
      goal: 'Pause only when blocked review has no actionable findings',
      constraints: [],
      successCriteria: ['truly blocked reviews still pause'],
      milestones: [
        {
          id: 'm1',
          title: 'Final Review',
          description: 'Run final product review',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Run final product review',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 1,
              status: 'in_progress',
              attempts: 1,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'running',
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 8,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      handleReviewFeatureResult: (
        milestone: MissionPlan['milestones'][number],
        feature: MissionPlan['milestones'][number]['features'][number],
        result: {
          type: 'blocked';
          report: WorkerFeatureReport;
        }
      ) => Promise<void>;
    };
    orchestratorAny.state.missionPlan = {
      ...runningPlan,
      activeMilestoneId: 'm1',
      activeFeatureId: 'm1-f1',
    };
    orchestratorAny.kernelState.missionPlan = orchestratorAny.state.missionPlan;

    const milestone = orchestratorAny.state.missionPlan.milestones[0]!;
    const feature = milestone.features[0]!;
    await orchestratorAny.handleReviewFeatureResult(milestone, feature, {
      type: 'blocked',
      report: {
        iteration: 1,
        milestoneId: 'm1',
        featureId: 'm1-f1',
        status: 'BLOCKED',
        summary: 'product review contract unusable',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: false,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: false,
          typecheckPassed: false,
        },
        checks: [],
        review: {
          reviewType: 'product',
          generation: 1,
          passed: false,
          summary: 'product review contract unusable',
          findings: [],
          artifacts: [],
        },
        learnings: [],
        requestsHelp: true,
        createdAt: new Date().toISOString(),
      },
    });

    const missionPlan = orchestratorAny.state.missionPlan!;
    expect(missionPlan.state).toBe('paused');
    expect(missionPlan.activeMilestoneId).toBe('m1');
    expect(missionPlan.activeFeatureId).toBe('m1-f1');
    expect(missionPlan.milestones[0]?.features.map((item) => ({ id: item.id, status: item.status }))).toEqual([
      { id: 'm1-f1', status: 'pending' },
    ]);

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('"type":"mission_interrupted"');
    expect(events).toContain('review blocked and requested help');
  });

  it('backfills product review checkpointResults from captured artifacts before enforcing evidence completeness', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-product-review-backfill-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(join(melosDir, 'reviews'), { recursive: true });
    mkdirSync(join(cwd, 'artifacts', 'screenshots'), { recursive: true });
    writeFileSync(join(cwd, 'artifacts', 'screenshots', 'root-after.png'), 'png', 'utf-8');

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Product review backfill\n', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const runningPlan = createMissionPlan({
      missionId: 'product-review-backfill',
      goal: 'Backfill checkpoint results from review artifacts',
      constraints: [],
      successCriteria: ['single-evidence checkpoint results are inferred from artifacts when missing'],
      productReviewContract: {
        target: 'http://127.0.0.1:${PORT}',
        preconditions: ['js_repl enabled', 'playwright importable'],
        checkpoints: [
          {
            id: 'root-dispatcher',
            description: 'Verify root dispatcher',
            visual: true,
            evidenceMode: 'single',
            requiredArtifacts: ['screenshot'],
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
          status: 'in_progress',
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
              status: 'in_progress',
              attempts: 1,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'running',
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 4,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null; validationEvidence?: Record<string, Record<string, ValidationCheckResult>> };
      enforceProductReviewEvidenceContract: (
        milestoneId: string,
        feature: MissionPlan['milestones'][number]['features'][number],
        reviewReport: ReviewReport
      ) => ReviewReport;
    };
    orchestratorAny.state.missionPlan = runningPlan;
    orchestratorAny.kernelState.missionPlan = runningPlan;
    orchestratorAny.kernelState.validationEvidence = {};

    const milestone = runningPlan.milestones[0]!;
    const feature = milestone.features[0]!;
    const enforced = orchestratorAny.enforceProductReviewEvidenceContract('m3', feature, {
      milestoneId: 'm3',
      featureId: 'm3-f1',
      reviewType: 'product',
      generation: 1,
      timestamp: new Date().toISOString(),
      passed: true,
      summary: 'product review passed',
      findings: [],
      artifacts: [
        {
          kind: 'screenshot',
          path: 'artifacts/screenshots/root-after.png',
          checkpointId: 'root-dispatcher',
          phase: 'after',
        },
      ],
      blockingFindingCount: 0,
    });

    expect(enforced.findings).toEqual([]);
    expect(enforced.checkpointResults).toEqual([
      expect.objectContaining({
        checkpointId: 'root-dispatcher',
        passed: true,
        afterScreenshotPath: 'artifacts/screenshots/root-after.png',
      }),
    ]);
  });

  it('does not require screenshots for non-visual product review checkpoints', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-product-review-nonvisual-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(join(melosDir, 'reviews'), { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Product review non visual\n', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const runningPlan = createMissionPlan({
      missionId: 'product-review-nonvisual',
      goal: 'Non-visual checkpoints should not require screenshots by default',
      constraints: [],
      successCriteria: ['non-visual checkpoints pass evidence completeness without screenshots'],
      productReviewContract: {
        target: 'http://127.0.0.1:${PORT}',
        preconditions: ['js_repl enabled', 'playwright importable'],
        artifactsDir: 'artifacts/screenshots',
        checkpoints: [
          {
            id: 'seo-head-signals',
            description: 'Verify canonical and hreflang output',
            visual: false,
            evidenceMode: 'single',
          },
        ],
      },
      milestones: [
        {
          id: 'm3',
          title: 'Final Review',
          description: 'Run final product review',
          order: 1,
          status: 'in_progress',
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
              status: 'in_progress',
              attempts: 1,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'running',
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 4,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null; validationEvidence?: Record<string, Record<string, ValidationCheckResult>> };
      enforceProductReviewEvidenceContract: (
        milestoneId: string,
        feature: MissionPlan['milestones'][number]['features'][number],
        reviewReport: ReviewReport
      ) => ReviewReport;
    };
    orchestratorAny.state.missionPlan = runningPlan;
    orchestratorAny.kernelState.missionPlan = runningPlan;
    orchestratorAny.kernelState.validationEvidence = {};

    const milestone = runningPlan.milestones[0]!;
    const feature = milestone.features[0]!;
    const enforced = orchestratorAny.enforceProductReviewEvidenceContract('m3', feature, {
      milestoneId: 'm3',
      featureId: 'm3-f1',
      reviewType: 'product',
      generation: 1,
      timestamp: new Date().toISOString(),
      passed: true,
      summary: 'product review passed',
      findings: [],
      artifacts: [],
      checkpointResults: [
        {
          checkpointId: 'seo-head-signals',
          passed: true,
          afterObserved: 'canonical and hreflang matched the dispatcher policy',
        },
      ],
      blockingFindingCount: 0,
    });

    expect(enforced.findings).toEqual([]);
    expect(enforced.passed).toBe(true);
  });

  it('does not add evidence completeness findings when a product review is already blocked', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-product-review-blocked-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(join(melosDir, 'reviews'), { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Product review blocked\n', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const runningPlan = createMissionPlan({
      missionId: 'product-review-blocked',
      goal: 'Keep the original blocked finding without synthetic evidence noise',
      constraints: [],
      successCriteria: ['blocked reviews are not rewritten into evidence failures'],
      productReviewContract: {
        target: 'http://127.0.0.1:${PORT}',
        preconditions: ['js_repl enabled', 'playwright importable'],
        artifactsDir: 'artifacts/screenshots',
        checkpoints: [
          {
            id: 'root-dispatcher',
            description: 'Verify root dispatcher',
            visual: true,
          },
        ],
      },
      milestones: [
        {
          id: 'm3',
          title: 'Final Review',
          description: 'Run final product review',
          order: 1,
          status: 'in_progress',
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
              status: 'in_progress',
              attempts: 1,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'running',
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 4,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null; validationEvidence?: Record<string, Record<string, ValidationCheckResult>> };
      enforceProductReviewEvidenceContract: (
        milestoneId: string,
        feature: MissionPlan['milestones'][number]['features'][number],
        reviewReport: ReviewReport
      ) => ReviewReport;
    };
    orchestratorAny.state.missionPlan = runningPlan;
    orchestratorAny.kernelState.missionPlan = runningPlan;
    orchestratorAny.kernelState.validationEvidence = {};

    const milestone = runningPlan.milestones[0]!;
    const feature = milestone.features[0]!;
    const enforced = orchestratorAny.enforceProductReviewEvidenceContract('m3', feature, {
      milestoneId: 'm3',
      featureId: 'm3-f1',
      reviewType: 'product',
      generation: 1,
      timestamp: new Date().toISOString(),
      passed: false,
      summary: 'Product review is blocked',
      findings: [
        {
          id: 'product-review-blocked',
          reviewType: 'product',
          priority: 'P1',
          summary: 'Product review is blocked',
          rationale: 'The review executor did not return a structured final review report.',
          trackingKey: 'product-review-blocked',
        },
      ],
      artifacts: [],
      blockingFindingCount: 1,
    });

    expect(enforced.findings).toEqual([
      expect.objectContaining({
        id: 'product-review-blocked',
        trackingKey: 'product-review-blocked',
      }),
    ]);
    expect(enforced.findings.find((finding) => finding.id === 'product-review-evidence-incomplete')).toBeUndefined();
  });

  it('does not generate review remediation tasks for evidence-only findings', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-review-evidence-only-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(melosDir, 'reviews'), { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Final review evidence only\n', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const runningPlan = createMissionPlan({
      missionId: 'final-review-evidence-only',
      goal: 'Do not convert review infrastructure findings into product remediation tasks',
      constraints: [],
      successCriteria: ['infra-only review failures pause instead of adding remediation features'],
      milestones: [
        {
          id: 'm1',
          title: 'Final Review',
          description: 'Run final product review',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Run final product review',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 1,
              status: 'in_progress',
              attempts: 1,
              model: 'codex-latest',
            },
          ],
        },
      ],
      productReviewContract: {
        target: 'http://127.0.0.1:${PORT}',
        preconditions: ['js_repl enabled', 'playwright importable'],
        artifactsDir: 'artifacts/screenshots',
        checkpoints: [
          {
            id: 'seo-head-signals',
            description: 'Verify head signals',
            visual: true,
            evidenceMode: 'single',
            requiredArtifacts: ['screenshot'],
          },
        ],
      },
      state: 'running',
    });

    const reviewFollowUps = jest.spyOn(ManagerAgent.prototype, 'generateReviewFollowUpFeatures');
    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 8,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      handleReviewFeatureResult: (
        milestone: MissionPlan['milestones'][number],
        feature: MissionPlan['milestones'][number]['features'][number],
        result: {
          type: 'success';
          report: WorkerFeatureReport;
        }
      ) => Promise<void>;
    };
    orchestratorAny.state.missionPlan = {
      ...runningPlan,
      activeMilestoneId: 'm1',
      activeFeatureId: 'm1-f1',
    };
    orchestratorAny.kernelState.missionPlan = orchestratorAny.state.missionPlan;

    const milestone = orchestratorAny.state.missionPlan.milestones[0]!;
    const feature = milestone.features[0]!;
    await orchestratorAny.handleReviewFeatureResult(milestone, feature, {
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: 'm1',
        featureId: 'm1-f1',
        status: 'SUCCESS',
        summary: 'review ran but evidence is incomplete',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: false,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: false,
          typecheckPassed: false,
        },
        checks: [],
        review: {
          reviewType: 'product',
          generation: 1,
          passed: true,
          summary: 'review ran but evidence is incomplete',
          findings: [],
          artifacts: [],
          checkpointResults: [
            {
              checkpointId: 'seo-head-signals',
              passed: true,
              afterObserved: 'canonical and hreflang matched the dispatcher policy',
            },
          ],
        },
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    });

    const missionPlan = orchestratorAny.state.missionPlan!;
    expect(missionPlan.state).toBe('paused');
    expect(missionPlan.activeMilestoneId).toBe('m1');
    expect(missionPlan.activeFeatureId).toBe('m1-f1');
    expect(missionPlan.milestones[0]?.features.map((item) => ({ id: item.id, status: item.status, kind: item.kind }))).toEqual([
      { id: 'm1-f1', status: 'pending', kind: 'review' },
    ]);
    expect(reviewFollowUps).not.toHaveBeenCalled();

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('review infrastructure findings require manual intervention');
    expect(events).toContain('"type":"mission_interrupted"');
    expect(events).not.toContain('"type":"task_added"');
  });

  it('filters review infrastructure findings out of remediation planning when product issues also exist', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-review-followup-filter-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(melosDir, 'reviews'), { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Final review follow-up filter\n', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const runningPlan = createMissionPlan({
      missionId: 'final-review-followup-filter',
      goal: 'Only product findings should become remediation tasks',
      constraints: [],
      successCriteria: ['evidence completeness findings are excluded from follow-up planning'],
      milestones: [
        {
          id: 'm1',
          title: 'Final Review',
          description: 'Run final product review',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Run final product review',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 1,
              status: 'in_progress',
              attempts: 1,
              model: 'codex-latest',
            },
            {
              id: 'm1-f2',
              description: 'Run final code review',
              kind: 'review',
              reviewType: 'code',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'running',
    });

    const reviewFollowUps = jest.spyOn(ManagerAgent.prototype, 'generateReviewFollowUpFeatures')
      .mockResolvedValue([
        {
          description: 'Move whitelist redirects behind a GET/HEAD middleware gate',
          trackingKey: 'locale-redirects-post-method-leak',
          priority: 'high',
          model: 'codex-latest',
        },
      ]);
    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 8,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      handleReviewFeatureResult: (
        milestone: MissionPlan['milestones'][number],
        feature: MissionPlan['milestones'][number]['features'][number],
        result: {
          type: 'success';
          report: WorkerFeatureReport;
        }
      ) => Promise<void>;
    };
    orchestratorAny.state.missionPlan = {
      ...runningPlan,
      activeMilestoneId: 'm1',
      activeFeatureId: 'm1-f1',
    };
    orchestratorAny.kernelState.missionPlan = orchestratorAny.state.missionPlan;

    const milestone = orchestratorAny.state.missionPlan.milestones[0]!;
    const feature = milestone.features[0]!;
    await orchestratorAny.handleReviewFeatureResult(milestone, feature, {
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: 'm1',
        featureId: 'm1-f1',
        status: 'SUCCESS',
        summary: 'review found one product issue and one evidence issue',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: false,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: false,
          typecheckPassed: false,
        },
        checks: [],
        review: {
          reviewType: 'product',
          generation: 1,
          passed: false,
          summary: 'review found one product issue and one evidence issue',
          findings: [
            {
              id: 'product-finding-1',
              reviewType: 'product',
              priority: 'P2',
              summary: 'Whitelist locale redirects still apply to POST requests',
              rationale: 'POST /for/authors redirected even though the PRD limits locale redirects to GET/HEAD.',
              suggestedFix: 'Move whitelist redirects behind a GET/HEAD middleware gate.',
              trackingKey: 'locale-redirects-post-method-leak',
              surface: 'whitelist-subpages',
            },
            {
              id: 'product-review-evidence-incomplete',
              reviewType: 'product',
              priority: 'P1',
              summary: 'Final product review evidence is incomplete',
              rationale: 'seo-head-signals: missing after screenshot',
              suggestedFix: 'Capture the required baseline and after evidence for each product review checkpoint before sign-off.',
              trackingKey: 'product-review-evidence-incomplete',
              surface: 'final-review-evidence',
              affectedFiles: [],
            },
          ],
          artifacts: [],
        },
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    });

    expect(reviewFollowUps).toHaveBeenCalledWith(expect.objectContaining({
      findings: [
        expect.objectContaining({
          trackingKey: 'locale-redirects-post-method-leak',
        }),
      ],
    }));

    const missionPlan = orchestratorAny.state.missionPlan!;
    expect(missionPlan.state).toBe('running');
    expect(missionPlan.milestones[0]?.features.map((item) => ({ id: item.id, status: item.status, kind: item.kind }))).toEqual([
      { id: 'm1-f1', status: 'done', kind: 'review' },
      { id: 'm1-f2', status: 'skipped', kind: 'review' },
      { id: 'm1-f3', status: 'pending', kind: 'review_remediation' },
      { id: 'm1-f4', status: 'pending', kind: 'review' },
    ]);
    expect(missionPlan.milestones[0]?.features[2]?.trackingKey).toBe('locale-redirects-post-method-leak');

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('"type":"task_added"');
  });

  it('fails manual validation when manual evidence is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-warning-handoff-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Warning handoff mission\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'warning-handoff',
      goal: 'Surface runtime warnings without blocking completion',
      constraints: ['No backward compatibility'],
      successCriteria: ['warnings are persisted to handoff and events'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement and manually verify',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'manual-qa',
                description: 'Check browser flow',
                type: 'manual',
                passed: false,
                failureCount: 0,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement flow',
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
    jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Capture the required manual verification evidence',
        trackingKey: 'manual-evidence-missing',
        priority: 'high',
        model: 'codex',
      },
    ]);
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => ({
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: input.milestone.id,
        featureId: input.feature.id,
        status: 'SUCCESS',
        summary: 'done',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: true,
          testsPassed: 1,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    }));

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 6,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(false);
    expect(result.reason).toBe('max_iterations');

    const report = JSON.parse(readFileSync(join(melosDir, 'validations', 'm1-attempt-1.json'), 'utf-8')) as {
      passed: boolean;
      results: Array<{ checkId: string; passed: boolean; failure?: { summary: string } }>;
    };
    expect(report.passed).toBe(false);
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        checkId: 'manual-qa',
        passed: false,
        failure: expect.objectContaining({
          summary: 'manual validation was not reported by the worker',
        }),
      }),
    ]));

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload?: { source?: string; message?: string } });
    const warningEvents = events.filter((event) => event.type === 'warning_emitted');
    expect(warningEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          source: 'validation',
          message: 'manual verification was not reported by the worker: Check browser flow',
        }),
      }),
    ]));
  });

  it('lets manager accept deviations or handoff gaps without generating review remediation', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-review-decision-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(melosDir, 'reviews'), { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Review decision mission\n', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const runningPlan = createMissionPlan({
      missionId: 'review-decision',
      goal: 'Allow manager-owned review decisions',
      constraints: ['Tests may pass even when PRD deviations must be handed off'],
      successCriteria: ['Manager can stop remediation loops and preserve handoff context'],
      milestones: [
        {
          id: 'm1',
          title: 'Final Review',
          description: 'Run final code review',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Run final code review',
              kind: 'review',
              reviewType: 'code',
              reviewGeneration: 1,
              status: 'in_progress',
              attempts: 1,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'running',
    });

    jest.spyOn(ManagerAgent.prototype, 'decideReviewDisposition').mockResolvedValue([
      {
        findingId: 'code-finding-1',
        decision: 'accept_deviation',
        rationale: 'The implementation is safer than the PRD and should be kept.',
      },
      {
        findingId: 'code-finding-2',
        decision: 'handoff_gap',
        rationale: 'The remaining PRD gap should be explained to the user instead of retried.',
      },
    ]);
    const reviewFollowUps = jest.spyOn(ManagerAgent.prototype, 'generateReviewFollowUpFeatures');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 8,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null; reviewDecisions: Array<{ decision: string; summary: string }> };
      kernelState: { missionPlan: MissionPlan | null };
      handleReviewFeatureResult: (
        milestone: MissionPlan['milestones'][number],
        feature: MissionPlan['milestones'][number]['features'][number],
        result: {
          type: 'success';
          report: WorkerFeatureReport;
        }
      ) => Promise<void>;
      writeHandoff: () => Promise<string>;
    };
    orchestratorAny.state.missionPlan = {
      ...runningPlan,
      activeMilestoneId: 'm1',
      activeFeatureId: 'm1-f1',
    };
    orchestratorAny.kernelState.missionPlan = orchestratorAny.state.missionPlan;

    const milestone = orchestratorAny.state.missionPlan.milestones[0]!;
    const feature = milestone.features[0]!;
    await orchestratorAny.handleReviewFeatureResult(milestone, feature, {
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: 'm1',
        featureId: 'm1-f1',
        status: 'SUCCESS',
        summary: 'review identified one acceptable deviation and one handoff gap',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: false,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: false,
          typecheckPassed: false,
        },
        checks: [],
        review: {
          reviewType: 'code',
          generation: 1,
          passed: false,
          summary: 'review identified one acceptable deviation and one handoff gap',
          findings: [
            {
              id: 'code-finding-1',
              reviewType: 'code',
              priority: 'P2',
              summary: 'Current implementation is better than the original PRD routing split',
              trackingKey: 'better-routing-split',
              classification: 'better_than_prd',
              classificationRationale: 'The reviewed implementation removes duplication and is safer to keep.',
            },
            {
              id: 'code-finding-2',
              reviewType: 'code',
              priority: 'P2',
              summary: 'One PRD edge case remains intentionally unsupported',
              trackingKey: 'remaining-prd-gap',
              classification: 'unimplementable',
              classificationRationale: 'Framework limitations prevent this edge case from being implemented cleanly.',
            },
          ],
          artifacts: [],
        },
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    });

    expect(reviewFollowUps).not.toHaveBeenCalled();
    expect(orchestratorAny.state.missionPlan?.milestones[0]?.features[0]?.status).toBe('done');
    expect(orchestratorAny.state.reviewDecisions).toEqual([
      expect.objectContaining({
        findingId: 'code-finding-1',
        decision: 'accept_deviation',
      }),
      expect.objectContaining({
        findingId: 'code-finding-2',
        decision: 'handoff_gap',
      }),
    ]);

    const handoff = await orchestratorAny.writeHandoff();
    expect(handoff).toContain('## Accepted Deviations');
    expect(handoff).toContain('better-routing-split');
    expect(handoff).toContain('## PRD Gaps To Share');
    expect(handoff).toContain('remaining-prd-gap');
  });

  it('fails browser validation when worker does not report browser evidence', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-browser-missing-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Browser evidence mission\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'browser-missing',
      goal: 'Browser validation requires worker evidence',
      constraints: ['No backward compatibility'],
      successCriteria: ['browser validation fails without worker evidence'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement and verify',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'browser-qa',
                description: 'Check browser flow',
                type: 'browser',
                requiredRunner: 'playwright-interactive',
                requiredArtifacts: ['screenshot'],
                passed: false,
                failureCount: 0,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement flow',
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
    const followUpSpy = jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Fix browser QA regression',
        priority: 'high',
        model: 'codex',
      },
    ]);
    jest.spyOn(WorkerAgent.prototype, 'run').mockResolvedValue({
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: 'm1',
        featureId: 'm1-f1',
        status: 'SUCCESS',
        summary: 'done',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: true,
          testsPassed: 1,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 3,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(false);
    expect(result.reason).toBe('max_iterations');
    expect(followUpSpy).toHaveBeenCalledWith(expect.objectContaining({
      milestoneId: 'm1',
      failures: expect.arrayContaining([
        expect.objectContaining({
          checkId: 'browser-qa',
          passed: false,
        }),
      ]),
    }));

    const report = JSON.parse(readFileSync(join(melosDir, 'validations', 'm1-attempt-1.json'), 'utf-8')) as {
      passed: boolean;
      results: Array<{ checkId: string; passed: boolean; failure?: { summary: string } }>;
    };
    expect(report.passed).toBe(false);
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        checkId: 'browser-qa',
        passed: false,
        failure: expect.objectContaining({
          summary: 'browser validation was not reported by the worker',
        }),
      }),
    ]));
  });

  it('retries implementation features before generating remediation follow-ups', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-feature-retry-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Feature retry mission\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'feature-retry',
      goal: 'Retry transient feature failures before remediation',
      constraints: ['No backward compatibility'],
      successCriteria: ['transient worker failures retry in place'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement and validate',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement flow',
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
    const remediationSpy = jest.spyOn(ManagerAgent.prototype, 'generateImplementationFollowUpFeatures');
    const workerRun = jest.spyOn(WorkerAgent.prototype, 'run');
    workerRun
      .mockResolvedValueOnce({
        type: 'failed',
        report: {
          iteration: 1,
          milestoneId: 'm1',
          featureId: 'm1-f1',
          status: 'FAILED',
          summary: 'transient failure',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 0,
            testsFailed: 1,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      })
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 2,
          milestoneId: 'm1',
          featureId: 'm1-f1',
          status: 'SUCCESS',
          summary: 'resolved after retry',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
      execution: {
        retryInitialDelayMs: 0,
        retryMaxDelayMs: 0,
      },
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(workerRun).toHaveBeenCalledTimes(2);
    expect(remediationSpy).not.toHaveBeenCalled();

    const saved = JSON.parse(readFileSync(missionPath, 'utf-8')) as {
      milestones: Array<{ features: Array<{ id: string; status: string; attempts: number }> }>;
    };
    expect(saved.milestones[0]?.features).toEqual([
      expect.objectContaining({
        id: 'm1-f1',
        status: 'done',
        attempts: 2,
      }),
    ]);
  });

  it('can fail worker warnings and retry the same feature', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-warning-retry-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Warning retry mission\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'warning-retry',
      goal: 'Treat worker warnings as blocking failures when configured',
      constraints: ['No backward compatibility'],
      successCriteria: ['warning-only worker runs retry when configured'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement and validate',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement flow',
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
    const workerRun = jest.spyOn(WorkerAgent.prototype, 'run');
    workerRun
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: 'm1',
          featureId: 'm1-f1',
          status: 'SUCCESS',
          summary: 'implemented with warning',
          warnings: ['manual verification is still required'],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      })
      .mockResolvedValueOnce({
        type: 'success',
        report: {
          iteration: 2,
          milestoneId: 'm1',
          featureId: 'm1-f1',
          status: 'SUCCESS',
          summary: 'implemented cleanly',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
      execution: {
        retryInitialDelayMs: 0,
        retryMaxDelayMs: 0,
      },
      verification: {
        failOnWorkerWarnings: true,
      },
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(workerRun).toHaveBeenCalledTimes(2);

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload?: { action?: string } });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'manager_decision',
        payload: expect.objectContaining({
          action: 'worker_warning_blocked',
        }),
      }),
      expect.objectContaining({
        type: 'manager_decision',
        payload: expect.objectContaining({
          action: 'feature_retry_scheduled',
        }),
      }),
    ]));
  });

  it('fails browser validation when runner does not match the required runner', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-browser-runner-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(cwd, 'artifacts', 'screenshots'), { recursive: true });
    writeFileSync(join(cwd, 'artifacts', 'screenshots', 'browser.png'), 'ok', 'utf-8');

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Browser runner mission\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'browser-runner',
      goal: 'Browser validation enforces runner matching',
      constraints: ['No backward compatibility'],
      successCriteria: ['browser validation fails on runner mismatch'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement and verify',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'browser-qa',
                description: 'Check browser flow',
                type: 'browser',
                requiredRunner: 'playwright-interactive',
                requiredArtifacts: ['screenshot'],
                passed: false,
                failureCount: 0,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement flow',
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
    jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Fix browser QA regression',
        priority: 'high',
        model: 'codex',
      },
    ]);
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => ({
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: input.milestone.id,
        featureId: input.feature.id,
        status: 'SUCCESS',
        summary: 'done',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: true,
          testsPassed: 1,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: input.feature.kind === 'qa'
          ? [
            {
              checkId: 'browser-qa',
              passed: true,
              runner: 'browser-test',
              screenshotPath: 'artifacts/screenshots/browser.png',
            },
          ]
          : [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    }));

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 3,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(false);
    const report = JSON.parse(readFileSync(join(melosDir, 'validations', 'm1-attempt-1.json'), 'utf-8')) as {
      passed: boolean;
      results: Array<{ checkId: string; passed: boolean; failure?: { summary: string } }>;
    };
    expect(report.passed).toBe(false);
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        checkId: 'browser-qa',
        passed: false,
        failure: expect.objectContaining({
          summary: 'browser validation used unexpected runner: browser-test',
        }),
      }),
    ]));
  });

  it('fails browser validation when worker reports a warning', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-browser-warning-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(cwd, 'artifacts', 'screenshots'), { recursive: true });
    writeFileSync(join(cwd, 'artifacts', 'screenshots', 'browser.png'), 'ok', 'utf-8');

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Browser warning mission\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'browser-warning',
      goal: 'Browser validation fails when worker reports caveats',
      constraints: ['No backward compatibility'],
      successCriteria: ['browser validation does not pass with warning evidence'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement and verify',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'browser-qa',
                description: 'Check browser flow',
                type: 'browser',
                requiredRunner: 'playwright-interactive',
                requiredArtifacts: ['screenshot'],
                passed: false,
                failureCount: 0,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement flow',
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
    jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Fix browser QA regression',
        priority: 'high',
        model: 'codex',
      },
    ]);
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => ({
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: input.milestone.id,
        featureId: input.feature.id,
        status: 'SUCCESS',
        summary: 'done',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: true,
          testsPassed: 1,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: input.feature.kind === 'qa'
          ? [
            {
              checkId: 'browser-qa',
              passed: true,
              runner: 'playwright-interactive',
              screenshotPath: 'artifacts/screenshots/browser.png',
              warning: 'fallback browser QA was used',
            },
          ]
          : [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    }));

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 3,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(false);
    const report = JSON.parse(readFileSync(join(melosDir, 'validations', 'm1-attempt-1.json'), 'utf-8')) as {
      passed: boolean;
      results: Array<{ checkId: string; passed: boolean; warning?: string; failure?: { summary: string } }>;
    };
    expect(report.passed).toBe(false);
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        checkId: 'browser-qa',
        passed: false,
        warning: 'fallback browser QA was used',
        failure: expect.objectContaining({
          summary: 'browser validation reported warning',
        }),
      }),
    ]));
  });

  it('fails browser validation when artifact paths do not exist', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-browser-path-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Browser path mission\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'browser-path',
      goal: 'Browser validation checks artifact paths',
      constraints: ['No backward compatibility'],
      successCriteria: ['browser validation fails on missing artifact path'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement and verify',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'browser-qa',
                description: 'Check browser flow',
                type: 'browser',
                requiredRunner: 'playwright-interactive',
                requiredArtifacts: ['screenshot'],
                passed: false,
                failureCount: 0,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement flow',
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
    jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Fix browser QA regression',
        priority: 'high',
        model: 'codex',
      },
    ]);
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => ({
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: input.milestone.id,
        featureId: input.feature.id,
        status: 'SUCCESS',
        summary: 'done',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: true,
          testsPassed: 1,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: input.feature.kind === 'qa'
          ? [
            {
              checkId: 'browser-qa',
              passed: true,
              runner: 'playwright-interactive',
              screenshotPath: 'artifacts/screenshots/missing.png',
            },
          ]
          : [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    }));

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 3,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(false);
    const report = JSON.parse(readFileSync(join(melosDir, 'validations', 'm1-attempt-1.json'), 'utf-8')) as {
      passed: boolean;
      results: Array<{ checkId: string; passed: boolean; failure?: { summary: string } }>;
    };
    expect(report.passed).toBe(false);
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        checkId: 'browser-qa',
        passed: false,
        failure: expect.objectContaining({
          summary: 'browser validation reported artifact paths that do not exist',
        }),
      }),
    ]));
  });

  it('fails before_after browser validation when baseline evidence is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-browser-before-after-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(melosDir, 'validations'), { recursive: true });
    mkdirSync(join(cwd, 'artifacts', 'screenshots'), { recursive: true });
    writeFileSync(join(cwd, 'artifacts', 'screenshots', 'after.png'), 'png', 'utf-8');

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Browser before/after mission\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'browser-before-after',
      goal: 'Before/after browser evidence must include the baseline',
      constraints: ['No backward compatibility'],
      successCriteria: ['browser validation fails without baseline evidence'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement and verify',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'browser-qa',
                description: 'Check browser flow before and after',
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
              description: 'Implement flow',
              status: 'done',
              attempts: 1,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'running',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Capture missing baseline browser evidence',
        priority: 'high',
        model: 'codex',
      },
    ]);

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 6,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: {
        missionPlan: MissionPlan | null;
        validationEvidence?: Record<string, Record<string, unknown>>;
      };
      runMilestoneValidation: (milestoneId: string) => Promise<void>;
    };
    orchestratorAny.state.missionPlan = {
      ...planned,
      activeMilestoneId: 'm1',
      activeFeatureId: null,
    };
    orchestratorAny.kernelState.missionPlan = orchestratorAny.state.missionPlan;
    orchestratorAny.kernelState.validationEvidence = {
      m1: {
        'browser-qa': {
          checkId: 'browser-qa',
          passed: true,
          runner: 'playwright-interactive',
          beforeReproduced: false,
          afterScreenshotPath: 'artifacts/screenshots/after.png',
        },
      },
    };

    await orchestratorAny.runMilestoneValidation('m1');

    const report = JSON.parse(readFileSync(join(melosDir, 'validations', 'm1-attempt-1.json'), 'utf-8')) as {
      passed: boolean;
      results: Array<{ checkId: string; passed: boolean; failure?: { summary: string; errorMessages: string[] } }>;
    };
    expect(report.passed).toBe(false);
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        checkId: 'browser-qa',
        passed: false,
        failure: expect.objectContaining({
          summary: 'browser validation is missing required evidence',
          errorMessages: expect.arrayContaining(['missing before screenshot']),
        }),
      }),
    ]));
  });

  it('passes manual validation when worker supplies structured evidence', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-manual-pass-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Manual evidence mission\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'manual-pass',
      goal: 'Manual evidence is treated as validation input',
      constraints: ['No backward compatibility'],
      successCriteria: ['manual validation passes from worker evidence'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement and verify',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'manual-qa',
                description: 'Check browser flow',
                type: 'manual',
                passed: false,
                failureCount: 0,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement flow',
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
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => ({
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: input.milestone.id,
        featureId: input.feature.id,
        status: 'SUCCESS',
        summary: 'done',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: true,
          testsPassed: 1,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: input.feature.kind === 'qa'
          ? [
            {
              checkId: 'manual-qa',
              passed: true,
              output: 'browser flow verified by worker',
            },
          ]
          : [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    }));

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
    const report = JSON.parse(readFileSync(join(melosDir, 'validations', 'm1-attempt-1.json'), 'utf-8')) as {
      passed: boolean;
      results: Array<{ checkId: string; passed: boolean; warning?: string }>;
    };
    expect(report.passed).toBe(true);
    expect(report.results).toEqual([
      expect.objectContaining({
        checkId: 'manual-qa',
        passed: true,
      }),
    ]);
    expect(report.results[0]?.warning).toBeUndefined();
  });

  it('fails validation when worker evidence marks a manual check as failed', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-manual-fail-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Manual failure mission\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'manual-fail',
      goal: 'Manual validation failure creates a follow-up',
      constraints: ['No backward compatibility'],
      successCriteria: ['manual validation failure is treated as real failure'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement and verify',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'manual-qa',
                description: 'Check browser flow',
                type: 'manual',
                passed: false,
                failureCount: 0,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement flow',
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
    const followUpSpy = jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Fix manual QA regression',
        priority: 'high',
        model: 'codex',
      },
    ]);
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => ({
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: input.milestone.id,
        featureId: input.feature.id,
        status: 'SUCCESS',
        summary: 'done',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: true,
          testsPassed: 1,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: input.feature.kind === 'qa'
          ? [
            {
              checkId: 'manual-qa',
              passed: false,
              failure: {
                summary: 'manual qa failed',
                affectedFiles: [],
                errorMessages: ['screen mismatch'],
              },
            },
          ]
          : [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    }));

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 3,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(false);
    expect(result.reason).toBe('max_iterations');
    expect(followUpSpy).toHaveBeenCalledWith(expect.objectContaining({
      milestoneId: 'm1',
      failures: expect.arrayContaining([
        expect.objectContaining({
          checkId: 'manual-qa',
          passed: false,
        }),
      ]),
    }));

    const mission = JSON.parse(readFileSync(missionPath, 'utf-8')) as {
      milestones: Array<{ features: Array<{ description: string; kind: string }> }>;
    };
    expect(mission.milestones[0]?.features).toHaveLength(3);
    expect(mission.milestones[0]?.features[1]).toMatchObject({
      description: 'Fix manual QA regression',
      kind: 'implementation',
    });
    expect(mission.milestones[0]?.features[2]?.kind).toBe('qa');
  });

  it('passes feature cwd through to the worker input', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-feature-cwd-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Feature cwd mission\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'feature-cwd',
      goal: 'Pass repo-relative feature cwd to worker',
      constraints: ['No backward compatibility'],
      successCriteria: ['worker sees feature cwd'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Execute from workspace subdir',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement workspace feature',
              cwd: 'frontend/apps/web',
              status: 'pending',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'planning',
      baseDir: cwd,
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');

    const workerInputs: Array<{ featureCwd?: string }> = [];
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => {
      workerInputs.push({ featureCwd: input.feature.cwd });
      return {
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: input.milestone.id,
          featureId: input.feature.id,
          status: 'SUCCESS',
          summary: 'done',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
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
    expect(workerInputs).toEqual([{ featureCwd: 'frontend/apps/web' }]);
  });

  it('uses bundled prompts directory instead of project cwd prompts', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-bundled-prompts-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 10,
      prdFile: join(cwd, 'PRD.md'),
      missionFile: join(cwd, 'TASK.json'),
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
    });

    const expectedPromptsDir = getDefaultPromptsDir();
    expect((orchestrator as unknown as { manager: { config: { promptsDir: string } } }).manager.config.promptsDir)
      .toBe(expectedPromptsDir);
    const workerConfig = (orchestrator as unknown as {
      worker: { config: { promptsDir: string; reasoningEffort: string } };
    }).worker.config;
    expect(workerConfig.promptsDir)
      .toBe(expectedPromptsDir);
    expect(workerConfig.reasoningEffort).toBe('high');
  });

  it('keeps codex resume thread at mission scope across multiple features', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-mission-thread-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Mission thread reuse\n\nImplement multiple features.', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'mission-thread',
      goal: 'Mission thread reuse',
      constraints: ['No backward compatibility'],
      successCriteria: ['all done'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Two features',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            { id: 'm1-f1', description: 'Feature 1', status: 'pending', attempts: 0, model: 'codex' },
            { id: 'm1-f2', description: 'Feature 2', status: 'pending', attempts: 0, model: 'codex' },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');
    const runSpy = jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => ({
      type: 'success',
      report: {
        iteration: 1,
        milestoneId: input.milestone.id,
        featureId: input.feature.id,
        status: 'SUCCESS',
        summary: `done ${input.feature.id}`,
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: true,
          testsPassed: 1,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    }));
    jest.spyOn(WorkerAgent.prototype, 'getActiveThreadId').mockReturnValue('thr_shared');
    const resumeSpy = jest.spyOn(WorkerAgent.prototype, 'setResumeSession');

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
    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(resumeSpy).toHaveBeenCalledWith('thr_shared', 'mission-thread');
    expect(resumeSpy.mock.calls.filter(([threadId, missionId]) => threadId === 'thr_shared' && missionId === 'mission-thread')).toHaveLength(2);
  });

  it('exposes full PRD/TASK content and streams manager logs during planning', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-doc-stream-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(
      prdPath,
      ['# Full PRD', 'line-1', 'line-2', 'line-3', '- checklist 1', '- checklist 2'].join('\n'),
      'utf-8'
    );

    const planned = createMissionPlan({
      missionId: 'doc-stream',
      goal: 'Verify full preview and manager stream',
      constraints: ['No backward compatibility'],
      successCriteria: ['status updates include full content'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'single dry-run feature',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Do work',
              status: 'pending',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockImplementation(async (input) => {
      input.onAgentMessageDelta?.('Inspecting repository coverage...\n');
      input.onAgentMessageDelta?.('Building mission plan');
      input.onCommandOutputDelta?.('npm query planning-context\n');
      input.onAppServerEvent?.('item/started', {
        item: {
          type: 'FileRead',
          filePath: 'PRD.md',
          limit: 3,
        },
      });
      return planned;
    });
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');

    const snapshots: MissionControlState[] = [];
    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 2,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: true,
      resume: false,
      onStatusUpdate: async (state) => {
        snapshots.push(state);
      },
    });

    const result = await orchestrator.run();
    expect(result.success).toBe(true);

    const anySnapshot = snapshots.find((state) => state.prdPreviewLines && state.taskPreviewLines);
    expect(anySnapshot?.prdPreviewLines).toEqual(expect.arrayContaining(['line-1', 'line-2', 'line-3']));
    expect(anySnapshot?.taskPreviewLines).toEqual(expect.arrayContaining([
      '# TASK generation in progress',
      'TASK.json has not been created yet.',
    ]));

    const plannedSnapshot = snapshots.find((state) =>
      state.taskPreviewLines?.some((line) => line.includes('Milestones / Features'))
    );
    expect(plannedSnapshot?.taskPreviewLines).toEqual(expect.arrayContaining(['Milestones / Features']));
    expect(plannedSnapshot?.taskPreviewLines).toEqual(expect.arrayContaining(['Tip: Open TASK.json directly for raw JSON if needed.']));

    const progressMessages = snapshots.flatMap((state) => state.progressLog.map((entry) => entry.message));
    expect(progressMessages.some((message) => message.includes('[READ] PRD.md'))).toBe(true);
    expect(progressMessages.some((message) => message.includes('planning: Inspecting repository coverage...'))).toBe(true);
    expect(progressMessages.some((message) => message.includes('planning: Building mission plan'))).toBe(true);
    expect(progressMessages.some((message) => message.includes('planning: [CMD] npm query planning-context'))).toBe(true);
  });

  it('refreshes status updates while planning before TASK.json exists', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-live-planning-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Live planning mission\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'live-planning',
      goal: 'Verify live planning refresh',
      constraints: ['Keep streaming updates visible'],
      successCriteria: ['Planning logs appear before TASK.json is generated'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'single feature',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Do work',
              status: 'pending',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockImplementation(async (input) => {
      input.onAgentMessageDelta?.('Inspecting repository coverage...\n');
      await new Promise((resolve) => setTimeout(resolve, 90));
      return planned;
    });
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');

    const snapshots: MissionControlState[] = [];
    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 2,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: true,
      resume: false,
      onStatusUpdate: async (state) => {
        snapshots.push(state);
      },
    });

    const result = await orchestrator.run();
    expect(result.success).toBe(true);

    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskPreviewLines: expect.arrayContaining([
            '# TASK generation in progress',
            'TASK.json has not been created yet.',
          ]),
          progressLog: expect.arrayContaining([
            expect.objectContaining({
              message: expect.stringContaining('planning: Inspecting repository coverage...'),
            }),
          ]),
        }),
      ])
    );
  });

  it('does not create TASK.json when planning fails before a plan is generated', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-planning-failure-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Broken planning mission', 'utf-8');

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockRejectedValue(
      new MissionPlanningError({
        reason: 'planner engine execution failed',
        detail: 'Process exited with code 1 | output: selected model issue',
        outputPreview: 'selected model issue',
      })
    );

    const snapshots: MissionControlState[] = [];
    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 2,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
      onStatusUpdate: async (state) => {
        snapshots.push(state);
      },
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(false);
    expect(result.reason).toBe('failed');
    expect(result.error).toContain('selected model issue');
    expect(existsSync(missionPath)).toBe(false);
    expect(snapshots.some((state) => state.taskPreviewLines?.includes('TASK.json has not been created yet.') === true)).toBe(true);
  });

  it('creates follow-up feature on validation failure and recovers', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-followup-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    const passFlagPath = join(cwd, '.pass-validation');

    writeFileSync(prdPath, '# Validation recovery mission', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'recovery',
      goal: 'Recover from validation failures',
      constraints: ['No backward compatibility'],
      successCriteria: ['Validation passes'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Build and validate',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [
              {
                id: 'flag-check',
                description: 'validation flag exists',
                type: 'command',
                command: `[ -f "${passFlagPath}" ]`,
                passed: false,
                failureCount: 0,
              },
            ],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Initial feature',
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
    jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Create validation pass flag',
        priority: 'high',
        model: 'codex',
      },
    ]);

    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => {
      if (input.feature.id === 'm1-f2') {
        writeFileSync(passFlagPath, 'ok', 'utf-8');
      }
      return {
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: input.milestone.id,
          featureId: input.feature.id,
          status: 'SUCCESS',
          summary: `done ${input.feature.id}`,
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 20,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
      execution: {
        retryInitialDelayMs: 0,
        retryMaxDelayMs: 0,
      },
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(result.reason).toBe('completed');
    expect(existsSync(passFlagPath)).toBe(true);
  });

  it('merges validation follow-up into existing unfinished feature by trackingKey', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-merge-followup-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    const passFlagPath = join(cwd, '.pass-validation');
    writeFileSync(prdPath, '# Merge follow-up mission', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'merge-followup',
      goal: 'Merge validation follow-up features',
      constraints: ['No backward compatibility'],
      successCriteria: ['Validation passes without feature growth'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Build and validate',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [
              {
                id: 'flag-check',
                description: 'validation flag exists',
                type: 'command',
                command: `[ -f "${passFlagPath}" ]`,
                passed: false,
                failureCount: 0,
              },
            ],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Initial feature',
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
    jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Resolve shared validation root cause with more context',
        trackingKey: 'shared-validation-root-cause',
        priority: 'high',
        model: 'codex',
      },
    ]);

    const featureRuns = new Map<string, number>();
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => {
      const count = (featureRuns.get(input.feature.id) ?? 0) + 1;
      featureRuns.set(input.feature.id, count);

      if (input.feature.id === 'm1-f2' && count >= 2) {
        writeFileSync(passFlagPath, 'ok', 'utf-8');
        return {
          type: 'success',
          report: {
            iteration: count,
            milestoneId: input.milestone.id,
            featureId: input.feature.id,
            status: 'SUCCESS',
            summary: 'resolved on retry',
            warnings: [],
            filesChanged: [],
            validation: {
              testsRun: true,
              testsPassed: 1,
              testsFailed: 0,
              lintPassed: true,
              typecheckPassed: true,
            },
            checks: [],
            learnings: [],
            requestsHelp: false,
            createdAt: new Date().toISOString(),
          },
        };
      }

      if (input.feature.id === 'm1-f2') {
        return {
          type: 'failed',
          report: {
            iteration: count,
            milestoneId: input.milestone.id,
            featureId: input.feature.id,
            status: 'FAILED',
            summary: 'needs retry',
            warnings: [],
            filesChanged: [],
            validation: {
              testsRun: true,
              testsPassed: 0,
              testsFailed: 1,
              lintPassed: true,
              typecheckPassed: true,
            },
            checks: [],
            learnings: [],
            requestsHelp: false,
            createdAt: new Date().toISOString(),
          },
        };
      }

      return {
        type: 'success',
        report: {
          iteration: count,
          milestoneId: input.milestone.id,
          featureId: input.feature.id,
          status: 'SUCCESS',
          summary: `done ${input.feature.id}`,
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 20,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
      execution: {
        retryInitialDelayMs: 0,
        retryMaxDelayMs: 0,
      },
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(featureRuns.get('m1-f2')).toBe(2);

    const saved = JSON.parse(readFileSync(missionPath, 'utf-8')) as {
      milestones: Array<{
        features: Array<{ id: string; description: string; trackingKey?: string; status: string }>;
      }>;
    };
    expect(saved.milestones[0]?.features).toHaveLength(2);
    expect(saved.milestones[0]?.features[1]?.id).toBe('m1-f2');
    expect(saved.milestones[0]?.features[1]?.trackingKey).toBe('shared-validation-root-cause');
    expect(saved.milestones[0]?.features[1]?.description).toBe('Resolve shared validation root cause with more context');
  });

  it('replays events after snapshot on resume', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-resume-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Resume mission\n\nReplay after snapshot.', 'utf-8');

    const completedPlan = createMissionPlan({
      missionId: 'resume-test',
      goal: 'Resume replay test',
      constraints: ['No backward compatibility'],
      successCriteria: ['Replay event after snapshot'],
      milestones: [
        {
          id: 'm1',
          title: 'Done',
          description: 'Already completed',
          order: 1,
          status: 'done',
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
      state: 'completed',
    });
    writeFileSync(missionPath, `${JSON.stringify(completedPlan, null, 2)}\n`, 'utf-8');

    const eventsPath = join(melosDir, 'events.jsonl');
    writeFileSync(eventsPath, [
      JSON.stringify({
        seq: 1,
        type: 'mission_started',
        timestamp: '2026-01-01T00:00:00.000Z',
        iteration: 0,
        agent: 'orchestrator',
        payload: { message: 'start' },
      }),
      JSON.stringify({
        seq: 2,
        type: 'command_executed',
        timestamp: '2026-01-01T00:00:01.000Z',
        iteration: 1,
        agent: 'system',
        payload: { command: 'echo before snapshot', exitCode: 0 },
      }),
      JSON.stringify({
        seq: 3,
        type: 'command_executed',
        timestamp: '2026-01-01T00:00:02.000Z',
        iteration: 1,
        agent: 'system',
        payload: { command: 'echo after snapshot', exitCode: 0 },
      }),
      '',
    ].join('\n'), 'utf-8');

    writeFileSync(join(melosDir, 'state.json'), JSON.stringify({
      seq: 2,
      savedAt: '2026-01-01T00:00:01.500Z',
      state: {
        kernel: {
          missionPlan: completedPlan,
          iteration: 1,
          workerRuns: [],
          progressLog: [{ timestamp: '2026-01-01T00:00:01.000Z', message: 'snapshot base' }],
          activeWorkerRunId: null,
          gitStrategy: null,
        },
      },
    }, null, 2), 'utf-8');

    const snapshots: Array<{ progressLog: Array<{ message: string }> }> = [];
    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 3,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: true,
      onStatusUpdate: async (state) => {
        snapshots.push({
          progressLog: state.progressLog.map((entry) => ({ message: entry.message })),
        });
      },
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(result.reason).toBe('completed');
    const flattened = snapshots.flatMap((snapshot) => snapshot.progressLog.map((entry) => entry.message));
    expect(flattened.some((message) => message.includes('echo after snapshot'))).toBe(true);
  });

  it('resumes safely from snapshot that lacks logEntries when no replay events exist', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-resume-no-logentries-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Resume mission\n', 'utf-8');

    const completedPlan = createMissionPlan({
      missionId: 'resume-no-logentries',
      goal: 'Resume without logEntries',
      constraints: ['No backward compatibility'],
      successCriteria: ['No crash'],
      milestones: [
        {
          id: 'm1',
          title: 'Done',
          description: 'Already done',
          order: 1,
          status: 'done',
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
      state: 'completed',
    });
    writeFileSync(missionPath, `${JSON.stringify(completedPlan, null, 2)}\n`, 'utf-8');

    const eventsPath = join(melosDir, 'events.jsonl');
    writeFileSync(eventsPath, [
      JSON.stringify({
        seq: 1,
        type: 'mission_started',
        timestamp: '2026-01-01T00:00:00.000Z',
        iteration: 0,
        agent: 'orchestrator',
        payload: { message: 'start' },
      }),
      '',
    ].join('\n'), 'utf-8');

    writeFileSync(join(melosDir, 'state.json'), JSON.stringify({
      seq: 1,
      savedAt: '2026-01-01T00:00:01.500Z',
      state: {
        kernel: {
          missionPlan: completedPlan,
          iteration: 1,
          workerRuns: [],
          progressLog: [],
          activeWorkerRunId: null,
          gitStrategy: null,
        },
      },
    }, null, 2), 'utf-8');

    const snapshots: MissionControlState[] = [];
    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 3,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: true,
      onStatusUpdate: async (state) => {
        snapshots.push(state);
      },
    });

    const result = await orchestrator.run();
    expect(result.success).toBe(true);
    expect(result.reason).toBe('completed');
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it('recovers aborted mission state on resume and continues from pending feature', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-resume-aborted-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Resume aborted mission\n', 'utf-8');

    const abortedPlan = createMissionPlan({
      missionId: 'resume-aborted',
      goal: 'Resume from interrupted feature',
      constraints: ['No backward compatibility'],
      successCriteria: ['Mission completes after resume'],
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'in_progress',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            { id: 'm1-f1', description: 'work', status: 'in_progress', attempts: 1, model: 'codex' },
          ],
        },
      ],
      state: 'aborted',
    });
    writeFileSync(missionPath, `${JSON.stringify(abortedPlan, null, 2)}\n`, 'utf-8');

    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');
    jest.spyOn(WorkerAgent.prototype, 'run').mockResolvedValue({
      type: 'success',
      report: {
        iteration: 2,
        milestoneId: 'm1',
        featureId: 'm1-f1',
        status: 'SUCCESS',
        summary: 'resumed',
        warnings: [],
        filesChanged: [],
        validation: {
          testsRun: true,
          testsPassed: 1,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: [],
        learnings: [],
        requestsHelp: false,
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
      resume: true,
    });

    const result = await orchestrator.run();
    expect(result.success).toBe(true);
    expect(result.reason).toBe('completed');
  });

  it('cycles model assignment for a role from Mission Control command', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-model-cycle-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(melosDir, 'validations'), { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Model cycle mission\n', 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 1,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: true,
      resume: false,
    });

    const router = (orchestrator as unknown as {
      modelRouter: { getModel: (role: 'planner') => string };
    }).modelRouter;

    expect(router.getModel('planner')).toBe('codex-latest');
    await orchestrator.cycleModel('planner');
    expect(router.getModel('planner')).toBe('claude-latest');
    await orchestrator.cycleModel('planner');
    expect(router.getModel('planner')).toBe('sonnet');
  });

  it('defaults all roles to codex-latest when models are not specified', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-default-models-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Default model mission\n', 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 1,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: true,
      resume: false,
    });

    const router = (orchestrator as unknown as {
      modelRouter: { getModel: (role: 'planner' | 'worker') => string };
    }).modelRouter;

    expect(router.getModel('planner')).toBe('codex-latest');
    expect(router.getModel('worker')).toBe('codex-latest');
  });

  it('keeps TASK fixed model even after pre-approval worker model switch', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-worker-opus-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Worker model switch mission\n\nVerify worker model.', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'worker-opus',
      goal: 'Verify worker model switch before approval',
      constraints: ['No backward compatibility'],
      successCriteria: ['worker uses opus'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Single feature execution',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement feature',
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

    const workerInputs: Array<{ featureModel?: string }> = [];
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => {
      workerInputs.push({ featureModel: input.feature.model });
      return {
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: input.milestone.id,
          featureId: input.feature.id,
          status: 'SUCCESS',
          summary: 'done',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
    });

    const states: Array<{
      workerModel: string;
      workerRuns: Array<{ engine?: string; model?: string }>;
    }> = [];

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
      onStatusUpdate: async (state) => {
        states.push({
          workerModel: state.modelAssignments.worker.model,
          workerRuns: state.workerRuns.map((run) => ({ engine: run.engine, model: run.model })),
        });
      },
    });

    await orchestrator.cycleModel('worker');
    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(workerInputs).toEqual([{ featureModel: 'codex-latest' }]);
    expect(states.some((state) => state.workerModel === 'claude-latest')).toBe(true);
    expect(
      states.some((state) => state.workerRuns.some((run) => run.engine === 'codex' && run.model === 'gpt-5.4 [Latest]'))
    ).toBe(true);
  });

  it('auto-resolves undefined feature model without stopping and persists model', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-worker-default-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Worker default model mission\n\nResolve undefined model.', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'worker-default',
      goal: 'Resolve undefined feature model',
      constraints: ['No backward compatibility'],
      successCriteria: ['model gets persisted'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Single feature execution',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement feature',
              status: 'pending',
              attempts: 0,
            },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');

    const workerInputs: Array<{ featureModel?: string }> = [];
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => {
      workerInputs.push({ featureModel: input.feature.model });
      return {
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: input.milestone.id,
          featureId: input.feature.id,
          status: 'SUCCESS',
          summary: 'done',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
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

    await orchestrator.cycleModel('worker');
    const result = await orchestrator.run();
    const mission = JSON.parse(readFileSync(missionPath, 'utf-8')) as {
      milestones: Array<{ features: Array<Record<string, unknown>> }>;
    };
    const feature = mission.milestones[0]?.features[0] ?? {};

    expect(result.success).toBe(true);
    expect(workerInputs).toEqual([{ featureModel: 'claude-latest' }]);
    expect(feature.model).toBe('claude-latest');
    expect(feature.requestedModel).toBeUndefined();
    expect(feature.effectiveModel).toBeUndefined();
  });

  it('does not create checkpoint commit after successful feature when git-strategy is disabled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-checkpoint-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Checkpoint commit mission\n', 'utf-8');
    initGitRepository(cwd);

    const planned = createMissionPlan({
      missionId: 'checkpoint',
      goal: 'Checkpoint commit test',
      constraints: ['No backward compatibility'],
      successCriteria: ['commit after success'],
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'pending',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            { id: 'm1-f1', description: 'Implement', status: 'pending', attempts: 0, model: 'codex' },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async () => {
      writeFileSync(join(cwd, 'checkpoint-success.txt'), 'ok', 'utf-8');
      return {
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: 'm1',
          featureId: 'm1-f1',
          status: 'SUCCESS',
          summary: 'implemented',
          warnings: [],
          filesChanged: [{ path: 'checkpoint-success.txt', additions: 1, deletions: 0 }],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
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
    const commitCount = Number(execSync('git rev-list --count HEAD', { cwd, encoding: 'utf-8' }).trim());
    expect(commitCount).toBe(1);
  });

  it('continues git-strategy flow when worker commits feature changes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-git-strategy-committed-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Committed branch mission\n', 'utf-8');
    initGitRepository(cwd);
    const baseBranch = execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim();

    const planned = createMissionPlan({
      missionId: 'committed-branch',
      goal: 'Committed branch flow',
      constraints: ['No backward compatibility'],
      successCriteria: ['must merge when committed'],
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'pending',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            { id: 'm1-f1', description: 'Implement', status: 'pending', attempts: 0, model: 'codex' },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async () => {
      writeFileSync(join(cwd, 'committed-change.txt'), 'ok', 'utf-8');
      execSync('git add -A', { cwd, stdio: 'ignore' });
      execSync('git commit -m "feat(checkpoint): complete m1-f1"', { cwd, stdio: 'ignore' });
      return {
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: 'm1',
          featureId: 'm1-f1',
          status: 'SUCCESS',
          summary: 'implemented with commit',
          warnings: [],
          filesChanged: [{ path: 'committed-change.txt', additions: 1, deletions: 0 }],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
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
      gitStrategy: {
        enabled: true,
        missionId: 'committed-branch',
        baseBranch,
        autoPush: false,
        preMergeValidation: false,
        validationCommands: [],
        pullRequestEnabled: false,
      },
    });

    const result = await orchestrator.run();
    expect(result.success).toBe(true);
    expect(execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim()).toBe(baseBranch);
  });

  it('runs pre-merge validation from feature.cwd when present', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-git-strategy-feature-cwd-validation-'));
    const melosDir = join(cwd, '.melos');
    const featureCwd = join(cwd, 'frontend/apps/web');
    const traceDir = mkdtempSync(join(tmpdir(), 'melos-validation-trace-'));
    const tracePath = join(traceDir, 'feature-cwd.txt');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(featureCwd, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Feature cwd validation mission\n', 'utf-8');
    initGitRepository(cwd);
    const baseBranch = execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim();
    execSync('git checkout -B feature-branch', { cwd, stdio: 'ignore' });
    writeFileSync(join(featureCwd, 'committed-change.txt'), 'ok', 'utf-8');
    execSync('git add -A', { cwd, stdio: 'ignore' });
    execSync('git commit -m "feat(checkpoint): complete m1-f1"', { cwd, stdio: 'ignore' });
    const validationCommand = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(tracePath)}, process.cwd())'`;

    const planned = createMissionPlan({
      missionId: 'feature-cwd-validation',
      goal: 'Run git validation in feature cwd',
      constraints: ['No backward compatibility'],
      successCriteria: ['validation respects feature cwd'],
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'in_progress',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement workspace feature',
              cwd: 'frontend/apps/web',
              status: 'in_progress',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'running',
      baseDir: cwd,
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
      gitStrategy: {
        enabled: true,
        missionId: 'feature-cwd-validation',
        baseBranch,
        autoPush: false,
        preMergeValidation: true,
        validationCommands: [validationCommand],
        pullRequestEnabled: false,
      },
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null; gitStrategy: ReturnType<typeof createGitStrategyState> | null };
      kernelState: { missionPlan: MissionPlan | null };
      runGitPostProcess: (report: WorkerFeatureReport) => Promise<{
        ok: boolean;
        summary: string;
        failureContext?: WorkerFeatureReport['failureContext'];
      }>;
    };
    orchestratorAny.state.missionPlan = planned;
    orchestratorAny.kernelState.missionPlan = planned;
    orchestratorAny.state.gitStrategy = createGitStrategyState({
      missionId: 'feature-cwd-validation',
      baseBranch,
      autoPush: false,
      preMergeValidation: true,
      validationCommands: [validationCommand],
      pullRequestEnabled: false,
    });
    const result = await orchestratorAny.runGitPostProcess({
      iteration: 1,
      milestoneId: 'm1',
      featureId: 'm1-f1',
      status: 'SUCCESS',
      summary: 'implemented with commit',
      warnings: [],
      filesChanged: [],
      validation: {
        testsRun: true,
        testsPassed: 1,
        testsFailed: 0,
        lintPassed: true,
        typecheckPassed: true,
      },
      checks: [],
      learnings: [],
      requestsHelp: false,
      createdAt: new Date().toISOString(),
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(tracePath, 'utf-8')).toBe(realpathSync(featureCwd));
  });

  it('keeps repo-root pre-merge validation when feature.cwd is absent', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-git-strategy-root-validation-'));
    const melosDir = join(cwd, '.melos');
    const traceDir = mkdtempSync(join(tmpdir(), 'melos-validation-trace-'));
    const tracePath = join(traceDir, 'root-cwd.txt');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Root validation mission\n', 'utf-8');
    initGitRepository(cwd);
    const baseBranch = execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim();
    execSync('git checkout -B feature-branch', { cwd, stdio: 'ignore' });
    writeFileSync(join(cwd, 'committed-change.txt'), 'ok', 'utf-8');
    execSync('git add -A', { cwd, stdio: 'ignore' });
    execSync('git commit -m "feat(checkpoint): complete m1-f1"', { cwd, stdio: 'ignore' });
    const validationCommand = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(tracePath)}, process.cwd())'`;

    const planned = createMissionPlan({
      missionId: 'root-validation',
      goal: 'Run git validation at repo root',
      constraints: ['No backward compatibility'],
      successCriteria: ['validation stays at repo root without feature cwd'],
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'in_progress',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            { id: 'm1-f1', description: 'Implement', status: 'in_progress', attempts: 0, model: 'codex' },
          ],
        },
      ],
      state: 'running',
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
      gitStrategy: {
        enabled: true,
        missionId: 'root-validation',
        baseBranch,
        autoPush: false,
        preMergeValidation: true,
        validationCommands: [validationCommand],
        pullRequestEnabled: false,
      },
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null; gitStrategy: ReturnType<typeof createGitStrategyState> | null };
      kernelState: { missionPlan: MissionPlan | null };
      runGitPostProcess: (report: WorkerFeatureReport) => Promise<{
        ok: boolean;
        summary: string;
        failureContext?: WorkerFeatureReport['failureContext'];
      }>;
    };
    orchestratorAny.state.missionPlan = planned;
    orchestratorAny.kernelState.missionPlan = planned;
    orchestratorAny.state.gitStrategy = createGitStrategyState({
      missionId: 'root-validation',
      baseBranch,
      autoPush: false,
      preMergeValidation: true,
      validationCommands: [validationCommand],
      pullRequestEnabled: false,
    });
    const result = await orchestratorAny.runGitPostProcess({
      iteration: 1,
      milestoneId: 'm1',
      featureId: 'm1-f1',
      status: 'SUCCESS',
      summary: 'implemented with commit',
      warnings: [],
      filesChanged: [],
      validation: {
        testsRun: true,
        testsPassed: 1,
        testsFailed: 0,
        lintPassed: true,
        typecheckPassed: true,
      },
      checks: [],
      learnings: [],
      requestsHelp: false,
      createdAt: new Date().toISOString(),
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(tracePath, 'utf-8')).toBe(realpathSync(cwd));
  });

  it('returns canonical failure context for post-feature validation failures', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-git-strategy-failure-context-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Failure context mission\n', 'utf-8');
    initGitRepository(cwd);
    const baseBranch = execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim();

    const planned = createMissionPlan({
      missionId: 'failure-context',
      goal: 'Classify post-feature validation failures',
      constraints: ['No backward compatibility'],
      successCriteria: ['Canonical failure context is attached'],
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'in_progress',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            { id: 'm1-f1', description: 'Implement', status: 'in_progress', attempts: 0, model: 'codex' },
          ],
        },
      ],
      state: 'running',
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
      gitStrategy: {
        enabled: true,
        missionId: 'failure-context',
        baseBranch,
        autoPush: false,
        preMergeValidation: true,
        validationCommands: ['exit 1'],
        pullRequestEnabled: false,
      },
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null; gitStrategy: ReturnType<typeof createGitStrategyState> | null };
      kernelState: { missionPlan: MissionPlan | null };
      runGitPostProcess: (report: WorkerFeatureReport) => Promise<{
        ok: boolean;
        summary: string;
        failureContext?: WorkerFeatureReport['failureContext'];
      }>;
    };
    orchestratorAny.state.missionPlan = planned;
    orchestratorAny.kernelState.missionPlan = planned;
    orchestratorAny.state.gitStrategy = createGitStrategyState({
      missionId: 'failure-context',
      baseBranch,
      autoPush: false,
      preMergeValidation: true,
      validationCommands: ['exit 1'],
      pullRequestEnabled: false,
    });
    const result = await orchestratorAny.runGitPostProcess({
      iteration: 1,
      milestoneId: 'm1',
      featureId: 'm1-f1',
      status: 'SUCCESS',
      summary: 'implemented with commit',
      warnings: [],
      filesChanged: [],
      validation: {
        testsRun: true,
        testsPassed: 1,
        testsFailed: 0,
        lintPassed: true,
        typecheckPassed: true,
      },
      checks: [],
      learnings: [],
      requestsHelp: false,
      createdAt: new Date().toISOString(),
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Post-feature validation failed: exit 1');
    expect(result.failureContext).toEqual(expect.objectContaining({
      stage: 'post_process',
      kind: 'post_feature_validation',
      command: 'exit 1',
      executionCwd: cwd,
      signature: expect.stringContaining('post-feature-validation:exit-1:'),
    }));
  });

  it('prefers canonical failure context for retry reasons', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-retry-reason-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# retry reason', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      extractFeatureRetryReason: (report: WorkerFeatureReport) => string;
    };

    const reason = orchestratorAny.extractFeatureRetryReason({
      iteration: 1,
      milestoneId: 'm1',
      featureId: 'm1-f1',
      status: 'FAILED',
      summary: 'implemented with commit\nPost-feature validation failed: npm run typecheck',
      failureContext: {
        stage: 'post_process',
        kind: 'post_feature_validation',
        signature: 'post-feature-validation:npm-run-typecheck:/repo',
        command: 'npm run typecheck',
        executionCwd: '/repo',
      },
      warnings: ['some unrelated warning'],
      filesChanged: [],
      validation: {
        testsRun: true,
        testsPassed: 1,
        testsFailed: 0,
        lintPassed: true,
        typecheckPassed: true,
      },
      checks: [],
      learnings: [],
      requestsHelp: true,
      createdAt: new Date().toISOString(),
    });

    expect(reason).toBe('Post-feature validation failed: npm run typecheck');
  });

  it('ignores non-actionable worker warnings before applying blocking warning policy', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-warning-filter-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# warning filter', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      verification: {
        failOnWorkerWarnings: true,
      },
    });
    const orchestratorAny = orchestrator as unknown as {
      normalizeWorkerWarnings: (
        feature: MissionPlan['milestones'][number]['features'][number],
        result: { type: 'success'; report: WorkerFeatureReport }
      ) => { type: 'success'; report: WorkerFeatureReport };
      applyWorkerWarningPolicy: (
        milestoneId: string,
        featureId: string,
        result: { type: 'success'; report: WorkerFeatureReport }
      ) => { type: string; report: WorkerFeatureReport };
    };

    const feature = {
      id: 'm1-f1',
      description: 'Implement',
      kind: 'implementation' as const,
      status: 'in_progress' as const,
      attempts: 1,
      model: 'codex',
    };
    const report: WorkerFeatureReport = {
      iteration: 1,
      milestoneId: 'm1',
      featureId: 'm1-f1',
      status: 'SUCCESS',
      summary: 'implemented',
      warnings: [
        'Dedicated QA was not run from this implementation feature.',
        'expected=no_match may return exit code 1 on success.',
        'No new commit was created because this was a no-op result.',
        'Need follow-up for unresolved API schema mismatch.',
      ],
      filesChanged: [],
      validation: {
        testsRun: true,
        testsPassed: 1,
        testsFailed: 0,
        lintPassed: true,
        typecheckPassed: true,
      },
      checks: [],
      learnings: [],
      requestsHelp: false,
      createdAt: new Date().toISOString(),
    };

    const normalized = orchestratorAny.normalizeWorkerWarnings(feature, { type: 'success', report });
    expect(normalized.report.warnings).toEqual(['Need follow-up for unresolved API schema mismatch.']);

    const blocked = orchestratorAny.applyWorkerWarningPolicy('m1', 'm1-f1', normalized);
    expect(blocked.type).toBe('failed');
    expect(blocked.report.summary).toContain('Need follow-up for unresolved API schema mismatch.');
    expect(blocked.report.summary).not.toContain('Dedicated QA was not run');
  });

  it('treats partial implementation results as immediate follow-up planning without same-feature retry', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-partial-followup-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# partial follow-up', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'partial-followup',
      goal: 'Convert partials into follow-up work',
      constraints: ['No backward compatibility'],
      successCriteria: ['partial result does not schedule same-feature retry'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement flow',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement flow',
              status: 'in_progress',
              attempts: 1,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'running',
    });
    const runningPlan: MissionPlan = {
      ...planned,
      activeMilestoneId: 'm1',
      activeFeatureId: 'm1-f1',
    };
    writeFileSync(missionPath, `${JSON.stringify(runningPlan, null, 2)}\n`, 'utf-8');

    jest.spyOn(ManagerAgent.prototype, 'generateImplementationFollowUpFeatures').mockResolvedValue([
      {
        description: 'Complete the remaining downstream work in a separate feature',
        trackingKey: 'separate-follow-up',
        priority: 'high',
        model: 'codex',
      },
    ]);

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      execution: {
        maxFeatureAttempts: 3,
      },
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      handleImplementationFeatureResult: (
        milestone: MissionPlan['milestones'][number],
        feature: MissionPlan['milestones'][number]['features'][number],
        result: { type: 'partial'; report: WorkerFeatureReport }
      ) => Promise<void>;
      findFeatureRetry: (milestoneId: string, featureId: string) => unknown;
    };
    orchestratorAny.state.missionPlan = runningPlan;
    orchestratorAny.kernelState.missionPlan = runningPlan;

    const milestone = runningPlan.milestones[0]!;
    const feature = milestone.features[0]!;
    await orchestratorAny.handleImplementationFeatureResult(milestone, feature, {
      type: 'partial',
      report: {
        iteration: 1,
        milestoneId: 'm1',
        featureId: 'm1-f1',
        status: 'PARTIAL',
        summary: 'feature-local work is complete; downstream validation remains',
        warnings: ['Remaining browser QA belongs to a dedicated QA feature.'],
        filesChanged: [{ path: 'src/app.ts', additions: 2, deletions: 0 }],
        validation: {
          testsRun: true,
          testsPassed: 1,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    });

    const missionPlan = orchestratorAny.state.missionPlan!;
    expect(orchestratorAny.findFeatureRetry('m1', 'm1-f1')).toBeNull();
    expect(missionPlan.milestones[0]?.features.map((item) => ({ id: item.id, status: item.status }))).toEqual([
      { id: 'm1-f1', status: 'failed' },
      { id: 'm1-f2', status: 'pending' },
    ]);

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('"action":"feature_partial_followup"');
    expect(events).not.toContain('"action":"feature_retry_scheduled"');
  });

  it('treats partial results that explicitly belong to a sibling feature as done', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-cross-feature-partial-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# cross feature partial', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'cross-feature-partial',
      goal: 'Mark scope-complete partials as done',
      constraints: ['No backward compatibility'],
      successCriteria: ['cross-feature residual work stays with the sibling feature'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement flow',
          order: 1,
          status: 'in_progress',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement AppHead changes',
              status: 'in_progress',
              attempts: 1,
              model: 'codex',
            },
            {
              id: 'm1-f2',
              description: 'Add SEO regression tests',
              status: 'pending',
              attempts: 0,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'running',
    });
    const runningPlan: MissionPlan = {
      ...planned,
      activeMilestoneId: 'm1',
      activeFeatureId: 'm1-f1',
    };
    writeFileSync(missionPath, `${JSON.stringify(runningPlan, null, 2)}\n`, 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      handleImplementationFeatureResult: (
        milestone: MissionPlan['milestones'][number],
        feature: MissionPlan['milestones'][number]['features'][number],
        result: { type: 'partial'; report: WorkerFeatureReport }
      ) => Promise<void>;
      findFeatureRetry: (milestoneId: string, featureId: string) => unknown;
    };
    orchestratorAny.state.missionPlan = runningPlan;
    orchestratorAny.kernelState.missionPlan = runningPlan;

    const milestone = runningPlan.milestones[0]!;
    const feature = milestone.features[0]!;
    await orchestratorAny.handleImplementationFeatureResult(milestone, feature, {
      type: 'partial',
      report: {
        iteration: 1,
        milestoneId: 'm1',
        featureId: 'm1-f1',
        status: 'PARTIAL',
        summary: 'AppHead updates are complete.',
        warnings: ['`AppHead.test.tsx` is owned by m1-f2 and remains downstream work.'],
        filesChanged: [{ path: 'src/app-head.tsx', additions: 4, deletions: 1 }],
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
        createdAt: new Date().toISOString(),
      },
    });

    const missionPlan = orchestratorAny.state.missionPlan!;
    expect(orchestratorAny.findFeatureRetry('m1', 'm1-f1')).toBeNull();
    expect(missionPlan.milestones[0]?.features.map((item) => ({ id: item.id, status: item.status }))).toEqual([
      { id: 'm1-f1', status: 'done' },
      { id: 'm1-f2', status: 'pending' },
    ]);

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('"action":"partial_deferred_to_related_feature"');
    expect(events).not.toContain('"action":"feature_partial_followup"');
  });

  it('classifies partial worker runs without logging them as worker_error', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-worker-partial-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# worker partial', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'worker-partial',
      goal: 'Partial runs are visible without error semantics',
      constraints: ['No backward compatibility'],
      successCriteria: ['partial events are not emitted as worker_error'],
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'pending',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            { id: 'm1-f1', description: 'Implement feature', status: 'pending', attempts: 0, model: 'codex' },
            { id: 'm1-f2', description: 'Add tests', status: 'pending', attempts: 0, model: 'codex' },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');
    let runCount = 0;
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => {
      runCount += 1;
      if (runCount === 1) {
        return {
          type: 'partial',
          report: {
            iteration: 1,
            milestoneId: input.milestone.id,
            featureId: input.feature.id,
            status: 'PARTIAL',
            summary: 'Implementation is complete.',
            warnings: ['Remaining regression tests belong to m1-f2.'],
            filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0 }],
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
            createdAt: new Date().toISOString(),
          },
        };
      }

      return {
        type: 'success',
        report: {
          iteration: 2,
          milestoneId: input.milestone.id,
          featureId: input.feature.id,
          status: 'SUCCESS',
          summary: 'tests added',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });

    const result = await orchestrator.run();
    expect(result.success).toBe(true);

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('"type":"worker_partial"');
    expect(events).not.toContain('"type":"worker_error"');
  });

  it('drops low-signal worker checkpoints', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-checkpoint-filter-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# checkpoint filter', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      shouldEmitWorkerCheckpoint: (message: string) => boolean;
    };

    expect(orchestratorAny.shouldEmitWorkerCheckpoint('[TOOL] TodoWrite')).toBe(false);
    expect(orchestratorAny.shouldEmitWorkerCheckpoint('[READ] src/app.ts')).toBe(false);
    expect(orchestratorAny.shouldEmitWorkerCheckpoint('[INFO] verbose tool output omitted (123 chars)')).toBe(false);
    expect(orchestratorAny.shouldEmitWorkerCheckpoint('[REPLY] focused update')).toBe(true);
  });

  it('skips git post-process for qa features', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-qa-post-process-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# qa post process', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      shouldRunGitPostProcess: (feature: MissionPlan['milestones'][number]['features'][number]) => boolean;
    };

    expect(orchestratorAny.shouldRunGitPostProcess({
      id: 'm1-f-qa',
      description: 'Run QA',
      kind: 'qa',
      status: 'pending',
      attempts: 0,
      model: 'codex',
    })).toBe(false);
    expect(orchestratorAny.shouldRunGitPostProcess({
      id: 'm1-f1',
      description: 'Implement',
      kind: 'implementation',
      status: 'pending',
      attempts: 0,
      model: 'codex',
    })).toBe(true);
  });

  it('uses a dedicated mission branch and post-pr follow-up phase when pull request automation is enabled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-pr-flow-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# PR flow mission\n', 'utf-8');
    initGitRepository(cwd);
    const baseBranch = execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim();

    const planned = createMissionPlan({
      missionId: 'pr-flow',
      goal: 'Run post-pr automation on a mission branch',
      constraints: ['No backward compatibility'],
      successCriteria: ['PR phase runs after final review'],
      milestones: [
        {
          id: 'm1',
          title: 'Implementation',
          description: 'Build the feature',
          order: 1,
          status: 'pending',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            { id: 'm1-f1', description: 'Implement', status: 'pending', attempts: 0, model: 'codex' },
          ],
        },
        {
          id: 'm2',
          title: 'Final Review',
          description: 'Run final reviews',
          order: 2,
          status: 'pending',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            {
              id: 'm2-f1',
              description: 'Run final product review',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
            {
              id: 'm2-f2',
              description: 'Run final code review',
              kind: 'review',
              reviewType: 'code',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'planning',
    });

    jest.spyOn(ManagerAgent.prototype, 'generateMissionPlan').mockResolvedValue(planned);
    jest.spyOn(ManagerAgent.prototype, 'generateFeatureBriefing').mockResolvedValue('briefing');

    const workerInputs: Array<{ featureId: string; currentBranch: string | null | undefined; baseBranch: string | undefined }> = [];
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => {
      workerInputs.push({
        featureId: input.feature.id,
        currentBranch: input.currentBranch,
        baseBranch: input.baseBranch,
      });

      if (input.feature.id === 'm1-f1') {
        writeFileSync(join(cwd, 'mission-branch-change.txt'), 'ok', 'utf-8');
        execSync('git add -A', { cwd, stdio: 'ignore' });
        execSync('git commit -m "feat(pr-flow): implement"', { cwd, stdio: 'ignore' });
        return {
          type: 'success',
          report: {
            iteration: 1,
            milestoneId: input.milestone.id,
            featureId: input.feature.id,
            status: 'SUCCESS',
            summary: 'implemented',
            warnings: [],
            filesChanged: [{ path: 'mission-branch-change.txt', additions: 1, deletions: 0 }],
            validation: {
              testsRun: true,
              testsPassed: 1,
              testsFailed: 0,
              lintPassed: true,
              typecheckPassed: true,
            },
            checks: [],
            learnings: [],
            requestsHelp: false,
            createdAt: new Date().toISOString(),
          },
        };
      }

      if (input.feature.kind === 'review') {
        return {
          type: 'success',
          report: {
            iteration: 1,
            milestoneId: input.milestone.id,
            featureId: input.feature.id,
            status: 'SUCCESS',
            summary: `${input.feature.reviewType} review passed`,
            warnings: [],
            filesChanged: [],
            validation: {
              testsRun: false,
              testsPassed: 0,
              testsFailed: 0,
              lintPassed: false,
              typecheckPassed: false,
            },
            checks: [],
            review: {
              reviewType: input.feature.reviewType!,
              generation: input.feature.reviewGeneration ?? 1,
              passed: true,
              summary: `${input.feature.reviewType} review passed`,
              findings: [],
              artifacts: [],
            },
            learnings: [],
            requestsHelp: false,
            createdAt: new Date().toISOString(),
          },
        };
      }

      if (input.feature.kind === 'pull_request') {
        return {
          type: 'success',
          report: {
            iteration: 1,
            milestoneId: input.milestone.id,
            featureId: input.feature.id,
            status: 'SUCCESS',
            summary: 'pr created',
            warnings: [],
            filesChanged: [],
            validation: {
              testsRun: false,
              testsPassed: 0,
              testsFailed: 0,
              lintPassed: false,
              typecheckPassed: false,
            },
            checks: [],
            pullRequest: {
              number: 99,
              url: 'https://github.com/example/repo/pull/99',
              title: 'feat: pr flow',
              baseBranch,
              headBranch: baseBranch,
              draft: false,
              action: 'created',
              updatedAt: new Date().toISOString(),
            },
            learnings: [],
            requestsHelp: false,
            createdAt: new Date().toISOString(),
          },
        };
      }

      return {
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: input.milestone.id,
          featureId: input.feature.id,
          status: 'SUCCESS',
          summary: 'follow-up complete',
          warnings: [],
          filesChanged: [],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          pullRequest: {
            number: 99,
            url: 'https://github.com/example/repo/pull/99',
            title: 'feat: pr flow',
            baseBranch,
            headBranch: baseBranch,
            draft: false,
            action: 'updated',
            updatedAt: new Date().toISOString(),
          },
          pullRequestFollowUp: {
            handledFeedbackIds: ['PRRC_1'],
            lastExternalActivityAt: '2026-03-07T00:00:00.000Z',
            quietUntil: '2026-03-07T00:30:00.000Z',
          },
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
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
      gitStrategy: {
        enabled: true,
        missionId: 'pr-flow',
        baseBranch,
        autoPush: false,
        preMergeValidation: false,
        validationCommands: [],
        pullRequestEnabled: true,
      },
    });

    const result = await orchestrator.run();
    expect(result.success).toBe(true);
    expect(workerInputs.map((item) => item.featureId)).toEqual(['m1-f1', 'm2-f1', 'm2-f2', 'm3-f1', 'm3-f2']);
    expect(workerInputs.every((item) => item.currentBranch === baseBranch)).toBe(true);
    expect(execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim()).toBe(baseBranch);

    const gitStrategy = JSON.parse(readFileSync(join(melosDir, 'git-strategy.json'), 'utf-8')) as {
      activeBranch: string | null;
      pullRequest: { url: string; action: string } | null;
      quietUntil: string | null;
    };
    expect(gitStrategy.activeBranch).toBe(baseBranch);
    expect(gitStrategy.pullRequest).toMatchObject({
      url: 'https://github.com/example/repo/pull/99',
      action: 'updated',
    });
    expect(gitStrategy.quietUntil).toBe('2026-03-07T00:30:00.000Z');
  });

  it('treats no_match validation outcomes as success', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-no-match-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# no-match', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      evaluateCommandValidationCheck: (
        check: {
          id: string;
          description: string;
          type: 'command';
          expectedOutcome: 'no_match';
          passed: boolean;
          failureCount: number;
        },
        result: { exitCode: number; stdout: string; stderr: string; durationMs: number }
      ) => { passed: boolean; output?: string };
    };

    const result = orchestratorAny.evaluateCommandValidationCheck(
      {
        id: 'absence-check',
        description: 'No matches remain',
        type: 'command',
        expectedOutcome: 'no_match',
        passed: false,
        failureCount: 0,
      },
      {
        exitCode: 1,
        stdout: '',
        stderr: '',
        durationMs: 5,
      }
    );

    expect(result.passed).toBe(true);
    expect(result.output).toContain('expected no matches');
  });

  it('fails validation when pnpm filter matched no workspace projects', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-no-projects-matched-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# no-projects-matched', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      evaluateCommandValidationCheck: (
        check: {
          id: string;
          description: string;
          type: 'command';
          expectedOutcome: 'exit_code_zero';
          passed: boolean;
          failureCount: number;
        },
        result: { exitCode: number; stdout: string; stderr: string; durationMs: number }
      ) => { passed: boolean; failure?: { rootCause?: string; summary: string } };
    };

    const result = orchestratorAny.evaluateCommandValidationCheck(
      {
        id: 'workspace-check',
        description: 'Run filtered pnpm command',
        type: 'command',
        expectedOutcome: 'exit_code_zero',
        passed: false,
        failureCount: 0,
      },
      {
        exitCode: 0,
        stdout: 'No projects matched the filters in "/repo"',
        stderr: '',
        durationMs: 5,
      }
    );

    expect(result.passed).toBe(false);
    expect(result.failure?.rootCause).toBe('validation-command-no-projects-matched');
    expect(result.failure?.summary).toContain('matched no workspace projects');
  });

  it('runs milestone validation commands from the milestone feature cwd when it is unique', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-validation-cwd-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(melosDir, 'validations'), { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    const packageCwd = join(cwd, 'frontend', 'apps', 'web');
    mkdirSync(packageCwd, { recursive: true });
    writeFileSync(prdPath, '# validation cwd', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const plan = createMissionPlan({
      missionId: 'validation-cwd',
      goal: 'Run validation from feature cwd',
      constraints: [],
      successCriteria: [],
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [
              {
                id: 'cwd-check',
                description: 'validate cwd',
                type: 'command',
                command: 'node -e "process.stdout.write(process.cwd())"',
                passed: false,
                failureCount: 0,
              },
            ],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'work',
              kind: 'implementation',
              cwd: 'frontend/apps/web',
              status: 'done',
              attempts: 1,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'running',
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null; latestValidationReport: { results: Array<{ output?: string }> } | null };
      kernelState: { missionPlan: MissionPlan | null };
      runMilestoneValidation: (milestoneId: string) => Promise<void>;
    };
    orchestratorAny.state.missionPlan = plan;
    orchestratorAny.kernelState.missionPlan = plan;

    await orchestratorAny.runMilestoneValidation('m1');

    expect(orchestratorAny.state.latestValidationReport?.results[0]?.output).toBe(realpathSync(packageCwd));
    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain(`"cwd":"${packageCwd.replace(/\\/g, '\\\\')}"`);
  });

  it('reuses completed validation follow-up features by trackingKey instead of appending duplicates', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-reuse-done-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# reuse done', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const plan = createMissionPlan({
      missionId: 'reuse-done',
      goal: 'Reuse done follow-ups',
      constraints: [],
      successCriteria: ['No duplicate follow-up features'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'desc',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Resolve shared validation root cause',
              trackingKey: 'shared-root-cause',
              status: 'done',
              attempts: 1,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'running',
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      applyValidationFollowUps: (
        missionPlan: MissionPlan,
        milestoneId: string,
        followUps: Array<{ description: string; trackingKey?: string; model?: string }>
      ) => {
        plan: MissionPlan;
        addedFeatures: Array<{ id: string }>;
        updatedFeatures: Array<{ id: string; status: string; description: string }>;
      };
    };

    const followUpResult = orchestratorAny.applyValidationFollowUps(plan, 'm1', [{
      description: 'Resolve shared validation root cause with more context',
      trackingKey: 'shared-root-cause',
      model: 'codex-latest',
    }]);

    expect(followUpResult.addedFeatures).toHaveLength(0);
    expect(followUpResult.updatedFeatures).toHaveLength(1);
    expect(followUpResult.updatedFeatures[0]?.id).toBe('m1-f1');
    expect(followUpResult.updatedFeatures[0]?.status).toBe('pending');
    expect(followUpResult.plan.milestones[0]?.features).toHaveLength(1);
  });

  it('reuses completed validation follow-up features when tracking keys normalize to the same problem', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-reuse-normalized-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# reuse normalized', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const plan = createMissionPlan({
      missionId: 'reuse-normalized',
      goal: 'Reuse normalized follow-ups',
      constraints: [],
      successCriteria: ['No duplicate follow-up features for the same QA problem'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'desc',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Align seeded content with hub expectations',
              trackingKey: 'learn-hub-seed-parity',
              status: 'done',
              attempts: 1,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'running',
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      applyValidationFollowUps: (
        missionPlan: MissionPlan,
        milestoneId: string,
        followUps: Array<{ description: string; trackingKey?: string; model?: string }>
      ) => {
        plan: MissionPlan;
        addedFeatures: Array<{ id: string }>;
        updatedFeatures: Array<{ id: string; status: string; description: string }>;
      };
    };

    const followUpResult = orchestratorAny.applyValidationFollowUps(plan, 'm1', [{
      description: 'Fix learn fixture determinism for hub QA',
      trackingKey: 'learn-content-fixture-parity',
      model: 'codex-latest',
    }]);

    expect(followUpResult.addedFeatures).toHaveLength(0);
    expect(followUpResult.updatedFeatures).toHaveLength(1);
    expect(followUpResult.updatedFeatures[0]?.id).toBe('m1-f1');
    expect(followUpResult.plan.milestones[0]?.features).toHaveLength(1);
  });

  it('keeps exhausted failed follow-up features failed when requeueFailedMatches is false', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-reuse-exhausted-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# reuse exhausted', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const plan = createMissionPlan({
      missionId: 'reuse-exhausted',
      goal: 'Do not requeue exhausted follow-ups',
      constraints: [],
      successCriteria: ['No duplicate remediation features'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'desc',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Resolve shared validation root cause',
              trackingKey: 'post-feature-validation:exit-1:/repo',
              status: 'failed',
              attempts: 3,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'running',
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      applyValidationFollowUps: (
        missionPlan: MissionPlan,
        milestoneId: string,
        followUps: Array<{ description: string; trackingKey?: string; model?: string }>,
        options?: { requeueFailedMatches?: boolean }
      ) => {
        plan: MissionPlan;
        addedFeatures: Array<{ id: string }>;
        updatedFeatures: Array<{ id: string; status: string; description: string }>;
      };
    };

    const followUpResult = orchestratorAny.applyValidationFollowUps(
      plan,
      'm1',
      [{
        description: 'Resolve shared validation root cause with more context',
        trackingKey: 'post-feature-validation:exit-1:/repo',
        model: 'codex-latest',
      }],
      { requeueFailedMatches: false }
    );

    expect(followUpResult.addedFeatures).toHaveLength(0);
    expect(followUpResult.updatedFeatures).toHaveLength(1);
    expect(followUpResult.updatedFeatures[0]?.id).toBe('m1-f1');
    expect(followUpResult.updatedFeatures[0]?.status).toBe('failed');
    expect(followUpResult.plan.milestones[0]?.features).toHaveLength(1);
    expect(followUpResult.plan.milestones[0]?.features[0]?.attempts).toBe(3);
  });

  it('fails worker results that mutate protected runtime files', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-protected-runtime-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# protected runtime', 'utf-8');
    writeFileSync(missionPath, '{"version":3}\n', 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      captureProtectedRuntimeSnapshot: () => Map<string, string>;
      enforceProtectedRuntimeWritePolicy: (
        feature: { id: string },
        result: {
          type: 'success';
          report: {
            status: 'SUCCESS';
            summary: string;
            warnings: string[];
            filesChanged: Array<{ path: string; additions: number; deletions: number }>;
            requestsHelp: boolean;
          };
        },
        before: Map<string, string>
      ) => {
        type: string;
        report: {
          status: string;
          summary: string;
          warnings: string[];
          requestsHelp: boolean;
        };
      };
    };
    const before = orchestratorAny.captureProtectedRuntimeSnapshot();
    writeFileSync(missionPath, '{"version":3,"changed":true}\n', 'utf-8');

    const blocked = orchestratorAny.enforceProtectedRuntimeWritePolicy(
      { id: 'm1-f1' },
      {
        type: 'success',
        report: {
          status: 'SUCCESS',
          summary: 'worker said success',
          warnings: [],
          filesChanged: [],
          requestsHelp: false,
        },
      },
      before
    );

    expect(blocked.type).toBe('failed');
    expect(blocked.report.status).toBe('FAILED');
    expect(blocked.report.summary).toContain('Worker edited protected runtime files.');
    expect(blocked.report.summary).toContain('TASK.json');
    expect(blocked.report.requestsHelp).toBe(true);
  });

  it('does not flag protected runtime files when Melos updates them during worker execution', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-allowed-runtime-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    const statePath = join(melosDir, 'state.json');
    writeFileSync(prdPath, '# allowed runtime', 'utf-8');
    writeFileSync(missionPath, '{"version":3}\n', 'utf-8');
    writeFileSync(statePath, '{"seq":1}\n', 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      allowedProtectedRuntimeWrites: Set<string> | null;
      captureProtectedRuntimeSnapshot: () => Map<string, string>;
      recordAllowedProtectedRuntimeWrite: (...paths: string[]) => void;
      enforceProtectedRuntimeWritePolicy: (
        feature: { id: string },
        result: {
          type: 'success';
          report: {
            status: 'SUCCESS';
            summary: string;
            warnings: string[];
            filesChanged: Array<{ path: string; additions: number; deletions: number }>;
            requestsHelp: boolean;
          };
        },
        before: Map<string, string>
      ) => {
        type: string;
        report: {
          status: string;
          summary: string;
          warnings: string[];
          requestsHelp: boolean;
        };
      };
    };
    const before = orchestratorAny.captureProtectedRuntimeSnapshot();
    orchestratorAny.allowedProtectedRuntimeWrites = new Set<string>();
    orchestratorAny.recordAllowedProtectedRuntimeWrite(missionPath, statePath);
    writeFileSync(missionPath, '{"version":3,"state":"aborted"}\n', 'utf-8');
    writeFileSync(statePath, '{"seq":2}\n', 'utf-8');

    const result = orchestratorAny.enforceProtectedRuntimeWritePolicy(
      { id: 'm1-f1' },
      {
        type: 'success',
        report: {
          status: 'SUCCESS',
          summary: 'worker said success',
          warnings: [],
          filesChanged: [],
          requestsHelp: false,
        },
      },
      before
    );

    expect(result.type).toBe('success');
    expect(result.report.status).toBe('SUCCESS');
    expect(result.report.summary).toBe('worker said success');
  });

  it('does not pause on implementation BLOCKED reports when requestsHelp is false', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-non-escalating-blocked-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# non escalating blocked\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'non-escalating-blocked',
      goal: 'Continue automatically when worker does not need human help',
      constraints: ['No backward compatibility'],
      successCriteria: ['non-escalating blocked results do not pause the mission'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement flow',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement flow',
              status: 'in_progress',
              attempts: 1,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'running',
    });
    const runningPlan: MissionPlan = {
      ...planned,
      activeMilestoneId: 'm1',
      activeFeatureId: 'm1-f1',
    };
    writeFileSync(missionPath, `${JSON.stringify(runningPlan, null, 2)}\n`, 'utf-8');

    jest.spyOn(ManagerAgent.prototype, 'generateImplementationFollowUpFeatures').mockResolvedValue([
      {
        description: 'Address remaining type debt outside the current feature scope',
        trackingKey: 'remaining-type-debt',
        priority: 'high',
        model: 'codex',
      },
    ]);

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      execution: {
        maxFeatureAttempts: 1,
      },
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      handleImplementationFeatureResult: (
        milestone: MissionPlan['milestones'][number],
        feature: MissionPlan['milestones'][number]['features'][number],
        result: {
          type: 'blocked';
          report: {
            iteration: number;
            milestoneId: string;
            featureId: string;
            status: 'BLOCKED';
            summary: string;
            warnings: string[];
            filesChanged: Array<{ path: string; additions: number; deletions: number }>;
            validation: {
              testsRun: boolean;
              testsPassed: number;
              testsFailed: number;
              lintPassed: boolean;
              typecheckPassed: boolean;
            };
            checks: [];
            learnings: string[];
            requestsHelp: boolean;
            createdAt: string;
          };
        }
      ) => Promise<void>;
    };
    orchestratorAny.state.missionPlan = runningPlan;
    orchestratorAny.kernelState.missionPlan = runningPlan;

    const milestone = runningPlan.milestones[0]!;
    const feature = milestone.features[0]!;
    await orchestratorAny.handleImplementationFeatureResult(milestone, feature, {
      type: 'blocked',
      report: {
        iteration: 1,
        milestoneId: 'm1',
        featureId: 'm1-f1',
        status: 'BLOCKED',
        summary: 'repo-wide type debt remains',
        warnings: ['remaining work does not require human intervention'],
        filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0 }],
        validation: {
          testsRun: true,
          testsPassed: 0,
          testsFailed: 1,
          lintPassed: true,
          typecheckPassed: false,
        },
        checks: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    });

    const missionPlan = orchestratorAny.state.missionPlan!;
    expect(missionPlan.state).toBe('running');
    expect(missionPlan.activeMilestoneId).toBe('m1');
    expect(missionPlan.activeFeatureId).toBeNull();
    expect(missionPlan.milestones[0]?.features.map((item) => ({ id: item.id, status: item.status }))).toEqual([
      { id: 'm1-f1', status: 'failed' },
      { id: 'm1-f2', status: 'pending' },
    ]);

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('"action":"worker_blocked_auto_downgraded"');
  });

  it('does not overwrite TASK.json when it was edited outside the active Melos process', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-external-task-edit-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# external task edit\n', 'utf-8');

    const originalPlan = createMissionPlan({
      missionId: 'external-task-edit',
      goal: 'Respect manual TASK.json edits',
      constraints: [],
      successCriteria: ['stale process does not clobber manual task edits'],
      milestones: [
        {
          id: 'm3',
          title: 'Final Review',
          description: 'Run final product review',
          order: 1,
          status: 'in_progress',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            {
              id: 'm3-f7',
              description: 'evidence task',
              kind: 'review_remediation',
              status: 'in_progress',
              attempts: 2,
              model: 'codex-latest',
            },
            {
              id: 'm3-f8',
              description: 're-run final product review',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 3,
              status: 'pending',
              attempts: 0,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'paused',
    });
    const diskEditedPlan: MissionPlan = {
      ...originalPlan,
      activeMilestoneId: 'm3',
      activeFeatureId: 'm3-f8',
      milestones: originalPlan.milestones.map((milestone) =>
        milestone.id === 'm3'
          ? {
            ...milestone,
            features: milestone.features.map((feature) =>
              feature.id === 'm3-f7'
                ? { ...feature, status: 'skipped' }
                : feature
            ),
          }
          : milestone
      ),
    };
    writeFileSync(missionPath, `${JSON.stringify(originalPlan, null, 2)}\n`, 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: {
        missionPlan: MissionPlan | null;
        missionPlanFingerprint: string | null;
      };
      kernelState: { missionPlan: MissionPlan | null };
      computeMissionPlanFingerprintFromDisk: () => Promise<string | null>;
      persistMissionPlan: () => Promise<void>;
    };
    orchestratorAny.state.missionPlan = originalPlan;
    orchestratorAny.kernelState.missionPlan = originalPlan;
    orchestratorAny.state.missionPlanFingerprint = await orchestratorAny.computeMissionPlanFingerprintFromDisk();

    writeFileSync(missionPath, `${JSON.stringify(diskEditedPlan, null, 2)}\n`, 'utf-8');

    await orchestratorAny.persistMissionPlan();

    const persisted = JSON.parse(readFileSync(missionPath, 'utf-8')) as MissionPlan;
    expect(persisted.activeFeatureId).toBe('m3-f8');
    expect(persisted.milestones[0]?.features[0]?.status).toBe('skipped');
    expect(orchestratorAny.state.missionPlan?.activeFeatureId).toBe('m3-f8');
    expect(orchestratorAny.state.missionPlan?.milestones[0]?.features[0]?.status).toBe('skipped');

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('TASK.json was modified outside the active Melos process');
  });

  it('continues a full mission run when worker returns BLOCKED without requestsHelp', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-blocked-run-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# blocked without help\n\nContinue automatically.', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'blocked-without-help',
      goal: 'Keep running without manual resume',
      constraints: ['No backward compatibility'],
      successCriteria: ['non-escalating blocked results do not pause the mission'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement flow',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Initial implementation',
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
    jest.spyOn(ManagerAgent.prototype, 'generateImplementationFollowUpFeatures').mockResolvedValue([
      {
        description: 'Address the remaining issue without human help',
        trackingKey: 'remaining-issue',
        priority: 'high',
        model: 'codex',
      },
    ]);

    let runCount = 0;
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async (input) => {
      runCount += 1;

      if (runCount === 1) {
        return {
          type: 'blocked',
          report: {
            iteration: 1,
            milestoneId: input.milestone.id,
            featureId: input.feature.id,
            status: 'BLOCKED',
            summary: 'remaining issue does not require human intervention',
            warnings: ['continue automatically'],
            filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0 }],
            validation: {
              testsRun: true,
              testsPassed: 0,
              testsFailed: 1,
              lintPassed: true,
              typecheckPassed: false,
            },
            checks: [],
            learnings: [],
            requestsHelp: false,
            createdAt: new Date().toISOString(),
          },
        };
      }

      return {
        type: 'success',
        report: {
          iteration: 2,
          milestoneId: input.milestone.id,
          featureId: input.feature.id,
          status: 'SUCCESS',
          summary: 'done',
          warnings: [],
          filesChanged: [{ path: 'src/fix.ts', additions: 2, deletions: 0 }],
          validation: {
            testsRun: true,
            testsPassed: 1,
            testsFailed: 0,
            lintPassed: true,
            typecheckPassed: true,
          },
          checks: [],
          learnings: [],
          requestsHelp: false,
          createdAt: new Date().toISOString(),
        },
      };
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 10,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      execution: {
        maxFeatureAttempts: 1,
      },
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    expect(result.reason).toBe('completed');
    expect(runCount).toBe(2);

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('"action":"worker_blocked_auto_downgraded"');
    expect(events).not.toContain('"type":"mission_interrupted"');
  });

  it('pauses and emits mission_interrupted on implementation BLOCKED reports when requestsHelp is true', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-escalating-blocked-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# escalating blocked\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'escalating-blocked',
      goal: 'Pause when worker needs human help',
      constraints: ['No backward compatibility'],
      successCriteria: ['mission is paused and records the interruption'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Implement flow',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement flow',
              status: 'in_progress',
              attempts: 1,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'running',
    });
    const runningPlan: MissionPlan = {
      ...planned,
      activeMilestoneId: 'm1',
      activeFeatureId: 'm1-f1',
    };
    writeFileSync(missionPath, `${JSON.stringify(runningPlan, null, 2)}\n`, 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      handleImplementationFeatureResult: (
        milestone: MissionPlan['milestones'][number],
        feature: MissionPlan['milestones'][number]['features'][number],
        result: {
          type: 'blocked';
          report: {
            iteration: number;
            milestoneId: string;
            featureId: string;
            status: 'BLOCKED';
            summary: string;
            warnings: string[];
            filesChanged: Array<{ path: string; additions: number; deletions: number }>;
            validation: {
              testsRun: boolean;
              testsPassed: number;
              testsFailed: number;
              lintPassed: boolean;
              typecheckPassed: boolean;
            };
            checks: [];
            learnings: string[];
            requestsHelp: boolean;
            createdAt: string;
          };
        }
      ) => Promise<void>;
    };
    orchestratorAny.state.missionPlan = runningPlan;
    orchestratorAny.kernelState.missionPlan = runningPlan;

    const milestone = runningPlan.milestones[0]!;
    const feature = milestone.features[0]!;
    await orchestratorAny.handleImplementationFeatureResult(milestone, feature, {
      type: 'blocked',
      report: {
        iteration: 1,
        milestoneId: 'm1',
        featureId: 'm1-f1',
        status: 'BLOCKED',
        summary: 'missing secret from user',
        warnings: ['human help required'],
        filesChanged: [],
        validation: {
          testsRun: false,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: false,
          typecheckPassed: false,
        },
        checks: [],
        learnings: [],
        requestsHelp: true,
        createdAt: new Date().toISOString(),
      },
    });

    const missionPlan = orchestratorAny.state.missionPlan!;
    expect(missionPlan.state).toBe('paused');
    expect(missionPlan.activeMilestoneId).toBe('m1');
    expect(missionPlan.activeFeatureId).toBe('m1-f1');
    expect(missionPlan.milestones[0]?.features.map((item) => ({ id: item.id, status: item.status }))).toEqual([
      { id: 'm1-f1', status: 'pending' },
    ]);

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    const blockedIndex = events.findIndex((event) => event.type === 'iteration_completed' && event.payload.status === 'blocked');
    const interruptedIndex = events.findIndex((event) => event.type === 'mission_interrupted');
    expect(blockedIndex).toBeGreaterThanOrEqual(0);
    expect(interruptedIndex).toBeGreaterThan(blockedIndex);
    expect(events[interruptedIndex]?.payload.reason).toBe('worker blocked and requested help');
  });

  it('ignores watchdog timeout callbacks while mission is paused', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-watchdog-paused-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# paused watchdog\n', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const pausedPlan = createMissionPlan({
      missionId: 'paused-watchdog',
      goal: 'Ignore watchdog while paused',
      constraints: [],
      successCriteria: ['no timeout events while paused'],
      milestones: [],
      state: 'paused',
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      watchdog: { callback?: (() => void) | null };
    };
    orchestratorAny.state.missionPlan = pausedPlan;
    orchestratorAny.kernelState.missionPlan = pausedPlan;

    orchestratorAny.watchdog.callback?.();

    const eventsPath = join(melosDir, 'events.jsonl');
    const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf-8') : '';
    expect(events).not.toContain('watchdog timeout');
  });

  it('aborts active agents when paused by watchdog timeout', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-watchdog-abort-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# watchdog abort\n', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const runningPlan = createMissionPlan({
      missionId: 'watchdog-abort',
      goal: 'Abort active agents on watchdog pause',
      constraints: [],
      successCriteria: ['manager and worker are aborted'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'desc',
          order: 1,
          status: 'in_progress',
          validationContract: { staticChecks: [], testSuites: [] },
          features: [
            {
              id: 'm1-f1',
              description: 'Implement flow',
              status: 'in_progress',
              attempts: 1,
              model: 'codex',
            },
          ],
        },
      ],
      state: 'running',
    });

    const managerAbortSpy = jest.spyOn(ManagerAgent.prototype, 'abort').mockImplementation(() => {});
    const workerAbortSpy = jest.spyOn(WorkerAgent.prototype, 'abort').mockImplementation(() => {});

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
    };
    orchestratorAny.state.missionPlan = runningPlan;
    orchestratorAny.kernelState.missionPlan = runningPlan;

    orchestrator.pause('watchdog worker timeout');

    expect(managerAbortSpy).toHaveBeenCalled();
    expect(workerAbortSpy).toHaveBeenCalled();
  });

  it('ignores late feature results after watchdog pause', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-stale-review-result-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# stale review result\n', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const activePlan = createMissionPlan({
      missionId: 'stale-review-result',
      goal: 'Ignore late review results after pause',
      constraints: [],
      successCriteria: ['paused mission ignores late worker outputs'],
      milestones: [
        {
          id: 'm3',
          title: 'Final Review',
          description: 'Run final review',
          order: 1,
          status: 'in_progress',
          validationContract: { staticChecks: [], testSuites: [], qaChecks: [] },
          features: [
            {
              id: 'm3-f1',
              description: 'Run final product review against the PRD and interactive browser checks',
              kind: 'review',
              reviewType: 'product',
              reviewGeneration: 1,
              status: 'pending',
              attempts: 1,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'paused',
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      ignoreLateFeatureResultIfPaused: (milestoneId: string, featureId: string) => boolean;
    };
    orchestratorAny.state.missionPlan = activePlan;
    orchestratorAny.kernelState.missionPlan = activePlan;

    expect(orchestratorAny.ignoreLateFeatureResultIfPaused('m3', 'm3-f1')).toBe(true);

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('"action":"stale_feature_result_ignored"');
    expect(events).not.toContain('"type":"task_added"');
  });

  it('defaults validation loop escalation to pause in non-interactive mode', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-validation-loop-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# validation loop', 'utf-8');
    writeFileSync(missionPath, '{}\n', 'utf-8');

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      resolveValidationEscalation: (milestone: { id: string }) => Promise<string>;
    };

    await expect(orchestratorAny.resolveValidationEscalation({ id: 'm1' })).resolves.toBe('modify');
  });

  it('continues with validation follow-up planning when non-interactive escalation defaults to modify', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-validation-loop-followup-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(melosDir, 'validations'), { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# validation loop follow-up', 'utf-8');

    const plan = createMissionPlan({
      missionId: 'validation-loop-followup',
      goal: 'Keep running after validation loop modify escalation',
      constraints: [],
      successCriteria: ['validation loop modify creates follow-up work instead of pausing'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Repair failed validation',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [
              {
                id: 'm1-build',
                description: 'Build must pass',
                type: 'command',
                command: 'false',
                expectedOutcome: 'exit_code_zero',
                passed: false,
                failureCount: 2,
              },
            ],
            testSuites: [],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Initial implementation',
              status: 'done',
              attempts: 1,
              model: 'codex-latest',
            },
          ],
        },
      ],
      state: 'running',
    });
    writeFileSync(missionPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf-8');

    const spy = jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Repair build regression detected by validation',
        trackingKey: 'build-regression',
        priority: 'high',
        affectedChecks: ['m1-build'],
        model: 'codex-latest',
      },
    ]);

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      runMilestoneValidation: (milestoneId: string) => Promise<void>;
    };
    orchestratorAny.state.missionPlan = plan;
    orchestratorAny.kernelState.missionPlan = plan;

    await orchestratorAny.runMilestoneValidation('m1');

    const missionPlan = orchestratorAny.state.missionPlan!;
    expect(missionPlan.state).toBe('running');
    expect(missionPlan.milestones[0]?.status).toBe('in_progress');
    expect(missionPlan.milestones[0]?.features.map((feature) => feature.id)).toEqual(['m1-f1', 'm1-f2']);
    expect(missionPlan.milestones[0]?.features[1]?.trackingKey).toBe('build-regression');
    expect(missionPlan.milestones[0]?.features[1]?.status).toBe('pending');

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('"answer":"modify"');
    expect(events).toContain('"action":"validation_loop_modify_followups"');
    expect(events).toContain('"type":"task_added"');
    expect(events).not.toContain('"type":"mission_interrupted"');

    spy.mockRestore();
  });

  it('reruns milestone QA instead of requeueing a done no-op implementation follow-up', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-validation-recovery-qa-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(melosDir, 'validations'), { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# validation recovery qa rerun', 'utf-8');

    let plan = createMissionPlan({
      missionId: 'validation-recovery-qa',
      goal: 'Retry QA before implementation remediation',
      constraints: [],
      successCriteria: ['QA rerun is preferred for done no-op features'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Repair ToC QA regression',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'manual-qa',
                description: 'Validate article ToC state',
                type: 'manual',
                passed: false,
                failureCount: 2,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Fix ToC active sync',
              trackingKey: 'learn-toc-active-sync',
              status: 'done',
              attempts: 1,
              model: 'codex-latest',
              lastExecution: {
                status: 'SUCCESS',
                resultKind: 'verified_existing',
                changeScope: 'none',
                problemKeys: ['toc-scrollspy-click-hash-active-desync'],
                filesChangedCount: 0,
                createdAt: '2026-03-13T00:00:00.000Z',
              },
            },
          ],
        },
      ],
      state: 'running',
    });
    plan = updateFeatureStatus(plan, 'm1', 'm1-f2', 'done');
    writeFileSync(missionPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf-8');

    jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Fix ToC active sync',
        trackingKey: 'learn-toc-active-sync',
        priority: 'high',
        affectedChecks: ['manual-qa'],
        model: 'codex-latest',
      },
    ]);

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      runMilestoneValidation: (milestoneId: string) => Promise<void>;
    };
    orchestratorAny.state.missionPlan = plan;
    orchestratorAny.kernelState.missionPlan = plan;

    await orchestratorAny.runMilestoneValidation('m1');

    const missionPlan = orchestratorAny.state.missionPlan!;
    expect(missionPlan.state).toBe('running');
    expect(missionPlan.milestones[0]?.features).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'm1-f1',
        status: 'done',
        recoveryStage: 'qa_rerun_attempted',
      }),
      expect.objectContaining({
        id: 'm1-f2',
        kind: 'qa',
        status: 'pending',
      }),
    ]));
    expect(missionPlan.milestones[0]?.features).toHaveLength(2);

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('"action":"validation_loop_modify_followups"');
    expect(events).toContain('"id":"m1-f2"');
    expect(events).not.toContain('"id":"m1-f3"');
  });

  it('appends one remediation feature after a QA rerun already failed for the same no-op implementation feature', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-validation-recovery-remediation-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(melosDir, 'validations'), { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# validation recovery remediation', 'utf-8');

    let plan = createMissionPlan({
      missionId: 'validation-recovery-remediation',
      goal: 'Escalate from QA rerun to implementation remediation',
      constraints: [],
      successCriteria: ['remediation follow-up is created once QA rerun was already attempted'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Repair ToC QA regression',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'manual-qa',
                description: 'Validate article ToC state',
                type: 'manual',
                passed: false,
                failureCount: 2,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Fix ToC active sync',
              trackingKey: 'learn-toc-active-sync',
              status: 'done',
              attempts: 1,
              model: 'codex-latest',
              recoveryStage: 'qa_rerun_attempted',
              lastExecution: {
                status: 'SUCCESS',
                resultKind: 'verified_existing',
                changeScope: 'none',
                problemKeys: ['toc-scrollspy-click-hash-active-desync'],
                filesChangedCount: 0,
                createdAt: '2026-03-13T00:00:00.000Z',
              },
            },
          ],
        },
      ],
      state: 'running',
    });
    plan = updateFeatureStatus(plan, 'm1', 'm1-f2', 'done');
    writeFileSync(missionPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf-8');

    jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Fix ToC active sync after QA rerun',
        trackingKey: 'learn-toc-active-sync',
        priority: 'high',
        affectedChecks: ['manual-qa'],
        model: 'codex-latest',
      },
    ]);

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      runMilestoneValidation: (milestoneId: string) => Promise<void>;
    };
    orchestratorAny.state.missionPlan = plan;
    orchestratorAny.kernelState.missionPlan = plan;

    await orchestratorAny.runMilestoneValidation('m1');

    const missionPlan = orchestratorAny.state.missionPlan!;
    expect(missionPlan.state).toBe('running');
    expect(missionPlan.milestones[0]?.features.map((feature) => ({
      id: feature.id,
      status: feature.status,
      recoveryStage: feature.recoveryStage,
    }))).toEqual([
      { id: 'm1-f1', status: 'done', recoveryStage: 'qa_rerun_attempted' },
      { id: 'm1-f3', status: 'pending', recoveryStage: 'remediation_attempted' },
      { id: 'm1-f2', status: 'done', recoveryStage: undefined },
    ]);
  });

  it('pauses once QA rerun and remediation are both exhausted for the same no-op failure', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-validation-recovery-pause-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });
    mkdirSync(join(melosDir, 'validations'), { recursive: true });
    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# validation recovery pause', 'utf-8');

    let plan = createMissionPlan({
      missionId: 'validation-recovery-pause',
      goal: 'Pause only after autonomous recovery is exhausted',
      constraints: [],
      successCriteria: ['mission pauses after remediation also finishes as a no-op'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Repair ToC QA regression',
          order: 1,
          status: 'in_progress',
          validationContract: {
            staticChecks: [],
            testSuites: [],
            qaChecks: [
              {
                id: 'manual-qa',
                description: 'Validate article ToC state',
                type: 'manual',
                passed: false,
                failureCount: 2,
              },
            ],
          },
          features: [
            {
              id: 'm1-f1',
              description: 'Fix ToC active sync remediation',
              trackingKey: 'learn-toc-active-sync',
              status: 'done',
              attempts: 1,
              model: 'codex-latest',
              recoveryStage: 'remediation_attempted',
              lastExecution: {
                status: 'SUCCESS',
                resultKind: 'verified_existing',
                changeScope: 'none',
                problemKeys: ['toc-scrollspy-click-hash-active-desync'],
                filesChangedCount: 0,
                createdAt: '2026-03-13T00:00:00.000Z',
              },
            },
          ],
        },
      ],
      state: 'running',
    });
    plan = updateFeatureStatus(plan, 'm1', 'm1-f2', 'done');
    writeFileSync(missionPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf-8');

    jest.spyOn(ManagerAgent.prototype, 'generateFollowUpFeatures').mockResolvedValue([
      {
        description: 'Fix ToC active sync after remediation',
        trackingKey: 'learn-toc-active-sync',
        priority: 'high',
        affectedChecks: ['manual-qa'],
        model: 'codex-latest',
      },
    ]);

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 5,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
    });
    const orchestratorAny = orchestrator as unknown as {
      state: { missionPlan: MissionPlan | null };
      kernelState: { missionPlan: MissionPlan | null };
      runMilestoneValidation: (milestoneId: string) => Promise<void>;
    };
    orchestratorAny.state.missionPlan = plan;
    orchestratorAny.kernelState.missionPlan = plan;

    await orchestratorAny.runMilestoneValidation('m1');

    const missionPlan = orchestratorAny.state.missionPlan!;
    expect(missionPlan.state).toBe('paused');
    expect(missionPlan.activeMilestoneId).toBe('m1');
    expect(missionPlan.activeFeatureId).toBeNull();
    expect(missionPlan.milestones[0]?.features).toHaveLength(2);

    const events = readFileSync(join(melosDir, 'events.jsonl'), 'utf-8');
    expect(events).toContain('"action":"validation_followup_exhausted"');
    expect(events).toContain('"type":"mission_interrupted"');
  });
});

function initGitRepository(cwd: string): void {
  execSync('git init', { cwd, stdio: 'ignore' });
  execSync('git config user.email "melos-test@example.com"', { cwd, stdio: 'ignore' });
  execSync('git config user.name "Melos Test"', { cwd, stdio: 'ignore' });
  writeFileSync(join(cwd, '.gitkeep'), 'seed\n', 'utf-8');
  execSync('git add -A', { cwd, stdio: 'ignore' });
  execSync('git commit -m "test: initial"', { cwd, stdio: 'ignore' });
}
