import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { jest } from '@jest/globals';

import { Orchestrator } from '../orchestrator.js';
import { ManagerAgent, MissionPlanningError } from '../agents/manager.js';
import { WorkerAgent } from '../agents/worker.js';
import { getDefaultPromptsDir } from '../prompts/index.js';
import { createMissionPlan, type MissionPlan } from '../state/mission.js';
import type { MissionControlState } from '../ui/tui-views.js';

describe('Orchestrator v0.8', () => {
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
        discoveredFeatures: [],
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
  });

  it('runs final review gate before completion and saves review reports', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-final-review-pass-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Final review mission\n\nVerify the final sign-off flow.', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'final-review-pass',
      goal: 'Finish implementation only after final reviews pass',
      constraints: ['No backward compatibility'],
      successCriteria: ['product review passes', 'code review passes'],
      productReviewContract: {
        target: 'http://127.0.0.1:${PORT}',
        preconditions: ['js_repl enabled', 'playwright importable'],
        checkpoints: [
          { id: 'hero', description: 'Hero flow satisfies the PRD', visual: true },
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
          discoveredFeatures: [],
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
              { kind: 'screenshot', path: 'artifacts/screenshots/home.png', label: 'Home' },
            ],
          },
          discoveredFeatures: [],
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
          discoveredFeatures: [],
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
          discoveredFeatures: [],
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
          discoveredFeatures: [],
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
          discoveredFeatures: [],
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
            artifacts: [],
          },
          discoveredFeatures: [],
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
          discoveredFeatures: [],
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
    expect(existsSync(join(melosDir, 'reviews', 'm2-f1.json'))).toBe(true);
    expect(existsSync(join(melosDir, 'reviews', 'm2-f4.json'))).toBe(true);
    expect(existsSync(join(melosDir, 'reviews', 'm2-f5.json'))).toBe(true);
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
            manualSteps: [
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
        discoveredFeatures: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    });

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
            browserChecks: [
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
        discoveredFeatures: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    });

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
          discoveredFeatures: [],
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
          discoveredFeatures: [],
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
          discoveredFeatures: [],
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
          discoveredFeatures: [],
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
            browserChecks: [
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
        checks: [
          {
            checkId: 'browser-qa',
            passed: true,
            runner: 'browser-test',
            screenshotPath: 'artifacts/screenshots/browser.png',
          },
        ],
        discoveredFeatures: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    });

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
            browserChecks: [
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
        checks: [
          {
            checkId: 'browser-qa',
            passed: true,
            runner: 'playwright-interactive',
            screenshotPath: 'artifacts/screenshots/browser.png',
            warning: 'fallback browser QA was used',
          },
        ],
        discoveredFeatures: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    });

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
            browserChecks: [
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
        checks: [
          {
            checkId: 'browser-qa',
            passed: true,
            runner: 'playwright-interactive',
            screenshotPath: 'artifacts/screenshots/missing.png',
          },
        ],
        discoveredFeatures: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    });

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
            manualSteps: [
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
        checks: [
          {
            checkId: 'manual-qa',
            passed: true,
            output: 'browser flow verified by worker',
          },
        ],
        discoveredFeatures: [],
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
            manualSteps: [
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
        checks: [
          {
            checkId: 'manual-qa',
            passed: false,
            failure: {
              summary: 'manual qa failed',
              affectedFiles: [],
              errorMessages: ['screen mismatch'],
            },
          },
        ],
        discoveredFeatures: [],
        learnings: [],
        requestsHelp: false,
        createdAt: new Date().toISOString(),
      },
    }));

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
      milestones: Array<{ features: Array<{ description: string }> }>;
    };
    expect(mission.milestones[0]?.features).toHaveLength(2);
    expect(mission.milestones[0]?.features[1]?.description).toBe('Fix manual QA regression');
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
          discoveredFeatures: [],
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
    expect(workerConfig.reasoningEffort).toBe('xhigh');
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
        discoveredFeatures: [],
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
          discoveredFeatures: [],
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

  it('does not append TASK features from worker discoveredFeatures', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-worker-discovered-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Worker discovered features\n', 'utf-8');

    const planned = createMissionPlan({
      missionId: 'worker-discovered',
      goal: 'Ignore worker discovered features for TASK growth',
      constraints: ['No backward compatibility'],
      successCriteria: ['Mission completes without appending follow-ups'],
      milestones: [
        {
          id: 'm1',
          title: 'Milestone 1',
          description: 'Execute single feature',
          order: 1,
          status: 'pending',
          validationContract: {
            staticChecks: [],
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
        discoveredFeatures: [
          { description: 'This should stay in the report only', priority: 'high', rationale: 'Do not append' },
        ],
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
      execution: {
        retryInitialDelayMs: 0,
        retryMaxDelayMs: 0,
      },
    });

    const result = await orchestrator.run();

    expect(result.success).toBe(true);
    const saved = JSON.parse(readFileSync(missionPath, 'utf-8')) as {
      milestones: Array<{ features: Array<{ id: string; description: string }> }>;
    };
    expect(saved.milestones[0]?.features).toHaveLength(1);
    expect(saved.milestones[0]?.features[0]?.id).toBe('m1-f1');
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
            discoveredFeatures: [],
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
            discoveredFeatures: [],
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
          discoveredFeatures: [],
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
        discoveredFeatures: [],
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
          discoveredFeatures: [],
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
          discoveredFeatures: [],
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
          discoveredFeatures: [],
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

  it('fails feature with clear guidance when git-strategy branch is dirty', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-orchestrator-git-strategy-dirty-'));
    const melosDir = join(cwd, '.melos');
    mkdirSync(melosDir, { recursive: true });

    const prdPath = join(cwd, 'PRD.md');
    const missionPath = join(cwd, 'TASK.json');
    writeFileSync(prdPath, '# Dirty branch mission\n', 'utf-8');
    initGitRepository(cwd);
    const baseBranch = execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim();

    const planned = createMissionPlan({
      missionId: 'dirty-branch',
      goal: 'Dirty branch guard',
      constraints: ['No backward compatibility'],
      successCriteria: ['must fail if uncommitted'],
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
    jest.spyOn(ManagerAgent.prototype, 'generateImplementationFollowUpFeatures').mockResolvedValue([
      {
        description: 'Commit dirty branch before merge',
        trackingKey: 'git-dirty-branch',
        priority: 'high',
        model: 'codex',
      },
    ]);
    jest.spyOn(WorkerAgent.prototype, 'run').mockImplementation(async () => {
      writeFileSync(join(cwd, 'dirty-change.txt'), 'dirty', 'utf-8');
      return {
        type: 'success',
        report: {
          iteration: 1,
          milestoneId: 'm1',
          featureId: 'm1-f1',
          status: 'SUCCESS',
          summary: 'implemented without commit',
          warnings: [],
          filesChanged: [{ path: 'dirty-change.txt', additions: 1, deletions: 0 }],
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
          createdAt: new Date().toISOString(),
        },
      };
    });

    const orchestrator = new Orchestrator({
      cwd,
      maxIterations: 1,
      prdFile: prdPath,
      missionFile: missionPath,
      melosDir,
      autoApprove: true,
      interactivePlanning: false,
      dryRun: false,
      resume: false,
      gitStrategy: {
        enabled: true,
        missionId: 'dirty-branch',
        baseBranch,
        autoPush: false,
        preMergeValidation: false,
        validationCommands: [],
      },
      execution: {
        maxFeatureAttempts: 1,
      },
    });

    const result = await orchestrator.run();
    expect(result.success).toBe(false);
    expect(result.reason).toBe('max_iterations');

    const mission = JSON.parse(readFileSync(join(cwd, 'TASK.json'), 'utf-8')) as {
      milestones: Array<{ features: Array<{ status: string }> }>;
    };
    expect(mission.milestones[0]?.features[0]?.status).toBe('failed');
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
          discoveredFeatures: [],
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
      },
    });

    const result = await orchestrator.run();
    expect(result.success).toBe(true);
    expect(execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim()).toBe(baseBranch);
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
