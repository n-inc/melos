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

  sections.push(`## タスク\n\n${task}`);
  sections.push(`## 完了条件\n\n${criteria}`);

  if (steering) {
    sections.push(`## ステアリング\n\n${steering}`);
  }

  if (progressLog) {
    sections.push(`## 進捗ログ\n\n\`.melos/progress.md\` に前回イテレーションのメモがあります:\n\n${progressLog}`);
  }

  if (handoff) {
    sections.push(`## 前回の進捗（イテレーション ${iteration}）\n\nこれまでの変更ファイル:\n${handoff}`);
  }

  const instructions: string[] = [
    '上記のタスクに取り組む。',
    `タスクが完全に完了し、すべての条件を満たしたら <complete></complete> を出力する。`,
  ];

  if (!noAsk) {
    instructions.push(
      `以下のいずれかに該当する場合、仮定せずに <question>質問内容</question> を出力して必ず質問する:`,
    );
    sections.push(`## 指示\n\n${instructions.map((s) => `- ${s}`).join('\n')}`);
    sections.push(`## 質問すべきとき

次のどれかに当てはまるなら、\`<question>...</question>\` で質問してから進める:

- **技術選定が決まっていない**: フレームワーク、ライブラリ、認証方式、DB など
- **読み方が複数ある**: タスクや条件を複数の妥当な方法で解釈できる
- **スコープがはっきりしない**: どのファイル・モジュール・境界が対象か分からない
- **壊す可能性がある**: 変更がシステムの他の部分に波及しそう
- **手本がない**: リポジトリにスタイルやアプローチを推測できる既存コードがない

コードを読めば分かることは聞かない。人間の判断が要る決定だけ質問する。
質問は具体的に: 何を調べたか、選択肢は何か、何を決めてほしいかを書く。`);
  } else {
    instructions.push(
      '質問せずに自分で判断する。最善の判断を使う。',
    );
    sections.push(`## 指示\n\n${instructions.map((s) => `- ${s}`).join('\n')}`);
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

  sections.push(`## 進捗トラッキング

セッション終了前に、\`.melos/progress.md\` に進捗エントリを追記する。

### フォーマット

\`\`\`markdown
## イテレーション ${iteration}

### ステータス: [🟢 順調 | 🟡 部分的 | 🔴 ブロック]

### やったこと
- [実施した内容とその結果]

### 主な判断
- [何を選んだか] — [なぜ。どんな選択肢を検討したか]

### 現在の状態
- テスト: [pass/fail 数、具体的な失敗]
- ビルド: [コンパイル通る？型エラーは？]
- 変更ファイル: \`path/to/file.ts\` — [何をなぜ変えたか]

### 次のステップ
1. **最優先**: [次にやるべき最も重要なアクション]
2. **その後**: [優先順位順の後続アクション]

### ブロッカー / 未解決の質問
- [ ] [進捗を妨げているもの — 具体的に]
\`\`\`

### ルール

- このファイルと git log 以外のコンテキストがない同僚にブリーフィングするつもりで書く
- 具体的に: 「test_auth が42行目で 'JWT expired' で失敗」であって「テストが失敗」ではない
- エラーメッセージはそのまま含める — 次のイテレーションはターミナルを見られない
- 根拠のない判断は無価値`);

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
