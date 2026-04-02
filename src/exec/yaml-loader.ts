/**
 * YAML Route Loader
 *
 * Parses .route.yaml files into RecipeConfig objects.
 * Supports template variables (${{ }}) and !include tags.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import yaml from 'js-yaml';

import { compileRecipeConfig } from './compiler.js';
import { normalizeRuntimeRecipe } from './recipe.js';
import type { RecipeConfig, RecipeDefinition, RecipeRunConfig, SkillRef } from './recipe.js';

// ---------------------------------------------------------------------------
// Template Engine
// ---------------------------------------------------------------------------

const TEMPLATE_RE = /\$\{\{\s*(.+?)\s*\}\}/g;

interface TemplateContext {
  vars: Record<string, unknown>;
}

function parseBracketKey(innerExpr: string, ctx: TemplateContext): string | number {
  const trimmed = innerExpr.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed) as string;
      } catch {
        throw new Error(`YAML route: invalid bracket string literal ${trimmed}`);
      }
    }
    return trimmed.slice(1, -1).replace(/\\(['\\])/g, '$1');
  }
  return String(resolveExpression(trimmed, ctx));
}

function resolveExpression(expr: string, ctx: TemplateContext): unknown {
  // env.VAR_NAME
  if (expr.startsWith('env.')) {
    const rest = expr.slice(4);
    // env.VAR ?? "default"
    const nullishMatch = rest.match(/^(\w+)\s*\?\?\s*"([^"]*)"$/);
    if (nullishMatch) {
      const [, varName, defaultValue] = nullishMatch;
      return process.env[varName!] ?? defaultValue;
    }
    return process.env[rest] ?? '';
  }

  // Dot-notation + bracket access: entry.slug, entries[slug].lang, etc.
  // Split on '.' but also handle '[varRef]' segments
  const segments = expr.match(/[^.[]+|\[[^\]]+\]/g) ?? [];
  let current: unknown = ctx.vars;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') {
      return '';
    }
    if (segment.startsWith('[') && segment.endsWith(']')) {
      const innerRef = segment.slice(1, -1);
      const key = parseBracketKey(innerRef, ctx);
      current = Reflect.get(current as object, key);
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current ?? '';
}

function resolveTemplateString(value: string, ctx: TemplateContext): string {
  return value.replace(TEMPLATE_RE, (_match, expr: string) => {
    const resolved = resolveExpression(expr, ctx);
    if (typeof resolved === 'string') {
      return resolved;
    }
    if (typeof resolved === 'number' || typeof resolved === 'boolean') {
      return String(resolved);
    }
    return JSON.stringify(resolved);
  });
}

/**
 * Recursively walk a parsed YAML value and resolve all ${{ }} templates.
 * Non-string leaves are returned as-is.
 */
function resolveTemplates(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === 'string') {
    // Check if the entire string is a single template expression
    // (allows resolving to non-string types)
    const singleMatch = value.match(/^\$\{\{\s*(.+?)\s*\}\}$/);
    if (singleMatch) {
      return resolveExpression(singleMatch[1]!, ctx);
    }
    return resolveTemplateString(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, ctx));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveTemplates(v, ctx)])
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// !include YAML tag
// ---------------------------------------------------------------------------

const VALID_COMMIT_WHEN_VALUES = new Set(['never', 'stop', 'accepted-iteration']);
const VALID_RUN_ENGINES = new Set(['auto', 'claude', 'codex']);
const VALID_RUN_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const VALID_SERVICE_TIERS = new Set(['fast', 'flex']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateEnumValue<T extends string>(
  value: unknown,
  label: string,
  allowedValues: Set<T>
): T | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'string' || !allowedValues.has(value as T)) {
    throw new Error(`YAML route: ${label} must be one of ${Array.from(allowedValues).join(', ')}`);
  }
  return value as T;
}

function validateOptionalString(value: unknown, label: string): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`YAML route: ${label} must be a string`);
  }
  return value;
}

function validateOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`YAML route: ${label} must be a boolean`);
  }
  return value;
}

function validateOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`YAML route: ${label} must be a positive integer`);
  }
  return value;
}

function validateSkillRef(value: unknown, label: string): SkillRef {
  if (typeof value === 'string') {
    return value;
  }
  if (isRecord(value) && typeof value.path === 'string') {
    return { path: value.path };
  }
  throw new Error(`YAML route: ${label} must be a string or { path: string }`);
}

