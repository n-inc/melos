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
        worker: 'gpt-5.3-codex',
        validator: 'sonnet',
        research: 'sonnet',
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
    expect(config.models?.worker).toBe('gpt-5.3-codex');
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
      git: {
        enabled: 'yes',
        validationCommands: ['npm test', 123, ''],
      },
    }), 'utf-8');

    const config = loadConfigSync(cwd);
    expect(config.maxIterations).toBeUndefined();
    expect(config.models).toBeUndefined();
    expect(config.git?.validationCommands).toEqual(['npm test']);
  });
});
