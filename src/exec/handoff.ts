import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderPromptWithSections, type PromptSection } from './prompt-sections.js';
import { type Decision, type Observation, type ResolvedQuestion, type RuntimeTraceEntry } from './recipe.js';
import { resolveShellExecutable } from './shell.js';

export const SAFE_PROMPT_CEILING = 900_000;

export interface IterationHandoff {
  iteration: number;
  timestamp: string;
  promptSummary: string;
  assistantText: string;
  observation: Observation;
  decision: {
    kind: Decision['kind'];
    summary?: string;
    reason?: string;
    success?: boolean;
    question?: string;
  };
  attempts: Array<{ action: string; result?: string }>;
  failures: Array<{ reason: string; file?: string; line?: number }>;
  insights: string[];
  nextSteps: string[];
  blockers: string[];
  modifiedFiles: string[];
  commands: string[];
  trace: RuntimeTraceEntry[];
  resolvedQuestions: ResolvedQuestion[];
}

export interface HandoffSectionDecision {
  mode: 'none' | 'full' | 'compact' | 'trimmed' | 'omitted';
  section: PromptSection | null;
  totalEntries: number;
  includedEntries: number;
  omittedEntries: number;
}

function handoffRootDir(melosDir: string): string {
  return join(melosDir, 'handoff');
}

function namespaceDirName(fingerprint: string): string {
  return `sha256-${fingerprint}`;
}

function handoffDir(melosDir: string, fingerprint: string): string {
  return join(handoffRootDir(melosDir), namespaceDirName(fingerprint));
}

function handoffPath(melosDir: string, fingerprint: string, iteration: number): string {
  return join(handoffDir(melosDir, fingerprint), `iteration-${iteration}.json`);
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function resolveHandoffFingerprint(input: {
  existingFingerprint?: string;
  recipePath?: string;
  prompt?: string;
  promptSource?: string;
}): string | null {
  if (typeof input.existingFingerprint === 'string' && input.existingFingerprint.trim().length > 0) {
    return input.existingFingerprint.trim();
  }
  if (typeof input.recipePath === 'string' && input.recipePath.trim().length > 0 && existsSync(input.recipePath)) {
    return sha256(readFileSync(input.recipePath, 'utf-8'));
  }
  if (typeof input.prompt === 'string') {
    return sha256(`simple:${input.prompt}`);
  }
  if (typeof input.promptSource === 'string' && input.promptSource.trim().length > 0) {
    return sha256(`inline:${input.promptSource}`);
  }
  return null;
}

function safeExecLines(command: string, cwd: string): string[] {
  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: resolveShellExecutable(),
    }).trim();
    if (output.length === 0) {
      return [];
    }
    return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function listModifiedFiles(cwd: string, checkpointRef?: string): string[] {
  const diffBase = checkpointRef ? `${checkpointRef} --` : '--';
  const tracked = safeExecLines(`git diff --name-only ${diffBase}`, cwd);
  const untracked = safeExecLines('git ls-files --others --exclude-standard', cwd);
  return Array.from(new Set([...tracked, ...untracked]));
}

export function buildIterationHandoff(input: {
  iteration: number;
  timestamp: string;
  cwd: string;
  checkpointRef?: string;
  promptSummary: string;
  assistantText: string;
  observation: Observation;
  decision: Decision;
  trace: RuntimeTraceEntry[];
  resolvedQuestions: ResolvedQuestion[];
}): IterationHandoff {
  const commands = Array.from(new Set(input.trace
    .filter((entry) => entry.kind === 'command')
    .map((entry) => entry.command)));
  const modifiedFilesFromTrace = input.trace
    .flatMap((entry) => entry.kind === 'file_change' && typeof entry.path === 'string' && entry.path.length > 0
      ? [entry.path]
      : []);
  const modifiedFiles = Array.from(new Set([
    ...modifiedFilesFromTrace,
    ...listModifiedFiles(input.cwd, input.checkpointRef),
  ]));

  const attempts = commands.length > 0
    ? commands.map((command) => ({
      action: command,
      result: input.observation.summary,
    }))
    : [{ action: `iteration ${input.iteration}`, result: input.observation.summary }];

  const failures = input.observation.ok
    ? []
    : [{
      reason: input.decision.reason ?? input.observation.details ?? input.observation.summary,
    }];

  const insights = Array.from(new Set([
    input.observation.summary,
    ...(typeof input.observation.details === 'string' && input.observation.details.trim().length > 0
      ? [input.observation.details.trim()]
      : []),
  ]));

  const nextSteps = Array.from(new Set([
    ...(input.decision.kind === 'ask' ? [`Answer question: ${input.decision.question}`] : []),
    ...(input.decision.kind === 'rollback'
      ? [input.decision.reason ?? 'Investigate the regression before retrying.']
      : []),
    ...(input.decision.kind === 'continue'
      ? [input.decision.reason ?? 'Continue iterating with the latest findings.']
      : []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)));

  const blockers = input.decision.kind === 'ask'
    ? [input.decision.question]
    : input.observation.status === 'error'
      ? [input.decision.reason ?? input.observation.summary]
      : [];

  return {
    iteration: input.iteration,
    timestamp: input.timestamp,
    promptSummary: input.promptSummary,
    assistantText: input.assistantText,
    observation: input.observation,
    decision: {
      kind: input.decision.kind,
      summary: input.decision.summary,
      reason: input.decision.reason,
      success: input.decision.success,
      question: 'question' in input.decision ? input.decision.question : undefined,
    },
    attempts,
    failures,
    insights,
    nextSteps,
    blockers,
    modifiedFiles,
    commands,
    trace: input.trace,
    resolvedQuestions: input.resolvedQuestions,
  };
}

export function writeIterationHandoff(melosDir: string, fingerprint: string, handoff: IterationHandoff): string {
  const dir = handoffDir(melosDir, fingerprint);
  mkdirSync(dir, { recursive: true });
  const path = handoffPath(melosDir, fingerprint, handoff.iteration);
  writeFileSync(path, `${JSON.stringify(handoff, null, 2)}\n`, 'utf-8');
  return path;
}

export function readLatestHandoff(melosDir: string, fingerprint: string): IterationHandoff | null {
  const history = readHandoffHistory(melosDir, fingerprint, { count: 1 });
  return history[0] ?? null;
}

export function readHandoffHistory(
  melosDir: string,
  fingerprint: string,
  options: { count?: number } = {}
): IterationHandoff[] {
  const dir = handoffDir(melosDir, fingerprint);
  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir)
    .filter((file) => /^iteration-\d+\.json$/.test(file))
    .sort((left, right) => {
      const leftNumber = Number(left.match(/\d+/)?.[0] ?? 0);
      const rightNumber = Number(right.match(/\d+/)?.[0] ?? 0);
      return leftNumber - rightNumber;
    });
  const selected = options.count ? files.slice(-Math.max(1, options.count)) : files;

  const history: IterationHandoff[] = [];
  for (const file of selected) {
    try {
      history.push(JSON.parse(readFileSync(join(dir, file), 'utf-8')) as IterationHandoff);
    } catch {
      // ignore malformed handoff file
    }
  }
  return history;
}

