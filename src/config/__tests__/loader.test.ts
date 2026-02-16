import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, loadConfigSync, CONFIG_FILE_NAME } from '../loader.js';

describe('config loader', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'melos-config-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeConfig(config: unknown): void {
    writeFileSync(join(tempDir, CONFIG_FILE_NAME), JSON.stringify(config));
  }

  describe('loadConfig', () => {
    it('ファイルが存在しない場合は空オブジェクトを返す', async () => {
      const result = await loadConfig(tempDir);
      expect(result).toEqual({});
    });

    it('有効な JSON を正しくパースする', async () => {
      writeConfig({ model: 'opus', maxIterations: 20 });
      const result = await loadConfig(tempDir);
      expect(result).toEqual({ model: 'opus', maxIterations: 20 });
    });

    it('不正な JSON はエラーをスローする', async () => {
      writeFileSync(join(tempDir, CONFIG_FILE_NAME), '{invalid json}');
      await expect(loadConfig(tempDir)).rejects.toThrow('設定ファイルの読み込みに失敗しました');
    });
  });

  describe('loadConfigSync', () => {
    it('ファイルが存在しない場合は空オブジェクトを返す', () => {
      const result = loadConfigSync(tempDir);
      expect(result).toEqual({});
    });

    it('有効な JSON を正しくパースする', () => {
      writeConfig({ model: 'sonnet', maxIterations: 10 });
      const result = loadConfigSync(tempDir);
      expect(result).toEqual({ model: 'sonnet', maxIterations: 10 });
    });

    it('不正な JSON はエラーをスローする', () => {
      writeFileSync(join(tempDir, CONFIG_FILE_NAME), 'not json');
      expect(() => loadConfigSync(tempDir)).toThrow('設定ファイルの読み込みに失敗しました');
    });
  });

  describe('model バリデーション', () => {
    it('文字列のモデル名をそのまま返す', async () => {
      writeConfig({ model: 'opus' });
      const result = await loadConfig(tempDir);
      expect(result.model).toBe('opus');
    });

    it('数値のモデルは無視する', async () => {
      writeConfig({ model: 123 });
      const result = await loadConfig(tempDir);
      expect(result.model).toBeUndefined();
    });
  });

  describe('maxIterations バリデーション', () => {
    it('有効な整数を返す', async () => {
      writeConfig({ maxIterations: 50 });
      const result = await loadConfig(tempDir);
      expect(result.maxIterations).toBe(50);
    });

    it('小数は floor する', async () => {
      writeConfig({ maxIterations: 10.7 });
      const result = await loadConfig(tempDir);
      expect(result.maxIterations).toBe(10);
    });

    it('範囲外（0以下）は無視する', async () => {
      writeConfig({ maxIterations: 0 });
      const result = await loadConfig(tempDir);
      expect(result.maxIterations).toBeUndefined();
    });

    it('範囲外（1001以上）は無視する', async () => {
      writeConfig({ maxIterations: 1001 });
      const result = await loadConfig(tempDir);
      expect(result.maxIterations).toBeUndefined();
    });

    it('文字列は無視する', async () => {
      writeConfig({ maxIterations: 'ten' });
      const result = await loadConfig(tempDir);
      expect(result.maxIterations).toBeUndefined();
    });
  });

  describe('manager バリデーション', () => {
    it('manager.model を正しく返す', async () => {
      writeConfig({ manager: { model: 'sonnet' } });
      const result = await loadConfig(tempDir);
      expect(result.manager?.model).toBe('sonnet');
    });

    it('有効な effort を返す', async () => {
      writeConfig({ manager: { effort: 'high' } });
      const result = await loadConfig(tempDir);
      expect(result.manager?.effort).toBe('high');
    });

    it('無効な effort は無視する', async () => {
      writeConfig({ manager: { effort: 'ultra' } });
      const result = await loadConfig(tempDir);
      expect(result.manager).toBeUndefined();
    });

    it('空オブジェクトは削除する', async () => {
      writeConfig({ manager: {} });
      const result = await loadConfig(tempDir);
      expect(result.manager).toBeUndefined();
    });

    it('非オブジェクトは無視する', async () => {
      writeConfig({ manager: 'claude' });
      const result = await loadConfig(tempDir);
      expect(result.manager).toBeUndefined();
    });
  });

  describe('worker バリデーション', () => {
    it('worker.model を正しく返す', async () => {
      writeConfig({ worker: { model: 'gpt-5.3-codex' } });
      const result = await loadConfig(tempDir);
      expect(result.worker?.model).toBe('gpt-5.3-codex');
    });

    it('有効な reasoningEffort を返す', async () => {
      writeConfig({ worker: { reasoningEffort: 'high' } });
      const result = await loadConfig(tempDir);
      expect(result.worker?.reasoningEffort).toBe('high');
    });

    it('無効な reasoningEffort は無視する', async () => {
      writeConfig({ worker: { reasoningEffort: 'ultra' } });
      const result = await loadConfig(tempDir);
      expect(result.worker).toBeUndefined();
    });

    it('空オブジェクトは削除する', async () => {
      writeConfig({ worker: {} });
      const result = await loadConfig(tempDir);
      expect(result.worker).toBeUndefined();
    });
  });

  describe('統合テスト', () => {
    it('全フィールド有効の設定を正しくパースする', async () => {
      writeConfig({
        model: 'opus',
        maxIterations: 30,
        manager: { model: 'sonnet', effort: 'high' },
        worker: { model: 'gpt-5.3-codex', reasoningEffort: 'high' },
      });
      const result = await loadConfig(tempDir);
      expect(result).toEqual({
        model: 'opus',
        maxIterations: 30,
        manager: { model: 'sonnet', effort: 'high' },
        worker: { model: 'gpt-5.3-codex', reasoningEffort: 'high' },
      });
    });

    it('無効値混在時に有効値のみ残る', async () => {
      writeConfig({
        model: 'opus',
        maxIterations: -1,
        manager: { model: 'sonnet', effort: 'invalid' },
        worker: { model: 123, reasoningEffort: 'high' },
      });
      const result = await loadConfig(tempDir);
      expect(result).toEqual({
        model: 'opus',
        manager: { model: 'sonnet' },
        worker: { reasoningEffort: 'high' },
      });
    });

    it('未知のフィールドは無視される', async () => {
      writeConfig({
        model: 'opus',
        unknownField: true,
        phases: { research: 'codex' },
      });
      const result = await loadConfig(tempDir);
      expect(result).toEqual({ model: 'opus' });
    });
  });
});
