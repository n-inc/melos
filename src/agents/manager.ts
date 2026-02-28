import { ClaudeEngine, type ClaudeEngineOptions } from '../engines/claude.js';
import {
  AppServerEngine,
  type AppServerEngineOptions,
} from '../engines/app-server.js';
import type { EngineResult } from '../engines/base.js';
import type { MissionPlan } from '../state/mission.js';
import {
  createMissionPlan,
} from '../state/mission.js';
import type { ValidationCheckResult } from '../state/validation.js';
import {
  createEmptyValidationContract,
} from '../state/validation.js';
import type { CheckType } from '../state/validation.js';
import type {
  Agent,
  AgentMode,
  FollowUpFeatureDraft,
  ManagerInput,
  SteerResult,
} from './types.js';

export interface ManagerAgentConfig {
  cwd: string;
  promptsDir: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  resumeThreadId?: string;
}

const CODEX_MODEL_PATTERN = /codex/i;

interface MissionPlanningOutput {
  goal: string;
  constraints: string[];
  successCriteria: string[];
  milestones: Array<{
    id?: string;
    title: string;
    description: string;
    validationContract?: {
      staticChecks?: Array<{ id: string; description: string; command?: string; type?: string }>;
      testSuites?: Array<{ id: string; description: string; command?: string; type?: string }>;
      e2eChecks?: Array<{ id: string; description: string; command?: string; type?: string }>;
      manualSteps?: Array<{ id: string; description: string; command?: string; type?: string }>;
    };
    features: Array<{
      id?: string;
      description: string;
      model?: 'claude' | 'codex';
      checks?: Array<{ text: string; type?: string }>;
    }>;
  }>;
}

export class ManagerAgent implements Agent {
  readonly name = 'manager';
  readonly mode: AgentMode = 'manager';

  private claudeEngine: ClaudeEngine;
  private codexEngine: AppServerEngine;
  private config: ManagerAgentConfig;
  private activeEngine: 'codex' | 'claude' | null = null;
  private resumeThreadId: string | null;

  constructor(config: ManagerAgentConfig) {
    this.config = config;
    this.claudeEngine = new ClaudeEngine();
    this.codexEngine = new AppServerEngine();
    this.resumeThreadId = config.resumeThreadId ?? null;
  }

  async generateMissionPlan(input: {
    missionId: string;
    prd: string | null;
    interactiveGoal?: string;
    approvalMethod?: 'auto' | 'interactive';
    prdFile?: string;
    onAgentMessageDelta?: (chunk: string) => void;
    onCommandOutputDelta?: (chunk: string) => void;
    onAppServerEvent?: (method: string, params: unknown) => void;
  }): Promise<MissionPlan> {
    const prompt = this.buildMissionPlanPrompt(input.prd, input.interactiveGoal);

    const result = await this.executeWithConfiguredEngine(prompt, this.config.effort ?? 'high', {
      onAgentMessageDelta: input.onAgentMessageDelta,
      onCommandOutputDelta: input.onCommandOutputDelta,
      onAppServerEvent: input.onAppServerEvent,
    });

    if (!result.success) {
      return this.fallbackMissionPlan(input);
    }

    const planning = this.parsePlanningOutput(result.output);
    if (!planning) {
      return this.fallbackMissionPlan(input);
    }

    return this.toMissionPlan(planning, input);
  }

  async generateFeatureBriefing(input: ManagerInput): Promise<string | undefined> {
    const milestone = input.activeMilestone;
    const feature = input.activeFeature;
    if (!milestone || !feature) {
      return undefined;
    }

    const prompt = [
      'You are a technical planning manager.',
      'Provide a concise implementation briefing in Japanese for the next feature.',
      '',
      `Mission Goal: ${input.missionPlan.mission.goal}`,
      `Milestone: ${milestone.id} ${milestone.title}`,
      `Feature: ${feature.id} ${feature.description}`,
      `Feature Attempts: ${feature.attempts}`,
      '',
      'Output only markdown with these sections:',
      '## Objective',
      '## Constraints',
      '## Validation focus',
      '## Risks',
    ].join('\n');

    const result = await this.executeWithConfiguredEngine(prompt, 'medium', {
      onAgentMessageDelta: input.onAgentMessageDelta,
      onCommandOutputDelta: input.onCommandOutputDelta,
      onAppServerEvent: input.onAppServerEvent,
    });

    if (!result.success) {
      return undefined;
    }

    const text = result.output.trim();
    return text.length > 0 ? text : undefined;
  }

