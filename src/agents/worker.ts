import { writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  AppServerEngine,
  type AppServerEngineOptions,
} from '../engines/app-server.js';
import { ClaudeEngine, type ClaudeEngineOptions } from '../engines/claude.js';
import { loadPromptFromPath } from '../prompts/index.js';
import {
  CLAUDE_LATEST_ALIAS,
  CODEX_LATEST_ALIAS,
  isClaudeFamily,
  isCodexFamily,
  resolveRuntimeModel,
} from '../models/registry.js';
import type { ValidationCheckFailure, ValidationCheckResult } from '../state/validation.js';
import {
  isBlockingReviewFinding,
  normalizeReviewArtifact,
  normalizeReviewFinding,
  type ProductReviewContract,
} from '../state/review.js';
import type {
  Agent,
  AgentMode,
  SteerResult,
  WorkerFeatureReport,
  WorkerInput,
  WorkerResult,
} from './types.js';

export interface WorkerAgentConfig {
  cwd: string;
  promptsDir: string;
  model?: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  claudeModel?: string;
  claudeEffort?: 'low' | 'medium' | 'high' | 'max';
  suppressTerminalOutput?: boolean;
  resumeThreadId?: string;
  resumeMissionId?: string;
}

export class WorkerAgent implements Agent {
  readonly name = 'worker';
  readonly mode: AgentMode = 'worker';

  private engine: AppServerEngine;
  private claudeEngine: ClaudeEngine;
  private config: WorkerAgentConfig;
  private resumeThreadId: string | null;
  private resumeMissionId: string | null;
  private activeEngine: 'codex' | 'claude' | null = null;

  constructor(config: WorkerAgentConfig) {
    this.config = config;
    this.engine = new AppServerEngine();
    this.claudeEngine = new ClaudeEngine();
    this.resumeThreadId = config.resumeThreadId ?? null;
    this.resumeMissionId = config.resumeMissionId ?? null;
  }

  async run(input: WorkerInput): Promise<WorkerResult> {
    const prompt = await this.buildPrompt(input);
    const executeWithClaude = this.shouldExecuteWithClaude(input);
    const streamTranscript: string[] = [];
    this.activeEngine = executeWithClaude ? 'claude' : 'codex';

    const result = await (executeWithClaude
      ? this.claudeEngine.execute(
        prompt,
        this.buildClaudeOptions(input, {
          onAgentMessageDelta: (chunk) => {
            streamTranscript.push(chunk);
            input.onAgentMessageDelta?.(chunk);
          },
          onAppServerEvent: (method, params) => {
            streamTranscript.push(`[event] ${method} ${safeStringify(params)}\n`);
            input.onAppServerEvent?.(method, params);
          },
        })
      )
      : this.engine.execute(
        prompt,
        this.buildCodexOptions(input, {
          onAgentMessageDelta: (chunk) => {
            streamTranscript.push(chunk);
            input.onAgentMessageDelta?.(chunk);
          },
          onCommandOutputDelta: (chunk) => {
            streamTranscript.push(`[command] ${chunk}`);
            input.onCommandOutputDelta?.(chunk);
          },
          onAppServerEvent: (method, params) => {
            streamTranscript.push(`[event] ${method} ${safeStringify(params)}\n`);
            input.onAppServerEvent?.(method, params);
          },
        })
      ))
      .finally(() => {
        this.activeEngine = null;
      });

    const logFilePath = await this.saveExecutionLog(
      input.iteration,
      input.milestone.id,
      input.feature.id,
      result.output,
      result.error,
      streamTranscript.join('')
    );

    const report = this.parseWorkReport(input, result.output, result.success);
    report.summary = `${report.summary}${logFilePath ? `\n(log: ${logFilePath})` : ''}`.trim();

    switch (report.status) {
      case 'SUCCESS':
        return { type: 'success', report };
      case 'PARTIAL':
        return { type: 'partial', report };
      case 'BLOCKED':
        return { type: 'blocked', report };
      default:
        return { type: 'failed', report };
    }
  }

  async isAvailable(): Promise<boolean> {
    const [codexAvailable, claudeAvailable] = await Promise.all([
      this.engine.isAvailable(),
      this.claudeEngine.isAvailable(),
    ]);
    return codexAvailable || claudeAvailable;
  }

