import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMissionPlan } from '../../state/mission.js';
import { prepareRunPreflight } from '../../cli.js';

describe('cli preflight', () => {
  it('creates PRD template when PRD.md is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-preflight-prd-'));
    const messages = await prepareRunPreflight({
      cwd,
      melosDir: join(cwd, '.melos'),
      missionFilePath: join(cwd, 'TASK.json'),
      prdFilePath: join(cwd, 'PRD.md'),
      resume: false,
    });

    expect(existsSync(join(cwd, 'PRD.md'))).toBe(true);
    expect(messages.some((message) => message.includes('PRD.md が見つからなかった'))).toBe(true);
  });

  it('archives terminal-state TASK.json and starts fresh run', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-preflight-archive-state-'));
    const missionFilePath = join(cwd, 'TASK.json');
    const mission = createMissionPlan({
      goal: 'Sample mission',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          status: 'done',
          order: 1,
          validationContract: { staticChecks: [], testSuites: [] },
          features: [{ id: 'm1-f1', description: 'done', status: 'done', attempts: 1 }],
        },
      ],
      state: 'completed',
    });
    writeFileSync(missionFilePath, `${JSON.stringify(mission, null, 2)}\n`, 'utf-8');

    const messages = await prepareRunPreflight({
      cwd,
      melosDir: join(cwd, '.melos'),
      missionFilePath,
      prdFilePath: join(cwd, 'PRD.md'),
      resume: false,
    });

    expect(existsSync(missionFilePath)).toBe(false);
    const archivedFiles = readdirSync(join(cwd, '.melos', 'archive')).filter((name) => name.includes('state-completed'));
    expect(archivedFiles.length).toBe(1);
    expect(messages.some((message) => message.includes('終了状態 (completed)'))).toBe(true);
  });

  it('archives invalid TASK.json with actionable message', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-preflight-archive-invalid-'));
    const missionFilePath = join(cwd, 'TASK.json');
    writeFileSync(missionFilePath, JSON.stringify([
      { id: '1', description: 'legacy task', passes: false },
    ]), 'utf-8');

    const messages = await prepareRunPreflight({
      cwd,
      melosDir: join(cwd, '.melos'),
      missionFilePath,
      prdFilePath: join(cwd, 'PRD.md'),
      resume: false,
    });

    expect(existsSync(missionFilePath)).toBe(false);
    const archivedFiles = readdirSync(join(cwd, '.melos', 'archive')).filter((name) => name.includes('.invalid.'));
    expect(archivedFiles.length).toBe(1);
    expect(messages.some((message) => message.includes('読み込みに失敗したため退避'))).toBe(true);
    expect(messages.some((message) => message.includes('読み込みエラー'))).toBe(true);
  });
});
