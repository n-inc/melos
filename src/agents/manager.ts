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
  requestTimeoutMs?: number;
  suppressTerminalOutput?: boolean;
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

type DocumentLanguage = 'ja' | 'en';

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
    const preferredLanguage = detectPreferredLanguage(input.prd, input.interactiveGoal);
    const prompt = this.buildMissionPlanPrompt(input.prd, input.interactiveGoal, preferredLanguage);

    const result = await this.executeWithConfiguredEngine(prompt, this.config.effort ?? 'high', {
      onAgentMessageDelta: input.onAgentMessageDelta,
      onCommandOutputDelta: input.onCommandOutputDelta,
      onAppServerEvent: input.onAppServerEvent,
    });

    if (!result.success) {
      input.onAppServerEvent?.('manager/fallback', {
        reason: 'planner engine execution failed',
        detail: result.error ?? `exitCode=${result.exitCode}`,
      });
      return this.fallbackMissionPlan(input, preferredLanguage);
    }

    const planning = this.parsePlanningOutput(result.output);
    if (!planning) {
      input.onAppServerEvent?.('manager/fallback', {
        reason: 'planner output parse failed',
        detail: truncateMessage(result.output.replace(/\s+/g, ' ').trim(), 240),
      });
      return this.fallbackMissionPlan(input, preferredLanguage);
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

  setModel(model: string): void {
    this.config.model = model;
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

  private fallbackMissionPlan(
    input: {
    missionId: string;
    prd: string | null;
    interactiveGoal?: string;
    approvalMethod?: 'auto' | 'interactive';
    prdFile?: string;
    },
    preferredLanguage: DocumentLanguage
  ): MissionPlan {
    const localized = preferredLanguage === 'ja'
      ? {
        fallbackGoal: 'PRDの要件を実装する',
        constraint: '後方互換レイヤーを実装しない',
        success: 'すべてのマイルストーン検証を通過する',
        milestoneTitle: 'コア実装',
        milestoneDescription: 'PRD の要求をエンドツーエンドで実装する',
        typecheckDescription: 'Typecheck を通過する',
        testDescription: 'テストスイートを通過する',
        featureDescription: 'PRD の要求スコープを実装する',
      }
      : {
        fallbackGoal: 'Implement the requested product changes',
        constraint: 'No backward compatibility layer',
        success: 'All milestone validations pass',
        milestoneTitle: 'Core implementation',
        milestoneDescription: 'Implement the mission scope end-to-end',
        typecheckDescription: 'Typecheck must pass',
        testDescription: 'Test suite must pass',
        featureDescription: 'Implement requested scope from PRD',
      };

    const goal = input.interactiveGoal?.trim()
      || extractGoalFromPrd(input.prd)
      || localized.fallbackGoal;

    return createMissionPlan({
      missionId: input.missionId,
      goal,
      constraints: [localized.constraint],
      successCriteria: [localized.success],
      prdFile: input.prdFile,
      approvalMethod: input.approvalMethod,
      state: 'planning',
      milestones: [
        {
          id: 'm1',
          title: localized.milestoneTitle,
          description: localized.milestoneDescription,
          status: 'pending',
          order: 1,
          validationContract: {
            ...createEmptyValidationContract(),
            staticChecks: [
              {
                id: 'typecheck',
                description: localized.typecheckDescription,
                type: 'auto:typecheck',
                command: 'npm run typecheck',
                passed: false,
                failureCount: 0,
              },
            ],
            testSuites: [
              {
                id: 'test',
                description: localized.testDescription,
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
              description: localized.featureDescription,
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
        description: normalizeFeatureDescription(feature.description),
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

  private buildMissionPlanPrompt(
    prd: string | null,
    interactiveGoal?: string,
    preferredLanguage: DocumentLanguage = detectPreferredLanguage(prd, interactiveGoal)
  ): string {
    const languageLabel = preferredLanguage === 'ja' ? 'Japanese' : 'English';
    return [
      'You are an expert technical planner.',
      'Create a MissionPlan JSON for a coding mission.',
      'Hard cutover mode: do not include backward compatibility tasks.',
      `All natural language fields must be written in ${languageLabel}.`,
      '',
      'Return only valid JSON. Do not add prose outside JSON.',
      'Wrap output exactly with markers:',
      'BEGIN_MISSION_PLAN_JSON',
      '{"goal":"...","constraints":["..."],"successCriteria":["..."],"milestones":[{"id":"m1","title":"...","description":"...","validationContract":{"staticChecks":[{"id":"...","description":"...","type":"auto:typecheck","command":"..."}],"testSuites":[{"id":"...","description":"...","type":"auto:test","command":"..."}],"e2eChecks":[],"manualSteps":[]},"features":[{"id":"m1-f1","description":"...","model":"codex"}]}]}',
      'END_MISSION_PLAN_JSON',
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
    const candidates = extractJsonCandidates(output);
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        const normalized = normalizePlanningOutput(parsed);
        if (normalized) {
          return normalized;
        }
      } catch {
        // try next candidate
      }
    }
    return null;
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
        timeout: this.config.requestTimeoutMs ?? 180_000,
        model: this.config.model,
        reasoningEffort: this.mapEffortForCodex(effort),
        execMode: true,
        suppressTerminalOutput: this.config.suppressTerminalOutput === true,
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
      timeout: this.config.requestTimeoutMs ?? 180_000,
      model: this.config.model,
      effort,
      skipPermissions: true,
      printMode: true,
      suppressTerminalOutput: this.config.suppressTerminalOutput === true,
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
  const normalized = normalizeFeatureDescription(description).toLowerCase();
  if (normalized.includes('ui') || normalized.includes('design') || normalized.includes('layout') || normalized.includes('style')) {
    return 'claude';
  }
  return 'codex';
}

function normalizeFeatureDescription(description: unknown): string {
  if (typeof description !== 'string') {
    return 'No description provided';
  }
  const trimmed = description.trim();
  return trimmed.length > 0 ? trimmed : 'No description provided';
}

function extractGoalFromPrd(prd: string | null): string | null {
  if (!prd) {
    return null;
  }

  const lines = prd.split(/\r?\n/);
  const firstHeading = lines.find((line) => /^\s{0,3}#{1,6}\s+\S/.test(line));
  if (firstHeading) {
    const title = firstHeading.replace(/^\s{0,3}#{1,6}\s+/, '').trim();
    if (title.length > 0) {
      return truncateMessage(title, 160);
    }
  }

  const firstText = lines.find((line) => line.trim().length > 0);
  if (!firstText) {
    return null;
  }

  const normalized = firstText
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .trim();
  return normalized.length > 0 ? truncateMessage(normalized, 160) : null;
}

function detectPreferredLanguage(prd: string | null, interactiveGoal?: string): DocumentLanguage {
  const source = `${interactiveGoal ?? ''}\n${prd ?? ''}`;
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(source) ? 'ja' : 'en';
}

function extractJsonCandidates(output: string): string[] {
  const candidates: string[] = [];
  const pushCandidate = (value: string | undefined): void => {
    if (!value) {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    if (!candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  const markerMatch = output.match(/BEGIN_MISSION_PLAN_JSON([\s\S]*?)END_MISSION_PLAN_JSON/);
  pushCandidate(markerMatch?.[1]);

  const fencedRegex = /```json\s*\n([\s\S]*?)\n```/g;
  for (const match of output.matchAll(fencedRegex)) {
    pushCandidate(match[1]);
  }

  for (const block of extractBalancedJsonObjects(output, 12)) {
    pushCandidate(block);
  }

  return candidates;
}

function extractBalancedJsonObjects(source: string, maxCount: number): string[] {
  const blocks: string[] = [];
  let start = source.indexOf('{');
  while (start >= 0 && blocks.length < maxCount) {
    const end = findMatchingBraceIndex(source, start);
    if (end > start) {
      blocks.push(source.slice(start, end + 1));
    }
    start = source.indexOf('{', start + 1);
  }
  return blocks;
}

function findMatchingBraceIndex(source: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (!ch) {
      continue;
    }
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === '\\') {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function normalizePlanningOutput(value: unknown): MissionPlanningOutput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const root = value as Record<string, unknown>;
  const goal = toNonEmptyString(root.goal);
  const constraints = toStringArray(root.constraints);
  const successCriteria = toStringArray(root.successCriteria);
  const rawMilestones = Array.isArray(root.milestones) ? root.milestones : [];

  if (!goal || rawMilestones.length === 0) {
    return null;
  }

  const milestones = rawMilestones
    .map((rawMilestone, milestoneIndex) => normalizePlanningMilestone(rawMilestone, milestoneIndex))
    .filter((milestone): milestone is MissionPlanningOutput['milestones'][number] => milestone !== null);

  if (milestones.length === 0) {
    return null;
  }

  return {
    goal,
    constraints: constraints.length > 0 ? constraints : ['No backward compatibility'],
    successCriteria: successCriteria.length > 0 ? successCriteria : ['All validations pass'],
    milestones,
  };
}

function normalizePlanningMilestone(
  value: unknown,
  milestoneIndex: number
): MissionPlanningOutput['milestones'][number] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const milestone = value as Record<string, unknown>;
  const title = toNonEmptyString(milestone.title) ?? `Milestone ${milestoneIndex + 1}`;
  const description = toNonEmptyString(milestone.description) ?? `Implement milestone ${milestoneIndex + 1}`;
  const rawFeatures = Array.isArray(milestone.features) ? milestone.features : [];
  if (rawFeatures.length === 0) {
    return null;
  }

  const features = rawFeatures
    .map((rawFeature, featureIndex) => normalizePlanningFeature(rawFeature, milestoneIndex, featureIndex))
    .filter((feature): feature is MissionPlanningOutput['milestones'][number]['features'][number] => feature !== null);
  if (features.length === 0) {
    return null;
  }

  return {
    id: toNonEmptyString(milestone.id) ?? undefined,
    title,
    description,
    validationContract: normalizeValidationContract(milestone.validationContract),
    features,
  };
}

function normalizePlanningFeature(
  value: unknown,
  _milestoneIndex: number,
  _featureIndex: number
): MissionPlanningOutput['milestones'][number]['features'][number] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const feature = value as Record<string, unknown>;
  const description = toNonEmptyString(feature.description) ?? 'No description provided';
  const model = toNonEmptyString(feature.model);
  return {
    id: toNonEmptyString(feature.id) ?? undefined,
    description,
    model: model === 'claude' ? 'claude' : 'codex',
    checks: normalizePlanningFeatureChecks(feature.checks),
  };
}

function normalizePlanningFeatureChecks(value: unknown): Array<{ text: string; type?: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const checks: Array<{ text: string; type?: string }> = [];
  for (const check of value) {
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      continue;
    }
    const record = check as Record<string, unknown>;
    const text = toNonEmptyString(record.text);
    if (!text) {
      continue;
    }
    const type = toNonEmptyString(record.type);
    checks.push(type ? { text, type } : { text });
  }
  return checks.length > 0 ? checks : undefined;
}

function normalizeValidationContract(value: unknown): MissionPlanningOutput['milestones'][number]['validationContract'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const contract = value as Record<string, unknown>;
  return {
    staticChecks: normalizeValidationChecks(contract.staticChecks),
    testSuites: normalizeValidationChecks(contract.testSuites),
    e2eChecks: normalizeValidationChecks(contract.e2eChecks),
    manualSteps: normalizeValidationChecks(contract.manualSteps),
  };
}

function normalizeValidationChecks(
  value: unknown
): Array<{ id: string; description: string; command?: string; type?: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const checks: Array<{ id: string; description: string; command?: string; type?: string }> = [];
  value.forEach((check, index) => {
    if (!check || typeof check !== 'object' || Array.isArray(check)) {
      return;
    }
    const record = check as Record<string, unknown>;
    const description = toNonEmptyString(record.description);
    if (!description) {
      return;
    }
    const id = toNonEmptyString(record.id) ?? `check-${index + 1}`;
    const type = toNonEmptyString(record.type);
    const command = toNonEmptyString(record.command);
    checks.push({
      id,
      description,
      type: type ?? undefined,
      command: command ?? undefined,
    });
  });
  return checks.length > 0 ? checks : undefined;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => toNonEmptyString(item))
    .filter((item): item is string => item !== null);
}

function truncateMessage(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