  abort(): void {
    this.engine.abort();
    this.claudeEngine.abort();
  }

  setRuntimeModel(model: string): void {
    if (isClaudeFamily(model)) {
      this.config.claudeModel = model;
      return;
    }
    this.config.model = model;
  }

  getActiveThreadId(): string | null {
    return this.engine.getActiveThreadId();
  }

  setResumeSession(threadId: string, missionId: string): void {
    this.resumeThreadId = threadId;
    this.resumeMissionId = missionId;
  }

  async steer(instruction: string): Promise<SteerResult> {
    if (this.activeEngine === null) {
      return 'unavailable';
    }
    if (this.activeEngine === 'claude') {
      return 'unsupported';
    }

    const accepted = await this.engine.steer(instruction);
    return accepted ? 'accepted' : 'unavailable';
  }

  private async buildPrompt(input: WorkerInput): Promise<string> {
    if (input.feature.kind === 'review' && input.feature.reviewType === 'product') {
      return this.buildProductReviewPrompt(input);
    }
    if (input.feature.kind === 'review' && input.feature.reviewType === 'code') {
      return this.buildCodeReviewPrompt(input);
    }

    const promptTemplate = await loadPromptFromPath(this.resolveWorkerPromptPath());
    const featureChecks = input.feature.checks?.map((check) => `- ${check.text}`).join('\n') || '- none';
    const executionCwd = this.resolveExecutionCwd(input);
    const validationChecks = [
      ...input.milestone.validationContract.staticChecks,
      ...input.milestone.validationContract.testSuites,
      ...(input.milestone.validationContract.browserChecks ?? []),
      ...(input.milestone.validationContract.manualSteps ?? []),
    ]
      .map((check) => {
        const action = typeof check.command === 'string' && check.command.trim().length > 0
          ? check.command.trim()
          : (check.type === 'manual'
              ? 'report structured evidence in `checks` if you actually performed the manual step'
              : check.type === 'browser'
                ? 'report structured browser evidence in `checks` with runner plus screenshot/video paths or URLs'
              : 'no command');
        return `- ${check.id} [${check.type}] ${check.description} :: ${action}`;
      })
      .join('\n');
    const validationCommands = [
      ...input.milestone.validationContract.staticChecks,
      ...input.milestone.validationContract.testSuites,
    ]
      .map((check) => check.command)
      .filter((command): command is string => typeof command === 'string' && command.trim().length > 0)
      .join('\n');

    const sections = [
      promptTemplate.trim(),
      '',
      '## Runtime Context',
      `- Mission goal: ${input.missionPlan.mission.goal}`,
      `- Milestone: ${input.milestone.id} ${input.milestone.title}`,
      `- Feature: ${input.feature.id} ${input.feature.description}`,
      `- Execution cwd: ${executionCwd}`,
      `- Current branch: ${input.currentBranch ?? '(not set)'}`,
      `- Base branch: ${input.baseBranch ?? '(not set)'}`,
      '',
      '## Feature Checks',
      featureChecks,
      '',
      '## Manager Briefing',
      input.briefing?.trim() || '(none)',
      '',
      '## PRD',
      input.prd?.trim() || '(PRD not found)',
      '',
      '## Milestone Validation Checks',
      validationChecks || '- none',
      '',
      '## Milestone Validation Commands',
      validationCommands || '(none)',
    ];

    if (input.currentBranch && input.baseBranch) {
      sections.push(
        '',
        '## Commit Workflow',
        `- Use the git-committer skill at: ${this.resolveGitCommitterSkillPath()}`,
        '- Before committing, inspect: `git status --porcelain`, `git log --oneline -20`, `git diff --staged`',
        '- Create the commit only after implementation and validation are complete for this feature branch',
        '- Use `type(scope): subject` for the commit subject',
        '- Do not use `...` or other abbreviated placeholders in the commit message',
        '- If you add a commit body, briefly explain why the change is needed'
      );
    }

    sections.push(
      '',
      '## Output JSON Schema',
      JSON.stringify({
        status: 'SUCCESS',
        summary: 'what was done',
        filesChanged: [{ path: 'src/file.ts', additions: 10, deletions: 2 }],
        validation: {
          testsRun: true,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: [
          {
            checkId: 'm1-browser-1',
            passed: true,
            runner: 'playwright-interactive',
            screenshotPath: 'artifacts/screenshots/example.png',
          },
        ],
        warnings: ['describe any fallback, unverified scope, or required user follow-up'],
        discoveredFeatures: [],
        learnings: [],
        requestsHelp: false,
      }, null, 2),
      '',
      'Return only one fenced json block.'
    );

    return sections.join('\n');
  }

  private async buildProductReviewPrompt(input: WorkerInput): Promise<string> {
    const promptTemplate = await loadPromptFromPath(this.resolveProductReviewPromptPath());
    const contract = this.resolveProductReviewContract(input);
    const executionCwd = this.resolveExecutionCwd(input);
    const startup = (contract?.startup ?? [])
      .map((step) => `- cwd=${step.cwd ?? '.'} :: ${step.command}`)
      .join('\n') || '- none';
    const checkpoints = (contract?.checkpoints ?? [])
      .map((checkpoint) => `- ${checkpoint.id} :: ${checkpoint.description}${checkpoint.claim ? ` (claim: ${checkpoint.claim})` : ''}${checkpoint.visual ? ' [visual]' : ''}`)
      .join('\n') || '- none';
    const preconditions = (contract?.preconditions ?? []).map((item) => `- ${item}`).join('\n') || '- none';

    return [
      promptTemplate.trim(),
      '',
      '## Runtime Context',
      `- Mission goal: ${input.missionPlan.mission.goal}`,
      `- Milestone: ${input.milestone.id} ${input.milestone.title}`,
      `- Review feature: ${input.feature.id} ${input.feature.description}`,
      `- Review generation: ${input.feature.reviewGeneration ?? 1}`,
      `- Execution cwd: ${executionCwd}`,
      '',
      '## Product Review Contract',
      contract ? JSON.stringify(contract, null, 2) : '(missing contract)',
      '',
      '## Startup',
      startup,
      '',
      '## Preconditions',
      preconditions,
      '',
      '## Checkpoints',
      checkpoints,
      '',
      '## Manager Briefing',
      input.briefing?.trim() || '(none)',
      '',
      '## PRD',
      input.prd?.trim() || '(PRD not found)',
      '',
      '## Output JSON Schema',
      JSON.stringify({
        status: 'SUCCESS',
        summary: 'product review summary',
        warnings: [],
        findings: [
          {
            id: 'product-finding-1',
            priority: 'P2',
            summary: 'Describe the unmet requirement',
            rationale: 'Why this blocks sign-off',
            suggestedFix: 'What should be fixed',
            trackingKey: 'stable-root-cause',
            surface: 'checkout-flow',
            affectedFiles: ['src/app.tsx'],
          },
        ],
        artifacts: [
          {
            kind: 'screenshot',
            path: `${contract?.artifactsDir ?? 'artifacts/screenshots'}/signoff-home.png`,
            label: 'Hero state after verification',
          },
        ],
        requestsHelp: false,
      }, null, 2),
      '',
      'Return only one fenced json block.',
    ].join('\n');
  }

  private async buildCodeReviewPrompt(input: WorkerInput): Promise<string> {
    const promptTemplate = await loadPromptFromPath(this.resolveCodeReviewPromptPath());
    const executionCwd = this.resolveExecutionCwd(input);

    return [
      promptTemplate.trim(),
      '',
      '## Runtime Context',
      `- Mission goal: ${input.missionPlan.mission.goal}`,
      `- Milestone: ${input.milestone.id} ${input.milestone.title}`,
      `- Review feature: ${input.feature.id} ${input.feature.description}`,
      `- Review generation: ${input.feature.reviewGeneration ?? 1}`,
      `- Execution cwd: ${executionCwd}`,
      '',
      '## Manager Briefing',
      input.briefing?.trim() || '(none)',
      '',
      '## PRD',
      input.prd?.trim() || '(PRD not found)',
      '',
      '## Output JSON Schema',
      JSON.stringify({
        status: 'SUCCESS',
        summary: 'code review summary',
        warnings: [],
        findings: [
          {
            id: 'code-finding-1',
            priority: 'P2',
            summary: 'Describe the blocking code issue',
            rationale: 'Why this blocks sign-off',
            suggestedFix: 'What should be fixed',
            trackingKey: 'stable-root-cause',
            surface: 'api-contract',
            affectedFiles: ['src/server.ts'],
          },
        ],
        artifacts: [],
        requestsHelp: false,
      }, null, 2),
      '',
      'Return only one fenced json block.',
    ].join('\n');
  }

  private resolveWorkerPromptPath(): string {
    const promptsDir = isAbsolute(this.config.promptsDir)
      ? this.config.promptsDir
      : resolve(this.config.cwd, this.config.promptsDir);
    return join(promptsDir, 'worker.md');
  }

  private resolveProductReviewPromptPath(): string {
    const promptsDir = isAbsolute(this.config.promptsDir)
      ? this.config.promptsDir
      : resolve(this.config.cwd, this.config.promptsDir);
    return join(promptsDir, 'product-review.md');
  }

  private resolveCodeReviewPromptPath(): string {
    const promptsDir = isAbsolute(this.config.promptsDir)
      ? this.config.promptsDir
      : resolve(this.config.cwd, this.config.promptsDir);
    return join(promptsDir, 'code-review.md');
  }

  private resolveProductReviewContract(input: WorkerInput): ProductReviewContract | undefined {
    return input.missionPlan.productReviewContract;
  }

  private resolveGitCommitterSkillPath(): string {
    return join(this.config.cwd, '.claude', 'skills', 'git-committer', 'SKILL.md');
  }

  private parseWorkReport(
    input: WorkerInput,
    output: string,
    engineSuccess: boolean
  ): WorkerFeatureReport {
    const report: WorkerFeatureReport = {
      iteration: input.iteration,
      milestoneId: input.milestone.id,
      featureId: input.feature.id,
      status: engineSuccess ? 'SUCCESS' : 'FAILED',
      summary: '',
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
      discoveredFeatures: [],
      learnings: [],
      requestsHelp: false,
      createdAt: new Date().toISOString(),
    };

    const jsonBlock = extractJsonBlock(output);
    if (jsonBlock) {
      try {
        const parsed = JSON.parse(jsonBlock) as Partial<WorkerFeatureReport>;
        if (parsed.status) {
          report.status = parsed.status;
        }
        if (typeof parsed.summary === 'string') {
          report.summary = parsed.summary;
        }
        if (Array.isArray(parsed.filesChanged)) {
          report.filesChanged = parsed.filesChanged.map((file) => ({
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
          }));
        }
        if (parsed.validation) {
          report.validation = {
            ...report.validation,
            ...parsed.validation,
          };
        }
        if (Array.isArray(parsed.checks)) {
          report.checks = normalizeValidationCheckResults(parsed.checks);
        }
        if (Array.isArray(parsed.warnings)) {
          report.warnings = normalizeWarnings(parsed.warnings);
        }
        const reviewType = input.feature.reviewType;
        if (reviewType && Array.isArray((parsed as { findings?: unknown[] }).findings)) {
          const findings = ((parsed as { findings?: unknown[] }).findings ?? [])
            .map((finding, index) => normalizeReviewFinding(finding, reviewType, index))
            .filter((finding): finding is NonNullable<typeof finding> => Boolean(finding));
          const artifacts = (Array.isArray((parsed as { artifacts?: unknown[] }).artifacts)
            ? (parsed as { artifacts?: unknown[] }).artifacts ?? []
            : [])
            .map((artifact) => normalizeReviewArtifact(artifact))
            .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact));
          report.review = {
            reviewType,
            generation: input.feature.reviewGeneration ?? 1,
            passed: findings.every((finding) => !isBlockingReviewFinding(finding))
              && parsed.status !== 'FAILED'
              && parsed.status !== 'BLOCKED',
            summary: typeof parsed.summary === 'string' ? parsed.summary : '',
            findings,
            artifacts,
          };
        }
        if (Array.isArray(parsed.discoveredFeatures)) {
          report.discoveredFeatures = normalizeDiscoveredFeatures(parsed.discoveredFeatures);
        }
        if (Array.isArray(parsed.learnings)) {
          report.learnings = parsed.learnings.filter((item): item is string => typeof item === 'string');
        }
        if (typeof parsed.requestsHelp === 'boolean') {
          report.requestsHelp = parsed.requestsHelp;
        }
      } catch {
        // fallback to heuristic
      }
    }

