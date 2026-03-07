import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractRunIdentity,
  loadRunSpec,
  runSpecToPrdText,
  type RunSpec,
} from '../run-spec.js';

describe('run-spec', () => {
  const createRunSpec = (overrides: Partial<RunSpec> = {}): RunSpec => ({
    version: 1,
    runId: 'run_123',
    createdAt: '2026-03-07T00:00:00.000Z',
    source: {
      tracker: 'github',
      issueId: '123',
      issueUrl: 'https://github.com/example/repo/issues/123',
      title: 'Improve quick mode',
      description: 'Need faster execution path',
      labels: ['hq', 'quick'],
      priority: 1,
      ...(overrides.source ?? {}),
    },
    target: {
      repo: 'example/repo',
      baseBranch: 'main',
      workspace: '/tmp/workspace',
      ...(overrides.target ?? {}),
    },
    objective: 'Implement Phase 1 support',
    constraints: ['No backward compatibility layer'],
    acceptanceCriteria: ['Quick mode skips planning'],
    context: {
      brief: 'Mission comes from HQ',
      relevantKnowledge: 'Use TASK.json as source of truth',
      recentChanges: 'CLI status schema changed recently',
      triage: 'P1',
      ...(overrides.context ?? {}),
    },
    options: {
      quick: true,
      model: 'codex-latest',
      maxIterations: 5,
      attempt: 2,
      ...(overrides.options ?? {}),
    },
    ...overrides,
  });

  it('loads a valid RunSpec JSON file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'melos-run-spec-'));
    const path = join(root, 'run-spec.json');
    writeFileSync(path, JSON.stringify(createRunSpec()), 'utf-8');

    await expect(loadRunSpec(path)).resolves.toMatchObject({
      version: 1,
      runId: 'run_123',
      source: {
        tracker: 'github',
        issueId: '123',
      },
      objective: 'Implement Phase 1 support',
    });
  });

  it('throws when required fields are missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'melos-run-spec-invalid-'));
    const path = join(root, 'run-spec.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      runId: 'run_123',
      createdAt: '2026-03-07T00:00:00.000Z',
      source: {
        tracker: 'github',
        title: 'Missing issue id',
      },
      target: {
        repo: 'example/repo',
      },
      objective: 'Implement Phase 1 support',
    }), 'utf-8');

    await expect(loadRunSpec(path)).rejects.toThrow(/source\.issueId is required/);
  });

  it('renders PRD markdown with all sections when fields exist', () => {
    const text = runSpecToPrdText(createRunSpec());

    expect(text).toContain('# Improve quick mode');
    expect(text).toContain('## Objective');
    expect(text).toContain('Implement Phase 1 support');
    expect(text).toContain('## Constraints');
    expect(text).toContain('- No backward compatibility layer');
    expect(text).toContain('## Acceptance Criteria');
    expect(text).toContain('- Quick mode skips planning');
    expect(text).toContain('## Source');
    expect(text).toContain('- Tracker: github');
    expect(text).toContain('- Issue: 123');
    expect(text).toContain('## Context');
    expect(text).toContain('### Background');
    expect(text).toContain('Mission comes from HQ');
    expect(text).toContain('### Relevant Knowledge');
    expect(text).toContain('### Recent Changes');
    expect(text).toContain('### Triage');
  });

  it('omits the Context section when context is missing', () => {
    const text = runSpecToPrdText(createRunSpec({ context: undefined }));

    expect(text).not.toContain('## Context');
    expect(text).toContain('## Source');
  });

  it('extracts run identity and defaults attempt to zero', () => {
    expect(extractRunIdentity(createRunSpec())).toEqual({
      runId: 'run_123',
      sourceTracker: 'github',
      sourceIssueId: '123',
      sourceIssueUrl: 'https://github.com/example/repo/issues/123',
      attempt: 2,
    });

    expect(extractRunIdentity(createRunSpec({
      options: {
        quick: true,
        attempt: undefined,
      },
    }))).toEqual({
      runId: 'run_123',
      sourceTracker: 'github',
      sourceIssueId: '123',
      sourceIssueUrl: 'https://github.com/example/repo/issues/123',
      attempt: 0,
    });
  });
});