  async generateFollowUpFeatures(input: {
    milestoneId: string;
    failures: ValidationCheckResult[];
    missionPlan: MissionPlan;
    onAgentMessageDelta?: (chunk: string) => void;
    onCommandOutputDelta?: (chunk: string) => void;
    onAppServerEvent?: (method: string, params: unknown) => void;
  }): Promise<FollowUpFeatureDraft[]> {
    const failedChecks = input.failures.filter((result) => !result.passed);
    if (failedChecks.length === 0) {
      return [];
    }

    const prompt = [
      'You are a technical manager.',
      'Generate follow-up features to repair failed milestone validation.',
      'Return JSON array only.',
      '',
      `Milestone ID: ${input.milestoneId}`,
      'Failed checks:',
      JSON.stringify(failedChecks, null, 2),
      '',
      'Schema:',
      '[{"description":"...","priority":"high|medium|low","rationale":"...","model":"claude|codex"}]',
    ].join('\n');

    const result = await this.executeWithConfiguredEngine(prompt, 'high', {
      onAgentMessageDelta: input.onAgentMessageDelta,
      onCommandOutputDelta: input.onCommandOutputDelta,
      onAppServerEvent: input.onAppServerEvent,
    });

    if (!result.success) {
      return this.fallbackFollowUpFeatures(failedChecks);
    }

    const parsed = this.parseJsonArray(result.output);
    if (!parsed) {
      return this.fallbackFollowUpFeatures(failedChecks);
    }

    const drafts: FollowUpFeatureDraft[] = [];
    for (const candidate of parsed) {
      if (!candidate || typeof candidate !== 'object') {
        continue;
      }
      const description = String((candidate as { description?: unknown }).description ?? '').trim();
      if (!description) {
        continue;
      }
      const priority = String((candidate as { priority?: unknown }).priority ?? 'medium').toLowerCase();
      drafts.push({
        description,
        priority: priority === 'high' || priority === 'low' ? priority : 'medium',
        rationale: String((candidate as { rationale?: unknown }).rationale ?? '').trim() || undefined,
        model: (candidate as { model?: unknown }).model === 'claude' ? 'claude' : 'codex',
      });
    }

    if (drafts.length === 0) {
      return this.fallbackFollowUpFeatures(failedChecks);
    }

    return drafts;
  }

  abort(): void {
    this.claudeEngine.abort();
    this.codexEngine.abort();
  }

  getActiveThreadId(): string | null {
    return this.codexEngine.getActiveThreadId();
  }

  async steer(instruction: string): Promise<SteerResult> {
    if (this.activeEngine === null) {
      return 'unavailable';
    }
    if (this.activeEngine === 'claude') {
      return 'unsupported';
    }

    const accepted = await this.codexEngine.steer(instruction);
    return accepted ? 'accepted' : 'unavailable';
  }