function compactHandoffEntry(entry: IterationHandoff): Record<string, unknown> {
  return {
    iteration: entry.iteration,
    timestamp: entry.timestamp,
    promptSummary: entry.promptSummary,
    observation: {
      status: entry.observation.status,
      summary: entry.observation.summary,
    },
    decision: {
      kind: entry.decision.kind,
      summary: entry.decision.summary,
    },
    modifiedFiles: entry.modifiedFiles.slice(0, 5),
    nextSteps: entry.nextSteps,
    blockers: entry.blockers,
  };
}

function fitsPromptBudget(input: {
  prompt: string;
  sections: PromptSection[];
  handoffSectionContent: string;
  ceiling: number;
}): boolean {
  return renderPromptWithSections(
    input.prompt,
    [...input.sections, { title: 'handoff history', content: input.handoffSectionContent }]
  ).length <= input.ceiling;
}

export function selectHandoffHistorySection(input: {
  melosDir: string;
  fingerprint: string;
  prompt: string;
  sections: PromptSection[];
  ceiling?: number;
}): HandoffSectionDecision {
  const history = readHandoffHistory(input.melosDir, input.fingerprint);
  if (history.length === 0) {
    return {
      mode: 'none',
      section: null,
      totalEntries: 0,
      includedEntries: 0,
      omittedEntries: 0,
    };
  }

  const ceiling = input.ceiling ?? SAFE_PROMPT_CEILING;
  const fullContent = JSON.stringify(history, null, 2);
  if (fitsPromptBudget({
    prompt: input.prompt,
    sections: input.sections,
    handoffSectionContent: fullContent,
    ceiling,
  })) {
    return {
      mode: 'full',
      section: { title: 'handoff history', content: fullContent },
      totalEntries: history.length,
      includedEntries: history.length,
      omittedEntries: 0,
    };
  }

  const compactEntries = history.map(compactHandoffEntry);
  const compactContent = JSON.stringify(compactEntries, null, 2);
  if (fitsPromptBudget({
    prompt: input.prompt,
    sections: input.sections,
    handoffSectionContent: compactContent,
    ceiling,
  })) {
    return {
      mode: 'compact',
      section: { title: 'handoff history', content: compactContent },
      totalEntries: history.length,
      includedEntries: history.length,
      omittedEntries: 0,
    };
  }

  for (let startIndex = 1; startIndex < compactEntries.length; startIndex++) {
    const trimmedEntries = compactEntries.slice(startIndex);
    const trimmedContent = JSON.stringify(trimmedEntries, null, 2);
    if (!fitsPromptBudget({
      prompt: input.prompt,
      sections: input.sections,
      handoffSectionContent: trimmedContent,
      ceiling,
    })) {
      continue;
    }
    return {
      mode: 'trimmed',
      section: { title: 'handoff history', content: trimmedContent },
      totalEntries: history.length,
      includedEntries: trimmedEntries.length,
      omittedEntries: startIndex,
    };
  }

  return {
    mode: 'omitted',
    section: null,
    totalEntries: history.length,
    includedEntries: 0,
    omittedEntries: history.length,
  };
}
