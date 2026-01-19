import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createDefaultStatus,
  createDefaultGitState,
  statusExists,
  loadStatus,
  saveStatus,
  updateStatus,
  markEngineStarted,
  markEngineCompleted,
  markIterationStarted,
  updateGitState,
  updateTaskProgress,
  clearStatus,
  type MarathonStatus,
  type GitState,
} from '../status.js';

describe('status.ts', () => {
  let tempDir: string;
  let statusPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'marathon-status-test-'));
    statusPath = join(tempDir, 'STATUS.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('createDefaultGitState', () => {
    test('デフォルト値を持つGitStateを生成する', () => {
      const gitState = createDefaultGitState();

      expect(gitState.branch).toBe('');
      expect(gitState.isPushed).toBe(false);
      expect(gitState.pullRequest).toBeNull();
      expect(gitState.lastCommitHash).toBe('');
      expect(gitState.fetchedAt).toBeTruthy();
    });
  });

  describe('createDefaultStatus', () => {
    test('デフォルト値を持つステータスを生成する', () => {
      const status = createDefaultStatus();

      expect(status.iteration).toBe(0);
      expect(status.maxIterations).toBe(30);
      expect(status.currentTask).toBeNull();
      expect(status.completedTasks).toBe(0);
      expect(status.totalTasks).toBe(0);
      expect(status.engine).toBe('claude');
      expect(status.status).toBe('idle');
      expect(status.gitState).toBeDefined();
      expect(status.gitState.branch).toBe('');
    });
  });

  describe('statusExists', () => {
    test('ファイルが存在しない場合 false を返す', () => {
      expect(statusExists(statusPath)).toBe(false);
    });

    test('ファイルが存在する場合 true を返す', async () => {
      const status = createDefaultStatus();
      await saveStatus(statusPath, status);

      expect(statusExists(statusPath)).toBe(true);
    });
  });

  describe('saveStatus / loadStatus', () => {
    test('ステータスを保存して読み込める', async () => {
      const gitState: GitState = {
        branch: 'feature/test',
        isPushed: true,
        pullRequest: { number: 123, url: 'https://github.com/test/pr/123' },
        lastCommitHash: 'abc123',
        fetchedAt: new Date().toISOString(),
      };

      const status: MarathonStatus = {
        ...createDefaultStatus(),
        iteration: 5,
        maxIterations: 10,
        gitState,
        currentTask: { id: 'test-1', description: 'テストタスク' },
      };

      await saveStatus(statusPath, status);
      const loaded = await loadStatus(statusPath);

      expect(loaded.iteration).toBe(5);
      expect(loaded.maxIterations).toBe(10);
      expect(loaded.gitState.branch).toBe('feature/test');
      expect(loaded.gitState.isPushed).toBe(true);
      expect(loaded.gitState.pullRequest?.number).toBe(123);
      expect(loaded.currentTask?.id).toBe('test-1');
    });

    test('ファイルが存在しない場合デフォルト値を返す', async () => {
      const loaded = await loadStatus(statusPath);

      expect(loaded.iteration).toBe(0);
      expect(loaded.status).toBe('idle');
    });
  });

  describe('updateStatus', () => {
    test('部分的な更新ができる', async () => {
      const initial = createDefaultStatus();
      await saveStatus(statusPath, initial);

      const updated = await updateStatus(statusPath, {
        iteration: 3,
        status: 'running',
      });

      expect(updated.iteration).toBe(3);
      expect(updated.status).toBe('running');
      expect(updated.maxIterations).toBe(30); // 変更されていない
    });
  });

  describe('markEngineStarted', () => {
    test('エンジン開始時刻を記録する', async () => {
      await saveStatus(statusPath, createDefaultStatus());

      const updated = await markEngineStarted(statusPath, 'codex');

      expect(updated.engine).toBe('codex');
      expect(updated.engineStartedAt).not.toBeNull();
      expect(updated.status).toBe('running');
    });
  });

  describe('markEngineCompleted', () => {
    test('成功時に completed ステータスを設定', async () => {
      await saveStatus(statusPath, {
        ...createDefaultStatus(),
        engineStartedAt: new Date().toISOString(),
        status: 'running',
      });

      const updated = await markEngineCompleted(statusPath, true);

      expect(updated.engineStartedAt).toBeNull();
      expect(updated.status).toBe('completed');
    });

    test('失敗時に error ステータスを設定', async () => {
      await saveStatus(statusPath, {
        ...createDefaultStatus(),
        status: 'running',
      });

      const updated = await markEngineCompleted(statusPath, false);

      expect(updated.status).toBe('error');
    });
  });

  describe('markIterationStarted', () => {
    test('イテレーション開始を記録する', async () => {
      await saveStatus(statusPath, createDefaultStatus());

      const updated = await markIterationStarted(statusPath, 5, 30, {
        id: 'impl-01',
        description: 'API実装',
      });

      expect(updated.iteration).toBe(5);
      expect(updated.maxIterations).toBe(30);
      expect(updated.currentTask?.id).toBe('impl-01');
      expect(updated.status).toBe('running');
    });
  });

  describe('updateGitState', () => {
    test('Git状態を更新する', async () => {
      await saveStatus(statusPath, createDefaultStatus());

      const newGitState: GitState = {
        branch: 'feature/new-branch',
        isPushed: true,
        pullRequest: { number: 456, url: 'https://github.com/test/pr/456' },
        lastCommitHash: 'def456',
        fetchedAt: new Date().toISOString(),
      };

      const updated = await updateGitState(statusPath, newGitState);

      expect(updated.gitState.branch).toBe('feature/new-branch');
      expect(updated.gitState.isPushed).toBe(true);
      expect(updated.gitState.pullRequest?.number).toBe(456);
      expect(updated.gitState.lastCommitHash).toBe('def456');
    });
  });

  describe('updateTaskProgress', () => {
    test('タスク進捗を更新する', async () => {
      await saveStatus(statusPath, createDefaultStatus());

      const updated = await updateTaskProgress(statusPath, 5, 15);

      expect(updated.completedTasks).toBe(5);
      expect(updated.totalTasks).toBe(15);
    });
  });

  describe('clearStatus', () => {
    test('ステータスファイルを削除する', async () => {
      await saveStatus(statusPath, createDefaultStatus());
      expect(statusExists(statusPath)).toBe(true);

      await clearStatus(statusPath);

      expect(statusExists(statusPath)).toBe(false);
    });

    test('ファイルが存在しなくてもエラーにならない', async () => {
      await clearStatus(statusPath); // エラーが発生しないことを確認
    });
  });
});