  private fallbackMissionPlan(input: {
    missionId: string;
    prd: string | null;
    interactiveGoal?: string;
    approvalMethod?: 'auto' | 'interactive';
    prdFile?: string;
  }): MissionPlan {
    const goal = input.interactiveGoal?.trim()
      || extractGoalFromPrd(input.prd)
      || 'Implement the requested product changes';

    return createMissionPlan({
      missionId: input.missionId,
      goal,
      constraints: ['No backward compatibility layer'],
      successCriteria: ['All milestone validations pass'],
      prdFile: input.prdFile,
      approvalMethod: input.approvalMethod,
      state: 'planning',
      milestones: [
        {
          id: 'm1',
          title: 'Core implementation',
          description: 'Implement the mission scope end-to-end',
          status: 'pending',
          order: 1,
          validationContract: {
            ...createEmptyValidationContract(),
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
                description: 'Test suite must pass',
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
              description: 'Implement requested scope from PRD',
              status: 'pending',
              model: 'codex',
              attempts: 0,
            },
          ],
        },
      ],
    });
  }

  private toMissionPlan(
    planning: MissionPlanningOutput,
    input: {
      missionId: string;
      approvalMethod?: 'auto' | 'interactive';
      prdFile?: string;
    }
  ): MissionPlan {
    const milestones = planning.milestones.map((milestone, milestoneIndex) => ({
      id: milestone.id?.trim() || `m${milestoneIndex + 1}`,
      title: milestone.title,
      description: milestone.description,
      status: 'pending' as const,
      order: milestoneIndex + 1,
      validationContract: {
        staticChecks: (milestone.validationContract?.staticChecks ?? []).map((check, index) => ({
          id: check.id || `m${milestoneIndex + 1}-static-${index + 1}`,
          description: check.description,
          type: normalizeCheckType(check.type, 'command'),
          command: check.command,
          passed: false,
          failureCount: 0,
        })),
        testSuites: (milestone.validationContract?.testSuites ?? []).map((check, index) => ({
          id: check.id || `m${milestoneIndex + 1}-test-${index + 1}`,
          description: check.description,
          type: normalizeCheckType(check.type, 'auto:test'),
          command: check.command,
          passed: false,
          failureCount: 0,
        })),
        e2eChecks: (milestone.validationContract?.e2eChecks ?? []).map((check, index) => ({
          id: check.id || `m${milestoneIndex + 1}-e2e-${index + 1}`,
          description: check.description,
          type: normalizeCheckType(check.type, 'e2e'),
          command: check.command,
          passed: false,
          failureCount: 0,
        })),
        manualSteps: (milestone.validationContract?.manualSteps ?? []).map((check, index) => ({
          id: check.id || `m${milestoneIndex + 1}-manual-${index + 1}`,
          description: check.description,
          type: normalizeCheckType(check.type, 'manual'),
          command: check.command,
          passed: false,
          failureCount: 0,
        })),
      },
      features: milestone.features.map((feature, featureIndex) => ({
        id: feature.id?.trim() || `m${milestoneIndex + 1}-f${featureIndex + 1}`,
        description: feature.description,
        checks: feature.checks?.map((check) => ({ text: check.text, type: check.type, passed: false })),
        status: 'pending' as const,
        model: feature.model ?? inferFeatureModel(feature.description),
        attempts: 0,
      })),
    }));

    return createMissionPlan({
      missionId: input.missionId,
      goal: planning.goal,
      constraints: planning.constraints,
      successCriteria: planning.successCriteria,
      prdFile: input.prdFile,
      milestones,
      state: 'planning',
      approvalMethod: input.approvalMethod,
    });
  }

  private buildMissionPlanPrompt(prd: string | null, interactiveGoal?: string): string {
    return [
      'You are an expert technical planner.',
      'Create a MissionPlan JSON for a coding mission.',
      'Hard cutover mode: do not include backward compatibility tasks.',
      '',
      'Output schema:',
      '{"goal":"...","constraints":["..."],"successCriteria":["..."],"milestones":[{"id":"m1","title":"...","description":"...","validationContract":{"staticChecks":[{"id":"...","description":"...","type":"auto:typecheck","command":"..."}],"testSuites":[{"id":"...","description":"...","type":"auto:test","command":"..."}],"e2eChecks":[],"manualSteps":[]},"features":[{"id":"m1-f1","description":"...","model":"codex"}]}]}',
      '',
      'Constraints:',
      '- Provide at least 3 milestones when possible',
      '- Each milestone requires validationContract with executable commands where possible',
      '- Feature IDs must follow mX-fY',
      '',
      'User stated goal:',
      interactiveGoal?.trim() || '(not provided)',
      '',
      'PRD content:',
      prd?.trim() || '(PRD not found)',
    ].join('\n');
  }

  private parsePlanningOutput(output: string): MissionPlanningOutput | null {
    const block = this.extractFirstJsonObject(output);
    if (!block) {
      return null;
    }

    try {
      const parsed = JSON.parse(block) as MissionPlanningOutput;
      if (!parsed.goal || !Array.isArray(parsed.milestones) || parsed.milestones.length === 0) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private parseJsonArray(output: string): unknown[] | null {
    const fenced = output.match(/```json\s*\n([\s\S]*?)\n```/);
    const source = fenced?.[1] ?? output;
    const arrayMatch = source.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      return null;
    }
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private extractFirstJsonObject(output: string): string | null {
    const fenced = output.match(/```json\s*\n([\s\S]*?)\n```/);
    if (fenced?.[1]) {
      return fenced[1];
    }

    const objectMatch = output.match(/\{[\s\S]*\}/);
    return objectMatch?.[0] ?? null;
  }

  private fallbackFollowUpFeatures(failures: ValidationCheckResult[]): FollowUpFeatureDraft[] {
    return failures.slice(0, 3).map((failure, index) => ({
      description: failure.failure?.summary
        ?? `Fix validation failure: ${failure.checkId}`,
      priority: index === 0 ? 'high' : 'medium',
      rationale: failure.failure?.rootCause,
      model: 'codex',
    }));
  }

  private executeWithConfiguredEngine(
    prompt: string,
    effort: NonNullable<ManagerAgentConfig['effort']>,
    callbacks: {
      onAgentMessageDelta?: (chunk: string) => void;
      onCommandOutputDelta?: (chunk: string) => void;
      onAppServerEvent?: (method: string, params: unknown) => void;
    } = {}
  ): Promise<EngineResult> {
    if (this.shouldUseCodexEngine(this.config.model)) {
      this.activeEngine = 'codex';
      const threadId = this.resumeThreadId ?? undefined;
      if (threadId) {
        this.resumeThreadId = null;
      }
      const options: AppServerEngineOptions = {
        cwd: this.config.cwd,
        model: this.config.model,
        reasoningEffort: this.mapEffortForCodex(effort),
        execMode: true,
        threadId,
        onStream: callbacks.onAgentMessageDelta,
        onCommandOutput: callbacks.onCommandOutputDelta,
        onEvent: callbacks.onAppServerEvent,
      };
      return this.codexEngine.execute(prompt, options).finally(() => {
        this.activeEngine = null;
      });
    }

    this.activeEngine = 'claude';
    const options: ClaudeEngineOptions = {
      cwd: this.config.cwd,
      model: this.config.model,
      effort,
      skipPermissions: true,
      printMode: true,
      onStream: callbacks.onAgentMessageDelta,
      onEvent: callbacks.onAppServerEvent,
    };
    return this.claudeEngine.execute(prompt, options).finally(() => {
      this.activeEngine = null;
    });
  }

  private shouldUseCodexEngine(model: string | undefined): boolean {
    if (typeof model !== 'string' || model.trim().length === 0) {
      return true;
    }
    return CODEX_MODEL_PATTERN.test(model);
  }

  private mapEffortForCodex(
    effort: NonNullable<ManagerAgentConfig['effort']>
  ): NonNullable<AppServerEngineOptions['reasoningEffort']> {
    if (effort === 'max') {
      return 'xhigh';
    }
    return effort;
  }
}

function normalizeCheckType(
  value: string | undefined,
  fallback: 'command' | 'auto:test' | 'e2e' | 'manual'
): CheckType {
  if (!value) {
    return fallback;
  }
  if (value === 'auto:lint' || value === 'auto:typecheck' || value === 'auto:test' || value === 'e2e' || value === 'manual' || value === 'command') {
    return value;
  }
  return fallback;
}

function inferFeatureModel(description: string): 'claude' | 'codex' {
  const normalized = description.toLowerCase();
  if (normalized.includes('ui') || normalized.includes('design') || normalized.includes('layout') || normalized.includes('style')) {
    return 'claude';
  }
  return 'codex';
}

function extractGoalFromPrd(prd: string | null): string | null {
  if (!prd) {
    return null;
  }

  const firstHeading = prd.split(/\r?\n/).find((line) => line.startsWith('# '));
  if (!firstHeading) {
    return null;
  }

  const title = firstHeading.replace(/^#\s+/, '').trim();
  return title.length > 0 ? title : null;
}
