const FOLLOW_UP_KEY_PATTERNS: Array<{ key: string; patterns: RegExp[] }> = [
  {
    key: 'qa-evidence-capture',
    patterns: [
      /\bevidence\b/,
      /\bartifact\b/,
      /\bscreenshot\b/,
      /\bvideo\b/,
      /\bcapture\b/,
      /\bmissing required evidence\b/,
      /\bmissing before screenshot\b/,
      /\bmissing after screenshot\b/,
    ],
  },
  {
    key: 'learn-hub-fixture-determinism',
    patterns: [
      /\bseed(?:ed)?\b/,
      /\bfixture\b/,
      /\bparity\b/,
      /\bdeterministic\b/,
      /\bcategory count\b/,
      /\bexample count\b/,
      /\breview content\b/,
    ],
  },
  {
    key: 'learn-article-scroll-alignment',
    patterns: [
      /\btoc\b/,
      /\btable of contents\b/,
      /\bscrollspy\b/,
      /\bactive(?: |-)?state\b/,
      /\bactive(?: |-)?highlight\b/,
      /\boffset\b/,
      /\bhash\b/,
      /\bheading\b/,
    ],
  },
  {
    key: 'validation-command-scope',
    patterns: [
      /\bfull suite\b/,
      /\bbroad(?:er)? suite\b/,
      /\bwide(?:r)? suite\b/,
      /\bpassthrough\b/,
      /\bscoped command\b/,
      /\btarget(?:ed)? file\b/,
      /\bvalidation scope\b/,
    ],
  },
  {
    key: 'spec-contract-gap',
    patterns: [
      /\bprd\b/,
      /\bspec\b/,
      /\bacceptance\b/,
      /\bcontract\b/,
      /\bexample\b/,
      /\billustrative\b/,
      /\bnormative\b/,
    ],
  },
];

export function normalizeFollowUpProblemKey(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  for (const entry of FOLLOW_UP_KEY_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(normalized))) {
      return entry.key;
    }
  }

  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug.length > 0 ? slug : undefined;
}
