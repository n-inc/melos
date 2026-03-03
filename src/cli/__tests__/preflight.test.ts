import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMissionPlan } from '../../state/mission.js';
import { detectResumableMissionState, prepareRunPreflight } from '../../cli.js';

describe('cli preflight', () => {
  it('fails fast when PRD.md is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-preflight-prd-'));
    await expect(prepareRunPreflight({
      cwd,
      melosDir: join(cwd, '.melos'),
      missionFilePath: join(cwd, 'TASK.json'),
      prdFilePath: join(cwd, 'PRD.md'),
      resume: false,
    })).rejects.toThrow(/PRD.md が見つからないためミッションを開始できません/);
    expect(existsSync(join(cwd, 'PRD.md'))).toBe(false);
  });

  it('fails on terminal-state TASK.json', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-preflight-archive-state-'));
    const missionFilePath = join(cwd, 'TASK.json');
    writeFileSync(join(cwd, 'PRD.md'), '# Mission\n', 'utf-8');
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

    await expect(prepareRunPreflight({
      cwd,
      melosDir: join(cwd, '.melos'),
      missionFilePath,
      prdFilePath: join(cwd, 'PRD.md'),
      resume: false,
    })).rejects.toThrow(/終了状態 \(completed\)/);
    expect(existsSync(missionFilePath)).toBe(true);
  });

  it('fails on invalid TASK.json', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-preflight-archive-invalid-'));
    const missionFilePath = join(cwd, 'TASK.json');
    writeFileSync(join(cwd, 'PRD.md'), '# Mission\n', 'utf-8');
    writeFileSync(missionFilePath, JSON.stringify([
      { id: '1', description: 'legacy task', passes: false },
    ]), 'utf-8');

    await expect(prepareRunPreflight({
      cwd,
      melosDir: join(cwd, '.melos'),
      missionFilePath,
      prdFilePath: join(cwd, 'PRD.md'),
      resume: false,
    })).rejects.toThrow(/TASK.json の読み込みに失敗したため、実行を停止しました/);
    expect(existsSync(missionFilePath)).toBe(true);
  });

  it('detects aborted TASK.json as resumable', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-preflight-resumable-aborted-'));
    const missionFilePath = join(cwd, 'TASK.json');
    const mission = createMissionPlan({
      goal: 'Sample mission',
      milestones: [
        {
          id: 'm1',
          title: 'M1',
          description: 'desc',
          status: 'in_progress',
          order: 1,
          validationContract: { staticChecks: [], testSuites: [] },
          features: [{ id: 'm1-f1', description: 'work', status: 'in_progress', attempts: 1 }],
        },
      ],
      state: 'aborted',
    });
    writeFileSync(missionFilePath, `${JSON.stringify(mission, null, 2)}\n`, 'utf-8');

    await expect(detectResumableMissionState(missionFilePath)).resolves.toBe('aborted');
  });

  it('does not mark completed mission as resumable', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-preflight-non-resumable-completed-'));
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

    await expect(detectResumableMissionState(missionFilePath)).resolves.toBeNull();
  });
});
