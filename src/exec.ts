import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppServerEngine } from './engines/app-server.js';
import { ClaudeEngine } from './engines/claude.js';
import { isClaudeFamily, resolveRuntimeModel } from './models/registry.js';
import type { Engine, EngineOptions } from './engines/base.js';

export interface ExecOptions {
  model: string;
  cwd: string;
  effort: string;
  criteria: string;
  maxIterations: number;
  noAsk: boolean;
  steering: string;
}

export function parseSignal(output: string): 'complete' | 'question' | 'continue' {
  if (output.includes('<question>')) return 'question';
  if (output.includes('<complete></complete>')) return 'complete';
  return 'continue';
}

export function extractQuestion(output: string): string {
  const match = output.match(/<question>([\s\S]*?)<\/question>/);
  return match?.[1]?.trim() ?? '';
}

export function buildPrompt(
  task: string,
  criteria: string,
  handoff: string,
  steering: string,
  iteration: number,
  noAsk: boolean,
  progressLog?: string,
): string {
  const sections: string[] = [];

  sections.push(`## Task\n\n${task}`);
  sections.push(`## Completion Criteria\n\n${criteria}`);

  if (steering) {
    sections.push(`## Steering\n\n${steering}`);
  }

  if (progressLog) {
    sections.push(`## Progress Log\n\nThe file \`.melos/progress.md\` contains notes from previous iterations:\n\n${progressLog}`);
  }

  if (handoff) {
    sections.push(`## Previous Progress (Iteration ${iteration})\n\nFiles changed so far:\n${handoff}`);
  }

  const instructions: string[] = [
    'Work on the task above.',
    `When you have fully completed the task and all criteria are met, output <complete></complete>.`,
  ];

  if (!noAsk) {
    instructions.push(
      `If any of the following apply, you MUST stop and ask by outputting <question>your question here</question> instead of making assumptions:`,
    );
    sections.push(`## Instructions\n\n${instructions.map((s) => `- ${s}`).join('\n')}`);
    sections.push(`## When to Ask

You MUST ask a question (\`<question>...</question>\`) before proceeding if:

- **Architecture/technology choice is unspecified** — e.g., which framework, library, authentication method (JWT vs session), database, etc.
- **Multiple valid interpretations exist** — the task or criteria can be read in more than one reasonable way
- **Scope is unclear** — it's not obvious what files, modules, or boundaries the task covers
- **Breaking changes are involved** — the task might require changes that affect other parts of the system
- **No existing patterns to follow** — there is no prior code in the repo to infer the expected style or approach

Do NOT ask about things you can determine by reading the codebase. Only ask about decisions that require human judgment.
When you ask, be specific: state what you've already investigated, what the options are, and what you need to decide.`);
  } else {
    instructions.push(
      'Make your own decisions without asking questions. Use your best judgment.',
    );
    sections.push(`## Instructions\n\n${instructions.map((s) => `- ${s}`).join('\n')}`);
  }

  sections.push(`## Git Commit Convention

意味のある単位でこまめにコミットする。各コミットは次のイテレーションへの引き継ぎであり、Manager が進捗を監視するための**実行ログ**になる。Manager は \`git log\` を読んで何をしたか・なぜそうしたか・どんな判断をしたかを把握するので、コミットメッセージはその推論を再構成できる詳細さで書くこと。

### Format

\`\`\`
prefix: 変更内容の要約

本文: diff から読み取れない「なぜ」を中心に書く。
経緯・背景、問題、判断理由、結果を散文で記述する。
\`\`\`

### Prefixes

- \`feat:\` — 新機能
- \`fix:\` — バグ修正
- \`update:\` — 既存機能の改善
- \`refactor:\` — 振る舞いを変えない構造変更
- \`test:\` — テストのみ
- \`chore:\` — メンテナンス、依存関係の更新

### 本文の構成

本文は**常に必須**（軽微な変更でも）。散文形式で以下を書く:

1. **経緯・背景**: そもそも何をしようとしていたのか、どういう状況だったのか
2. **問題**: 何が起きていたのか（バグ修正の場合は再現条件や症状）
3. **判断**: どんな選択肢を検討し、なぜこのアプローチを選んだのか
4. **結果**: 結果はどうなったか。残っている懸念やフォローアップはあるか

ファイル変更の箇条書きではなく散文で書くこと。diff を見れば何が変わったかは分かる。本文には「なぜその変更をしたか」「どんな判断がそこに至ったか」を書く。

### Example

\`\`\`
fix: 折りたたみサイドバー時の初回ロードで白紙になる問題を修正

開閉トランジション時のちらつきを解消するため、CollapsedSidebar を
常時マウント方式に変更していた（前回コミット）。

しかし常時マウントにしたことで、ページ読み込み直後に
CollapsedSidebar 内の useLazyLoadQuery が発火し、Suspense
境界がないまま Promise が throw されて RequireAccountLogin の
エラーバウンダリに到達、ページ全体が白紙になっていた。

CollapsedSidebar を Suspense で囲むことで、データ取得中の
一時停止を吸収するようにした。また isMounted ガードを追加し、
SSR 時の Suspense ハイドレーション不整合も回避した。
\`\`\`

### Rules

- コミットメッセージに個人名を含めない
- 変更ファイルの列挙だけの本文は書かない（その情報は diff にある）
- 意味のある作業単位ごとにコミットする（最後にまとめてではなく）
- 秘密ファイル（.env, credentials.json 等）は絶対にコミットしない
- \`.melos/\` ディレクトリは絶対にコミットしない（melos exec の一時作業ディレクトリ）`);

  sections.push(`## Progress Tracking

Before your session ends, append a progress entry to \`.melos/progress.md\`.

### Format

\`\`\`markdown
## Iteration ${iteration}

### Status: [🟢 On Track | 🟡 Partial | 🔴 Blocked]

### What Was Done
- [action taken and its outcome]

### Key Decisions
- [what you chose] — [why; what alternatives you considered]

### Current State
- Tests: [pass/fail count, specific failures]
- Build: [compiles? type errors?]
- Modified files: \`path/to/file.ts\` — [what changed and why]

### Next Steps
1. **Immediate**: [the single most important next action]
2. **Then**: [subsequent actions in priority order]

### Blockers / Open Questions
- [ ] [anything preventing progress — be specific]
\`\`\`

### Rules

- Write as if briefing a colleague who has zero context beyond this file and the git log
- Be specific: "test_auth fails with 'JWT expired' on line 42" not "some tests fail"
- Include error messages verbatim — the next iteration cannot see your terminal
- Decisions without rationale are useless`);

  return sections.join('\n\n');
}