    if (output.includes('<promise>ESCALATE</promise>')) {
      report.status = 'BLOCKED';
      report.requestsHelp = true;
    }
    if (output.includes('<promise>TASK_DONE</promise>')) {
      report.status = 'SUCCESS';
    }

    if (input.feature.reviewType && !report.review) {
      const summary = report.summary
        || output.split(/\n/).find((line) => line.trim().length > 0)?.trim()
        || `${input.feature.reviewType} review could not be completed`;
      report.review = {
        reviewType: input.feature.reviewType,
        generation: input.feature.reviewGeneration ?? 1,
        passed: false,
        summary,
        findings: [
          {
            id: `${input.feature.reviewType}-review-blocked`,
            reviewType: input.feature.reviewType,
            priority: 'P1',
            summary,
            rationale: 'The review executor did not return a structured final review report.',
          },
        ],
        artifacts: [],
      };
      if (report.status === 'SUCCESS' && report.review.findings.some((finding) => isBlockingReviewFinding(finding))) {
        report.status = 'FAILED';
      }
    }

    if (!report.summary) {
      report.summary = output.split(/\n/).find((line) => line.trim().length > 0)?.trim()
        || `${report.status} ${input.feature.id}`;
    }
    if (report.review && !report.review.summary) {
      report.review.summary = report.summary;
    }

