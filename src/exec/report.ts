import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { ClaudeEngine, type ClaudeEngineOptions } from '../engines/claude.js';
import type { EngineResult } from '../engines/base.js';
import { CLAUDE_LATEST_ALIAS, resolveRuntimeModel } from '../models/registry.js';
import { readHandoffHistory, type IterationHandoff } from './handoff.js';
import type {
  FinalReport,
  FinalReportCheckEvidence,
  FinalReportPassEvidence,
  Observation,
  RecipeDefinition,
  RecipeReportConfig,
  ResolvedQuestion,
  RuntimeTraceEntry,
} from './recipe.js';
import { defaultPromptRenderer } from './recipe.js';
import { resolveShellExecutable } from './shell.js';

const REPORT_RUNTIME_MODEL = resolveRuntimeModel(CLAUDE_LATEST_ALIAS, CLAUDE_LATEST_ALIAS);
const REPORT_EFFORT: ClaudeEngineOptions['effort'] = 'medium';
const REPORT_TIMEOUT_MS = 90_000;
const REPORT_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];
const REPORT_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'LS',
];
const REPORT_DISALLOWED_TOOLS = ['Edit', 'Write', 'MultiEdit'];
const REPORT_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'changes',
    'rationale',
    'finalState',
    'remainingIssues',
    'userConfirmationNeeded',
  ],
  properties: {
    summary: { type: 'string' },
    changes: {
      type: 'array',
      items: { type: 'string' },
    },
    rationale: {
      type: 'array',
      items: { type: 'string' },
    },
    finalState: { type: 'string' },
    remainingIssues: {
      type: 'array',
      items: { type: 'string' },
    },
    userConfirmationNeeded: {
      type: 'array',
      items: { type: 'string' },
    },
  },
});

interface GenerateFinalReportInput {
  recipe: RecipeDefinition;
  cwd: string;
  melosDir: string;
  recipePath?: string;
  handoffFingerprint?: string;
  lastHandoffPath?: string;
  iterations: number;
  success: boolean;
  decision: string;
  summary: string;
  reason?: string;
  output?: string;
  observation?: Observation;
  resolvedQuestions?: ResolvedQuestion[];
  trace?: RuntimeTraceEntry[];
}

interface ReportNarrative {
  summary: string;
  changes: string[];
  rationale: string[];
  finalState: string;
  remainingIssues: string[];
  userConfirmationNeeded: string[];
}

export interface GenerateFinalReportResult {
  report: FinalReport;
  degraded: boolean;
  error?: string;
  model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const strings = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return strings.length === value.length ? strings : null;
}

function normalizeNarrative(parsed: unknown): ReportNarrative | null {
  if (!isRecord(parsed)) {
    return null;
  }
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const finalState = typeof parsed.finalState === 'string' ? parsed.finalState.trim() : '';
  const changes = readStringArray(parsed.changes);
  const rationale = readStringArray(parsed.rationale);
  const remainingIssues = readStringArray(parsed.remainingIssues);
  const userConfirmationNeeded = readStringArray(parsed.userConfirmationNeeded);
  if (!summary || !finalState || !changes || !rationale || !remainingIssues || !userConfirmationNeeded) {
    return null;
  }
  return {
    summary,
    changes,
    rationale,
    finalState,
    remainingIssues,
    userConfirmationNeeded,
  };
}

function normalizeCheckEvidence(checks: unknown): FinalReportCheckEvidence[] | undefined {
  if (!Array.isArray(checks)) {
    return undefined;
  }
  const normalized = checks.flatMap((check) => {
    if (!isRecord(check) || typeof check.command !== 'string' || typeof check.exitCode !== 'number') {
      return [];
    }
    return [{
      command: check.command,
      cwd: typeof check.cwd === 'string' ? check.cwd : undefined,
      exitCode: check.exitCode,
      ok: check.exitCode === 0,
      timedOut: typeof check.timedOut === 'boolean' ? check.timedOut : undefined,
    } satisfies FinalReportCheckEvidence];
  });
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePassEvidence(criteria: unknown): FinalReportPassEvidence[] | undefined {
  if (!Array.isArray(criteria)) {
    return undefined;
  }
  const normalized = criteria.flatMap((item) => {
    if (!isRecord(item) || typeof item.criterion !== 'string' || (item.verdict !== 'yes' && item.verdict !== 'no')) {
      return [];
    }
    return [{
      criterion: item.criterion,
      verdict: item.verdict,
      rationale: typeof item.rationale === 'string' ? item.rationale : undefined,
    } satisfies FinalReportPassEvidence];
  });
  return normalized.length > 0 ? normalized : undefined;
}

function buildEvidence(observation?: Observation): FinalReport['evidence'] | undefined {
  if (!observation) {
    return undefined;
  }
  const data = observation.data;
  const checks = isRecord(data) && isRecord(data.check)
    ? normalizeCheckEvidence(data.check.checks)
    : isRecord(data)
      ? normalizeCheckEvidence(data.checks)
      : undefined;
  const pass = isRecord(data) && isRecord(data.pass)
    ? normalizePassEvidence(data.pass.criteria)
    : isRecord(data)
      ? normalizePassEvidence(data.criteria)
      : undefined;
  const metrics = Object.keys(observation.metrics).length > 0
    ? observation.metrics
    : undefined;

  if (!checks && !pass && !metrics) {
    return undefined;
  }
  return {
    checks,
    metrics,
    pass,
  };
}

function createFallbackReport(input: GenerateFinalReportInput, degradedReason?: string): FinalReport {
  return {
    summary: input.summary,
    changes: input.output?.trim().length
      ? [input.output.trim()]
      : [],
    rationale: degradedReason ? [degradedReason] : [],
    finalState: input.reason
      ? `${input.summary} (${input.reason})`
      : input.summary,
    remainingIssues: input.success
      ? []
      : [input.reason ?? input.summary],
    userConfirmationNeeded: [],
    evidence: buildEvidence(input.observation),
  };
}

function safeExecOutput(command: string, cwd: string): string {
  try {
    return execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: resolveShellExecutable(),
    }).trim();
  } catch {
    return '';
  }
}

