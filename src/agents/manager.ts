import { existsSync } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { ClaudeEngine, type ClaudeEngineOptions } from '../engines/claude.js';
import {
  AppServerEngine,
  type AppServerEngineOptions,
} from '../engines/app-server.js';
import type { EngineResult } from '../engines/base.js';
import type { MissionPlan } from '../state/mission.js';
import {
  createMissionPlan,
  ensurePullRequestFollowUpMilestone,
} from '../state/mission.js';
import type { ProductReviewContract, ReviewFinding, ReviewType } from '../state/review.js';
import { normalizeProductReviewContract } from '../state/review.js';
import type { ValidationArtifact, ValidationCheckResult, ValidationRunner } from '../state/validation.js';
import {
  createEmptyValidationContract,
} from '../state/validation.js';
import type { CheckType } from '../state/validation.js';
import {
  CLAUDE_LATEST_ALIAS,
  CODEX_LATEST_ALIAS,
  isClaudeFamily,
  isCodexFamily,
  normalizeModelName,
  resolveRuntimeModel,
} from '../models/registry.js';
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
  pullRequestAutomationEnabled?: boolean;
}

export class MissionPlanningError extends Error {
  readonly reason: string;
  readonly detail: string;
  readonly outputPreview?: string;

  constructor(params: { reason: string; detail: string; outputPreview?: string }) {
    super(params.detail);
    this.name = 'MissionPlanningError';
    this.reason = params.reason;
    this.detail = params.detail;
    this.outputPreview = params.outputPreview;
  }
}

const CODEBASE_CONTEXT_MAX_LINES = 32;
const PLANNING_PROMPT_MAX_CHARS = 220_000;
const PLANNING_CONTEXT_SECTION_MAX_CHARS = 80_000;
const PLANNING_REVIEWED_FILES_MAX_COUNT = 160;
const PLANNING_REVIEWED_FILES_MAX_CHARS = 12_000;
const PLANNING_CONFIG_FILES = [
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'vite.config.ts',
  'vite.config.js',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'astro.config.mjs',
  'nuxt.config.ts',
  'README.md',
] as const;
const PLANNING_ENTRYPOINT_PATTERNS = [
  'src/index.',
  'src/main.',
  'src/app.',
  'src/server.',
  'src/routes.',
  'app/page.',
  'app/layout.',
  'pages/index.',
  'pages/_app.',
  'pages/api/',
] as const;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.melos',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
]);
const BINARY_FILE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.bmp',
  '.tiff',
  '.mp4',
  '.m4v',
  '.mov',
  '.avi',
  '.webm',
  '.mkv',
  '.m4s',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.tar',
  '.7z',
  '.rar',
  '.dmg',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  '.gem',
  '.jar',
  '.wasm',
  '.psd',
  '.sketch',
  '.ai',
  '.eps',
  '.sqlite',
  '.db',
  '.bin',
]);

interface MissionPlanningOutput {
  goal: string;
  constraints: string[];
  successCriteria: string[];
  productReviewContract?: {
    cwd?: string;
    target?: string;
    startup?: Array<{ cwd?: string; command?: string } | string>;
    preconditions?: string[];
    checkpoints?: Array<{ id?: string; description?: string; claim?: string; visual?: boolean } | string>;
    artifactsDir?: string;
    video?: boolean;
  };
  milestones: Array<{
    id?: string;
    title: string;
    description: string;
    validationContract?: {
      staticChecks?: Array<{ id: string; description: string; command?: string; type?: string }>;
      testSuites?: Array<{ id: string; description: string; command?: string; type?: string }>;
      qaChecks?: Array<{
        id: string;
        description: string;
        command?: string;
        type?: string;
        requiredRunner?: string;
        requiredArtifacts?: string[];
      }>;
    };
    features: Array<{
      id?: string;
      description: string;
      model?: string;
      cwd?: string;
      checks?: Array<{ text: string; type?: string }>;
    }>;
  }>;
}

type DocumentLanguage = 'ja' | 'en';
interface LocalizedFallbackTemplate {
  fallbackGoal: string;
  defaultConstraint: string;
  defaultSuccess: string;
  milestoneTitlePrefix: string;
  milestoneDescriptionPrefix: string;
  typecheckDescription: string;
  testDescription: string;
  featureFallbackDescription: string;
}

interface PlanningCodebaseContext {
  summary: string;
  reviewedFiles: string[];
}