    return report;
  }

  private async saveExecutionLog(
    iteration: number,
    milestoneId: string,
    featureId: string,
    output: string,
    error?: string,
    streamTranscript?: string
  ): Promise<string> {
    const logsDir = join(this.config.cwd, '.melos', 'worker-logs');
    mkdirSync(logsDir, { recursive: true });

    const filename = `${iteration}-${milestoneId}-${featureId}.log`;
    const filepath = join(logsDir, filename);
    const content = `=== Worker Execution Log ===\nIteration: ${iteration}\nMilestoneId: ${milestoneId}\nFeatureId: ${featureId}\nTimestamp: ${new Date().toISOString()}\n\n=== Output ===\n${output}\n\n${streamTranscript ? `=== Stream Transcript ===\n${streamTranscript}\n\n` : ''}${error ? `=== Error ===\n${error}` : ''}\n`;
    await writeFile(filepath, content, 'utf-8');
    return filepath;
  }

  private buildCodexOptions(
    input: WorkerInput,
    callbacks: Pick<WorkerInput, 'onAgentMessageDelta' | 'onCommandOutputDelta' | 'onAppServerEvent'> = {}
  ): AppServerEngineOptions {
    const shouldResume = this.resumeThreadId !== null
      && this.resumeMissionId !== null
      && this.resumeMissionId === input.missionPlan.mission.id;
    const isReviewFeature = input.feature.kind === 'review';
    const threadId = shouldResume && this.resumeThreadId
      && !isReviewFeature
      ? this.resumeThreadId
      : undefined;

    return {
      cwd: this.resolveExecutionCwd(input),
      model: resolveRuntimeModel(this.config.model, CODEX_LATEST_ALIAS),
      reasoningEffort: this.config.reasoningEffort || 'xhigh',
      enabledFeatures: input.feature.kind === 'review' && input.feature.reviewType === 'product'
        ? ['js_repl']
        : undefined,
      execMode: true,
      suppressTerminalOutput: this.config.suppressTerminalOutput === true,
      threadId,
      onStream: callbacks.onAgentMessageDelta,
      onCommandOutput: callbacks.onCommandOutputDelta,
      onEvent: callbacks.onAppServerEvent,
    };
  }

  private buildClaudeOptions(
    input: WorkerInput,
    callbacks: Pick<WorkerInput, 'onAgentMessageDelta' | 'onAppServerEvent'> = {}
  ): ClaudeEngineOptions {
    return {
      cwd: this.resolveExecutionCwd(input),
      model: this.resolveClaudeModel(),
      effort: this.config.claudeEffort,
      skipPermissions: true,
      printMode: true,
      suppressTerminalOutput: this.config.suppressTerminalOutput === true,
      onStream: callbacks.onAgentMessageDelta,
      onEvent: callbacks.onAppServerEvent,
    };
  }

  private resolveClaudeModel(): string | undefined {
    if (!isClaudeFamily(this.config.claudeModel) && isCodexFamily(this.config.claudeModel)) {
      return resolveRuntimeModel(CLAUDE_LATEST_ALIAS, CLAUDE_LATEST_ALIAS);
    }
    return resolveRuntimeModel(this.config.claudeModel, CLAUDE_LATEST_ALIAS);
  }

  private shouldExecuteWithClaude(input: WorkerInput): boolean {
    if (input.feature.kind === 'review' && input.feature.reviewType === 'product') {
      return false;
    }
    return isClaudeFamily(input.feature.model);
  }

  private resolveExecutionCwd(input: WorkerInput): string {
    if (typeof input.feature.cwd === 'string' && input.feature.cwd.trim().length > 0) {
      return resolve(this.config.cwd, input.feature.cwd);
    }
    if (input.feature.kind === 'review') {
      const reviewCwd = input.missionPlan.productReviewContract?.cwd;
      if (typeof reviewCwd === 'string' && reviewCwd.trim().length > 0) {
        return resolve(this.config.cwd, reviewCwd);
      }
    }
    return this.config.cwd;
  }
}