function validateSkillRefs(value: unknown, label: string): SkillRef[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`YAML route: ${label} must be an array`);
  }
  return value.map((entry, index) => validateSkillRef(entry, `${label}[${index}]`));
}

function validateRepoMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value == null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`YAML route: ${label} must be an object`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([alias, repoPath]) => {
      if (typeof repoPath !== 'string') {
        throw new Error(`YAML route: ${label}.${alias} must be a string`);
      }
      return [alias, repoPath];
    })
  );
}

function assertIncludePathWithinRoot(filePath: string, includeRoot: string, includeRef: string): void {
  const relativePath = relative(includeRoot, filePath);
  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
    return;
  }
  throw new Error(`YAML !include path escapes the route directory: ${includeRef}`);
}

function formatIncludeChain(includeStack: string[], nextPath: string): string {
  return [...includeStack, nextPath].join(' -> ');
}

function resolveIncludedFilePath(baseDir: string, includeRoot: string, includeRef: string): string {
  if (isAbsolute(includeRef)) {
    throw new Error(`YAML !include path must be relative to the route directory: ${includeRef}`);
  }

  const candidatePath = resolve(baseDir, includeRef);
  const resolvedPath = realpathSync(candidatePath);
  assertIncludePathWithinRoot(resolvedPath, includeRoot, includeRef);
  return resolvedPath;
}

function createIncludeType(baseDir: string, includeRoot: string, includeStack: string[]): yaml.Type {
  return new yaml.Type('!include', {
    kind: 'scalar',
    resolve(data: string) {
      return typeof data === 'string' && data.length > 0;
    },
    construct(data: string) {
      const filePath = resolveIncludedFilePath(baseDir, includeRoot, data);
      if (includeStack.includes(filePath)) {
        throw new Error(`YAML !include circular reference detected: ${formatIncludeChain(includeStack, filePath)}`);
      }
      const content = readFileSync(filePath, 'utf-8');
      return yaml.load(content, {
        schema: createYamlSchema(dirname(filePath), includeRoot, [...includeStack, filePath]),
      });
    },
  });
}

function createYamlSchema(baseDir: string, includeRoot: string, includeStack: string[]): yaml.Schema {
  return yaml.DEFAULT_SCHEMA.extend([createIncludeType(baseDir, includeRoot, includeStack)]);
}

// ---------------------------------------------------------------------------
// YAML → RecipeConfig Conversion
// ---------------------------------------------------------------------------

interface YamlVarsSection {
  [key: string]: unknown;
}

interface YamlRouteRaw {
  vars?: YamlVarsSection;
  run?: Partial<RecipeRunConfig>;
  skills?: unknown;
  repos?: unknown;
  workflow?: {
    start?: string;
    phases?: Record<string, unknown>;
  };
  limit?: number;
  report?: {
    path?: string;
    stdout?: boolean;
  };
  commit?: {
    when?: string;
    message?: string;
  };
}

function resolveVars(varsSection: YamlVarsSection | undefined): Record<string, unknown> {
  if (!varsSection) {
    return {};
  }

  const resolved: Record<string, unknown> = {};
  const ctx: TemplateContext = { vars: resolved };

  // Resolve vars in declaration order — each var can reference previously resolved vars
  for (const [key, value] of Object.entries(varsSection)) {
    resolved[key] = resolveTemplates(value, ctx);
  }

  return resolved;
}

function normalizeTransition(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value === 'stop' || value === 'repeat') {
      return value;
    }
    // Short-form: "brief" → { goto: "brief" }
    return { goto: value };
  }
  return value;
}

function normalizePhaseOn(on: unknown): unknown {
  if (on == null || typeof on !== 'object') {
    return on;
  }
  const entries = Object.entries(on as Record<string, unknown>);
  return Object.fromEntries(
    entries.map(([key, value]) => [key, normalizeTransition(value)])
  );
}

function normalizePhases(phases: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!phases) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(phases).map(([name, phase]) => {
      if (phase == null || typeof phase !== 'object') {
        return [name, phase];
      }
      const p = phase as Record<string, unknown>;
      const normalized = { ...p };

      // Normalize on.pass / on.fail shorthand
      if (normalized.on) {
        normalized.on = normalizePhaseOn(normalized.on);
      }
      if (Object.prototype.hasOwnProperty.call(normalized, 'skills')) {
        normalized.skills = validateSkillRefs(normalized.skills, `workflow.phases.${name}.skills`);
      }

      const nextTransition = normalizeTransition(normalized.next);
      if (nextTransition !== undefined) {
        const on = (normalized.on && typeof normalized.on === 'object')
          ? { ...(normalized.on as Record<string, unknown>) }
          : {};
        if (on.pass !== undefined) {
          throw new Error(`YAML route: workflow phase "${name}" cannot define both next and on.pass`);
        }
        on.pass = nextTransition;
        normalized.on = on;
        delete normalized.next;
      }

      return [name, normalized];
    })
  );
}

