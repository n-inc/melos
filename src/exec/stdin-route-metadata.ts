const STDIN_YAML_INCLUDE_ROOT_PREFIX = '# __MELOS_STDIN_YAML_INCLUDE_ROOT__=';

export function prependStdinYamlIncludeRoot(sourceText: string, includeRoot: string): string {
  return `${STDIN_YAML_INCLUDE_ROOT_PREFIX}${JSON.stringify(includeRoot)}\n${sourceText}`;
}

export function extractStdinYamlIncludeRoot(sourceText: string): {
  content: string;
  includeRoot?: string;
} {
  if (!sourceText.startsWith(STDIN_YAML_INCLUDE_ROOT_PREFIX)) {
    return { content: sourceText };
  }

  const newlineIndex = sourceText.indexOf('\n');
  if (newlineIndex === -1) {
    return { content: sourceText };
  }

  const rawIncludeRoot = sourceText
    .slice(STDIN_YAML_INCLUDE_ROOT_PREFIX.length, newlineIndex)
    .trim();
  try {
    const includeRoot = JSON.parse(rawIncludeRoot) as unknown;
    if (typeof includeRoot === 'string' && includeRoot.length > 0) {
      return {
        content: sourceText.slice(newlineIndex + 1),
        includeRoot,
      };
    }
  } catch {
    // Ignore malformed metadata and fall back to the original content.
  }

  return { content: sourceText };
}
