import { readFile } from 'node:fs/promises';

export interface RunSpec {
  version: number;
  runId: string;
  createdAt: string;
  source: {
    tracker: string;
    issueId: string;
    issueUrl?: string;
    title: string;
    description?: string;
    labels?: string[];
    priority?: number | null;
  };
  target: {
    repo: string;
    baseBranch?: string;
    workspace?: string;
  };
  objective: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  context?: {
    brief?: string;
    relevantKnowledge?: string;
    recentChanges?: string;
    triage?: string | null;
  };
  options?: {
    quick?: boolean;
    model?: string | null;
    maxIterations?: number | null;
    attempt?: number | null;
  };
}

export interface RunIdentity {
  runId: string;
  sourceTracker: string;
  sourceIssueId: string;
  sourceIssueUrl?: string;
  attempt: number;
}

export async function loadRunSpec(path: string): Promise<RunSpec> {
  const raw = await readFile(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid RunSpec JSON: ${message}`);
  }
  return validateRunSpec(parsed);
}

export function validateRunSpec(data: unknown): RunSpec {
  const spec = asObject(data, 'RunSpec must be a JSON object');
  const source = asObject(spec.source, 'RunSpec source is required');
  const target = asObject(spec.target, 'RunSpec target is required');

  const version = requireNumber(spec.version, 'RunSpec version is required');
  const runId = requireString(spec.runId, 'RunSpec runId is required');
  const createdAt = requireString(spec.createdAt, 'RunSpec createdAt is required');
  const objective = requireString(spec.objective, 'RunSpec objective is required');

  const normalizedSource: RunSpec['source'] = {
    tracker: requireString(source.tracker, 'RunSpec source.tracker is required'),
    issueId: requireString(source.issueId, 'RunSpec source.issueId is required'),
    title: requireString(source.title, 'RunSpec source.title is required'),
  };
  const issueUrl = optionalString(source.issueUrl);
  if (issueUrl) {
    normalizedSource.issueUrl = issueUrl;
  }
  const description = optionalString(source.description);
  if (description) {
    normalizedSource.description = description;
  }
  const labels = optionalStringArray(source.labels, 'RunSpec source.labels must be an array of strings');
  if (labels) {
    normalizedSource.labels = labels;
  }
  const priority = optionalNullableNumber(source.priority, 'RunSpec source.priority must be a number or null');
  if (priority !== undefined) {
    normalizedSource.priority = priority;
  }

  const normalizedTarget: RunSpec['target'] = {
    repo: requireString(target.repo, 'RunSpec target.repo is required'),
  };
  const baseBranch = optionalString(target.baseBranch);
  if (baseBranch) {
    normalizedTarget.baseBranch = baseBranch;
  }
  const workspace = optionalString(target.workspace);
  if (workspace) {
    normalizedTarget.workspace = workspace;
  }

  const constraints = optionalStringArray(spec.constraints, 'RunSpec constraints must be an array of strings');
  const acceptanceCriteria = optionalStringArray(spec.acceptanceCriteria, 'RunSpec acceptanceCriteria must be an array of strings');

  let context: RunSpec['context'] | undefined;
  if (spec.context !== undefined) {
    const rawContext = asObject(spec.context, 'RunSpec context must be an object');
    context = {};
    const brief = optionalString(rawContext.brief);
    if (brief) {
      context.brief = brief;
    }
    const relevantKnowledge = optionalString(rawContext.relevantKnowledge);
    if (relevantKnowledge) {
      context.relevantKnowledge = relevantKnowledge;
    }
    const recentChanges = optionalString(rawContext.recentChanges);
    if (recentChanges) {
      context.recentChanges = recentChanges;
    }
    const triage = optionalNullableString(rawContext.triage, 'RunSpec context.triage must be a string or null');
    if (triage !== undefined) {
      context.triage = triage;
    }
    if (Object.keys(context).length === 0) {
      context = undefined;
    }
  }

  let options: RunSpec['options'] | undefined;
  if (spec.options !== undefined) {
    const rawOptions = asObject(spec.options, 'RunSpec options must be an object');
    options = {};
    const quick = optionalBoolean(rawOptions.quick, 'RunSpec options.quick must be a boolean');
    if (quick !== undefined) {
      options.quick = quick;
    }
    const model = optionalNullableString(rawOptions.model, 'RunSpec options.model must be a string or null');
    if (model !== undefined) {
      options.model = model;
    }
    const maxIterations = optionalNullableNumber(rawOptions.maxIterations, 'RunSpec options.maxIterations must be a number or null');
    if (maxIterations !== undefined) {
      options.maxIterations = maxIterations;
    }
    const attempt = optionalNullableNumber(rawOptions.attempt, 'RunSpec options.attempt must be a number or null');
    if (attempt !== undefined) {
      options.attempt = attempt;
    }
    if (Object.keys(options).length === 0) {
      options = undefined;
    }
  }

  return {
    version,
    runId,
    createdAt,
    source: normalizedSource,
    target: normalizedTarget,
    objective,
    constraints,
    acceptanceCriteria,
    context,
    options,
  };
}

export function runSpecToPrdText(spec: RunSpec): string {
  const lines: string[] = [
    `# ${spec.source.title}`,
    '',
    '## Objective',
    spec.objective,
  ];

  if (spec.constraints && spec.constraints.length > 0) {
    lines.push('', '## Constraints', ...spec.constraints.map((item) => `- ${item}`));
  }

  if (spec.acceptanceCriteria && spec.acceptanceCriteria.length > 0) {
    lines.push('', '## Acceptance Criteria', ...spec.acceptanceCriteria.map((item) => `- ${item}`));
  }

  lines.push(
    '',
    '## Source',
    `- Tracker: ${spec.source.tracker}`,
    `- Issue: ${spec.source.issueId}`
  );

  const contextBlocks = [
    formatContextSection('Background', spec.context?.brief),
    formatContextSection('Relevant Knowledge', spec.context?.relevantKnowledge),
    formatContextSection('Recent Changes', spec.context?.recentChanges),
    formatContextSection('Triage', spec.context?.triage ?? undefined),
  ].filter((section): section is string[] => section !== null);

  if (contextBlocks.length > 0) {
    lines.push('', '## Context');
    for (const section of contextBlocks) {
      lines.push('', ...section);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function extractRunIdentity(spec: RunSpec): RunIdentity {
  return {
    runId: spec.runId,
    sourceTracker: spec.source.tracker,
    sourceIssueId: spec.source.issueId,
    sourceIssueUrl: spec.source.issueUrl,
    attempt: spec.options?.attempt ?? 0,
  };
}

function formatContextSection(title: string, value: string | undefined): string[] | null {
  if (!value) {
    return null;
  }
  return [`### ${title}`, value];
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}

function requireNumber(value: unknown, message: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(message);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('Expected string');
  }
  return value;
}

function optionalNullableString(value: unknown, message: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(message);
  }
  return value;
}

function optionalNullableNumber(value: unknown, message: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(message);
  }
  return value;
}

function optionalStringArray(value: unknown, message: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(message);
  }
  return value;
}

function optionalBoolean(value: unknown, message: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(message);
  }
  return value;
}
