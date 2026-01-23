import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { Orchestrator, type EngineType } from '../orchestrator.js';
import { MockEngine } from '../engines/mock.js';
import type { Engine } from '../engines/base.js';
import type { Plan } from '../state/plan.js';

describe('Orchestrator Integration Tests', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `melos-integration-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    // Initialize as git repository (required for git state fetch)
    spawnSync('git', ['init'], { cwd: testDir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: testDir,
    });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * 最小 PRD を作成
   */
  async function createMinimalPrd(): Promise<void> {
    const prdContent = `# Smoke Test PRD
このタスクは正常終了することが目的です。
## 受入基準
- <promise>COMPLETE</promise> を出力する
`;
    await writeFile(join(testDir, 'PRD.md'), prdContent);
  }

  /**
   * 最小 PLAN を作成
   */
  async function createMinimalPlan(): Promise<void> {
    const plan: Plan = [
      {
        id: '1',
        description:
          'PLAN.jsonのpasses: trueに更新し、<promise>COMPLETE</promise>を出力する',
        passes: false,
      },
    ];
    await writeFile(join(testDir, 'PLAN.json'), JSON.stringify(plan, null, 2));
  }

  /**
   * MockEngine を使用したエンジンマップを作成
   */
  function createMockEngines(
    output: string = 'Task completed.\n<promise>COMPLETE</promise>'
  ): Map<EngineType, Engine> {
    const mockEngine = new MockEngine({ customOutput: output });
    const engines = new Map<EngineType, Engine>();
    engines.set('claude', mockEngine);
    engines.set('codex', mockEngine);
    return engines;
  }

  describe('Full loop with MockEngine', () => {
    it('should complete successfully with COMPLETE promise', async () => {
      // Setup
      await createMinimalPrd();
      await createMinimalPlan();

      const engines = createMockEngines();
      const orchestrator = new Orchestrator({
        cwd: testDir,
        mode: 'default',
        maxIterations: 5,
        engine: 'claude',
        hitl: false,
        prdFile: 'PRD.md',
        planFile: 'PLAN.json',
        progressFile: 'PROGRESS.md',
        statusFile: 'STATUS.json',
        engines,
      });

      // Execute
      const result = await orchestrator.run();

      // Verify
      expect(result.success).toBe(true);
      expect(result.reason).toBe('complete');
      expect(result.completedIterations).toBeGreaterThanOrEqual(1);
    });

    it('should handle TASK_DONE and continue loop', async () => {
      // Setup
      await createMinimalPrd();
      await createMinimalPlan();

      // First call returns TASK_DONE, second call returns COMPLETE
      let callCount = 0;
      const mockEngine = new MockEngine();
      mockEngine.setDefaultOutput('Task done.\n<promise>TASK_DONE</promise>');

      // Override execute to change output on second call
      const originalExecute = mockEngine.execute.bind(mockEngine);
      mockEngine.execute = async (prompt, options) => {
        callCount++;
        if (callCount >= 2) {
          mockEngine.setDefaultOutput(
            'All done.\n<promise>COMPLETE</promise>'
          );
        }
        return originalExecute(prompt, options);
      };

      const engines = new Map<EngineType, Engine>();
      engines.set('claude', mockEngine);
      engines.set('codex', mockEngine);

      const orchestrator = new Orchestrator({
        cwd: testDir,
        mode: 'default',
        maxIterations: 5,
        engine: 'claude',
        hitl: false,
        prdFile: 'PRD.md',
        planFile: 'PLAN.json',
        progressFile: 'PROGRESS.md',
        statusFile: 'STATUS.json',
        engines,
      });

      // Execute
      const result = await orchestrator.run();

      // Verify - should have run multiple iterations
      expect(result.success).toBe(true);
      expect(result.reason).toBe('complete');
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('should stop at max iterations when no COMPLETE promise', async () => {
      // Setup
      await createMinimalPrd();
      await createMinimalPlan();

      // Always return TASK_DONE (never complete)
      const engines = createMockEngines(
        'Still working.\n<promise>TASK_DONE</promise>'
      );

      const orchestrator = new Orchestrator({
        cwd: testDir,
        mode: 'default',
        maxIterations: 3,
        engine: 'claude',
        hitl: false,
        prdFile: 'PRD.md',
        planFile: 'PLAN.json',
        progressFile: 'PROGRESS.md',
        statusFile: 'STATUS.json',
        engines,
      });

      // Execute
      const result = await orchestrator.run();

      // Verify
      expect(result.success).toBe(false);
      expect(result.reason).toBe('max_iterations');
    });

    it('should handle ESCALATE promise', async () => {
      // Setup
      await createMinimalPrd();
      await createMinimalPlan();

      const engines = createMockEngines(
        'Need help.\n<promise>ESCALATE</promise>'
      );

      const orchestrator = new Orchestrator({
        cwd: testDir,
        mode: 'default',
        maxIterations: 5,
        engine: 'claude',
        hitl: false,
        prdFile: 'PRD.md',
        planFile: 'PLAN.json',
        progressFile: 'PROGRESS.md',
        statusFile: 'STATUS.json',
        engines,
      });

      // Execute
      const result = await orchestrator.run();

      // Verify
      expect(result.success).toBe(false);
      expect(result.reason).toBe('escalation');
    });

    it('should work with HITL mode (single iteration)', async () => {
      // Setup
      await createMinimalPrd();
      await createMinimalPlan();

      const engines = createMockEngines(
        'Task done.\n<promise>TASK_DONE</promise>'
      );

      const orchestrator = new Orchestrator({
        cwd: testDir,
        mode: 'default',
        maxIterations: 5,
        engine: 'claude',
        hitl: true, // HITL mode enabled
        prdFile: 'PRD.md',
        planFile: 'PLAN.json',
        progressFile: 'PROGRESS.md',
        statusFile: 'STATUS.json',
        engines,
      });

      // Execute
      const result = await orchestrator.run();

      // Verify - HITL mode should stop after 1 iteration
      expect(result.success).toBe(true);
      expect(result.reason).toBe('hitl_pause');
      expect(result.completedIterations).toBe(1);
    });
  });

  describe('Error handling', () => {
    it('should throw error when PRD file is missing', async () => {
      // Setup - create PLAN but no PRD
      await createMinimalPlan();

      const engines = createMockEngines();
      const orchestrator = new Orchestrator({
        cwd: testDir,
        mode: 'default',
        maxIterations: 5,
        engine: 'claude',
        hitl: false,
        prdFile: 'PRD.md',
        planFile: 'PLAN.json',
        progressFile: 'PROGRESS.md',
        statusFile: 'STATUS.json',
        engines,
      });

      // Execute & Verify
      await expect(orchestrator.run()).rejects.toThrow('PRD ファイルが見つかりません');
    });

    it('should throw error when PLAN file is missing', async () => {
      // Setup - create PRD but no PLAN
      await createMinimalPrd();

      const engines = createMockEngines();
      const orchestrator = new Orchestrator({
        cwd: testDir,
        mode: 'default',
        maxIterations: 5,
        engine: 'claude',
        hitl: false,
        prdFile: 'PRD.md',
        planFile: 'PLAN.json',
        progressFile: 'PROGRESS.md',
        statusFile: 'STATUS.json',
        engines,
      });

      // Execute & Verify
      await expect(orchestrator.run()).rejects.toThrow(
        'プランファイルが見つかりません'
      );
    });
  });

  describe('Mode-specific behavior', () => {
    it('should work with task-only mode', async () => {
      // Setup
      await createMinimalPrd();
      await createMinimalPlan();

      const engines = createMockEngines();
      const orchestrator = new Orchestrator({
        cwd: testDir,
        mode: 'task-only',
        maxIterations: 5,
        engine: 'claude',
        hitl: false,
        prdFile: 'PRD.md',
        planFile: 'PLAN.json',
        progressFile: 'PROGRESS.md',
        statusFile: 'STATUS.json',
        engines,
      });

      // Execute
      const result = await orchestrator.run();

      // Verify
      expect(result.success).toBe(true);
      expect(result.reason).toBe('complete');
    });

    it('should work with review-only mode (no PRD/PLAN required)', async () => {
      // Setup - no PRD/PLAN files needed for review-only
      const engines = createMockEngines();
      const orchestrator = new Orchestrator({
        cwd: testDir,
        mode: 'review-only',
        maxIterations: 5,
        engine: 'claude',
        hitl: false,
        prdFile: 'PRD.md',
        planFile: 'PLAN.json',
        progressFile: 'PROGRESS.md',
        statusFile: 'STATUS.json',
        engines,
      });

      // Execute
      const result = await orchestrator.run();

      // Verify
      expect(result.success).toBe(true);
      expect(result.reason).toBe('complete');
    });
  });
});