function extractJsonBlock(output: string): string | null {
  const fenced = output.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fenced?.[1]) {
    return fenced[1];
  }

  const objectMatch = output.match(/\{[\s\S]*\}/);
  return objectMatch?.[0] ?? null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeValidationCheckResults(value: unknown): ValidationCheckResult[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [];
    }

    const record = item as Record<string, unknown>;
    const checkId = typeof record.checkId === 'string' ? record.checkId.trim() : '';
    if (checkId.length === 0 || typeof record.passed !== 'boolean') {
      return [];
    }

    const result: ValidationCheckResult = {
      checkId,
      passed: record.passed,
    };

    if (typeof record.exitCode === 'number') {
      result.exitCode = record.exitCode;
    }
    if (typeof record.durationMs === 'number') {
      result.durationMs = record.durationMs;
    }
    if (typeof record.output === 'string' && record.output.trim().length > 0) {
      result.output = record.output;
    }
    if (typeof record.warning === 'string' && record.warning.trim().length > 0) {
      result.warning = record.warning.trim();
    }
    if (typeof record.runner === 'string' && record.runner.trim().length > 0) {
      result.runner = record.runner.trim();
    }
    if (typeof record.screenshotPath === 'string' && record.screenshotPath.trim().length > 0) {
      result.screenshotPath = record.screenshotPath.trim();
    }
    if (typeof record.videoPath === 'string' && record.videoPath.trim().length > 0) {
      result.videoPath = record.videoPath.trim();
    }
    if (typeof record.screenshotUrl === 'string' && record.screenshotUrl.trim().length > 0) {
      result.screenshotUrl = record.screenshotUrl.trim();
    }
    if (typeof record.videoUrl === 'string' && record.videoUrl.trim().length > 0) {
      result.videoUrl = record.videoUrl.trim();
    }

    const failure = normalizeValidationCheckFailure(record.failure);
    if (failure) {
      result.failure = failure;
    }

    return [result];
  });
}

