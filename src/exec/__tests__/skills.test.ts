import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { skillContextProvider } from '../compiler.js';
import { compileRecipeConfig } from '../compiler.js';
import type { RecipeContextBase, RecipeRunConfig } from '../recipe.js';

function stubContext(cwd: string, runConfig?: RecipeRunConfig): RecipeContextBase {
  return {
    cwd,
    melosDir: join(cwd, '.melos'),
    runConfig,
    state: {
      iteration: 0,
      phaseExecution: 0,
      startedAt: new Date().toISOString(),
      lastObservation: null,
      bestMetrics: {},
      cwd,
      attempts: 0,
      phaseCounts: {},
      outputs: {},
      history: [],
      phaseStates: {},
    },
    previousObservation: null,
  };
}

describe('skillContextProvider', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'melos-skill-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves skill name to .claude/skills/<name>/SKILL.md', async () => {
    const skillDir = join(tmpDir, '.claude/skills/my-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: my-skill\n---\n\n# My Skill\n\nDo the thing.');

    const provider = skillContextProvider('my-skill', tmpDir);
    const result = await provider(stubContext(tmpDir));

    expect(result).toEqual({
      title: 'Skill: my-skill',
      content: '# My Skill\n\nDo the thing.',
    });
  });

  it('falls back to Codex global skills for missing local skill names', async () => {
    const skillDir = join(tmpDir, '.codex/skills/simplify');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: simplify\n---\n\nCodex global skill.');

    const provider = skillContextProvider('simplify', tmpDir);
    const result = await provider(stubContext(tmpDir, { engine: 'codex' }));

    expect(result).toEqual({
      title: 'Skill: simplify',
      content: 'Codex global skill.',
    });
  });

  it('falls back to Claude global skills for missing local skill names', async () => {
    const skillDir = join(tmpDir, '.claude/skills/human-writing');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: human-writing\n---\n\nClaude global skill.');

    const provider = skillContextProvider('human-writing', join(tmpDir, 'workspace'));
    const result = await provider(stubContext(join(tmpDir, 'workspace'), { engine: 'claude' }));

    expect(result).toEqual({
      title: 'Skill: human-writing',
      content: 'Claude global skill.',
    });
  });

  it('prefers repo-local skills over Codex global fallbacks', async () => {
    const localSkillDir = join(tmpDir, '.claude/skills/simplify');
    const globalSkillDir = join(tmpDir, '.codex/skills/simplify');
    await mkdir(localSkillDir, { recursive: true });
    await mkdir(globalSkillDir, { recursive: true });
    await writeFile(join(localSkillDir, 'SKILL.md'), '---\nname: simplify\n---\n\nLocal skill.');
    await writeFile(join(globalSkillDir, 'SKILL.md'), '---\nname: simplify\n---\n\nGlobal skill.');

    const provider = skillContextProvider('simplify', tmpDir);
    const result = await provider(stubContext(tmpDir, { engine: 'codex' }));

    expect(result).toEqual({
      title: 'Skill: simplify',
      content: 'Local skill.',
    });
  });

  it('resolves { path } ref relative to cwd', async () => {
    const guidePath = join(tmpDir, 'guides/STYLE.md');
    await mkdir(join(tmpDir, 'guides'), { recursive: true });
    await writeFile(guidePath, 'Be concise.');

    const provider = skillContextProvider({ path: './guides/STYLE.md' }, tmpDir);
    const result = await provider(stubContext(tmpDir));

    expect(result).toEqual({
      title: 'Skill: STYLE',
      content: 'Be concise.',
    });
  });

  it('resolves @alias/skill-name using repos map', async () => {
    const flowDir = join(tmpDir, 'repos/flow');
    const skillDir = join(flowDir, '.claude/skills/deploy');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: deploy\n---\n\n# Deploy\n\nDeploy the app.');

    const repos = { flow: './repos/flow' };
    const provider = skillContextProvider('@flow/deploy', tmpDir, repos);
    const result = await provider(stubContext(tmpDir));

    expect(result).toEqual({
      title: 'Skill: deploy',
      content: '# Deploy\n\nDeploy the app.',
    });
  });

  it('throws on unknown repo alias', async () => {
    const provider = skillContextProvider('@unknown/skill', tmpDir, {});
    await expect(provider(stubContext(tmpDir))).rejects.toThrow(
      'Unknown repo alias "unknown"',
    );
  });

  it('throws on malformed @ref without slash', async () => {
    const provider = skillContextProvider('@noSlash', tmpDir, {});
    await expect(provider(stubContext(tmpDir))).rejects.toThrow(
      'Invalid skill ref "@noSlash": expected @alias/skill-name',
    );
  });

  it('throws on empty alias (@/skill)', async () => {
    const provider = skillContextProvider('@/skill', tmpDir, {});
    await expect(provider(stubContext(tmpDir))).rejects.toThrow(
      'empty alias',
    );
  });

  it('throws on empty skill name (@alias/)', async () => {
    const provider = skillContextProvider('@alias/', tmpDir, { alias: './some-repo' });
    await expect(provider(stubContext(tmpDir))).rejects.toThrow(
      'empty skill name',
    );
  });

  it('strips YAML frontmatter from skill content', async () => {
    const skillDir = join(tmpDir, '.claude/skills/fm-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: fm-skill\ndescription: test\ntype: editorial\n---\n\nClean content here.',
    );

    const provider = skillContextProvider('fm-skill', tmpDir);
    const result = await provider(stubContext(tmpDir));

    expect(result).toEqual({
      title: 'Skill: fm-skill',
      content: 'Clean content here.',
    });
  });
});