function listChangedFiles(cwd: string): string[] {
  const tracked = safeExecOutput('git diff --name-only --', cwd)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const staged = safeExecOutput('git diff --cached --name-only --', cwd)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const untracked = safeExecOutput('git ls-files --others --exclude-standard', cwd)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return Array.from(new Set([...tracked, ...staged, ...untracked]));
}

function buildDiffStat(cwd: string): string | null {
  const output = safeExecOutput('git diff --stat --', cwd);
  return output.length > 0 ? output : null;
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
      reason: entry.decision.reason,
    },
    modifiedFiles: entry.modifiedFiles.slice(0, 8),
    blockers: entry.blockers,
    nextSteps: entry.nextSteps,
  };
}

function buildCompactHandoffSummary(entries: IterationHandoff[]): {
  content: string;
  includedEntries: number;
  omittedEntries: number;
} {
  const compact = entries.map(compactHandoffEntry);
  let selected = compact.slice(-6);
  while (selected.length > 1 && JSON.stringify(selected, null, 2).length > 24_000) {
    selected = selected.slice(1);
  }
  return {
    content: JSON.stringify({
      totalEntries: compact.length,
      includedEntries: selected.length,
      omittedEntries: compact.length - selected.length,
      entries: selected,
    }, null, 2),
    includedEntries: selected.length,
    omittedEntries: compact.length - selected.length,
  };
}

function buildAvailableArtifacts(input: GenerateFinalReportInput, changedFiles: string[]): Record<string, unknown> {
  const eventsPath = join(input.melosDir, 'events.jsonl');
  const handoffDir = input.handoffFingerprint
    ? join(input.melosDir, 'handoff', `sha256-${input.handoffFingerprint}`)
    : undefined;
  return {
    cwd: input.cwd,
    melosDir: input.melosDir,
    recipePath: input.recipePath,
    eventsPath,
    handoffDir,
    lastHandoffPath: input.lastHandoffPath,
    changedFiles,
  };
}

function buildReportPrompt(input: GenerateFinalReportInput): string {
  const handoffEntries = input.handoffFingerprint
    ? readHandoffHistory(input.melosDir, input.handoffFingerprint)
    : [];
  const handoffSummary = buildCompactHandoffSummary(handoffEntries);
  const changedFiles = listChangedFiles(input.cwd);
  const diffStat = buildDiffStat(input.cwd);
  const evidence = buildEvidence(input.observation);

  return defaultPromptRenderer(
    [
      'Generate the final execution report as strict JSON.',
      'You are in a read-only reporting phase.',
      'Start from the compact summaries below.',
      'Keep the report concise and high-signal.',
      'If the summaries are insufficient, inspect the listed artifacts with the allowed read-only file tools only.',
      'Do not modify files, do not apply edits, and do not run write commands.',
      'Return only JSON that matches the provided schema.',
      'Use `userConfirmationNeeded` only for decisions that must be reviewed by the executor before proceeding.',
    ].join('\n'),
    [
      {
        title: 'execution result',
        content: JSON.stringify({
          success: input.success,
          decision: input.decision,
          iterations: input.iterations,
          summary: input.summary,
          reason: input.reason,
        }, null, 2),
      },
      ...(input.observation
        ? [{
          title: 'final observation',
          content: JSON.stringify({
            ok: input.observation.ok,
            status: input.observation.status,
            summary: input.observation.summary,
            details: input.observation.details,
            metrics: input.observation.metrics,
          }, null, 2),
        }]
        : []),
      ...(evidence
        ? [{
          title: 'final evidence',
          content: JSON.stringify(evidence, null, 2),
        }]
        : []),
      ...(input.resolvedQuestions && input.resolvedQuestions.length > 0
        ? [{
          title: 'resolved questions',
          content: JSON.stringify(input.resolvedQuestions, null, 2),
        }]
        : []),
      {
        title: 'handoff summary',
        content: handoffSummary.content,
      },
      ...(diffStat
        ? [{
          title: 'git diff stat',
          content: diffStat,
        }]
        : []),
      {
        title: 'available artifacts',
        content: JSON.stringify(buildAvailableArtifacts(input, changedFiles), null, 2),
      },
    ]
  );
}