export function createEngine(model: string): Engine {
  if (isClaudeFamily(model)) {
    return new ClaudeEngine();
  }
  return new AppServerEngine();
}

export function buildEngineOptions(model: string, opts: ExecOptions): EngineOptions {
  const runtimeModel = resolveRuntimeModel(model);
  const base = { cwd: opts.cwd, model: runtimeModel, timeout: 4 * 60 * 60 * 1000 }; // 4h fail-safe for exec
  if (isClaudeFamily(model)) {
    return { ...base, effort: opts.effort as EngineOptions['effort'] };
  }
  return { ...base, reasoningEffort: opts.effort as EngineOptions['reasoningEffort'] };
}

function createExecLogger(cwd: string) {
  const melosDir = join(cwd, '.melos');
  mkdirSync(melosDir, { recursive: true });
  const logPath = join(melosDir, 'exec.log');
  writeFileSync(logPath, '');
  return {
    path: logPath,
    log(message: string) {
      appendFileSync(logPath, message + '\n');
    },
    appendChunk(chunk: string) {
      appendFileSync(logPath, chunk);
    },
  };
}

export async function exec(task: string, options: ExecOptions): Promise<boolean> {
  const engine = createEngine(options.model);
  const engineOpts = buildEngineOptions(options.model, options);
  const logger = createExecLogger(options.cwd);

  logger.log(`=== melos exec ===`);
  logger.log(`Task: ${task}`);
  logger.log(`Criteria: ${options.criteria}`);
  logger.log(`Model: ${options.model}`);
  logger.log(`Started: ${new Date().toISOString()}`);
  logger.log('');

  process.stderr.write(`log: ${logger.path}\n`);

  try {
    const startHead = gitHead(options.cwd);
    clearProgressLog(options.cwd);

    for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
      const handoff = iteration > 1 ? gitDiffStat(options.cwd, startHead) : '';
      const progressLog = readProgressLog(options.cwd);
      const prompt = buildPrompt(task, options.criteria, handoff, options.steering, iteration, options.noAsk, progressLog);

      process.stderr.write(`[iteration ${iteration}/${options.maxIterations}]\n`);
      logger.log(`--- iteration ${iteration}/${options.maxIterations} [${new Date().toISOString()}] ---`);

      const optsWithLogging = {
        ...engineOpts,
        onStream: (chunk: string) => logger.appendChunk(chunk),
        onCommandOutput: (chunk: string) => logger.log(`[cmd] ${chunk}`),
        suppressTerminalOutput: true,
      };

      const result = await engine.execute(prompt, optsWithLogging);

      if (!result.success) {
        const msg = `engine error: ${result.error || 'unknown'}`;
        process.stderr.write(`  ✗ ${msg}\n`);
        logger.log(`\n--- error: ${msg} ---`);
        return false;
      }

      const signal = parseSignal(result.output);
      logger.log(`\n--- signal: ${signal} ---`);

      if (signal === 'question') {
        const question = extractQuestion(result.output);
        process.stderr.write(`\n⏸ ${question}\n`);
        logger.log(`question: ${question}`);
        return false;
      }

      if (signal === 'complete') {
        process.stderr.write(`✓ complete\n`);
        logger.log(`\n=== complete [${new Date().toISOString()}] ===`);
        return true;
      }

      // signal === 'continue' — auto-continue to next iteration
      process.stderr.write(`  → continuing...\n`);
    }

    process.stderr.write(`✗ max iterations (${options.maxIterations}) reached\n`);
    logger.log(`\n=== max iterations reached [${new Date().toISOString()}] ===`);
    return false;
  } finally {
    if ('shutdown' in engine && typeof engine.shutdown === 'function') {
      await engine.shutdown();
    }
  }
}

function gitHead(cwd: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function readProgressLog(cwd: string): string {
  try {
    const progressPath = join(cwd, '.melos', 'progress.md');
    return readFileSync(progressPath, 'utf-8').trim();
  } catch {
    return '';
  }
}

function clearProgressLog(cwd: string): void {
  try {
    const progressPath = join(cwd, '.melos', 'progress.md');
    writeFileSync(progressPath, '');
  } catch {
    // .melos/ may not exist yet — createExecLogger will create it
  }
}

function gitDiffStat(cwd: string, before: string): string {
  try {
    const parts: string[] = [];
    const after = gitHead(cwd);
    if (before && after && before !== after) {
      const committed = execSync(`git diff --stat ${before}..${after}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (committed) parts.push(committed);
    }
    // Uncommitted changes (staged + unstaged + untracked)
    const dirty = execSync('git diff --stat', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (dirty) parts.push(dirty);
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (untracked) parts.push('Untracked files:\n' + untracked);
    return parts.join('\n');
  } catch {
    return '';
  }
}
