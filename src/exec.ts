import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppServerEngine } from './engines/app-server.js';
import { ClaudeEngine } from './engines/claude.js';
import { isClaudeFamily, isCodexFamily, resolveRuntimeModel } from './models/registry.js';
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

Commit often in meaningful units. Each commit is your handoff to the next iteration and serves as **the execution log** for the Manager monitoring your progress. The Manager reads \`git log\` to understand what you did, why, and what decisions you made — so commit messages must be detailed enough to reconstruct your reasoning.

### Format

\`\`\`
prefix: concise summary (imperative mood)

Body: explain "why" — the reasoning, decisions, and context that
cannot be understood from the diff alone.
\`\`\`

### Prefixes

- \`feat:\` — new feature or capability
- \`fix:\` — bug fix
- \`update:\` — enhancement to existing functionality
- \`refactor:\` — structural change with no behavior change
- \`test:\` — tests only
- \`chore:\` — maintenance, dependency updates

### Body structure

The body is **always required** (even for small changes). Structure it as a narrative:

1. **経緯・背景**: What were you trying to accomplish? What was the situation?
2. **問題**: What issue did you encounter? (For bug fixes: reproduction conditions, symptoms)
3. **判断**: What alternatives did you consider? Why did you choose this approach?
4. **結果**: What is the outcome? Are there remaining concerns or follow-up items?

Write in narrative prose, not a bullet list of file changes. The diff shows what changed — the body explains *why* those changes were made and *what decisions* led to them.

### Example

\`\`\`
fix: prevent blank page on initial load with collapsed sidebar

CollapsedSidebar was switched to always-mounted to fix a flicker
issue during open/close transitions.

However, always-mounting caused useLazyLoadQuery inside
CollapsedSidebar to fire immediately on page load. Without a
Suspense boundary, the thrown Promise propagated up to
RequireAccountLogin's error boundary, rendering a blank page.

Wrapping CollapsedSidebar in Suspense absorbs the data-fetching
suspension. Also added an isMounted guard to prevent SSR
hydration mismatches with Suspense.
\`\`\`

### Rules

- Do NOT include person names in commit messages
- Do NOT write a body that merely lists the files changed — that information is in the diff
- Commit after each meaningful unit of work, not only at the end
- Secret files (.env, credentials.json, etc.) must never be committed
- \`.melos/\` directory must never be committed — it is a temporary working directory for melos exec`);

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
  const base = { cwd: opts.cwd, model: runtimeModel, timeout: 0 }; // 0 = no timeout for exec
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

      if (!result.success && !result.output) {
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

function gitDiffStat(cwd: string, before: string): string {
  try {
    const after = gitHead(cwd);
    if (before && after && before !== after) {
      return execSync(`git diff --stat ${before}..${after}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    }
    // コミットされていない変更を取得
    return execSync('git diff --stat', { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}
