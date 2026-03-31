/**
 * YAML Route Loader
 *
 * Parses .route.yaml files into RecipeConfig objects.
 * Supports template variables (${{ }}) and !include tags.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';

import { compileRecipeConfig } from './compiler.js';
import { normalizeRuntimeRecipe } from './recipe.js';
import type { RecipeConfig, RecipeDefinition, RecipeRunConfig } from './recipe.js';

// ---------------------------------------------------------------------------
// Template Engine
// ---------------------------------------------------------------------------

const TEMPLATE_RE = /\$\{\{\s*(.+?)\s*\}\}/g;

interface TemplateContext {
  vars: Record<string, unknown>;
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

  // Dot-notation access: entry.slug, entry.lang, etc.
  const parts = expr.split('.');
  let current: unknown = ctx.vars;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return '';
    }
    current = (current as Record<string, unknown>)[part];
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

function createIncludeType(baseDir: string): yaml.Type {
  return new yaml.Type('!include', {
    kind: 'scalar',
    resolve(data: string) {
      return typeof data === 'string' && data.length > 0;
    },
    construct(data: string) {
      const filePath = resolve(baseDir, data);
      const content = readFileSync(filePath, 'utf-8');
      return yaml.load(content, {
        schema: createYamlSchema(dirname(filePath)),
      });
    },
  });
}

function createYamlSchema(baseDir: string): yaml.Schema {
  return yaml.DEFAULT_SCHEMA.extend([createIncludeType(baseDir)]);
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
  skills?: string[];
  repos?: Record<string, string>;
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

      // Normalize next shorthand
      if (typeof normalized.next === 'string') {
        normalized.next = normalizeTransition(normalized.next);
      }

      return [name, normalized];
    })
  );
}

function toRecipeConfig(raw: YamlRouteRaw): RecipeConfig {
  if (!raw.run) {
    throw new Error('YAML route: run is required');
  }
  if (!raw.workflow?.start) {
    throw new Error('YAML route: workflow.start is required');
  }
  if (!raw.workflow.phases || Object.keys(raw.workflow.phases).length === 0) {
    throw new Error('YAML route: workflow.phases is required');
  }

  const config: RecipeConfig = {
    run: {
      engine: (raw.run.engine ?? 'auto') as RecipeRunConfig['engine'],
      model: raw.run.model,
      ...(raw.run.effort ? { effort: raw.run.effort } : {}),
      ...(raw.run.cwd ? { cwd: raw.run.cwd } : {}),
      ...(raw.run.timeoutMs ? { timeoutMs: raw.run.timeoutMs } : {}),
    },
    workflow: {
      start: raw.workflow.start,
      phases: normalizePhases(raw.workflow.phases) as RecipeConfig['workflow']['phases'],
    },
  };

  if (raw.skills) {
    config.skills = raw.skills;
  }
  if (raw.repos) {
    config.repos = raw.repos;
  }
  if (raw.limit != null) {
    config.limit = raw.limit;
  }
  if (raw.report) {
    config.report = raw.report;
  }
  if (raw.commit) {
    config.commit = {
      when: raw.commit.when as 'never' | 'stop' | 'accepted-iteration' | undefined,
      message: raw.commit.message,
    };
  }

  return config;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadYamlRoute(routePath: string): RecipeDefinition {
  const content = readFileSync(routePath, 'utf-8');
  const baseDir = dirname(routePath);
  const schema = createYamlSchema(baseDir);

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
