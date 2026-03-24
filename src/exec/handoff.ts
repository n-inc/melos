import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Decision, Observation, ResolvedQuestion, RuntimeTraceEntry } from './recipe.js';

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

function handoffDir(melosDir: string): string {
  return join(melosDir, 'handoff');
}

function handoffPath(melosDir: string, iteration: number): string {
  return join(handoffDir(melosDir), `iteration-${iteration}.json`);
}

function safeExecLines(command: string, cwd: string): string[] {
  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: '/bin/zsh',
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

export function writeIterationHandoff(melosDir: string, handoff: IterationHandoff): string {
  const dir = handoffDir(melosDir);
  mkdirSync(dir, { recursive: true });
  const path = handoffPath(melosDir, handoff.iteration);
  writeFileSync(path, `${JSON.stringify(handoff, null, 2)}\n`, 'utf-8');
  return path;
}

export function readLatestHandoff(melosDir: string): IterationHandoff | null {
  const history = readHandoffHistory(melosDir, { count: 1 });
  return history[0] ?? null;
}

export function readHandoffHistory(
  melosDir: string,
  options: { count?: number } = {}
): IterationHandoff[] {
  const dir = handoffDir(melosDir);
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
