import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectFromContent,
  detectFromGitDiff,
  detectFromPlanFile,
  detectFeedbackLoops,
  buildFeedbackInstructions,
} from '../feedback.js';

describe('feedback detection', () => {
  describe('detectFromContent', () => {
    it('should detect frontend keywords', () => {
      const result = detectFromContent('frontend/src/components/Button.tsx');
      expect(result.frontend).toBe(true);
      expect(result.backend).toBe(false);
    });

    it('should detect backend keywords', () => {
      const result = detectFromContent('api/app/controllers/users_controller.rb');
      expect(result.frontend).toBe(false);
      expect(result.backend).toBe(true);
    });

    it('should detect both frontend and backend', () => {
      const result = detectFromContent(`
        frontend/src/App.tsx
        api/app/models/user.rb
      `);
      expect(result.frontend).toBe(true);
      expect(result.backend).toBe(true);
    });

    it('should detect react keyword (case insensitive)', () => {
      const result = detectFromContent('Some React component');
      expect(result.frontend).toBe(true);
    });

    it('should detect tsx files', () => {
      const result = detectFromContent('Button.tsx');
      expect(result.frontend).toBe(true);
    });

    it('should detect jsx files', () => {
      const result = detectFromContent('App.jsx');
      expect(result.frontend).toBe(true);
    });

    it('should detect nextjs', () => {
      const result = detectFromContent('next.js config');
      expect(result.frontend).toBe(true);
    });

    it('should detect nextjs without dot', () => {
      const result = detectFromContent('nextjs page');
      expect(result.frontend).toBe(true);
    });

    it('should detect page keyword', () => {
      const result = detectFromContent('pages/index.tsx');
      expect(result.frontend).toBe(true);
    });

    it('should detect ui keyword', () => {
      const result = detectFromContent('ui/Button');
      expect(result.frontend).toBe(true);
    });

    it('should detect component keyword', () => {
      const result = detectFromContent('MyComponent');
      expect(result.frontend).toBe(true);
    });

    it('should detect rails keyword', () => {
      const result = detectFromContent('Rails.application');
      expect(result.backend).toBe(true);
    });

    it('should detect ruby keyword', () => {
      const result = detectFromContent('ruby code');
      expect(result.backend).toBe(true);
    });

    it('should detect controller keyword', () => {
      const result = detectFromContent('UsersController');
      expect(result.backend).toBe(true);
    });

    it('should detect model keyword', () => {
      const result = detectFromContent('User model');
      expect(result.backend).toBe(true);
    });

    it('should detect migration keyword', () => {
      const result = detectFromContent('db/migrate/20240101_add_users.rb');
      expect(result.backend).toBe(true);
    });

    it('should detect service keyword', () => {
      const result = detectFromContent('UserService');
      expect(result.backend).toBe(true);
    });

    it('should detect graphql keyword', () => {
      const result = detectFromContent('graphql/types');
      expect(result.backend).toBe(true);
    });

    it('should detect rspec keyword', () => {
      const result = detectFromContent('rspec tests');
      expect(result.backend).toBe(true);
    });

    it('should return both when no keywords detected', () => {
      const result = detectFromContent('some random text');
      expect(result.frontend).toBe(true);
      expect(result.backend).toBe(true);
    });

    it('should return both for empty content', () => {
      const result = detectFromContent('');
      expect(result.frontend).toBe(true);
      expect(result.backend).toBe(true);
    });
  });

  describe('detectFromGitDiff', () => {
    it('should return results from current git repo', () => {
      // This test runs in an actual git repo, so it should work
      const result = detectFromGitDiff('main');
      // Just verify it returns a valid FeedbackLoops object
      expect(typeof result.frontend).toBe('boolean');
      expect(typeof result.backend).toBe('boolean');
    });

    it('should use custom branch', () => {
      // Test with a branch that likely doesn't exist
      const result = detectFromGitDiff('nonexistent-branch-12345');
      // When git diff fails, it should return both true
      expect(result.frontend).toBe(true);
      expect(result.backend).toBe(true);
    });
  });

  describe('detectFromPlanFile', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `marathon-feedback-test-${Date.now()}`);
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    it('should detect from PLAN.json content with frontend keywords', async () => {
      const planPath = join(testDir, 'PLAN.json');
      await writeFile(
        planPath,
        JSON.stringify([
          { id: '1', description: 'Implement frontend Button component' },
        ])
      );

      const result = await detectFromPlanFile(planPath);
      expect(result.frontend).toBe(true);
      expect(result.backend).toBe(false);
    });

    it('should detect from PLAN.json content with backend keywords', async () => {
      const planPath = join(testDir, 'PLAN.json');
      await writeFile(
        planPath,
        JSON.stringify([
          { id: '1', description: 'Update api controller for users' },
        ])
      );

      const result = await detectFromPlanFile(planPath);
      expect(result.frontend).toBe(false);
      expect(result.backend).toBe(true);
    });

    it('should return both when file does not exist', async () => {
      const result = await detectFromPlanFile(join(testDir, 'nonexistent.json'));
      expect(result.frontend).toBe(true);
      expect(result.backend).toBe(true);
    });
  });

  describe('detectFeedbackLoops', () => {
    let testDir: string;

    beforeEach(async () => {
      testDir = join(tmpdir(), `marathon-feedback-test-${Date.now()}`);
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    it('should use PLAN.json when path provided and file exists', async () => {
      const planPath = join(testDir, 'PLAN.json');
      await writeFile(
        planPath,
        JSON.stringify([{ description: 'api controller changes' }])
      );

      const result = await detectFeedbackLoops(planPath);
      expect(result.backend).toBe(true);
      expect(result.frontend).toBe(false);
    });

    it('should fall back to git diff when no PLAN.json path', async () => {
      const result = await detectFeedbackLoops(undefined, 'main');
      // Just verify it returns a valid result
      expect(typeof result.frontend).toBe('boolean');
      expect(typeof result.backend).toBe('boolean');
    });

    it('should fall back to git diff when PLAN.json does not exist', async () => {
      const result = await detectFeedbackLoops(join(testDir, 'nonexistent.json'), 'main');
      // Just verify it returns a valid result (falls back to git diff or returns both)
      expect(typeof result.frontend).toBe('boolean');
      expect(typeof result.backend).toBe('boolean');
    });
  });

  describe('buildFeedbackInstructions', () => {
    it('should build frontend instructions only', () => {
      const result = buildFeedbackInstructions({ frontend: true, backend: false });
      expect(result).toContain('Frontend');
      expect(result).toContain('yarn typecheck');
      expect(result).toContain('yarn lint');
      expect(result).not.toContain('Backend');
    });

    it('should build backend instructions only', () => {
      const result = buildFeedbackInstructions({ frontend: false, backend: true });
      expect(result).not.toContain('Frontend');
      expect(result).toContain('Backend');
      expect(result).toContain('rubocop');
    });

    it('should build both instructions', () => {
      const result = buildFeedbackInstructions({ frontend: true, backend: true });
      expect(result).toContain('Frontend');
      expect(result).toContain('Backend');
    });

    it('should return empty string when none', () => {
      const result = buildFeedbackInstructions({ frontend: false, backend: false });
      expect(result).toBe('');
    });

    it('should format frontend instruction correctly', () => {
      const result = buildFeedbackInstructions({ frontend: true, backend: false });
      expect(result).toBe('   - Frontend: `cd frontend && yarn typecheck && yarn lint`');
    });

    it('should format backend instruction correctly', () => {
      const result = buildFeedbackInstructions({ frontend: false, backend: true });
      expect(result).toBe('   - Backend: `cd api && bundle exec rubocop --format simple`');
    });

    it('should format both instructions with newline', () => {
      const result = buildFeedbackInstructions({ frontend: true, backend: true });
      const lines = result.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('Frontend');
      expect(lines[1]).toContain('Backend');
    });
  });
});
