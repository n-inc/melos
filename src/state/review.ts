import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

export type ReviewType = 'product' | 'code';
export type ReviewFindingPriority = 'P1' | 'P2' | 'P3';

export interface ReviewFinding {
  id: string;
  reviewType: ReviewType;
  priority: ReviewFindingPriority;
  summary: string;
  rationale?: string;
  affectedFiles?: string[];
  suggestedFix?: string;
  trackingKey?: string;
  surface?: string;
}

export interface ReviewArtifact {
  kind: 'screenshot' | 'video' | 'note';
  path: string;
  label?: string;
}

export interface ProductReviewCheckpoint {
  id: string;
  description: string;
  claim?: string;
  visual?: boolean;
}

export interface ProductReviewStartupStep {
  cwd?: string;
  command: string;
}

export interface ProductReviewContract {
  cwd?: string;
  target: string;
  startup?: ProductReviewStartupStep[];
  preconditions: string[];
  checkpoints: ProductReviewCheckpoint[];
  artifactsDir: string;
  video?: boolean;
}

export interface ReviewReport {
  milestoneId: string;
  featureId: string;
  reviewType: ReviewType;
  generation: number;
  timestamp: string;
  passed: boolean;
  summary: string;
  findings: ReviewFinding[];
  artifacts: ReviewArtifact[];
  blockingFindingCount: number;
}

export function normalizeProductReviewContract(
  value: unknown,
  baseDir?: string
): ProductReviewContract | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const target = asTrimmedString(record.target) || 'http://127.0.0.1:${PORT}';
  const checkpoints = normalizeProductReviewCheckpoints(record.checkpoints);
  const preconditions = normalizeStringList(record.preconditions);
  const startup = normalizeProductReviewStartup(record.startup, baseDir);
  const cwd = normalizeRelativePath(record.cwd, baseDir);
  const artifactsDir = normalizeRelativePath(record.artifactsDir, baseDir) ?? 'artifacts/screenshots';

  return {
    cwd,
    target,
    startup: startup.length > 0 ? startup : undefined,
    preconditions: preconditions.length > 0
      ? preconditions
      : [
        'js_repl must be enabled for Codex app-server',
        'playwright must be importable from the review cwd',
      ],
    checkpoints: checkpoints.length > 0
      ? checkpoints
      : [
        {
          id: 'prd-goal',
          description: 'Verify the main PRD success criteria interactively in the browser.',
          visual: true,
        },
      ],
    artifactsDir,
    video: typeof record.video === 'boolean' ? record.video : undefined,
  };
}

export function normalizeReviewFinding(
  value: unknown,
  reviewType: ReviewType,
  index: number
): ReviewFinding | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const summary = asTrimmedString(record.summary);
  if (!summary) {
    return null;
  }

  return {
    id: asTrimmedString(record.id) || `${reviewType.toLowerCase()}-finding-${index + 1}`,
    reviewType,
    priority: normalizeReviewFindingPriority(record.priority),
    summary,
    rationale: asTrimmedString(record.rationale) || undefined,
    affectedFiles: normalizeStringList(record.affectedFiles),
    suggestedFix: asTrimmedString(record.suggestedFix) || undefined,
    trackingKey: asTrimmedString(record.trackingKey) || undefined,
    surface: asTrimmedString(record.surface) || undefined,
  };
}

export function normalizeReviewArtifact(value: unknown): ReviewArtifact | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const path = asTrimmedString(record.path);
  if (!path) {
    return null;
  }

  const rawKind = asTrimmedString(record.kind).toLowerCase();
  const kind = rawKind === 'video' || rawKind === 'note' ? rawKind : 'screenshot';
  return {
    kind,
    path,
    label: asTrimmedString(record.label) || undefined,
  };
}

export function isBlockingReviewFinding(finding: Pick<ReviewFinding, 'priority'>): boolean {
  return finding.priority === 'P1' || finding.priority === 'P2';
}

function normalizeProductReviewCheckpoints(value: unknown): ProductReviewCheckpoint[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry, index) => {
      if (typeof entry === 'string') {
        const description = entry.trim();
        if (!description) {
          return null;
        }
        return {
          id: `checkpoint-${index + 1}`,
          description,
        };
      }
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const description = asTrimmedString(record.description);
      if (!description) {
        return null;
      }
      return {
        id: asTrimmedString(record.id) || `checkpoint-${index + 1}`,
        description,
        claim: asTrimmedString(record.claim) || undefined,
        visual: typeof record.visual === 'boolean' ? record.visual : undefined,
      };
    })
    .filter((entry): entry is ProductReviewCheckpoint => Boolean(entry));
}

function normalizeProductReviewStartup(
  value: unknown,
  baseDir?: string
): ProductReviewStartupStep[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (typeof entry === 'string') {
        const command = entry.trim();
        if (!command) {
          return null;
        }
        return { command };
      }
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const command = asTrimmedString(record.command);
      if (!command) {
        return null;
      }
      return {
        cwd: normalizeRelativePath(record.cwd, baseDir),
        command,
      };
    })
    .filter((entry): entry is ProductReviewStartupStep => Boolean(entry));
}

function normalizeReviewFindingPriority(value: unknown): ReviewFindingPriority {
  const normalized = asTrimmedString(value).toUpperCase();
  if (normalized === 'P1' || normalized === 'P2' || normalized === 'P3') {
    return normalized;
  }
  return 'P2';
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => asTrimmedString(entry))
    .filter((entry) => entry.length > 0);
}

function normalizeRelativePath(value: unknown, baseDir?: string): string | undefined {
  const raw = asTrimmedString(value);
  if (!raw) {
    return undefined;
  }
  if (isAbsolute(raw)) {
    throw new Error(`Review path must be relative to the repo root: ${raw}`);
  }

  const normalized = normalize(raw);
  if (normalized === '.' || normalized.length === 0) {
    return undefined;
  }
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`Review path must stay inside the repo root: ${raw}`);
  }

  if (baseDir) {
    const resolved = resolve(baseDir, normalized);
    const relativePath = relative(baseDir, resolved);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`Review path must stay inside the repo root: ${raw}`);
    }
  }

  return normalized.replace(/\\/g, '/');
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
