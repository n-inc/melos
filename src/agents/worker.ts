import { writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AppServerEngine,
  type AppServerEngineOptions,
} from '../engines/app-server.js';
import { ClaudeEngine, type ClaudeEngineOptions } from '../engines/claude.js';
import type {
  Agent,
  AgentMode,
  SteerResult,
  WorkerFeatureReport,
  WorkerInput,
  WorkerResult,
} from './types.js';

const DEFAULT_CLAUDE_MODEL = 'opus';

export interface WorkerAgentConfig {
  cwd: string;
  promptsDir: string;
  model?: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  claudeModel?: string;
  claudeEffort?: 'low' | 'medium' | 'high' | 'max';
  resumeThreadId?: string;
  resumeFeatureId?: string;
}

export class WorkerAgent implements Agent {
  readonly name = 'worker';
  readonly mode: AgentMode = 'worker';

  private engine: AppServerEngine;
  private claudeEngine: ClaudeEngine;
  private config: WorkerAgentConfig;
  private resumeThreadId: string | null;
  private resumeFeatureId: string | null;
  private activeEngine: 'codex' | 'claude' | null = null;

  constructor(config: WorkerAgentConfig) {
    this.config = config;
    this.engine = new AppServerEngine();
    this.claudeEngine = new ClaudeEngine();
    this.resumeThreadId = config.resumeThreadId ?? null;
    this.resumeFeatureId = config.resumeFeatureId ?? null;
  }

  async run(input: WorkerInput): Promise<WorkerResult> {
    const prompt = this.buildPrompt(input);
    const executeWithClaude = this.shouldExecuteWithClaude(input);
    const streamTranscript: string[] = [];
    this.activeEngine = executeWithClaude ? 'claude' : 'codex';

    const result = await (executeWithClaude
      ? this.claudeEngine.execute(
        prompt,
        this.buildClaudeOptions({
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

  getActiveThreadId(): string | null {
    return this.engine.getActiveThreadId();
  }

  setResumeSession(threadId: string, featureId: string): void {
    this.resumeThreadId = threadId;
    this.resumeFeatureId = featureId;
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

  private buildPrompt(input: WorkerInput): string {
    const featureChecks = input.feature.checks?.map((check) => `- ${check.text}`).join('\n') || '- none';
    const validationCommands = [
      ...input.milestone.validationContract.staticChecks,
      ...input.milestone.validationContract.testSuites,
      ...(input.milestone.validationContract.e2eChecks ?? []),
    ]
      .map((check) => check.command)
      .filter((command): command is string => typeof command === 'string' && command.trim().length > 0)
      .join('\n');

    return [
      'You are a senior implementation worker.',
      'Implement exactly one mission feature and output a JSON report.',
      'Hard cutover mode: do not implement backward compatibility.',
      '',
      `Mission Goal: ${input.missionPlan.mission.goal}`,
      `Milestone: ${input.milestone.id} ${input.milestone.title}`,
      `Feature: ${input.feature.id} ${input.feature.description}`,
      `Branch: ${input.currentBranch ?? '(not set)'}`,
      `Base Branch: ${input.baseBranch ?? '(not set)'}`,
      '',
      'Feature checks:',
      featureChecks,
      '',
      'Manager briefing:',
      input.briefing?.trim() || '(none)',
      '',
      'PRD:',
      input.prd?.trim() || '(PRD not found)',
      '',
      'Milestone validation commands:',
      validationCommands || '(none)',
      '',
      'Output JSON schema:',
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
        checks: [],
        discoveredFeatures: [],
        learnings: [],
        requestsHelp: false,
        tokenUsage: { input: 0, output: 0, cached: 0 },
      }, null, 2),
      '',
      'Return only one fenced json block.',
    ].join('\n');
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
          report.checks = parsed.checks;
        }
        if (Array.isArray(parsed.discoveredFeatures)) {
          report.discoveredFeatures = parsed.discoveredFeatures.map((item) => ({
            description: item.description,
            priority: item.priority,
            rationale: item.rationale,
          }));
        }
        if (Array.isArray(parsed.learnings)) {
          report.learnings = parsed.learnings.filter((item): item is string => typeof item === 'string');
        }
        if (typeof parsed.requestsHelp === 'boolean') {
          report.requestsHelp = parsed.requestsHelp;
        }
        if (parsed.tokenUsage) {
          report.tokenUsage = parsed.tokenUsage;
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

    if (!report.summary) {
      report.summary = output.split(/\n/).find((line) => line.trim().length > 0)?.trim()
        || `${report.status} ${input.feature.id}`;
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
      && this.resumeFeatureId !== null
      && this.resumeFeatureId === input.feature.id;
    const threadId = shouldResume && this.resumeThreadId
      ? this.resumeThreadId
      : undefined;
    if (shouldResume) {
      this.resumeThreadId = null;
      this.resumeFeatureId = null;
    }

    return {
      cwd: this.config.cwd,
      model: this.config.model,
      reasoningEffort: this.config.reasoningEffort || 'high',
      execMode: true,
      threadId,
      onStream: callbacks.onAgentMessageDelta,
      onCommandOutput: callbacks.onCommandOutputDelta,
      onEvent: callbacks.onAppServerEvent,
    };
  }

  private buildClaudeOptions(
    callbacks: Pick<WorkerInput, 'onAgentMessageDelta' | 'onAppServerEvent'> = {}
  ): ClaudeEngineOptions {
    return {
      cwd: this.config.cwd,
      model: this.resolveClaudeModel(),
      effort: this.config.claudeEffort,
      skipPermissions: true,
      printMode: true,
      onStream: callbacks.onAgentMessageDelta,
      onEvent: callbacks.onAppServerEvent,
    };
  }

  private resolveClaudeModel(): string | undefined {
    const candidate = this.config.claudeModel;
    if (!candidate || candidate.trim().length === 0) {
      return DEFAULT_CLAUDE_MODEL;
    }
    if (candidate.toLowerCase().includes('codex')) {
      return DEFAULT_CLAUDE_MODEL;
    }
    return candidate;
  }

  private shouldExecuteWithClaude(input: WorkerInput): boolean {
    return input.feature.model === 'claude';
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