describe('compileRecipeConfig with skills', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'melos-skill-compile-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('adds skill context providers when route-level skills are set', () => {
    const compiled = compileRecipeConfig({
      run: { engine: 'auto' },
      skills: ['my-skill'],
      workflow: {
        start: 'draft',
        phases: {
          draft: {
            task: 'Write a draft',
            on: { pass: 'stop' },
          },
        },
      },
    });

    expect(compiled.workflow.phases.draft.context.length).toBeGreaterThan(0);
  });

  it('adds skill context providers when phase-level skills are set', () => {
    const compiled = compileRecipeConfig({
      run: { engine: 'auto' },
      workflow: {
        start: 'lint',
        phases: {
          lint: {
            task: 'Lint the text',
            skills: ['human-writing'],
            on: { pass: 'stop' },
          },
        },
      },
    });

    expect(compiled.workflow.phases.lint.context.length).toBeGreaterThan(0);
  });

  it('merges route-level and phase-level skills into one aggregated provider', () => {
    const compiled = compileRecipeConfig({
      run: { engine: 'auto' },
      skills: ['base-skill'],
      workflow: {
        start: 'draft',
        phases: {
          draft: {
            task: 'Write a draft',
            skills: ['extra-skill'],
            on: { pass: 'stop' },
          },
        },
      },
    });

    expect(compiled.workflow.phases.draft.context.length).toBe(1);
  });

  it('preserves user context providers alongside skill providers', () => {
    const userProvider = async () => ({ title: 'User Context', content: 'Custom stuff' });

    const compiled = compileRecipeConfig({
      run: { engine: 'auto' },
      skills: ['my-skill'],
      workflow: {
        start: 'draft',
        phases: {
          draft: {
            task: 'Write a draft',
            context: [userProvider],
            on: { pass: 'stop' },
          },
        },
      },
    });

    // 1 skill aggregator + 1 user provider = 2
    expect(compiled.workflow.phases.draft.context.length).toBe(2);
  });

  it('does not add skill providers when no skills are specified', () => {
    const compiled = compileRecipeConfig({
      run: { engine: 'auto' },
      workflow: {
        start: 'draft',
        phases: {
          draft: {
            task: 'Write a draft',
            on: { pass: 'stop' },
          },
        },
      },
    });

    expect(compiled.workflow.phases.draft.context).toEqual([]);
  });

  it('resolves @alias skills at runtime via repos map', async () => {
    const flowDir = join(tmpDir, 'repos/flow');
    const skillDir = join(flowDir, '.claude/skills/target-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: target-skill\n---\n\nTarget repo skill.');

    const compiled = compileRecipeConfig({
      run: { engine: 'auto' },
      repos: { flow: './repos/flow' },
      skills: ['@flow/target-skill'],
      workflow: {
        start: 'deploy',
        phases: {
          deploy: {
            task: 'Deploy it',
            on: { pass: 'stop' },
          },
        },
      },
    });

    const ctx = stubContext(tmpDir);
    const provider = compiled.workflow.phases.deploy.context[0];
    const result = await provider(ctx);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { title: 'Skill: target-skill', content: 'Target repo skill.' },
    ]);
  });

  it('skill provider reads file at runtime using ctx.cwd', async () => {
    const skillDir = join(tmpDir, '.claude/skills/runtime-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: runtime-skill\n---\n\nRuntime content.');

    const compiled = compileRecipeConfig({
      run: { engine: 'auto' },
      skills: ['runtime-skill'],
      workflow: {
        start: 'draft',
        phases: {
          draft: {
            task: 'Write a draft',
            on: { pass: 'stop' },
          },
        },
      },
    });

    const ctx = stubContext(tmpDir);
    const provider = compiled.workflow.phases.draft.context[0];
    const result = await provider(ctx);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { title: 'Skill: runtime-skill', content: 'Runtime content.' },
    ]);
  });
});
