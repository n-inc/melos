import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, loadConfigSync } from '../loader.js';

describe('config loader v0.8', () => {
  it('loads models section', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-config-'));
    writeFileSync(join(cwd, '.melos.json'), JSON.stringify({
      maxIterations: 321,
      models: {
        planner: 'opus',
        worker: 'gpt-5.4',
        validator: 'sonnet',
        research: 'sonnet',
      },
      execution: {
        maxFeatureAttempts: 5,
        retryInitialDelayMs: 2500,
        retryMaxDelayMs: 15000,
        stallTimeoutMs: 450000,
      },
      verification: {
        requireManualEvidence: true,
        requireE2EEvidence: false,
        failOnWorkerWarnings: true,
      },
      git: {
        enabled: true,
        baseBranch: 'develop',
        autoPush: true,
        preMergeValidation: true,
        validationCommands: ['npm run typecheck'],
      },
    }), 'utf-8');

    const config = await loadConfig(cwd);
    expect(config.maxIterations).toBe(321);
    expect(config.models?.planner).toBe('opus');
    expect(config.models?.worker).toBe('gpt-5.4');
    expect(config.execution).toEqual({
      maxFeatureAttempts: 5,
      retryInitialDelayMs: 2500,
      retryMaxDelayMs: 15000,
      stallTimeoutMs: 450000,
    });
    expect(config.verification).toEqual({
      requireManualEvidence: true,
      requireE2EEvidence: false,
      failOnWorkerWarnings: true,
    });
    expect(config.git?.enabled).toBe(true);
    expect(config.git?.baseBranch).toBe('develop');
    expect(config.git?.validationCommands).toEqual(['npm run typecheck']);
  });

  it('filters invalid fields', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-config-invalid-'));
    writeFileSync(join(cwd, '.melos.json'), JSON.stringify({
      maxIterations: -1,
      models: {
        planner: '',
        worker: '   ',
      },
      execution: {
        maxFeatureAttempts: 0,
        retryInitialDelayMs: -1,
        retryMaxDelayMs: 4_000_000,
        stallTimeoutMs: 999,
      },
      verification: {
        requireManualEvidence: 'yes',
        failOnWorkerWarnings: 1,
      },
      git: {
        enabled: 'yes',
        validationCommands: ['npm test', 123, ''],
      },
    }), 'utf-8');

    const config = loadConfigSync(cwd);
    expect(config.maxIterations).toBeUndefined();
    expect(config.models).toBeUndefined();
    expect(config.execution).toBeUndefined();
    expect(config.verification).toBeUndefined();
    expect(config.git?.validationCommands).toEqual(['npm test']);
  });
});