function buildReportSystemPrompt(): string {
  return [
    'You are generating a final report for melos run.',
    'This is a one-shot Claude Opus reporting pass.',
    'Treat the workspace as strictly read-only.',
    'Prefer Read, Grep, Glob, and LS for inspection.',
    'Do not expand scope beyond what is needed for a concise final report.',
    'Never run commands that modify files, git state, or external systems.',
    'Never fabricate changes, rationale, or confirmations.',
  ].join('\n');
}

function buildReportEngineOptions(cwd: string): ClaudeEngineOptions {
  return {
    cwd,
    model: REPORT_RUNTIME_MODEL,
    effort: REPORT_EFFORT,
    timeout: REPORT_TIMEOUT_MS,
    printMode: true,
    skipPermissions: false,
    permissionMode: 'dontAsk',
    tools: REPORT_TOOLS,
    allowedTools: REPORT_ALLOWED_TOOLS,
    disallowedTools: REPORT_DISALLOWED_TOOLS,
    appendSystemPrompt: buildReportSystemPrompt(),
    jsonSchema: REPORT_JSON_SCHEMA,
    addDirectories: [cwd],
    suppressTerminalOutput: true,
  };
}

export function resolveReportPath(cwd: string, config?: RecipeReportConfig): string {
  const configured = config?.path?.trim();
  if (!configured) {
    return resolve(cwd, '.melos', 'final-report.json');
  }
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

export async function generateFinalReport(input: GenerateFinalReportInput): Promise<GenerateFinalReportResult> {
  const fallback = (reason: string): GenerateFinalReportResult => ({
    report: createFallbackReport(input, reason),
    degraded: true,
    error: reason,
    model: REPORT_RUNTIME_MODEL,
  });

  const engine = new ClaudeEngine();
  const prompt = buildReportPrompt(input);

  let result: EngineResult;
  try {
    result = await engine.execute(prompt, buildReportEngineOptions(input.cwd));
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error));
  }

  if (!result.success) {
    return fallback(result.error ?? 'report generation failed');
  }

  try {
    const parsed = JSON.parse(result.output);
    const narrative = normalizeNarrative(parsed);
    if (!narrative) {
      return fallback('report generation returned an invalid schema');
    }
    return {
      report: {
        ...narrative,
        evidence: buildEvidence(input.observation),
      },
      degraded: false,
      model: REPORT_RUNTIME_MODEL,
    };
  } catch (error) {
    return fallback(error instanceof Error ? error.message : 'report generation returned invalid JSON');
  }
}

export function writeFinalReport(path: string, report: FinalReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
}

function renderStringList(items: string[]): string {
  return items.length > 0
    ? items.map((item) => `- ${item}`).join('\n')
    : '- None';
}

function renderEvidence(report: FinalReport): string[] {
  const evidence = report.evidence;
  if (!evidence) {
    return [];
  }
  const lines: string[] = [];
  if (evidence.checks && evidence.checks.length > 0) {
    lines.push('Checks:');
    lines.push(...evidence.checks.map((check) => `- [${check.ok ? 'ok' : 'fail'}] ${check.command}`));
  }
  if (evidence.metrics && Object.keys(evidence.metrics).length > 0) {
    lines.push(`Metrics: ${JSON.stringify(evidence.metrics)}`);
  }
  if (evidence.pass && evidence.pass.length > 0) {
    lines.push('Pass Criteria:');
    lines.push(...evidence.pass.map((item) => `- [${item.verdict}] ${item.criterion}`));
  }
  return lines;
}

export function renderFinalReportText(
  report: FinalReport,
  reportPath?: string,
  options: { degraded?: boolean } = {}
): string {
  const lines = [
    `Summary: ${report.summary}`,
    '',
    'Changes:',
    renderStringList(report.changes),
    '',
    'Rationale:',
    renderStringList(report.rationale),
    '',
    `Final State: ${report.finalState}`,
    '',
    'Remaining Issues:',
    renderStringList(report.remainingIssues),
    '',
    'User Confirmation Needed:',
    renderStringList(report.userConfirmationNeeded),
  ];
  const evidenceLines = renderEvidence(report);
  if (evidenceLines.length > 0) {
    lines.push('', ...evidenceLines);
  }
  if (options.degraded) {
    lines.push('', 'Warning: report was generated from fallback data.');
  }
  if (reportPath) {
    lines.push('', `Report Path: ${reportPath}`);
  }
  return lines.join('\n');
}
