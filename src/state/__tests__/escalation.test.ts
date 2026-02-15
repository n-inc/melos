import { mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  createEscalation,
  saveEscalation,
  loadEscalation,
  clearEscalation,
  type Escalation,
} from '../escalation.js';

describe('escalation.ts', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `melos-escalation-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('createEscalation', () => {
    it('creates a QUESTION escalation', () => {
      const escalation = createEscalation({
        type: 'QUESTION',
        context: 'task-1',
        question: 'Which approach should we use?',
      });

      expect(escalation.type).toBe('QUESTION');
      expect(escalation.context).toBe('task-1');
      expect(escalation.question).toBe('Which approach should we use?');
      expect(escalation.status).toBe('pending');
      expect(escalation.id).toBeDefined();
      expect(escalation.id).toMatch(/^esc-/);
    });

    it('creates an APPROVAL escalation with options', () => {
      const escalation = createEscalation({
        type: 'APPROVAL',
        context: 'production-deploy',
        question: 'Approve production deployment?',
        options: [
          { label: 'Yes', description: 'Proceed with deployment' },
          { label: 'No', description: 'Cancel deployment' },
        ],
        recommendation: 'Yes',
      });

      expect(escalation.type).toBe('APPROVAL');
      expect(escalation.options).toHaveLength(2);
      expect(escalation.options![0].label).toBe('Yes');
      expect(escalation.recommendation).toBe('Yes');
    });

    it('creates a BLOCKER escalation', () => {
      const escalation = createEscalation({
        type: 'BLOCKER',
        context: 'api-integration',
        question: 'API credentials are required',
      });

      expect(escalation.type).toBe('BLOCKER');
    });
  });

  describe('saveEscalation and loadEscalation', () => {
    it('saves and loads an escalation', async () => {
      const escalation = createEscalation({
        type: 'QUESTION',
        context: 'task-1',
        question: 'What should we do?',
      });

      await saveEscalation(testDir, escalation);

      const loaded = await loadEscalation(testDir);
      expect(loaded).not.toBeNull();
      expect(loaded!.type).toBe('QUESTION');
      expect(loaded!.question).toBe('What should we do?');
    });

    it('returns null when no escalation exists', async () => {
      const loaded = await loadEscalation(testDir);
      expect(loaded).toBeNull();
    });

    it('saves escalation as JSON file', async () => {
      const escalation = createEscalation({
        type: 'QUESTION',
        context: 'test',
        question: 'Test question',
      });

      await saveEscalation(testDir, escalation);

      const filePath = join(testDir, 'ESCALATION.json');
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed.type).toBe('QUESTION');
      expect(parsed.status).toBe('pending');
    });

    it('updates escalation with answer', async () => {
      const escalation = createEscalation({
        type: 'QUESTION',
        context: 'task-1',
        question: 'Which option?',
        options: [
          { label: 'A', description: 'Option A' },
          { label: 'B', description: 'Option B' },
        ],
      });

      await saveEscalation(testDir, escalation);

      // Update with answer
      escalation.status = 'answered';
      escalation.answer = 'A';
      await saveEscalation(testDir, escalation);

      const loaded = await loadEscalation(testDir);
      expect(loaded!.status).toBe('answered');
      expect(loaded!.answer).toBe('A');
    });
  });

  describe('clearEscalation', () => {
    it('removes the escalation file', async () => {
      const escalation = createEscalation({
        type: 'QUESTION',
        context: 'test',
        question: 'Test',
      });

      await saveEscalation(testDir, escalation);

      const filePath = join(testDir, 'ESCALATION.json');
      expect(existsSync(filePath)).toBe(true);

      await clearEscalation(testDir);
      expect(existsSync(filePath)).toBe(false);
    });

    it('does nothing when no escalation exists', async () => {
      // Should not throw
      await clearEscalation(testDir);
    });
  });
});
