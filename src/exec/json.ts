export function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function extractEmbeddedJson(text: string): string | null {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return null;
  }

  for (const fencedMatch of normalized.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const fenced = fencedMatch[1]?.trim();
    if (!fenced || fenced.length === 0) {
      continue;
    }
    if (tryParseJson(fenced).ok) {
      return fenced;
    }
  }

  for (let start = 0; start < normalized.length; start += 1) {
    const open = normalized[start];
    if (open !== '{' && open !== '[') {
      continue;
    }

    const stack = [open];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < normalized.length; index += 1) {
      const char = normalized[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{' || char === '[') {
        stack.push(char);
        continue;
      }

      if (char === '}' || char === ']') {
        const expected = char === '}' ? '{' : '[';
        if (stack[stack.length - 1] !== expected) {
          break;
        }
        stack.pop();
        if (stack.length === 0) {
          const candidate = normalized.slice(start, index + 1);
          if (tryParseJson(candidate).ok) {
            return candidate;
          }
          break;
        }
      }
    }
  }

  return null;
}

export function parseJsonOrEmbedded(text: string): { ok: true; value: unknown } | { ok: false; error: unknown } {
  const direct = tryParseJson(text);
  if (direct.ok) {
    return direct;
  }

  const embedded = extractEmbeddedJson(text);
  if (!embedded) {
    return direct;
  }

  return tryParseJson(embedded);
}
