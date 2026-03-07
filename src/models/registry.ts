export type ModelEngine = 'claude' | 'codex';

export const CODEX_LATEST_ALIAS = 'codex-latest';
export const CLAUDE_LATEST_ALIAS = 'claude-latest';

export interface ResolvedModel {
  input: string;
  normalized: string;
  runtimeModel: string;
  engine: ModelEngine;
  effort: string;
  displayLabel: string;
  displayModel: string;
  isLatestAlias: boolean;
}

interface ModelDefinition {
  runtimeModel: string;
  engine: ModelEngine;
  effort: string;
  displayLabel: string;
  isLatestAlias: boolean;
}

const MODEL_DEFINITIONS: Record<string, ModelDefinition> = {
  [CODEX_LATEST_ALIAS]: {
    runtimeModel: 'gpt-5.4',
    engine: 'codex',
    effort: 'xhigh',
    displayLabel: 'gpt-5.4',
    isLatestAlias: true,
  },
  [CLAUDE_LATEST_ALIAS]: {
    runtimeModel: 'opus',
    engine: 'claude',
    effort: 'max',
    displayLabel: 'claude-opus-4.6',
    isLatestAlias: true,
  },
  'gpt-5.4': {
    runtimeModel: 'gpt-5.4',
    engine: 'codex',
    effort: 'xhigh',
    displayLabel: 'gpt-5.4',
    isLatestAlias: false,
  },
  'gpt-5.4-codex': {
    runtimeModel: 'gpt-5.4-codex',
    engine: 'codex',
    effort: 'xhigh',
    displayLabel: 'gpt-5.4-codex',
    isLatestAlias: false,
  },
  opus: {
    runtimeModel: 'opus',
    engine: 'claude',
    effort: 'max',
    displayLabel: 'opus',
    isLatestAlias: false,
  },
  'claude-opus-4.6': {
    runtimeModel: 'claude-opus-4.6',
    engine: 'claude',
    effort: 'max',
    displayLabel: 'claude-opus-4.6',
    isLatestAlias: false,
  },
  sonnet: {
    runtimeModel: 'sonnet',
    engine: 'claude',
    effort: 'high',
    displayLabel: 'sonnet',
    isLatestAlias: false,
  },
  'claude-sonnet-4.5': {
    runtimeModel: 'claude-sonnet-4.5',
    engine: 'claude',
    effort: 'high',
    displayLabel: 'claude-sonnet-4.5',
    isLatestAlias: false,
  },
  haiku: {
    runtimeModel: 'haiku',
    engine: 'claude',
    effort: 'low',
    displayLabel: 'haiku',
    isLatestAlias: false,
  },
  'claude-haiku-4.5': {
    runtimeModel: 'claude-haiku-4.5',
    engine: 'claude',
    effort: 'low',
    displayLabel: 'claude-haiku-4.5',
    isLatestAlias: false,
  },
};

export function normalizeModelName(
  model: string | undefined | null
): string | undefined {
  if (typeof model !== 'string') {
    return undefined;
  }
  const normalized = model.trim().toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized === 'codex') {
    return CODEX_LATEST_ALIAS;
  }
  if (normalized === 'claude') {
    return CLAUDE_LATEST_ALIAS;
  }
  return normalized;
}

export function resolveModel(
  model: string | undefined | null,
  fallbackAlias: string = CODEX_LATEST_ALIAS
): ResolvedModel {
  const normalized = normalizeModelName(model) ?? normalizeModelName(fallbackAlias) ?? CODEX_LATEST_ALIAS;
  const definition = MODEL_DEFINITIONS[normalized];
  if (definition) {
    return {
      input: model?.trim() || fallbackAlias,
      normalized,
      runtimeModel: definition.runtimeModel,
      engine: definition.engine,
      effort: definition.effort,
      displayLabel: definition.displayLabel,
      displayModel: definition.isLatestAlias
        ? `${definition.displayLabel} [Latest]`
        : definition.displayLabel,
      isLatestAlias: definition.isLatestAlias,
    };
  }

  const engine = inferEngineFromUnknownModel(normalized);
  return {
    input: model?.trim() || fallbackAlias,
    normalized,
    runtimeModel: normalized,
    engine,
    effort: inferEffortForUnknownModel(normalized, engine),
    displayLabel: normalized,
    displayModel: normalized,
    isLatestAlias: false,
  };
}

export function resolveModelEngine(model: string | undefined | null): ModelEngine {
  return resolveModel(model).engine;
}

export function resolveModelEffort(model: string | undefined | null): string {
  return resolveModel(model).effort;
}

export function resolveRuntimeModel(
  model: string | undefined | null,
  fallbackAlias: string = CODEX_LATEST_ALIAS
): string {
  return resolveModel(model, fallbackAlias).runtimeModel;
}

export function resolveDisplayModel(
  model: string | undefined | null,
  fallbackAlias: string = CODEX_LATEST_ALIAS
): string {
  return resolveModel(model, fallbackAlias).displayModel;
}

export function isCodexFamily(model: string | undefined | null): boolean {
  return resolveModel(model).engine === 'codex';
}

export function isClaudeFamily(model: string | undefined | null): boolean {
  return resolveModel(model).engine === 'claude';
}

export function getModelRotation(): string[] {
  return [CODEX_LATEST_ALIAS, CLAUDE_LATEST_ALIAS, 'sonnet', 'haiku'];
}

function inferEngineFromUnknownModel(normalized: string): ModelEngine {
  if (
    normalized.startsWith('gpt-')
    || normalized.includes('codex')
    || normalized.startsWith('o')
  ) {
    return 'codex';
  }
  return 'claude';
}

function inferEffortForUnknownModel(normalized: string, engine: ModelEngine): string {
  if (engine === 'codex') {
    return 'xhigh';
  }
  if (normalized.includes('haiku')) {
    return 'low';
  }
  if (normalized.includes('sonnet')) {
    return 'high';
  }
  if (normalized.includes('opus')) {
    return 'max';
  }
  return 'medium';
}