function normalizeCommitWhen(value: unknown): 'never' | 'stop' | 'accepted-iteration' | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'string' || !VALID_COMMIT_WHEN_VALUES.has(value)) {
    throw new Error('YAML route: commit.when must be one of never, stop, accepted-iteration');
  }
  return value as 'never' | 'stop' | 'accepted-iteration';
}

function toRecipeConfig(raw: YamlRouteRaw): RecipeConfig {
  if (!isRecord(raw.run)) {
    throw new Error('YAML route: run is required');
  }
  if (!raw.workflow?.start) {
    throw new Error('YAML route: workflow.start is required');
  }
  if (!raw.workflow.phases || Object.keys(raw.workflow.phases).length === 0) {
    throw new Error('YAML route: workflow.phases is required');
  }

  const engine = validateEnumValue(raw.run.engine, 'run.engine', VALID_RUN_ENGINES) ?? 'auto';
  const effort = validateEnumValue(raw.run.effort, 'run.effort', VALID_RUN_EFFORTS);
  const serviceTier = validateEnumValue(raw.run.serviceTier, 'run.serviceTier', VALID_SERVICE_TIERS);
  const cwd = validateOptionalString(raw.run.cwd, 'run.cwd');
  const timeoutMs = validateOptionalPositiveInteger(raw.run.timeoutMs, 'run.timeoutMs');

  const config: RecipeConfig = {
    run: {
      engine: engine as RecipeRunConfig['engine'],
      model: validateOptionalString(raw.run.model, 'run.model'),
      ...(effort ? { effort: effort as RecipeRunConfig['effort'] } : {}),
      ...(serviceTier ? { serviceTier: serviceTier as RecipeRunConfig['serviceTier'] } : {}),
      ...(cwd ? { cwd } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    },
    workflow: {
      start: raw.workflow.start,
      phases: normalizePhases(raw.workflow.phases) as RecipeConfig['workflow']['phases'],
    },
  };

  const skills = validateSkillRefs(raw.skills, 'skills');
  if (skills) {
    config.skills = skills;
  }
  const repos = validateRepoMap(raw.repos, 'repos');
  if (repos) {
    config.repos = repos;
  }
  const limit = validateOptionalPositiveInteger(raw.limit, 'limit');
  if (limit != null) {
    config.limit = limit;
  }
  if (raw.report != null) {
    if (!isRecord(raw.report)) {
      throw new Error('YAML route: report must be an object');
    }
    config.report = {
      ...(validateOptionalString(raw.report.path, 'report.path')
        ? { path: validateOptionalString(raw.report.path, 'report.path') }
        : {}),
      ...(validateOptionalBoolean(raw.report.stdout, 'report.stdout') != null
        ? { stdout: validateOptionalBoolean(raw.report.stdout, 'report.stdout') }
        : {}),
    };
  }
  if (raw.commit != null) {
    if (!isRecord(raw.commit)) {
      throw new Error('YAML route: commit must be an object');
    }
    config.commit = {
      when: normalizeCommitWhen(raw.commit.when),
      message: validateOptionalString(raw.commit.message, 'commit.message'),
    };
  }

  return config;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadYamlRoute(routePath: string): RecipeDefinition {
  const content = readFileSync(routePath, 'utf-8');
  const canonicalRoutePath = realpathSync(routePath);
  const includeRoot = dirname(canonicalRoutePath);
  const schema = createYamlSchema(includeRoot, includeRoot, [canonicalRoutePath]);

  const raw = yaml.load(content, { schema }) as YamlRouteRaw;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`YAML route file is empty or invalid: ${routePath}`);
  }

  // 1. Resolve vars (with env access and self-referencing)
  const vars = resolveVars(raw.vars);
  const ctx: TemplateContext = { vars };

  // 2. Remove vars from config and resolve all remaining templates
  const rest = { ...raw };
  delete rest.vars;
  const resolved = resolveTemplates(rest, ctx) as YamlRouteRaw;

  // 3. Convert to RecipeConfig and compile
  const recipeConfig = toRecipeConfig(resolved);
  const compiled = compileRecipeConfig(recipeConfig);
  return normalizeRuntimeRecipe(compiled);
}