function normalizeValidationCheckFailure(value: unknown): ValidationCheckFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  if (summary.length === 0) {
    return undefined;
  }

  return {
    summary,
    affectedFiles: Array.isArray(record.affectedFiles)
      ? record.affectedFiles.filter((item): item is string => typeof item === 'string')
      : [],
    errorMessages: Array.isArray(record.errorMessages)
      ? record.errorMessages.filter((item): item is string => typeof item === 'string')
      : [],
    rootCause: typeof record.rootCause === 'string' && record.rootCause.trim().length > 0
      ? record.rootCause.trim()
      : undefined,
  };
}

function normalizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeDiscoveredFeatures(value: unknown): WorkerFeatureReport['discoveredFeatures'] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === 'string') {
      const description = item.trim();
      return description.length > 0
        ? [{ description, priority: 'medium' as const }]
        : [];
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return [];
    }

    const description = typeof item.description === 'string' ? item.description.trim() : '';
    if (description.length === 0) {
      return [];
    }

    const priority = item.priority === 'high' || item.priority === 'medium' || item.priority === 'low'
      ? item.priority
      : 'medium';
    const rationale = typeof item.rationale === 'string' && item.rationale.trim().length > 0
      ? item.rationale.trim()
      : undefined;

    return [{ description, priority, rationale }];
  });
}