const MAX_MILESTONES_PER_PLAN = 3;
const MAX_FEATURES_PER_MILESTONE = 5;

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
    fallbackOnFailure?: boolean;
    approvalMethod?: 'auto' | 'interactive';
    prdFile?: string;
    onAgentMessageDelta?: (chunk: string) => void;
    onCommandOutputDelta?: (chunk: string) => void;
    onAppServerEvent?: (method: string, params: unknown) => void;
  }): Promise<MissionPlan> {
    const preferredLanguage = detectPreferredLanguage(input.prd, input.interactiveGoal);
    const codebaseContext = await buildPlanningCodebaseContext(
      this.config.cwd,
      input.prd,
      input.interactiveGoal
    );
    for (const file of codebaseContext.reviewedFiles) {
      input.onAppServerEvent?.('item/started', {
        item: {
          type: 'fileRead',
          filePath: file,
          limit: CODEBASE_CONTEXT_MAX_LINES,
        },
      });
    }
    const prompt = this.buildMissionPlanPrompt(
      input.prd,
      input.interactiveGoal,
      preferredLanguage,
      codebaseContext.summary,
      codebaseContext.reviewedFiles
    );
    const planningTimeoutMs = Math.max(300_000, this.config.requestTimeoutMs ?? 180_000);

    const result = await this.executeWithConfiguredEngine(
      prompt,
      this.config.effort ?? 'high',
      {
        onAgentMessageDelta: input.onAgentMessageDelta,
        onCommandOutputDelta: input.onCommandOutputDelta,
        onAppServerEvent: input.onAppServerEvent,
      },
      { timeoutMs: planningTimeoutMs }
    );

    if (!result.success) {
      const outputPreview = summarizePlannerOutput(result.output);
      if (input.fallbackOnFailure === false) {
        throw new MissionPlanningError({
          reason: 'planner engine execution failed',
          detail: buildPlannerFailureDetail(
            result.error ?? `exitCode=${result.exitCode}`,
            outputPreview
          ),
          outputPreview,
        });
      }
      input.onAppServerEvent?.('manager/fallback', {
        reason: 'planner engine execution failed',
        detail: buildPlannerFailureDetail(
          result.error ?? `exitCode=${result.exitCode}`,
          outputPreview
        ),
        error: result.error ?? `exitCode=${result.exitCode}`,
        outputPreview,
      });
      return this.fallbackMissionPlan(input, preferredLanguage);
    }

    const planning = this.parsePlanningOutput(result.output);
    if (!planning) {
      const outputPreview = summarizePlannerOutput(result.output);
      if (input.fallbackOnFailure === false) {
        throw new MissionPlanningError({
          reason: 'planner output parse failed',
          detail: outputPreview ?? 'planner output parse failed',
          outputPreview,
        });
      }
      input.onAppServerEvent?.('manager/fallback', {
        reason: 'planner output parse failed',
        detail: outputPreview,
        outputPreview,
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
    return buildFeatureBriefing(input);
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
      'Group failures by root cause. Merge checks that should be fixed together into the same follow-up.',
      'Prefer reusing the same tracking key for the same root cause.',
      'Return JSON array only.',
      '',
      `Milestone ID: ${input.milestoneId}`,
      'Failed checks:',
      JSON.stringify(failedChecks, null, 2),
      '',
      'Schema:',
      '[{"description":"...","trackingKey":"stable-root-cause-key","priority":"high|medium|low","affectedChecks":["check-id"],"rationale":"...","model":"codex-latest|claude-latest|explicit-model"}]',
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

    const drafts = normalizeFollowUpDrafts(parsed, failedChecks);

    if (drafts.length === 0) {
      return this.fallbackFollowUpFeatures(failedChecks);
    }

    return drafts;
  }

  async generateImplementationFollowUpFeatures(input: {
    milestoneId: string;
    featureId: string;
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
      'Generate remediation implementation features after a worker execution exhausted its retry budget.',
      'Group failures by root cause. Merge failures that should be fixed together into the same feature.',
      'Prefer reusing the same tracking key for the same root cause.',
      'Return JSON array only.',
      '',
      `Milestone ID: ${input.milestoneId}`,
      `Feature ID: ${input.featureId}`,
      'Execution failures:',
      JSON.stringify(failedChecks, null, 2),
      '',
      'Schema:',
      '[{"description":"...","trackingKey":"stable-root-cause-key","priority":"high|medium|low","affectedChecks":["check-id"],"rationale":"...","model":"codex-latest|claude-latest|explicit-model"}]',
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

    const drafts = normalizeFollowUpDrafts(parsed, failedChecks);
    if (drafts.length === 0) {
      return this.fallbackFollowUpFeatures(failedChecks);
    }

    return drafts;
  }

  async generateReviewFollowUpFeatures(input: {
    milestoneId: string;
    reviewType: ReviewType;
    generation: number;
    findings: ReviewFinding[];
    missionPlan: MissionPlan;
    onAgentMessageDelta?: (chunk: string) => void;
    onCommandOutputDelta?: (chunk: string) => void;
    onAppServerEvent?: (method: string, params: unknown) => void;
  }): Promise<FollowUpFeatureDraft[]> {
    if (input.findings.length === 0) {
      return [];
    }

    const prompt = [
      'You are a technical manager.',
      `Generate grouped remediation features for a failed ${input.reviewType} final review.`,
      'Group related findings by root cause or surface area.',
      'Do not create review tasks. Create only implementation/remediation features.',
      'Use a small number of meaningful features instead of one feature per finding.',
      'Return JSON array only.',
      '',
      `Milestone ID: ${input.milestoneId}`,
      `Review generation: ${input.generation}`,
      'Findings:',
      JSON.stringify(input.findings, null, 2),
      '',
      'Schema:',
      '[{"description":"...","trackingKey":"stable-root-cause-key","priority":"high|medium|low","rationale":"...","model":"codex-latest|claude-latest|explicit-model"}]',
    ].join('\n');

    const result = await this.executeWithConfiguredEngine(prompt, 'high', {
      onAgentMessageDelta: input.onAgentMessageDelta,
      onCommandOutputDelta: input.onCommandOutputDelta,
      onAppServerEvent: input.onAppServerEvent,
    });

    if (!result.success) {
      return fallbackReviewFollowUpFeatures(input.findings);
    }

    const parsed = this.parseJsonArray(result.output);
    if (!parsed) {
      return fallbackReviewFollowUpFeatures(input.findings);
    }

    const drafts = normalizeReviewFollowUpDrafts(parsed, input.findings);
    if (drafts.length === 0) {
      return fallbackReviewFollowUpFeatures(input.findings);
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
    const localized = buildLocalizedFallbackTemplate(preferredLanguage);
    const derived = deriveFallbackPlanFromPrd(input.prd, localized);

    const goal = input.interactiveGoal?.trim()
      || extractGoalFromPrd(input.prd)
      || localized.fallbackGoal;
    const constraints = derived?.constraints.length
      ? derived.constraints
      : [localized.defaultConstraint];
    const successCriteria = derived?.successCriteria.length
      ? derived.successCriteria
      : [localized.defaultSuccess];
    const milestones = (derived?.milestones.length ? derived.milestones : [{
      title: `${localized.milestoneTitlePrefix} 1`,
      description: `${localized.milestoneDescriptionPrefix} 1`,
      features: [localized.featureFallbackDescription],
    }]).map((milestone, milestoneIndex) => ({
      id: `m${milestoneIndex + 1}`,
      title: milestone.title,
      description: milestone.description,
      status: 'pending' as const,
      validationContract: {
        ...createEmptyValidationContract(),
        staticChecks: [
          {
            id: `m${milestoneIndex + 1}-typecheck`,
            description: localized.typecheckDescription,
            type: 'auto:typecheck' as const,
            command: 'npm run typecheck',
            passed: false,
            failureCount: 0,
          },
        ],
        testSuites: [
          {
            id: `m${milestoneIndex + 1}-test`,
            description: localized.testDescription,
            type: 'auto:test' as const,
            command: 'npm test',
            passed: false,
            failureCount: 0,
          },
        ],
      },
      features: milestone.features.map((featureDescription, featureIndex) => ({
        id: `m${milestoneIndex + 1}-f${featureIndex + 1}`,
        description: featureDescription,
        kind: 'implementation' as const,
        status: 'pending' as const,
        model: inferFeatureModel(featureDescription),
        attempts: 0,
      })),
    }));

    const productReviewContract = resolveProductReviewContract(undefined, {
      cwd: this.config.cwd,
      prd: input.prd,
      goal,
      successCriteria,
    });

    const plan = createMissionPlan({
      missionId: input.missionId,
      goal,
      constraints,
      successCriteria,
      productReviewContract,
      state: 'planning',
      milestones: appendFinalReviewMilestone(milestones, productReviewContract),
    });
    return this.config.pullRequestAutomationEnabled
      ? ensurePullRequestFollowUpMilestone(plan)
      : plan;
  }

  private toMissionPlan(
    planning: MissionPlanningOutput,
    input: {
      missionId: string;
      prd?: string | null;
      approvalMethod?: 'auto' | 'interactive';
      prdFile?: string;
    }
  ): MissionPlan {
    const milestones = planning.milestones.map((milestone, milestoneIndex) => ({
      id: milestone.id?.trim() || `m${milestoneIndex + 1}`,
      title: milestone.title,
      description: milestone.description,
      status: 'pending' as const,
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
        qaChecks: (milestone.validationContract?.qaChecks ?? []).map((check, index) => ({
          id: check.id || `m${milestoneIndex + 1}-qa-${index + 1}`,
          description: check.description,
          type: normalizeCheckType(check.type, 'manual'),
          command: check.command,
          requiredRunner: normalizeValidationRunner(check.requiredRunner),
          requiredArtifacts: normalizeValidationArtifacts(check.requiredArtifacts),
          passed: false,
          failureCount: 0,
        })),
      },
      features: milestone.features.map((feature, featureIndex) => ({
        id: feature.id?.trim() || `m${milestoneIndex + 1}-f${featureIndex + 1}`,
        description: normalizeFeatureDescription(feature.description),
        cwd: feature.cwd,
        checks: feature.checks?.map((check) => ({ text: check.text, type: check.type, passed: false })),
        kind: 'implementation' as const,
        status: 'pending' as const,
        model: resolveFeatureModel(feature.model, feature.description),
        attempts: 0,
      })),
    }));

    const productReviewContract = resolveProductReviewContract(planning.productReviewContract, {
      cwd: this.config.cwd,
      prd: input.prd,
      goal: planning.goal,
      successCriteria: planning.successCriteria,
    });

    const plan = createMissionPlan({
      missionId: input.missionId,
      goal: planning.goal,
      constraints: planning.constraints,
      successCriteria: planning.successCriteria,
      productReviewContract,
      milestones: appendFinalReviewMilestone(milestones, productReviewContract),
      state: 'planning',
    });
    return this.config.pullRequestAutomationEnabled
      ? ensurePullRequestFollowUpMilestone(plan)
      : plan;
  }

  private buildMissionPlanPrompt(
    prd: string | null,
    interactiveGoal?: string,
    preferredLanguage: DocumentLanguage = detectPreferredLanguage(prd, interactiveGoal),
    codebaseContext?: string,
    reviewedFiles: string[] = []
  ): string {
    const languageLabel = preferredLanguage === 'ja' ? 'Japanese' : 'English';
    const reviewedFilesBlock = formatPlanningReviewedFiles(reviewedFiles);
    const repositoryContextBlock = truncatePlanningText(
      codebaseContext?.trim() || '(no repository context available)',
      PLANNING_CONTEXT_SECTION_MAX_CHARS,
      'Repository Context'
    );
    const promptPrefix = [
      'You are an expert technical planner.',
      'Create a MissionPlan JSON for a coding mission.',
      'Hard cutover mode: do not include backward compatibility tasks.',
      `All natural language fields must be written in ${languageLabel}.`,
      'You must inspect the repository before finalizing the plan.',
      'Treat planning as coverage work, not spot-checking.',
      'Read the relevant implementation files, their local imports, nearby tests, and config/entrypoint files until the requested scope has no unresolved references.',
      'Do not stop after an arbitrary number of files.',
      '',
      'Return only valid JSON. Do not add prose outside JSON.',
      'Wrap output exactly with markers:',
      'BEGIN_MISSION_PLAN_JSON',
      '{"goal":"...","constraints":["..."],"successCriteria":["..."],"productReviewContract":{"cwd":"frontend/apps/web","target":"http://127.0.0.1:${PORT}","startup":[{"cwd":"frontend/apps/web","command":"npm run dev"}],"preconditions":["js_repl must be enabled","playwright must be importable"],"checkpoints":[{"id":"hero","description":"Hero flow satisfies the PRD claim","claim":"hero CTA works","visual":true}],"artifactsDir":"artifacts/screenshots"},"milestones":[{"id":"m1","title":"...","description":"...","validationContract":{"staticChecks":[{"id":"...","description":"...","type":"auto:typecheck","command":"..."}],"testSuites":[{"id":"...","description":"...","type":"auto:test","command":"..."}],"qaChecks":[{"id":"m1-qa-hero","description":"Open /settings/profile with playwright-interactive, capture before screenshot to artifacts/screenshots/m1-qa-hero-before.png before the first repo-tracked file edit, then capture after screenshot to artifacts/screenshots/m1-qa-hero-after.png and compare the updated hero state.","type":"browser","requiredRunner":"playwright-interactive","requiredArtifacts":["screenshot"]}]},"features":[{"id":"m1-f1","description":"...","model":"codex-latest","cwd":"frontend/apps/web"}]}]}',
      'END_MISSION_PLAN_JSON',
      '',
      'Constraints:',
      '- Prefer 2-3 milestones (phases). Split larger scope into Phase 1/2/3 at most.',
      '- Keep each milestone focused by avoiding too many tiny features in one milestone.',
      '- For large implementations, keep phase count compact but allow sufficient features when necessary.',
      '- One feature must represent a cohesive implementation slice that can be completed in one focused worker session.',
      '- If scope is too large, fold details into phase descriptions and keep executable features compact.',
      '- Each milestone requires validationContract with executable commands where possible',
      '- Provide productReviewContract for the final interactive product review. It must include cwd, target, startup/preconditions, and concrete checkpoints derived from the PRD.',
      '- If the PRD/repository mentions `.port`, `CONDUCTOR_PORT`, or `make info`, validation commands must reuse that local URL resolution strategy and must not hardcode port 8000 except as a final fallback through `${CONDUCTOR_PORT:-8000}` or `.port`.',
      '- Set feature.cwd only when the implementation or QA must run from a workspace subdirectory. cwd must be repo-relative (example: `frontend/apps/web`).',
      '- Feature IDs must follow mX-fY',
      '- Put interactive browser/manual/e2e verification in `validationContract.qaChecks`. Do not output a dedicated qa feature; Melos synthesizes it automatically when qaChecks exist.',
      '- When the change affects a user-visible screen, the relevant qaChecks must describe before/after evidence explicitly so it is visible in TASK.json and the TUI. Do not use generic QA descriptions.',
      '- Before evidence must be captured after the QA inventory/target screen is known and before the first repo-tracked file edit. Encode that timing expectation directly in the qaChecks description.',
      '- Use canonical artifact names in qaChecks descriptions: `artifacts/screenshots/<qa-check-id>-before.png`, `artifacts/screenshots/<qa-check-id>-after.png`, `artifacts/videos/<qa-check-id>-before.webm`, and `artifacts/videos/<qa-check-id>-after.webm`.',
      '- Use screenshots for static visual diffs (copy/layout/color/final state). Use video for motion or multi-step interaction diffs (animation/hover/accordion/loading/drag). When final visual state also matters, mention both video and after screenshot.',
      '- Default feature model is codex-latest',
      '- Use model "claude-latest" only when the primary deliverable is a user-visible UI change in the rendered surface.',
      '- Do not use "claude-latest" for React/runtime/hooks/providers/contexts/types/dependencies/tests/config/build/tooling tasks, even if the files live under frontend/, shared/ui/, editor/ui/, or mention components.',
      '- If a task mixes visual UI work and infrastructure work, split it into separate features. Only the visual feature should use "claude-latest".',
      '',
      'Files already reviewed by system and required for planning coverage:',
      reviewedFilesBlock,
      '',
      'User stated goal:',
      interactiveGoal?.trim() || '(not provided)',
      '',
      'Repository Context (coverage-oriented, pre-read by system):',
      repositoryContextBlock,
      '',
      'PRD content:',
    ].join('\n');
    const prdBlock = truncatePlanningText(
      prd?.trim() || '(PRD not found)',
      Math.max(0, PLANNING_PROMPT_MAX_CHARS - promptPrefix.length - 1),
      'PRD content'
    );
    return `${promptPrefix}\n${prdBlock}`;
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
    const groups = groupValidationFailuresByTrackingKey(failures);
    return groups.map((group, index) => ({
      description: synthesizeFollowUpDescription({
        trackingKey: group.trackingKey,
        affectedChecks: group.failures.map((failure) => failure.checkId),
        failures: group.failures,
      }) ?? `Resolve ${group.trackingKey.replace(/[-_]+/g, ' ')}`,
      trackingKey: group.trackingKey,
      priority: index === 0 ? 'high' : 'medium',
      affectedChecks: group.failures.map((failure) => failure.checkId),
      rationale: group.failures.map((failure) => failure.failure?.rootCause).find((value) => typeof value === 'string' && value.trim().length > 0),
      model: CODEX_LATEST_ALIAS,
    }));
  }

  private executeWithConfiguredEngine(
    prompt: string,
    effort: NonNullable<ManagerAgentConfig['effort']>,
    callbacks: {
      onAgentMessageDelta?: (chunk: string) => void;
      onCommandOutputDelta?: (chunk: string) => void;
      onAppServerEvent?: (method: string, params: unknown) => void;
    } = {},
    options: { timeoutMs?: number } = {}
  ): Promise<EngineResult> {
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs ?? 180_000;
    if (this.shouldUseCodexEngine(this.config.model)) {
      this.activeEngine = 'codex';
      const threadId = this.resumeThreadId ?? undefined;
      if (threadId) {
        this.resumeThreadId = null;
      }
      const engineOptions: AppServerEngineOptions = {
        cwd: this.config.cwd,
        timeout: timeoutMs,
        model: resolveRuntimeModel(this.config.model, CODEX_LATEST_ALIAS),
        reasoningEffort: this.mapEffortForCodex(effort),
        execMode: true,
        suppressTerminalOutput: this.config.suppressTerminalOutput === true,
        threadId,
        onStream: callbacks.onAgentMessageDelta,
        onCommandOutput: callbacks.onCommandOutputDelta,
        onEvent: callbacks.onAppServerEvent,
      };
      return this.codexEngine.execute(prompt, engineOptions).finally(() => {
        this.activeEngine = null;
      });
    }

    this.activeEngine = 'claude';
    const engineOptions: ClaudeEngineOptions = {
      cwd: this.config.cwd,
      timeout: timeoutMs,
      model: resolveRuntimeModel(this.config.model, CLAUDE_LATEST_ALIAS),
      effort,
      skipPermissions: true,
      printMode: true,
      suppressTerminalOutput: this.config.suppressTerminalOutput === true,
      onStream: callbacks.onAgentMessageDelta,
      onEvent: callbacks.onAppServerEvent,
    };
    return this.claudeEngine.execute(prompt, engineOptions).finally(() => {
      this.activeEngine = null;
    });
  }

  private shouldUseCodexEngine(model: string | undefined): boolean {
    if (typeof model !== 'string' || model.trim().length === 0) {
      return true;
    }
    return isCodexFamily(model);
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
  fallback: 'command' | 'auto:test' | 'browser' | 'manual' | 'e2e'
): CheckType {
  if (!value) {
    return fallback;
  }
  if (value === 'auto:lint' || value === 'auto:typecheck' || value === 'auto:test' || value === 'browser' || value === 'manual' || value === 'e2e' || value === 'command') {
    return value;
  }
  return fallback;
}

function inferFeatureModel(description: string): string {
  if (isUiFocusedFeature(description)) {
    return CLAUDE_LATEST_ALIAS;
  }
  return CODEX_LATEST_ALIAS;
}

function resolveFeatureModel(
  _model: string | undefined,
  description: string
): string {
  return inferFeatureModel(description);
}

function isUiFocusedFeature(description: string): boolean {
  const normalized = sanitizeFeatureDescriptionForModelSelection(description).toLowerCase();

  const strongSignalPatterns = [
    /\bui\b/,
    /\bux\b/,
    /\bdesign\b/,
    /\bredesign\b/,
    /\blayout\b/,
    /\bstyle\b/,
    /\bstyling\b/,
    /\bvisual\b/,
    /\btheme\b/,
    /\bcss\b/,
    /\btailwind\b/,
    /\bresponsive\b/,
    /\bspacing\b/,
    /\bcolor\b/,
    /\btypography\b/,
  ];
  if (strongSignalPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const japaneseStrongSignals = [
    'レスポンシブ',
    'デザイン',
    'レイアウト',
    'スタイル',
    'スタイリング',
    '見た目',
    '画面デザイン',
    '配色',
    '余白',
    'タイポグラフィ',
  ];
  if (japaneseStrongSignals.some((signal) => normalized.includes(signal))) {
    return true;
  }

  const infraSignalPatterns = [
    /\bruntime\b/,
    /\bhook\b/,
    /\bprovider\b/,
    /\bcontext\b/,
    /\btype\b/,
    /\btypes\b/,
    /\btyping\b/,
    /\bjsx\b/,
    /\btsx\b/,
    /\bdependency\b/,
    /\bdependencies\b/,
    /\bpackage\b/,
    /\bpackages\b/,
    /\bsetup\b/,
    /\bconfig\b/,
    /\bconfiguration\b/,
    /\bbuild\b/,
    /\bbundl(?:e|er|ing)\b/,
    /\bmodule\b/,
    /\bimport\b/,
    /\bexport\b/,
    /\btest\b/,
    /\btests\b/,
    /\btesting\b/,
    /\bvitest\b/,
    /\bjest\b/,
    /\btsconfig\b/,
    /\blint\b/,
    /\beslint\b/,
    /\bcompiler\b/,
    /\bcompile\b/,
    /\bresolution\b/,
    /\bresolver\b/,
    /\bprops\b/,
    /\bapi\b/,
  ];
  const japaneseInfraSignals = [
    '型解決',
    '型定義',
    '型不整合',
    '依存解決',
    '依存関係',
    '単一ランタイム',
    'ランタイム',
    'フック',
    'プロバイダ',
    'コンテキスト',
    'テスト',
    'テストセットアップ',
    '設定',
    '構成',
    'パッケージ',
    'ビルド',
  ];
  if (
    infraSignalPatterns.some((pattern) => pattern.test(normalized))
    || japaneseInfraSignals.some((signal) => normalized.includes(signal))
  ) {
    return false;
  }

  const uiTargets = [
    'page',
    'screen',
    'component',
    'modal',
    'dialog',
    'form',
    'button',
    'card',
    'header',
    'footer',
    'navbar',
    'sidebar',
    'ページ',
    '画面',
    'コンポーネント',
    'モーダル',
    'ダイアログ',
    'フォーム',
    'ボタン',
    'カード',
    'ヘッダー',
    'フッター',
    'ナビゲーション',
    'サイドバー',
  ];
  const uiActions = [
    'create',
    'build',
    'implement',
    'add',
    'update',
    'fix',
    'adjust',
    'refine',
    'polish',
    'tweak',
    'repair',
    '作成',
    '新規',
    '実装',
    '追加',
    '更新',
    '修正',
    '改修',
    '調整',
    '改善',
  ];

  return uiTargets.some((target) => normalized.includes(target))
    && uiActions.some((action) => normalized.includes(action));
}

function sanitizeFeatureDescriptionForModelSelection(description: string): string {
  return normalizeFeatureDescription(description)
    .replace(/\b[\w@.-]+(?:[\\/][\w@.-]+){1,}\b/g, ' ')
    .replace(/[`"'“”‘’]/g, ' ');
}

function buildFeatureBriefing(input: ManagerInput): string {
  const milestone = input.activeMilestone;
  const feature = input.activeFeature;
  if (!milestone || !feature) {
    return '';
  }

  if (feature.kind === 'review') {
    const contract = input.missionPlan.productReviewContract;
    const checkpoints = contract?.checkpoints.map((checkpoint) => checkpoint.description) ?? [];
    const objectiveLines = [
      `${feature.id} ${feature.description} を実行し、final review を判定する。`,
      `Mission goal: ${input.missionPlan.mission.goal}`,
    ];
    const constraintLines = [
      'P1/P2 finding があれば sign-off せず、root cause ごとに remediation に落とし込む前提で観察する。',
      `reviewType=${feature.reviewType ?? 'unknown'} generation=${feature.reviewGeneration ?? 1}`,
      `現在の試行回数: ${feature.attempts}`,
    ];
    const validationFocusLines = [
      ...toBulletItems(checkpoints, 'productReviewContract の checkpoints を優先確認する。'),
      'PRD と実装差分の両方を読み、通常系だけでなく境界条件も確認する。',
    ];
    const riskLines = [
      feature.reviewType === 'product'
        ? 'product review では interactive browser verification が前提。js_repl / Playwright / startup 条件が満たせない場合は BLOCKED にする。'
        : 'code review では PRD を満たさない実装や regression risk を P1/P2/P3 で分類する。',
      feature.attempts > 0
        ? '再試行 review なので、前 generation の findings が解消されているかを重点確認する。'
        : null,
    ];

    return [
      '## Objective',
      ...objectiveLines.map((line) => `- ${line}`),
      '',
      '## Constraints',
      ...constraintLines.map((line) => `- ${line}`),
      '',
      '## Validation focus',
      ...validationFocusLines.map((line) => `- ${line}`),
      '',
      '## Risks',
      ...toBulletItems(riskLines, '大きな追加リスクは現時点で未検出。').map((line) => `- ${line}`),
    ].join('\n');
  }

  const objectiveLines = [
    `${feature.id} ${feature.description} を実装し、${milestone.id} ${milestone.title} を前進させる。`,
    `Mission goal: ${input.missionPlan.mission.goal}`,
  ];

  const constraintLines = [
    ...toBulletItems(input.missionPlan.mission.constraints, 'ミッション制約は未定義。TASK.json を確認すること。'),
    'source of truth は TASK.json の feature description / checks / validationContract。',
    `現在の試行回数: ${feature.attempts}`,
  ];

  const featureCheckLines = (feature.checks ?? []).map((check) =>
    check.type ? `${check.text} [${check.type}]` : check.text
  );
  const validationLines = getValidationFocusLines(milestone.validationContract);
  const validationFocusLines = [
    ...toBulletItems(featureCheckLines, null),
    ...toBulletItems(validationLines, '明示的な validation check は未定義。'),
  ];

  const riskLines = [
    feature.attempts > 0
      ? '再試行中の feature なので、前回の差分や未解決事項の取りこぼしに注意が必要。'
      : null,
    input.prd && input.prd.trim().length > 0
      ? null
      : 'PRD が読み込めていないため、TASK.json と既存実装の整合ずれが起こりやすい。',
    validationLines.length === 0
      ? '検証条件が薄いため、実装完了後の確認漏れが起こりやすい。'
      : null,
  ];

  return [
    '## Objective',
    ...objectiveLines.map((line) => `- ${line}`),
    '',
    '## Constraints',
    ...constraintLines.map((line) => `- ${line}`),
    '',
    '## Validation focus',
    ...validationFocusLines.map((line) => `- ${line}`),
    '',
    '## Risks',
    ...toBulletItems(riskLines, '大きな追加リスクは現時点で未検出。').map((line) => `- ${line}`),
  ].join('\n');
}

function getValidationFocusLines(contract: MissionPlan['milestones'][number]['validationContract']): string[] {
  return [
    ...contract.staticChecks.map((check) => formatValidationCheckLine('static', check.description, check.command)),
    ...contract.testSuites.map((check) => formatValidationCheckLine('test', check.description, check.command)),
    ...(contract.qaChecks ?? []).map((check) => formatValidationCheckLine(`qa:${check.type}`, check.description, check.command)),
  ].filter((line) => line.trim().length > 0);
}

function formatValidationCheckLine(kind: string, description: string, command?: string): string {
  if (command && command.trim().length > 0) {
    return `${kind}: ${description} (${command.trim()})`;
  }
  return `${kind}: ${description}`;
}

function toBulletItems(items: Array<string | null | undefined>, fallback: string | null): string[] {
  const normalized = items
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
  if (normalized.length > 0) {
    return normalized;
  }
  return fallback ? [fallback] : [];
}

function normalizeFeatureDescription(description: unknown): string {
  if (typeof description !== 'string') {
    return 'Requested feature scope';
  }
  const trimmed = description.trim();
  return trimmed.length > 0 ? trimmed : 'Requested feature scope';
}

function normalizeFollowUpDrafts(
  candidates: unknown[],
  failures: ValidationCheckResult[]
): FollowUpFeatureDraft[] {
  const drafts: FollowUpFeatureDraft[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const affectedChecks = toStringArray(record.affectedChecks);
    const trackingKey = normalizeFollowUpTrackingKey(
      toNonEmptyString(record.trackingKey)
      ?? deriveTrackingKeyFromChecks(affectedChecks, failures)
      ?? deriveTrackingKeyFromText(toNonEmptyString(record.description))
    );
    const description = synthesizeFollowUpDescription({
      explicitDescription: toNonEmptyString(record.description),
      trackingKey,
      affectedChecks,
      failures,
    });
    if (!description || !trackingKey) {
      continue;
    }

    const priority = String(record.priority ?? 'medium').toLowerCase();
    drafts.push({
      description,
      trackingKey,
      priority: priority === 'high' || priority === 'low' ? priority : 'medium',
      affectedChecks,
      rationale: toNonEmptyString(record.rationale) ?? undefined,
      model: resolveFeatureModel(
        typeof record.model === 'string' ? record.model : undefined,
        description
      ),
    });
  }

  return mergeFollowUpDrafts(drafts);
}

function mergeFollowUpDrafts(drafts: FollowUpFeatureDraft[]): FollowUpFeatureDraft[] {
  const grouped = new Map<string, FollowUpFeatureDraft>();
  for (const draft of drafts) {
    const trackingKey = normalizeFollowUpTrackingKey(draft.trackingKey)
      ?? normalizeFollowUpTrackingKey(deriveTrackingKeyFromText(draft.description));
    if (!trackingKey) {
      continue;
    }

    const existing = grouped.get(trackingKey);
    if (!existing) {
      grouped.set(trackingKey, {
        ...draft,
        trackingKey,
        affectedChecks: Array.from(new Set(draft.affectedChecks ?? [])),
      });
      continue;
    }

    grouped.set(trackingKey, {
      description: draft.description || existing.description,
      trackingKey,
      priority: pickHigherPriority(existing.priority, draft.priority),
      affectedChecks: Array.from(new Set([...(existing.affectedChecks ?? []), ...(draft.affectedChecks ?? [])])),
      rationale: pickMoreSpecificDescription(existing.rationale, draft.rationale),
      model: chooseDraftModel(existing.model, draft.model),
    });
  }

  return Array.from(grouped.values());
}

function groupValidationFailuresByTrackingKey(
  failures: ValidationCheckResult[]
): Array<{ trackingKey: string; failures: ValidationCheckResult[] }> {
  const grouped = new Map<string, ValidationCheckResult[]>();
  for (const failure of failures) {
    const trackingKey = normalizeFollowUpTrackingKey(deriveTrackingKeyFromFailure(failure))
      ?? normalizeFollowUpTrackingKey(failure.checkId)
      ?? 'validation-failure';
    const bucket = grouped.get(trackingKey) ?? [];
    bucket.push(failure);
    grouped.set(trackingKey, bucket);
  }
  return Array.from(grouped.entries()).map(([trackingKey, groupedFailures]) => ({
    trackingKey,
    failures: groupedFailures,
  }));
}

function deriveTrackingKeyFromFailure(failure: ValidationCheckResult): string | null {
  return deriveTrackingKeyFromText(
    failure.failure?.rootCause
    ?? failure.failure?.summary
    ?? failure.checkId
  );
}

function deriveTrackingKeyFromChecks(
  affectedChecks: string[],
  failures: ValidationCheckResult[]
): string | null {
  if (affectedChecks.length === 0) {
    return null;
  }

  const firstMatchingFailure = affectedChecks
    .map((checkId) => failures.find((failure) => failure.checkId === checkId))
    .find((failure): failure is ValidationCheckResult => Boolean(failure));

  if (!firstMatchingFailure) {
    return deriveTrackingKeyFromText(affectedChecks.join('-'));
  }

  return deriveTrackingKeyFromFailure(firstMatchingFailure);
}

function deriveTrackingKeyFromText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug.length > 0 ? slug : null;
}

function normalizeFollowUpTrackingKey(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function synthesizeFollowUpDescription(input: {
  explicitDescription?: string | null;
  trackingKey?: string;
  affectedChecks?: string[];
  failures: ValidationCheckResult[];
}): string | null {
  const explicitDescription = input.explicitDescription?.trim();
  if (explicitDescription) {
    return explicitDescription;
  }

  const matchingFailures = (input.affectedChecks && input.affectedChecks.length > 0
    ? input.affectedChecks
      .map((checkId) => input.failures.find((failure) => failure.checkId === checkId))
      .filter((failure): failure is ValidationCheckResult => Boolean(failure))
    : input.failures
  );

  const rootCause = matchingFailures
    .map((failure) => failure.failure?.rootCause?.trim())
    .find((value): value is string => Boolean(value));
  if (rootCause) {
    return truncateMessage(`Resolve ${rootCause}`, 220);
  }

  const summary = matchingFailures
    .map((failure) => failure.failure?.summary?.trim())
    .find((value): value is string => Boolean(value));
  if (summary) {
    return truncateMessage(`Resolve validation failure: ${summary}`, 220);
  }

  if (input.affectedChecks && input.affectedChecks.length > 0) {
    return truncateMessage(`Resolve validation failures in ${input.affectedChecks.join(', ')}`, 220);
  }

  if (input.trackingKey) {
    return truncateMessage(`Resolve ${input.trackingKey.replace(/[-_]+/g, ' ')}`, 220);
  }

  return null;
}

function pickHigherPriority(
  left: FollowUpFeatureDraft['priority'],
  right: FollowUpFeatureDraft['priority']
): FollowUpFeatureDraft['priority'] {
  const ranking: Record<FollowUpFeatureDraft['priority'], number> = {
    high: 3,
    medium: 2,
    low: 1,
  };
  return ranking[left] >= ranking[right] ? left : right;
}

function chooseDraftModel(left?: string, right?: string): string | undefined {
  if (left && isClaudeFamily(left)) {
    return left;
  }
  if (right && isClaudeFamily(right)) {
    return right;
  }
  return left ?? right;
}

function pickMoreSpecificDescription(left?: string, right?: string): string | undefined {
  const normalizedLeft = left?.trim();
  const normalizedRight = right?.trim();
  if (!normalizedLeft) {
    return normalizedRight;
  }
  if (!normalizedRight) {
    return normalizedLeft;
  }
  return normalizedRight.length > normalizedLeft.length ? normalizedRight : normalizedLeft;
}

function extractGoalFromPrd(prd: string | null): string | null {
  if (!prd) {
    return null;
  }

  const lines = prd.split(/\r?\n/);
  const headings = lines
    .filter((line) => /^\s{0,3}#{1,6}\s+\S/.test(line))
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s+/, '').trim())
    .filter((line) => line.length > 0);
  const preferredHeading = headings.find((heading) => !isGenericHeading(heading));
  if (preferredHeading) {
    return truncateMessage(preferredHeading, 160);
  }
  if (headings[0]) {
    return truncateMessage(headings[0], 160);
  }

  const firstText = lines.find((line) => {
    const normalized = line.trim();
    if (!normalized) {
      return false;
    }
    if (/^\s*[-*+]\s+/.test(normalized) || /^\s*\d+\.\s+/.test(normalized)) {
      return true;
    }
    return normalized.length >= 8;
  });
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
  const mission = toRecord(root.mission);
  const goal = toNonEmptyString(root.goal) ?? toNonEmptyString(mission?.goal);
  const constraints = toStringArray(root.constraints).length > 0
    ? toStringArray(root.constraints)
    : toStringArray(mission?.constraints);
  const successCriteria = toStringArray(root.successCriteria).length > 0
    ? toStringArray(root.successCriteria)
    : toStringArray(mission?.successCriteria);
  const rawMilestones = Array.isArray(root.milestones)
    ? root.milestones.slice(0, MAX_MILESTONES_PER_PLAN)
    : [];

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
    productReviewContract: normalizePlanningProductReviewContract(root.productReviewContract),
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
  const rawFeatures = Array.isArray(milestone.features)
    ? milestone.features
    : (Array.isArray(milestone.tasks) ? milestone.tasks : (Array.isArray(milestone.items) ? milestone.items : []));
  if (rawFeatures.length === 0) {
    return null;
  }

  const features = rawFeatures
    .map((rawFeature, featureIndex) => normalizePlanningFeature(rawFeature, milestoneIndex, featureIndex))
    .filter((feature): feature is MissionPlanningOutput['milestones'][number]['features'][number] => feature !== null);
  const coarsenedFeatures = coarsenPlanningFeatures(features, MAX_FEATURES_PER_MILESTONE);
  if (coarsenedFeatures.length === 0) {
    return null;
  }

  return {
    id: toNonEmptyString(milestone.id) ?? undefined,
    title,
    description,
    validationContract: normalizeValidationContract(milestone.validationContract),
    features: coarsenedFeatures,
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
  const description = toNonEmptyString(feature.description)
    ?? toNonEmptyString(feature.title)
    ?? toNonEmptyString(feature.task)
    ?? 'No description provided';
  const model = toNonEmptyString(feature.model) ?? toNonEmptyString(feature.requestedModel);
  return {
    id: toNonEmptyString(feature.id) ?? undefined,
    description,
    model: normalizeModelName(model) ?? CODEX_LATEST_ALIAS,
    cwd: toNonEmptyString(feature.cwd) ?? undefined,
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

function normalizePlanningProductReviewContract(
  value: unknown
): MissionPlanningOutput['productReviewContract'] | undefined {
  const normalized = normalizeProductReviewContract(value);
  if (!normalized) {
    return undefined;
  }
  return {
    cwd: normalized.cwd,
    target: normalized.target,
    startup: normalized.startup?.map((step) => ({
      cwd: step.cwd,
      command: step.command,
    })),
    preconditions: normalized.preconditions,
    checkpoints: normalized.checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      description: checkpoint.description,
      claim: checkpoint.claim,
      visual: checkpoint.visual,
    })),
    artifactsDir: normalized.artifactsDir,
    video: normalized.video,
  };
}

function resolveProductReviewContract(
  value: unknown,
  context: {
    cwd: string;
    prd: string | null | undefined;
    goal: string;
    successCriteria: string[];
  }
): ProductReviewContract {
  const normalized = normalizeProductReviewContract(value, context.cwd);
  if (normalized) {
    return normalized;
  }

  const inferredCwd = existsSync(join(context.cwd, 'frontend', 'apps', 'web'))
    ? 'frontend/apps/web'
    : undefined;
  const checkpoints = context.successCriteria.length > 0
    ? context.successCriteria.slice(0, 4).map((criterion, index) => ({
      id: `criterion-${index + 1}`,
      description: criterion,
      claim: criterion,
      visual: true,
    }))
    : [
      {
        id: 'mission-goal',
        description: context.goal,
        claim: context.goal,
        visual: true,
      },
    ];

  return {
    cwd: inferredCwd,
    target: 'http://127.0.0.1:${PORT}',
    startup: [
      {
        cwd: inferredCwd,
        command: 'npm run dev',
      },
    ],
    preconditions: [
      'Resolve PORT using .port, CONDUCTOR_PORT, or 8000 as the final fallback.',
      'js_repl must be enabled for Codex app-server.',
      'playwright must be importable from the review cwd.',
    ],
    checkpoints,
    artifactsDir: 'artifacts/screenshots',
  };
}

function appendFinalReviewMilestone(
  milestones: MissionPlan['milestones'],
  productReviewContract: ProductReviewContract
): MissionPlan['milestones'] {
  const nextMilestoneIndex = milestones.length + 1;
  const milestoneId = `m${nextMilestoneIndex}`;
  return [
    ...milestones,
    {
      id: milestoneId,
      title: 'Final Review',
      description: 'Run final product review and code review before mission completion.',
      status: 'pending' as const,
      validationContract: createEmptyValidationContract(),
      features: [
        {
          id: `${milestoneId}-f1`,
          description: 'Run final product review against the PRD and interactive browser checks',
          cwd: productReviewContract.cwd,
          kind: 'review' as const,
          reviewType: 'product' as const,
          reviewGeneration: 1,
          status: 'pending' as const,
          model: CODEX_LATEST_ALIAS,
          attempts: 0,
        },
        {
          id: `${milestoneId}-f2`,
          description: 'Run final code review against the PRD and final implementation',
          kind: 'review' as const,
          reviewType: 'code' as const,
          reviewGeneration: 1,
          status: 'pending' as const,
          model: CODEX_LATEST_ALIAS,
          attempts: 0,
        },
      ],
    },
  ];
}

function normalizeReviewFollowUpDrafts(
  candidates: unknown[],
  findings: ReviewFinding[]
): FollowUpFeatureDraft[] {
  const drafts: FollowUpFeatureDraft[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const trackingKey = normalizeFollowUpTrackingKey(
      toNonEmptyString(record.trackingKey)
      ?? deriveTrackingKeyFromReviewFinding(findings[0])
    );
    const description = toNonEmptyString(record.description)
      ?? synthesizeReviewFollowUpDescription(findings, trackingKey);
    if (!description || !trackingKey) {
      continue;
    }

    const priority = String(record.priority ?? 'medium').toLowerCase();
    drafts.push({
      description,
      trackingKey,
      priority: priority === 'high' || priority === 'low' ? priority : 'medium',
      rationale: toNonEmptyString(record.rationale) ?? undefined,
      model: resolveFeatureModel(
        typeof record.model === 'string' ? record.model : undefined,
        description
      ),
    });
  }

  return mergeFollowUpDrafts(drafts);
}

function fallbackReviewFollowUpFeatures(findings: ReviewFinding[]): FollowUpFeatureDraft[] {
  const buckets = new Map<string, ReviewFinding[]>();
  for (const finding of findings) {
    const trackingKey = normalizeFollowUpTrackingKey(
      finding.trackingKey
      ?? deriveTrackingKeyFromText(finding.surface)
      ?? deriveTrackingKeyFromReviewFinding(finding)
      ?? 'final-review'
    ) ?? 'final-review';
    const bucket = buckets.get(trackingKey) ?? [];
    bucket.push(finding);
    buckets.set(trackingKey, bucket);
  }

  return Array.from(buckets.entries()).map(([trackingKey, groupedFindings], index) => ({
    description: synthesizeReviewFollowUpDescription(groupedFindings, trackingKey) ?? `Address ${trackingKey.replace(/[-_]+/g, ' ')}`,
    trackingKey,
    priority: index === 0 ? 'high' : 'medium',
    rationale: groupedFindings[0]?.rationale,
    model: CODEX_LATEST_ALIAS,
  }));
}

function deriveTrackingKeyFromReviewFinding(finding: ReviewFinding | undefined): string | null {
  if (!finding) {
    return null;
  }
  return deriveTrackingKeyFromText(finding.trackingKey ?? finding.surface ?? finding.summary);
}

function synthesizeReviewFollowUpDescription(
  findings: ReviewFinding[],
  trackingKey?: string
): string | null {
  const suggestedFix = findings
    .map((finding) => finding.suggestedFix?.trim())
    .find((value): value is string => Boolean(value));
  if (suggestedFix) {
    return truncateMessage(suggestedFix, 220);
  }

  const summary = findings
    .map((finding) => finding.summary.trim())
    .find((value) => value.length > 0);
  if (summary) {
    return truncateMessage(`Address final review issue: ${summary}`, 220);
  }

  if (trackingKey) {
    return truncateMessage(`Address ${trackingKey.replace(/[-_]+/g, ' ')}`, 220);
  }

  return null;
}

function coarsenPlanningFeatures(
  features: MissionPlanningOutput['milestones'][number]['features'],
  maxFeatures: number
): MissionPlanningOutput['milestones'][number]['features'] {
  if (features.length <= maxFeatures) {
    return features;
  }
  const chunkSize = Math.max(2, Math.ceil(features.length / maxFeatures));
  return chunkArray(features, chunkSize).map((chunk) => mergePlanningFeatureChunk(chunk));
}

function mergePlanningFeatureChunk(
  chunk: MissionPlanningOutput['milestones'][number]['features']
): MissionPlanningOutput['milestones'][number]['features'][number] {
  const description = truncateMessage(
    chunk
      .map((feature) => normalizeFeatureDescription(feature.description))
      .filter((text) => text.length > 0)
      .join(' / '),
    280
  );
  const checks = chunk.flatMap((feature) => feature.checks ?? []);
  const uniqueCwds = Array.from(new Set(
    chunk
      .map((feature) => feature.cwd?.trim())
      .filter((cwd): cwd is string => typeof cwd === 'string' && cwd.length > 0)
  ));
  return {
    description,
    model: chunk.some((feature) => isClaudeFamily(feature.model)) ? CLAUDE_LATEST_ALIAS : CODEX_LATEST_ALIAS,
    cwd: uniqueCwds.length === 1 ? uniqueCwds[0] : undefined,
    checks: checks.length > 0 ? checks.slice(0, 10) : undefined,
  };
}

function normalizeValidationContract(value: unknown): MissionPlanningOutput['milestones'][number]['validationContract'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const contract = value as Record<string, unknown>;
  return {
    staticChecks: normalizeValidationChecks(contract.staticChecks),
    testSuites: normalizeValidationChecks(contract.testSuites),
    qaChecks: normalizeQaValidationChecks(contract.qaChecks),
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
      command: normalizeValidationCommand(command),
    });
  });
  return checks.length > 0 ? checks : undefined;
}

function normalizeQaValidationChecks(
  value: unknown
): Array<{
  id: string;
  description: string;
  command?: string;
  type?: string;
  requiredRunner?: ValidationRunner;
  requiredArtifacts?: ValidationArtifact[];
}> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const checks: Array<{
    id: string;
    description: string;
    command?: string;
    type?: string;
    requiredRunner?: ValidationRunner;
    requiredArtifacts?: ValidationArtifact[];
  }> = [];

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
    const type = normalizeQaCheckType(record.type, record.requiredRunner, record.requiredArtifacts);
    const command = toNonEmptyString(record.command);
    checks.push({
      id,
      description,
      type,
      command: normalizeValidationCommand(command),
      requiredRunner: normalizeValidationRunner(record.requiredRunner),
      requiredArtifacts: normalizeValidationArtifacts(record.requiredArtifacts),
    });
  });

  return checks.length > 0 ? checks : undefined;
}

function normalizeValidationRunner(value: unknown): ValidationRunner | undefined {
  return value === 'playwright-interactive' || value === 'browser-test'
    ? value
    : undefined;
}

function normalizeQaCheckType(
  value: unknown,
  requiredRunner: unknown,
  requiredArtifacts: unknown
): 'browser' | 'manual' | 'e2e' {
  if (value === 'browser' || value === 'manual' || value === 'e2e') {
    return value;
  }
  return (normalizeValidationRunner(requiredRunner) || Array.isArray(requiredArtifacts))
    ? 'browser'
    : 'manual';
}

function normalizeValidationArtifacts(value: unknown): ValidationArtifact[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const artifacts = value.filter((item): item is ValidationArtifact => item === 'screenshot' || item === 'video');
  return artifacts.length > 0 ? artifacts : undefined;
}

function normalizeValidationCommand(command: string | null): string | undefined {
  if (!command) {
    return undefined;
  }

  let normalized = command;
  normalized = normalized.replace(
    /\bPORT=8000\b/g,
    'PORT=$(cat .port 2>/dev/null || echo ${CONDUCTOR_PORT:-8000})'
  );
  normalized = normalized.replace(/http:\/\/127\.0\.0\.1:8000\b/g, 'http://127.0.0.1:$PORT');
  normalized = normalized.replace(/http:\/\/localhost:8000\b/g, 'http://localhost:$PORT');
  normalized = normalized.replace(/\bnext dev -p 8000\b/g, 'next dev -p $PORT');
  normalized = normalized.replace(/\b--port 8000\b/g, '--port $PORT');
  normalized = normalized.replace(/\b-p 8000\b/g, '-p $PORT');

  return normalized;
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

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

async function buildPlanningCodebaseContext(
  cwd: string,
  prd: string | null,
  interactiveGoal?: string
): Promise<PlanningCodebaseContext> {
  const topLevelEntries = await safeReadDir(cwd);
  const topLevelNames = topLevelEntries
    .map((entry) => entry.name)
    .filter((name) => !IGNORED_DIRECTORIES.has(name))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 20);

  const packageSummary = await buildPackageSummary(cwd);
  const allFiles = await collectRepositoryFiles(cwd);
  const planningSource = `${interactiveGoal ?? ''}\n${prd ?? ''}`;
  const reviewedFiles = await selectPlanningCoverageFiles(
    cwd,
    allFiles,
    extractPlanningKeywords(planningSource),
    extractPlanningPathReferences(planningSource)
  );
  const limitedCoverage = limitPlanningReviewedFiles(reviewedFiles);

  const lines = [
    `Repository root entries: ${topLevelNames.length > 0 ? topLevelNames.join(', ') : '(none)'}`,
    `Coverage-required files: ${limitedCoverage.reviewedFiles.length > 0 ? limitedCoverage.reviewedFiles.join(', ') : '(none detected)'}`,
    packageSummary,
  ];
  if (limitedCoverage.omittedCount > 0) {
    lines.push(`Planning coverage trimmed: ${limitedCoverage.omittedCount} files omitted due to prompt budget.`);
  }

  const snippets: string[] = [];
  let omittedSnippets = 0;
  for (let index = 0; index < limitedCoverage.reviewedFiles.length; index += 1) {
    const relativePath = limitedCoverage.reviewedFiles[index];
    const snippet = await readPlanningSnippet(join(cwd, relativePath));
    if (!snippet) {
      continue;
    }

    const entry = [`FILE: ${relativePath}`, snippet].join('\n');
    const candidateSummary = [
      ...lines,
      ...(snippets.length > 0 ? ['', 'Reviewed file snippets:', ...snippets, entry] : ['', 'Reviewed file snippets:', entry]),
    ].join('\n');
    if (candidateSummary.length > PLANNING_CONTEXT_SECTION_MAX_CHARS) {
      omittedSnippets = limitedCoverage.reviewedFiles.length - index;
      break;
    }
    snippets.push(entry);
  }

  if (omittedSnippets > 0) {
    lines.push(`Reviewed file snippets trimmed: ${omittedSnippets} files omitted due to prompt budget.`);
  }
  if (snippets.length > 0) {
    lines.push('', 'Reviewed file snippets:');
    lines.push(...snippets);
  }

  return {
    summary: lines.join('\n'),
    reviewedFiles: limitedCoverage.reviewedFiles,
  };
}

async function buildPackageSummary(cwd: string): Promise<string> {
  const packageJsonPath = join(cwd, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return 'Package summary: package.json not found';
  }

  try {
    const raw = JSON.parse(await readFile(packageJsonPath, 'utf-8')) as Record<string, unknown>;
    const scripts = toRecord(raw.scripts);
    const dependencies = {
      ...toRecord(raw.dependencies),
      ...toRecord(raw.devDependencies),
    };
    const frameworkCandidates = [
      'react',
      'next',
      'vite',
      'vue',
      'nuxt',
      'svelte',
      'astro',
      'express',
      'fastify',
      'nestjs',
      'vitest',
      'jest',
      'typescript',
    ].filter((name) => Object.prototype.hasOwnProperty.call(dependencies, name));

    const scriptNames = Object.keys(scripts ?? {}).slice(0, 8);
    return [
      `Package name: ${typeof raw.name === 'string' ? raw.name : '(unnamed)'}`,
      `Framework hints: ${frameworkCandidates.length > 0 ? frameworkCandidates.join(', ') : '(none detected)'}`,
      `Scripts: ${scriptNames.length > 0 ? scriptNames.join(', ') : '(none)'}`,
    ].join('\n');
  } catch {
    return 'Package summary: failed to parse package.json';
  }
}

async function selectPlanningCoverageFiles(
  cwd: string,
  allFiles: string[],
  keywords: string[],
  referencedPaths: string[] = []
): Promise<string[]> {
  const sortedFiles = [...allFiles].sort((left, right) => left.localeCompare(right));
  const fileIndex = new Set(allFiles);
  const required = new Set<string>();
  const frontier: string[] = [];

  for (const configFile of PLANNING_CONFIG_FILES) {
    const absolutePath = join(cwd, configFile);
    if (fileIndex.has(absolutePath)) {
      addCoverageFile(required, frontier, absolutePath);
    }
  }

  for (const file of sortedFiles) {
    const normalized = relative(cwd, file).replace(/\\/g, '/').toLowerCase();
    if (PLANNING_ENTRYPOINT_PATTERNS.some((pattern) => normalized.startsWith(pattern))) {
      addCoverageFile(required, frontier, file);
    }
  }

  for (const referencedPath of referencedPaths) {
    const absolutePath = join(cwd, referencedPath);
    if (fileIndex.has(absolutePath)) {
      addCoverageFile(required, frontier, absolutePath);
    }
  }

  const shouldUseKeywordAnchors = referencedPaths.length === 0;
  const keywordAnchors = shouldUseKeywordAnchors
    ? sortedFiles.filter((file) => {
      const normalized = relative(cwd, file).replace(/\\/g, '/').toLowerCase();
      return keywords.some((keyword) => normalized.includes(keyword));
    })
    : [];

  for (const file of keywordAnchors) {
    addCoverageFile(required, frontier, file);
  }

  if (required.size === 0) {
    for (const file of sortedFiles) {
      const normalized = relative(cwd, file).replace(/\\/g, '/').toLowerCase();
      if (normalized.startsWith('src/') || normalized.startsWith('app/') || normalized.startsWith('pages/')) {
        addCoverageFile(required, frontier, file);
      }
    }
  }

  while (frontier.length > 0) {
    const current = frontier.pop();
    if (!current) {
      continue;
    }

    const localImports = await extractLocalImports(current, fileIndex);
    for (const imported of localImports) {
      addCoverageFile(required, frontier, imported);
    }

    for (const relatedTest of findRelatedTestFiles(current, fileIndex)) {
      addCoverageFile(required, frontier, relatedTest);
    }
  }

  return Array.from(required).map((file) => relative(cwd, file).replace(/\\/g, '/'));
}

function addCoverageFile(required: Set<string>, frontier: string[], file: string): void {
  if (required.has(file)) {
    return;
  }
  required.add(file);
  frontier.push(file);
}

async function extractLocalImports(file: string, fileIndex: Set<string>): Promise<string[]> {
  try {
    const content = await readFile(file, 'utf-8');
    const imports = new Set<string>();
    const patterns = [
      /from\s+['"]([^'"]+)['"]/g,
      /import\(\s*['"]([^'"]+)['"]\s*\)/g,
      /require\(\s*['"]([^'"]+)['"]\s*\)/g,
      /export\s+.*from\s+['"]([^'"]+)['"]/g,
    ];

    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        const specifier = match[1]?.trim();
        if (!specifier || !specifier.startsWith('.')) {
          continue;
        }
        const resolved = resolveLocalImport(file, specifier, fileIndex);
        if (resolved) {
          imports.add(resolved);
        }
      }
    }

    return Array.from(imports);
  } catch {
    return [];
  }
}

function resolveLocalImport(file: string, specifier: string, fileIndex: Set<string>): string | null {
  const basePath = join(dirname(file), specifier);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    join(basePath, 'index.ts'),
    join(basePath, 'index.tsx'),
    join(basePath, 'index.js'),
    join(basePath, 'index.jsx'),
    join(basePath, 'index.mjs'),
    join(basePath, 'index.cjs'),
  ];

  for (const candidate of candidates) {
    if (fileIndex.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function findRelatedTestFiles(file: string, fileIndex: Set<string>): string[] {
  const basename = file.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
  const candidates = [
    `${basename}.test.ts`,
    `${basename}.test.tsx`,
    `${basename}.test.js`,
    `${basename}.spec.ts`,
    `${basename}.spec.tsx`,
    `${basename}.spec.js`,
  ];
  return candidates.filter((candidate) => fileIndex.has(candidate));
}

async function collectRepositoryFiles(cwd: string): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [cwd];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    const entries = await safeReadDir(current);
    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      const relativePath = relative(cwd, absolutePath);
      if (!relativePath || relativePath.startsWith('..')) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          queue.push(absolutePath);
        }
        continue;
      }
      if (!(await isLikelyTextFile(absolutePath))) {
        continue;
      }
      results.push(absolutePath);
    }
  }

  return results;
}

function extractPlanningKeywords(source: string): string[] {
  const stopWords = new Set([
    'implement',
    'feature',
    'page',
    'pages',
    'screen',
    'task',
    'plan',
    'with',
    'from',
    'that',
    'this',
    'json',
    'user',
    'data',
    'form',
  ]);

  const tokens = new Set<string>();
  for (const match of source.toLowerCase().matchAll(/[a-z][a-z0-9_-]{2,}/g)) {
    const token = match[0];
    if (!stopWords.has(token)) {
      tokens.add(token);
    }
  }
  return Array.from(tokens).slice(0, 20);
}

function extractPlanningPathReferences(source: string): string[] {
  const references = new Set<string>();
  const matches = source.matchAll(/[`'"]?([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)[`'"]?/g);

  for (const match of matches) {
    const candidate = match[1]?.trim();
    if (!candidate) {
      continue;
    }
    if (candidate.startsWith('/')) {
      continue;
    }
    if (!candidate.includes('.')) {
      continue;
    }
    references.add(candidate.replace(/^\.?\//, ''));
  }

  return Array.from(references);
}

function limitPlanningReviewedFiles(files: string[]): { reviewedFiles: string[]; omittedCount: number } {
  const reviewedFiles: string[] = [];
  let totalChars = 0;

  for (const file of files) {
    const nextChars = totalChars + file.length + 1;
    if (
      reviewedFiles.length > 0
      && (reviewedFiles.length >= PLANNING_REVIEWED_FILES_MAX_COUNT || nextChars > PLANNING_REVIEWED_FILES_MAX_CHARS)
    ) {
      break;
    }
    reviewedFiles.push(file);
    totalChars = nextChars;
  }

  return {
    reviewedFiles,
    omittedCount: Math.max(0, files.length - reviewedFiles.length),
  };
}

function formatPlanningReviewedFiles(files: string[]): string {
  return files.length > 0 ? files.join('\n') : '(none)';
}

function truncatePlanningText(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) {
    return text;
  }

  const suffix = `\n...[${label} truncated due to planner prompt budget]`;
  if (maxChars <= suffix.length) {
    return suffix.trimStart();
  }

  return `${text.slice(0, maxChars - suffix.length).trimEnd()}${suffix}`;
}

function summarizePlannerOutput(output: string): string | undefined {
  const compact = output.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) {
    return undefined;
  }
  return truncateMessage(compact, 240);
}

function buildPlannerFailureDetail(error: string, outputPreview?: string): string {
  if (!outputPreview) {
    return error;
  }
  return `${error} | output: ${outputPreview}`;
}

async function readPlanningSnippet(path: string): Promise<string | null> {
  try {
    if (!(await isLikelyTextFile(path))) {
      return null;
    }
    const content = await readFile(path, 'utf-8');
    const lines = content
      .split(/\r?\n/)
      .slice(0, CODEBASE_CONTEXT_MAX_LINES)
      .map((line) => line.slice(0, 160));
    const snippet = lines.join('\n').trim();
    return snippet.length > 0 ? snippet : null;
  } catch {
    return null;
  }
}

async function isLikelyTextFile(path: string): Promise<boolean> {
  const extension = extname(path).toLowerCase();
  if (BINARY_FILE_EXTENSIONS.has(extension)) {
    return false;
  }

  let handle;
  try {
    handle = await open(path, 'r');
    const sample = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    if (bytesRead === 0) {
      return true;
    }

    let suspiciousBytes = 0;
    for (let index = 0; index < bytesRead; index += 1) {
      const byte = sample[index];
      if (byte === 0) {
        return false;
      }
      const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
      if (isControl) {
        suspiciousBytes += 1;
      }
    }

    return suspiciousBytes / bytesRead < 0.1;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {
      // ignore close errors and treat sniff result as authoritative
    });
  }
}

async function safeReadDir(path: string): Promise<Array<{ name: string; isDirectory(): boolean }>> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isGenericHeading(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  const generic = new Set([
    '概要',
    '背景',
    '背景・動機',
    '目的',
    'ゴール',
    '要件',
    '仕様',
    'summary',
    'overview',
    'background',
    'goal',
    'requirements',
    'specification',
  ]);
  return generic.has(normalized);
}

function buildLocalizedFallbackTemplate(language: DocumentLanguage): LocalizedFallbackTemplate {
  if (language === 'ja') {
    return {
      fallbackGoal: 'PRDの要件を実装する',
      defaultConstraint: '後方互換レイヤーを実装しない',
      defaultSuccess: 'すべてのマイルストーン検証を通過する',
      milestoneTitlePrefix: 'PRD実装',
      milestoneDescriptionPrefix: 'PRD 要件を段階的に実装するフェーズ',
      typecheckDescription: 'Typecheck を通過する',
      testDescription: 'テストスイートを通過する',
      featureFallbackDescription: 'PRD の要求スコープを実装する',
    };
  }
  return {
    fallbackGoal: 'Implement the requested product changes',
    defaultConstraint: 'No backward compatibility layer',
    defaultSuccess: 'All milestone validations pass',
    milestoneTitlePrefix: 'PRD implementation',
    milestoneDescriptionPrefix: 'Implement PRD requirements in this phase',
    typecheckDescription: 'Typecheck must pass',
    testDescription: 'Test suite must pass',
    featureFallbackDescription: 'Implement requested scope from PRD',
  };
}

function deriveFallbackPlanFromPrd(
  prd: string | null,
  localized: LocalizedFallbackTemplate
): {
  constraints: string[];
  successCriteria: string[];
  milestones: Array<{ title: string; description: string; features: string[] }>;
} | null {
  if (!prd || prd.trim().length === 0) {
    return null;
  }

  const lines = prd.split(/\r?\n/);
  const sections = parsePrdSections(lines)
    .filter((section) => !isGenericHeading(section.title))
    .map((section) => ({
      title: section.title,
      bullets: extractSectionFeatureBullets(section.lines),
      descriptionLine: section.lines.find((line) => line.trim().length > 0) ?? '',
    }))
    .filter((section) => section.bullets.length > 0 || section.descriptionLine.length > 0);

  let milestones = sections.slice(0, MAX_MILESTONES_PER_PLAN).map((section, index) => {
    const rawFeatures = (section.bullets.length > 0
      ? section.bullets
      : [truncateMessage(section.descriptionLine.trim(), 120)])
      .slice(0, 5)
      .filter((text) => text.length > 0);
    const features = coarsenFallbackFeatureDescriptions(rawFeatures, MAX_FEATURES_PER_MILESTONE);
    return {
      title: section.title,
      description: section.descriptionLine.trim().length > 0
        ? truncateMessage(section.descriptionLine.trim(), 140)
        : `${localized.milestoneDescriptionPrefix} ${index + 1}`,
      features,
    };
  }).filter((milestone) => milestone.features.length > 0);

  if (milestones.length === 0) {
    const globalBullets = lines
      .map((line) => normalizeBulletLine(line))
      .filter((line): line is string => line !== null)
      .filter((line) => line.length >= 8)
      .slice(0, 12);
    if (globalBullets.length > 0) {
      const chunkSize = Math.max(2, Math.ceil(globalBullets.length / 3));
      milestones = chunkArray(globalBullets, chunkSize).map((chunk, index) => ({
        title: `${localized.milestoneTitlePrefix} ${index + 1}`,
        description: `${localized.milestoneDescriptionPrefix} ${index + 1}`,
        features: chunk,
      }));
    }
  }

  const constraints = extractKeywordLines(lines, ['制約', 'constraint', 'must', '必須', 'しない', '禁止']).slice(0, 6);
  const successCriteria = extractKeywordLines(lines, ['受け入れ', 'acceptance', '成功', '完了条件', '検証', 'test', 'validation']).slice(0, 8);

  return {
    constraints,
    successCriteria,
    milestones,
  };
}

function coarsenFallbackFeatureDescriptions(features: string[], maxFeatures: number): string[] {
  if (features.length <= maxFeatures) {
    return features;
  }
  const chunkSize = Math.max(2, Math.ceil(features.length / maxFeatures));
  return chunkArray(features, chunkSize).map((chunk) => truncateMessage(chunk.join(' / '), 260));
}

function parsePrdSections(lines: string[]): Array<{ title: string; lines: string[] }> {
  const sections: Array<{ title: string; lines: string[] }> = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const headingMatch = line.match(/^\s{0,3}#{2,4}\s+(.+)$/);
    if (headingMatch) {
      if (current) {
        sections.push(current);
      }
      current = { title: headingMatch[1].trim(), lines: [] };
      continue;
    }
    if (!current) {
      continue;
    }
    current.lines.push(rawLine);
  }

  if (current) {
    sections.push(current);
  }
  return sections;
}

function extractSectionFeatureBullets(lines: string[]): string[] {
  return lines
    .map((line) => normalizeBulletLine(line))
    .filter((line): line is string => line !== null)
    .filter((line) => line.length >= 8)
    .slice(0, 8);
}

function normalizeBulletLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
  if (bulletMatch) {
    return truncateMessage(bulletMatch[1].trim(), 140);
  }
  const numberedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
  if (numberedMatch) {
    return truncateMessage(numberedMatch[1].trim(), 140);
  }
  return null;
}

function extractKeywordLines(lines: string[], keywords: string[]): string[] {
  const loweredKeywords = keywords.map((keyword) => keyword.toLowerCase());
  const out: string[] = [];
  for (const rawLine of lines) {
    const normalized = rawLine.trim();
    if (normalized.length < 6) {
      continue;
    }
    const lower = normalized.toLowerCase();
    if (!loweredKeywords.some((keyword) => lower.includes(keyword))) {
      continue;
    }
    const cleaned = normalized.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '');
    if (!out.includes(cleaned)) {
      out.push(truncateMessage(cleaned, 160));
    }
  }
  return out;
}

function chunkArray<T>(values: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

function truncateMessage(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
