import { writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
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
import type {
  ValidationCheckFailure,
  ValidationCheckResult,
} from '../state/validation.js';
import {
  isBlockingReviewFinding,
  normalizeProductReviewCheckpointResult,
  normalizeReviewArtifact,
  normalizeReviewFinding,
  type ProductReviewCheckpointResult,
  type ProductReviewContract,
  type ReviewArtifact,
} from '../state/review.js';
import { resolveFeatureExecutionCwd } from '../state/execution-cwd.js';
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

    const report = this.parseWorkReport(input, result.output, result.success, result.error);
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
    if (input.feature.kind === 'pull_request') {
      return this.buildPullRequestPrompt(input);
    }
    if (input.feature.kind === 'pr_followup') {
      return this.buildPullRequestFollowUpPrompt(input);
    }
    if (input.feature.kind === 'qa') {
      return this.buildQaPrompt(input);
    }
    return this.buildImplementationPrompt(input);
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
    const reviewEvidenceRules = (contract?.checkpoints ?? [])
      .map((checkpoint) => {
        const requirements = [
          checkpoint.evidenceMode ? `evidenceMode=${checkpoint.evidenceMode}` : null,
          checkpoint.reproduceBefore ? 'reproduceBefore=true' : null,
          checkpoint.requiredArtifacts?.length ? `artifacts=${checkpoint.requiredArtifacts.join(',')}` : null,
        ].filter((value): value is string => Boolean(value));
        return `- ${checkpoint.id} :: ${requirements.join(' ') || 'default screenshot evidence'}`;
      })
      .join('\n') || '- none';

    return [
      promptTemplate.trim(),
      '',
      '## ランタイムコンテキスト',
      `- ミッションゴール: ${input.missionPlan.mission.goal}`,
      `- マイルストーン: ${input.milestone.id} ${input.milestone.title}`,
      `- レビュー feature: ${input.feature.id} ${input.feature.description}`,
      `- レビュー世代: ${input.feature.reviewGeneration ?? 1}`,
      `- 実行 cwd: ${executionCwd}`,
      '',
      '## プロダクトレビュー契約',
      contract ? JSON.stringify(contract, null, 2) : '(契約なし)',
      '',
      '## 起動コマンド',
      startup,
      '',
      '## 前提条件',
      preconditions,
      '',
      '## チェックポイント',
      checkpoints,
      '',
      '## エビデンスルール',
      reviewEvidenceRules,
      '',
      '## Manager ブリーフィング',
      input.briefing?.trim() || '(なし)',
      '',
      '## PRD',
      input.prd?.trim() || '(PRD が見つからない)',
      '',
      '## 出力 JSON スキーマ',
      JSON.stringify({
        status: 'SUCCESS',
        summary: 'プロダクトレビューの要約',
        warnings: [],
        findings: [
          {
            id: 'product-finding-1',
            priority: 'P2',
            summary: '満たされていない要件の説明',
            rationale: 'サインオフをブロックする理由',
            suggestedFix: '修正すべき内容',
            trackingKey: 'stable-root-cause',
            surface: 'checkout-flow',
            affectedFiles: ['src/app.tsx'],
          },
        ],
        artifacts: [
          {
            kind: 'screenshot',
            path: `${contract?.artifactsDir ?? 'artifacts/screenshots'}/signoff-home.png`,
            label: '検証後のヒーロー状態',
            checkpointId: contract?.checkpoints?.[0]?.id ?? 'prd-goal',
            phase: 'after',
          },
        ],
        checkpointResults: [
          {
            checkpointId: contract?.checkpoints?.[0]?.id ?? 'prd-goal',
            passed: true,
            beforeReproduced: true,
            beforeObserved: '修正前に見えていたものの説明',
            afterObserved: '修正後の検証済み状態の説明',
            beforeScreenshotPath: `${contract?.artifactsDir ?? 'artifacts/screenshots'}/${contract?.checkpoints?.[0]?.id ?? 'prd-goal'}-before.png`,
            afterScreenshotPath: `${contract?.artifactsDir ?? 'artifacts/screenshots'}/${contract?.checkpoints?.[0]?.id ?? 'prd-goal'}-after.png`,
          },
        ],
        requestsHelp: false,
      }, null, 2),
      '',
      'ブラウザレビューが実際に実行された場合、契約チェックポイントごとに1つの `checkpointResults` エントリを必ず返す。',
      'すべてのビジュアルチェックポイントについて、少なくとも1つの `after` スクリーンショットをキャプチャし、`artifacts` と対応する `checkpointResults.afterScreenshotPath` の両方に含める。',
      '`evidenceMode=single` の場合、`passed` とキャプチャした `after*` アーティファクトパスを含むチェックポイントを含める。',
      '`artifacts` を返す場合、すべてのスクリーンショット/ビデオに対応する `checkpointId` と `phase` を含める。',
      '`checkpointResults` を省略するのは、レビュー開始前に `BLOCKED` を返す場合のみ。',
      '',
      'fenced json ブロックを1つだけ返す。',
    ].join('\n');
  }

  private async buildCodeReviewPrompt(input: WorkerInput): Promise<string> {
    const promptTemplate = await loadPromptFromPath(this.resolveCodeReviewPromptPath());
    const executionCwd = this.resolveExecutionCwd(input);

    return [
      promptTemplate.trim(),
      '',
      '## ランタイムコンテキスト',
      `- ミッションゴール: ${input.missionPlan.mission.goal}`,
      `- マイルストーン: ${input.milestone.id} ${input.milestone.title}`,
      `- レビュー feature: ${input.feature.id} ${input.feature.description}`,
      `- レビュー世代: ${input.feature.reviewGeneration ?? 1}`,
      `- 実行 cwd: ${executionCwd}`,
      '',
      '## Manager ブリーフィング',
      input.briefing?.trim() || '(なし)',
      '',
      '## PRD',
      input.prd?.trim() || '(PRD が見つからない)',
      '',
      '## 出力 JSON スキーマ',
      JSON.stringify({
        status: 'SUCCESS',
        summary: 'コードレビューの要約',
        warnings: [],
        findings: [
          {
            id: 'code-finding-1',
            priority: 'P2',
            summary: 'ブロッキングなコード問題の説明',
            rationale: 'サインオフをブロックする理由',
            suggestedFix: '修正すべき内容',
            trackingKey: 'stable-root-cause',
            surface: 'api-contract',
            affectedFiles: ['src/server.ts'],
          },
        ],
        artifacts: [],
        requestsHelp: false,
      }, null, 2),
      '',
      'fenced json ブロックを1つだけ返す。',
    ].join('\n');
  }

  private async buildPullRequestPrompt(input: WorkerInput): Promise<string> {
    const promptTemplate = await loadPromptFromPath(this.resolvePullRequestPromptPath());
    const executionCwd = this.resolveExecutionCwd(input);

    return [
      promptTemplate.trim(),
      '',
      '## ランタイムコンテキスト',
      `- ミッションゴール: ${input.missionPlan.mission.goal}`,
      `- マイルストーン: ${input.milestone.id} ${input.milestone.title}`,
      `- Feature: ${input.feature.id} ${input.feature.description}`,
      `- 実行 cwd: ${executionCwd}`,
      `- 現在のブランチ: ${input.currentBranch ?? '(未設定)'}`,
      `- ベースブランチ: ${input.baseBranch ?? '(未設定)'}`,
      `- git-new-pull-request スキル: ${this.resolveGitNewPullRequestSkillPath()}`,
      '- `gh pr create` や `gh pr edit` 等の非インタラクティブな GitHub CLI コマンドを使う',
      '',
      '## Manager ブリーフィング',
      input.briefing?.trim() || '(なし)',
      '',
      '## PRD',
      input.prd?.trim() || '(PRD が見つからない)',
      '',
      '## 出力 JSON スキーマ',
      JSON.stringify({
        status: 'SUCCESS',
        summary: 'PR を作成または更新した',
        filesChanged: [],
        validation: {
          testsRun: false,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: false,
          typecheckPassed: false,
        },
        checks: [],
        warnings: [],
        pullRequest: {
          number: 123,
          url: 'https://github.com/owner/repo/pull/123',
          title: 'feat: PR title',
          baseBranch: input.baseBranch ?? 'main',
          headBranch: input.currentBranch ?? 'current-branch',
          draft: false,
          action: 'created',
        },
        learnings: [],
        requestsHelp: false,
      }, null, 2),
      '',
      'fenced json ブロックを1つだけ返す。',
    ].join('\n');
  }

  private async buildPullRequestFollowUpPrompt(input: WorkerInput): Promise<string> {
    const promptTemplate = await loadPromptFromPath(this.resolvePullRequestFollowUpPromptPath());
    const executionCwd = this.resolveExecutionCwd(input);

    return [
      promptTemplate.trim(),
      '',
      '## ランタイムコンテキスト',
      `- ミッションゴール: ${input.missionPlan.mission.goal}`,
      `- マイルストーン: ${input.milestone.id} ${input.milestone.title}`,
      `- Feature: ${input.feature.id} ${input.feature.description}`,
      `- 実行 cwd: ${executionCwd}`,
      `- 現在のブランチ: ${input.currentBranch ?? '(未設定)'}`,
      `- ベースブランチ: ${input.baseBranch ?? '(未設定)'}`,
      `- melos-ci-fix-loop スキル: ${this.resolveMelosCiFixLoopSkillPath()}`,
      `- git-commit スキル: ${this.resolveGitCommitSkillPath()}`,
      '- `gh pr view --json ...`、`gh api graphql`、`gh pr checks --required` で PR の状態を取得する',
      '- このフォローアップステップからネストされた `npx melos` を呼び出さない',
      '',
      '## Manager ブリーフィング',
      input.briefing?.trim() || '(なし)',
      '',
      '## PRD',
      input.prd?.trim() || '(PRD が見つからない)',
      '',
      '## 出力 JSON スキーマ',
      JSON.stringify({
        status: 'SUCCESS',
        summary: '対応可能な PR フィードバックを処理し、静穏ウィンドウまで待機した',
        filesChanged: [{ path: 'src/file.ts', additions: 10, deletions: 2 }],
        validation: {
          testsRun: true,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: [],
        warnings: ['対象外のフィードバックをスキップ: スキップした理由を説明'],
        pullRequest: {
          number: 123,
          url: 'https://github.com/owner/repo/pull/123',
          title: 'feat: PR title',
          baseBranch: input.baseBranch ?? 'main',
          headBranch: input.currentBranch ?? 'current-branch',
          draft: false,
          action: 'updated',
        },
        pullRequestFollowUp: {
          handledFeedbackIds: ['PRRC_kwDO_example'],
          lastExternalActivityAt: '2026-03-07T09:00:00.000Z',
          quietUntil: '2026-03-07T09:30:00.000Z',
        },
        learnings: [],
        requestsHelp: false,
      }, null, 2),
      '',
      'fenced json ブロックを1つだけ返す。',
    ].join('\n');
  }

  private async buildImplementationPrompt(input: WorkerInput): Promise<string> {
    const promptTemplate = await loadPromptFromPath(this.resolveWorkerPromptPath());
    const featureChecks = input.feature.checks?.map((check) => `- ${check.text}`).join('\n') || '- なし';
    const executionCwd = this.resolveExecutionCwd(input);
    const sections = [
      promptTemplate.trim(),
      '',
      '## ランタイムコンテキスト',
      `- ミッションゴール: ${input.missionPlan.mission.goal}`,
      `- マイルストーン: ${input.milestone.id} ${input.milestone.title}`,
      `- Feature: ${input.feature.id} ${input.feature.description}`,
      `- 実行 cwd: ${executionCwd}`,
      `- 現在のブランチ: ${input.currentBranch ?? '(未設定)'}`,
      `- ベースブランチ: ${input.baseBranch ?? '(未設定)'}`,
      '',
      '## Feature チェック',
      featureChecks,
      '',
      '## Manager ブリーフィング',
      input.briefing?.trim() || '(なし)',
      '',
      '## 保護されたランタイムファイル',
      '- TASK.json は編集しない。',
      '- `.melos/state.json`、`.melos/validations/*`、`.melos/reviews/*` は編集しない。',
      '- バリデーションのセマンティクスがおかしく見える場合、ランタイム状態をパッチするのではなく `warnings` で報告する。',
      '',
      '## PRD',
      input.prd?.trim() || '(PRD が見つからない)',
      '',
      '## バリデーション境界',
      '- この feature のローカル実装と、この feature が直接要求するチェックを完了する。',
      '- マイルストーンレベルのバリデーションと専用 QA はオーケストレーターが管理する下流ステップ。未実行のマイルストーン QA を feature の失敗として扱わない。',
      '- 専用 QA が実行されていない、`expected=no_match` が非ゼロ終了する可能性がある、無関係な既存リポジトリ警告がある、no-op 結果でコミットが作成されなかった、といった理由だけで warnings を追加しない。',
      '- 問題が現在のツリーで既に修正済みの場合、新しい修正を実装したふりをするのではなく `resultKind` を `verified_existing` に設定する。',
      '- ブロッカーがアプリコードではなく仕様/フィクスチャ/エビデンス/ツーリングの問題である場合、`resultKind` を `contract_gap` または `tooling_gap` として報告し、`changeScope` を正確に設定する。',
    ];

    if (this.shouldIncludeCommitWorkflow(input)) {
      sections.push(
        '',
        '## コミットワークフロー',
        `- コミットメッセージとワークフローは git-commit スキル（${this.resolveGitCommitSkillPath()}）に従う。`,
        '- コミット前に確認: `git status --porcelain`、`git log --oneline -20`、`git diff --staged`',
        '- 現在のブランチで実装とスコープローカルのバリデーションが完了してからコミットする'
      );
    }

    sections.push(
      '',
      '## 出力 JSON スキーマ',
      JSON.stringify({
        status: 'SUCCESS',
        resultKind: 'implemented',
        changeScope: 'tracked',
        problemKeys: ['stable-root-cause'],
        summary: 'やったこと',
        filesChanged: [{ path: 'src/file.ts', additions: 10, deletions: 2 }],
        validation: {
          testsRun: true,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: true,
          typecheckPassed: true,
        },
        checks: [],
        warnings: ['フォールバック、未検証のスコープ、ユーザーのフォローアップが必要な場合にここに記述'],
        learnings: [],
        requestsHelp: false,
      }, null, 2),
      '',
      'fenced json ブロックを1つだけ返す。'
    );

    return sections.join('\n');
  }

  private async buildQaPrompt(input: WorkerInput): Promise<string> {
    const promptTemplate = await loadPromptFromPath(this.resolveWorkerPromptPath());
    const executionCwd = this.resolveExecutionCwd(input);
    const qaChecks = this.formatQaChecks(input);
    const validationCommands = [
      ...input.milestone.validationContract.staticChecks,
      ...input.milestone.validationContract.testSuites,
    ]
      .map((check) => check.command)
      .filter((command): command is string => typeof command === 'string' && command.trim().length > 0)
      .join('\n');
    const qaPhase = input.feature.qaPhase === 'baseline' ? 'baseline' : 'after';

    return [
      promptTemplate.trim(),
      '',
      '## QA モード',
      `- この feature はマイルストーン専用の QA 実行ステップ（${qaPhase}）。`,
      '- QA 環境が完全にブロックされ、Manager がセットアップのみの変更をブリーフィングした場合を除き、コードを変更しない。',
      '- このステップからコミットやブランチを作成しない。',
      qaPhase === 'baseline'
        ? '- `evidenceMode=before_after` かつ `reproduceBefore=true` の qaChecks のベースライン/before エビデンスのみキャプチャする。このフェーズで after エビデンスを捏造しない。'
        : '- 以下の qaChecks を実行し、すべての checkId を `checks` に報告する。before/after チェックの場合、after エビデンスを添付し、ベースラインとの紐付けを維持する。',
      '- qaCheck が失敗した場合、その失敗を `checks` 内に保持する。QA チェックリスト自体が実行されエビデンスがキャプチャされたら feature ステータス `SUCCESS` を返す。',
      '- 環境、認証情報、起動、ツーリングのブロッカーにより QA を実行できなかった場合のみ `BLOCKED` を返す。',
      '',
      '## ランタイムコンテキスト',
      `- ミッションゴール: ${input.missionPlan.mission.goal}`,
      `- マイルストーン: ${input.milestone.id} ${input.milestone.title}`,
      `- QA feature: ${input.feature.id} ${input.feature.description}`,
      `- 実行 cwd: ${executionCwd}`,
      '',
      '## Manager ブリーフィング',
      input.briefing?.trim() || '(なし)',
      '',
      '## 保護されたランタイムファイル',
      '- TASK.json は編集しない。',
      '- `.melos/state.json`、`.melos/validations/*`、`.melos/reviews/*` は編集しない。',
      '',
      '## PRD',
      input.prd?.trim() || '(PRD が見つからない)',
      '',
      '## QA チェック',
      qaChecks,
      '',
      '## 参照用バリデーションコマンド',
      validationCommands || '(なし)',
      '',
      '## 出力 JSON スキーマ',
      JSON.stringify({
        status: 'SUCCESS',
        summary: 'QA チェックリストを実行した',
        filesChanged: [],
        validation: {
          testsRun: false,
          testsPassed: 0,
          testsFailed: 0,
          lintPassed: false,
          typecheckPassed: false,
        },
        checks: [
          {
            checkId: 'm1-qa-1',
            passed: true,
            runner: 'playwright-interactive',
            beforeReproduced: true,
            beforeScreenshotPath: 'artifacts/screenshots/m1-qa-1-before.png',
            afterScreenshotPath: 'artifacts/screenshots/m1-qa-1-after.png',
            beforeObserved: '再現した before 状態の説明',
            afterObserved: '検証した after 状態の説明',
          },
          {
            checkId: 'm1-qa-2',
            passed: false,
            failure: {
              summary: 'QA 観察が失敗した',
              affectedFiles: [],
              errorMessages: ['何が失敗したかを記述'],
            },
          },
        ],
        warnings: ['QA 実行に影響したフォールバックや注意点があれば記述'],
        learnings: [],
        requestsHelp: false,
      }, null, 2),
      '',
      'fenced json ブロックを1つだけ返す。',
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

  private resolvePullRequestPromptPath(): string {
    const promptsDir = isAbsolute(this.config.promptsDir)
      ? this.config.promptsDir
      : resolve(this.config.cwd, this.config.promptsDir);
    return join(promptsDir, 'pull-request.md');
  }

  private resolvePullRequestFollowUpPromptPath(): string {
    const promptsDir = isAbsolute(this.config.promptsDir)
      ? this.config.promptsDir
      : resolve(this.config.cwd, this.config.promptsDir);
    return join(promptsDir, 'pr-followup.md');
  }

  private resolveProductReviewContract(input: WorkerInput): ProductReviewContract | undefined {
    const contract = input.missionPlan.productReviewContract;
    const scopedCheckpointIds = input.feature.scopedReviewCheckpointIds;
    if (!contract || !scopedCheckpointIds || scopedCheckpointIds.length === 0) {
      return contract;
    }
    const checkpoints = contract.checkpoints.filter((checkpoint) => scopedCheckpointIds.includes(checkpoint.id));
    if (checkpoints.length === 0) {
      return contract;
    }
    return {
      ...contract,
      checkpoints,
    };
  }

  private resolveSkillPath(skillId: string): string {
    const candidates = skillId === 'git-commit' || skillId === 'git-committer'
      ? ['git-commit', 'git-committer']
      : [skillId];

    for (const candidate of candidates) {
      const skillPath = join(this.config.cwd, '.claude', 'skills', candidate, 'SKILL.md');
      if (existsSync(skillPath)) {
        return skillPath;
      }
    }

    const preferredPath = join(this.config.cwd, '.claude', 'skills', candidates[0]!, 'SKILL.md');
    throw new Error(`Required skill not found: ${skillId} (${preferredPath})`);
  }

  private resolveGitCommitSkillPath(): string {
    return this.resolveSkillPath('git-commit');
  }

  private resolveGitNewPullRequestSkillPath(): string {
    return this.resolveSkillPath('git-new-pull-request');
  }

  private resolveMelosCiFixLoopSkillPath(): string {
    return this.resolveSkillPath('melos-ci-fix-loop');
  }

  private formatQaChecks(input: WorkerInput): string {
    return (input.milestone.validationContract.qaChecks ?? [])
      .map((check) => {
        const action = typeof check.command === 'string' && check.command.trim().length > 0
          ? check.command.trim()
          : (check.type === 'browser'
              ? 'report browser evidence in `checks` with runner plus screenshot/video paths or URLs'
              : check.type === 'e2e'
                ? 'report structured e2e evidence in `checks`'
                : 'report structured QA evidence in `checks`');
        const requirementNotes = [
          check.requiredRunner ? `runner=${check.requiredRunner}` : null,
          check.requiredArtifacts?.length ? `artifacts=${check.requiredArtifacts.join(',')}` : null,
          check.artifactNames?.length ? `artifactNames=${check.artifactNames.join(',')}` : null,
          check.preconditions?.length ? `preconditions=${check.preconditions.join(' | ')}` : null,
          check.deterministicInputs?.length ? `deterministicInputs=${check.deterministicInputs.join(' | ')}` : null,
          check.evidenceMode ? `evidenceMode=${check.evidenceMode}` : null,
          check.reproduceBefore ? 'reproduceBefore=true' : null,
        ].filter((item): item is string => Boolean(item));
        const requirements = requirementNotes.length > 0 ? ` [${requirementNotes.join(' ')}]` : '';
        return `- ${check.id} [${check.type}] ${check.description}${requirements} :: ${action}`;
      })
      .join('\n') || '- none';
  }

  private shouldIncludeCommitWorkflow(input: WorkerInput): boolean {
    if (!input.currentBranch) {
      return false;
    }
    return input.feature.kind === 'implementation' || input.feature.kind === 'review_remediation';
  }

  private parseWorkReport(
    input: WorkerInput,
    output: string,
    engineSuccess: boolean,
    engineError?: string
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
      learnings: [],
      requestsHelp: false,
      createdAt: new Date().toISOString(),
    };

    let parsedStructuredReport = false;
    const jsonBlock = extractJsonBlock(output);
    if (jsonBlock) {
      try {
        const parsed = JSON.parse(jsonBlock) as Partial<WorkerFeatureReport>;
        parsedStructuredReport = true;
        if (parsed.status) {
          report.status = parsed.status;
        }
        if (parsed.resultKind === 'implemented'
          || parsed.resultKind === 'verified_existing'
          || parsed.resultKind === 'contract_gap'
          || parsed.resultKind === 'tooling_gap'
          || parsed.resultKind === 'env_blocked') {
          report.resultKind = parsed.resultKind;
        }
        if (parsed.changeScope === 'tracked'
          || parsed.changeScope === 'untracked'
          || parsed.changeScope === 'gitignored'
          || parsed.changeScope === 'none') {
          report.changeScope = parsed.changeScope;
        }
        if (Array.isArray(parsed.problemKeys)) {
          report.problemKeys = parsed.problemKeys.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
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
        const pullRequest = normalizePullRequestState((parsed as { pullRequest?: unknown }).pullRequest);
        if (pullRequest) {
          report.pullRequest = pullRequest;
        }
        const pullRequestFollowUp = normalizePullRequestFollowUpState((parsed as { pullRequestFollowUp?: unknown }).pullRequestFollowUp);
        if (pullRequestFollowUp) {
          report.pullRequestFollowUp = pullRequestFollowUp;
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
          const checkpointResults = (Array.isArray((parsed as { checkpointResults?: unknown[] }).checkpointResults)
            ? (parsed as { checkpointResults?: unknown[] }).checkpointResults ?? []
            : [])
            .map((result) => normalizeProductReviewCheckpointResult(result))
            .filter((result): result is NonNullable<typeof result> => Boolean(result));
          const normalizedArtifacts = synthesizeReviewArtifactsFromCheckpointResults(artifacts, checkpointResults);
          report.review = {
            reviewType,
            generation: input.feature.reviewGeneration ?? 1,
            passed: findings.every((finding) => !isBlockingReviewFinding(finding))
              && parsed.status !== 'FAILED'
              && parsed.status !== 'BLOCKED',
            summary: typeof parsed.summary === 'string' ? parsed.summary : '',
            findings,
            artifacts: normalizedArtifacts,
            checkpointResults: checkpointResults.length > 0 ? checkpointResults : undefined,
          };
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
      const reviewType = input.feature.reviewType;
      const summary = report.summary
        || output.split(/\n/).find((line) => line.trim().length > 0)?.trim()
        || engineError?.trim()
        || `${reviewType} review could not be completed`;
      const blockedSummary = `${capitalizeLabel(reviewType)} review is blocked`;
      const rationale = engineError
        ? `The review executor did not return a structured final review report. Engine error: ${engineError}`
        : 'The review executor did not return a structured final review report.';
      report.status = 'BLOCKED';
      report.requestsHelp = true;
      report.summary = summary;
      report.warnings = normalizeWarnings([
        ...report.warnings,
        engineError ? `review engine error: ${engineError}` : 'review executor returned no structured JSON report',
      ]);
      report.review = {
        reviewType,
        generation: input.feature.reviewGeneration ?? 1,
        passed: false,
        summary,
        findings: [
          {
            id: `${reviewType}-review-blocked`,
            reviewType,
            priority: 'P1',
            summary: blockedSummary,
            rationale,
            suggestedFix: 'Retry the final review after restoring the review runtime and ensure the executor returns the required fenced JSON report.',
            trackingKey: `${reviewType}-review-blocked`,
            surface: `${reviewType}-review-runtime`,
            affectedFiles: [],
          },
        ],
        artifacts: [],
      };
    }

    if (!input.feature.reviewType && !parsedStructuredReport) {
      report.status = 'FAILED';
      report.requestsHelp = true;
      report.summary = 'worker did not return a structured JSON report';
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
    const disallowThreadReuse = input.feature.kind === 'review' || input.feature.kind === 'qa';
    const threadId = shouldResume && this.resumeThreadId
      && !disallowThreadReuse
      ? this.resumeThreadId
      : undefined;

    return {
      cwd: this.resolveExecutionCwd(input),
      model: resolveRuntimeModel(this.config.model, CODEX_LATEST_ALIAS),
      reasoningEffort: this.config.reasoningEffort || 'high',
      enabledFeatures: this.shouldEnableJsRepl(input) ? ['js_repl'] : undefined,
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
    if (input.feature.kind === 'qa') {
      return false;
    }
    if (input.feature.kind === 'pull_request' || input.feature.kind === 'pr_followup') {
      return true;
    }
    return isClaudeFamily(input.feature.model);
  }

  private resolveExecutionCwd(input: WorkerInput): string {
    return resolveFeatureExecutionCwd(this.config.cwd, {
      feature: input.feature,
      missionPlan: input.missionPlan,
    });
  }

  private shouldEnableJsRepl(input: WorkerInput): boolean {
    if (input.feature.kind === 'review' && input.feature.reviewType === 'product') {
      return true;
    }
    if (input.feature.kind !== 'qa') {
      return false;
    }
    return (input.milestone.validationContract.qaChecks ?? []).some((check) => check.type === 'browser');
  }
}

function capitalizeLabel(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
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
    if (typeof record.beforeScreenshotPath === 'string' && record.beforeScreenshotPath.trim().length > 0) {
      result.beforeScreenshotPath = record.beforeScreenshotPath.trim();
    }
    if (typeof record.afterScreenshotPath === 'string' && record.afterScreenshotPath.trim().length > 0) {
      result.afterScreenshotPath = record.afterScreenshotPath.trim();
    }
    if (typeof record.beforeVideoPath === 'string' && record.beforeVideoPath.trim().length > 0) {
      result.beforeVideoPath = record.beforeVideoPath.trim();
    }
    if (typeof record.afterVideoPath === 'string' && record.afterVideoPath.trim().length > 0) {
      result.afterVideoPath = record.afterVideoPath.trim();
    }
    if (typeof record.beforeScreenshotUrl === 'string' && record.beforeScreenshotUrl.trim().length > 0) {
      result.beforeScreenshotUrl = record.beforeScreenshotUrl.trim();
    }
    if (typeof record.afterScreenshotUrl === 'string' && record.afterScreenshotUrl.trim().length > 0) {
      result.afterScreenshotUrl = record.afterScreenshotUrl.trim();
    }
    if (typeof record.beforeVideoUrl === 'string' && record.beforeVideoUrl.trim().length > 0) {
      result.beforeVideoUrl = record.beforeVideoUrl.trim();
    }
    if (typeof record.afterVideoUrl === 'string' && record.afterVideoUrl.trim().length > 0) {
      result.afterVideoUrl = record.afterVideoUrl.trim();
    }
    if (typeof record.beforeReproduced === 'boolean') {
      result.beforeReproduced = record.beforeReproduced;
    }
    if (typeof record.beforeObserved === 'string' && record.beforeObserved.trim().length > 0) {
      result.beforeObserved = record.beforeObserved.trim();
    }
    if (typeof record.afterObserved === 'string' && record.afterObserved.trim().length > 0) {
      result.afterObserved = record.afterObserved.trim();
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

function normalizePullRequestState(value: unknown): WorkerFeatureReport['pullRequest'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const url = typeof record.url === 'string' ? record.url.trim() : '';
  const baseBranch = typeof record.baseBranch === 'string' ? record.baseBranch.trim() : '';
  const headBranch = typeof record.headBranch === 'string' ? record.headBranch.trim() : '';
  const action = record.action === 'created' || record.action === 'updated'
    ? record.action
    : null;
  if (!url || !baseBranch || !headBranch || !action) {
    return undefined;
  }

  return {
    number: typeof record.number === 'number' && Number.isFinite(record.number)
      ? Math.max(1, Math.floor(record.number))
      : undefined,
    url,
    title: typeof record.title === 'string' && record.title.trim().length > 0
      ? record.title.trim()
      : undefined,
    baseBranch,
    headBranch,
    draft: record.draft === true,
    action,
    updatedAt: typeof record.updatedAt === 'string' && record.updatedAt.trim().length > 0
      ? record.updatedAt
      : new Date().toISOString(),
  };
}

function normalizePullRequestFollowUpState(value: unknown): WorkerFeatureReport['pullRequestFollowUp'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const handledFeedbackIds = Array.isArray(record.handledFeedbackIds)
    ? record.handledFeedbackIds
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    : [];

  return {
    handledFeedbackIds,
    lastExternalActivityAt: typeof record.lastExternalActivityAt === 'string' && record.lastExternalActivityAt.trim().length > 0
      ? record.lastExternalActivityAt
      : null,
    quietUntil: typeof record.quietUntil === 'string' && record.quietUntil.trim().length > 0
      ? record.quietUntil
      : null,
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

function synthesizeReviewArtifactsFromCheckpointResults(
  artifacts: ReviewArtifact[],
  checkpointResults: ProductReviewCheckpointResult[]
): ReviewArtifact[] {
  const existingKeys = new Set(
    artifacts.map((artifact) => `${artifact.kind}:${artifact.checkpointId ?? ''}:${artifact.phase ?? ''}:${artifact.path}`)
  );
  const synthesized = [...artifacts];

  for (const result of checkpointResults) {
    const candidates: Array<ReviewArtifact | null> = [
      result.beforeScreenshotPath
        ? { kind: 'screenshot', path: result.beforeScreenshotPath, checkpointId: result.checkpointId, phase: 'before' }
        : null,
      result.afterScreenshotPath
        ? { kind: 'screenshot', path: result.afterScreenshotPath, checkpointId: result.checkpointId, phase: 'after' }
        : null,
      result.beforeVideoPath
        ? { kind: 'video', path: result.beforeVideoPath, checkpointId: result.checkpointId, phase: 'before' }
        : null,
      result.afterVideoPath
        ? { kind: 'video', path: result.afterVideoPath, checkpointId: result.checkpointId, phase: 'after' }
        : null,
    ];

    for (const artifact of candidates) {
      if (!artifact) {
        continue;
      }
      const key = `${artifact.kind}:${artifact.checkpointId ?? ''}:${artifact.phase ?? ''}:${artifact.path}`;
      if (existingKeys.has(key)) {
        continue;
      }
      existingKeys.add(key);
      synthesized.push(artifact);
    }
  }

  return synthesized;
}
