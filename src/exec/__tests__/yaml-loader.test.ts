import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadYamlRoute } from '../yaml-loader.js';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'melos-yaml-'));
}

function writeYamlRoute(dir: string, content: string, filename = 'route.yaml'): string {
  const routePath = join(dir, filename);
  writeFileSync(routePath, content, 'utf-8');
  return routePath;
}

describe('YAML route loader', () => {
  it('loads a minimal YAML route', () => {
    const dir = createTempDir();
    const routePath = writeYamlRoute(dir, `
run:
  engine: auto
  model: opus

workflow:
  start: implement
  phases:
    implement:
      task: "Do the thing"
      on:
        pass: stop
`);

    const recipe = loadYamlRoute(routePath);
    expect(recipe.apiVersion).toBe(2);
    expect(recipe.run.model).toBe('opus');
    expect(recipe.workflow.start).toBe('implement');
    expect(recipe.workflow.phases.implement.task).toBe('Do the thing');
  });

  it('resolves env vars in vars section', () => {
    const dir = createTempDir();
    process.env.__MELOS_TEST_SLUG = 'test-article';
    const routePath = writeYamlRoute(dir, `
vars:
  slug: $\{{ env.__MELOS_TEST_SLUG }}
  path: .melos/research-$\{{ slug }}.json

run:
  engine: auto

workflow:
  start: research
  phases:
    research:
      task: "Research $\{{ slug }}"
      produce:
        from:
          file: $\{{ path }}
      on:
        pass: stop
`);

    const recipe = loadYamlRoute(routePath);
    expect(recipe.workflow.phases.research.task).toBe('Research test-article');
    expect((recipe.workflow.phases.research.produce as { from: { file: string } }).from.file)
      .toBe('.melos/research-test-article.json');

    delete process.env.__MELOS_TEST_SLUG;
  });

  it('resolves env vars with defaults', () => {
    const dir = createTempDir();
    delete process.env.__MELOS_NONEXISTENT;
    const routePath = writeYamlRoute(dir, `
vars:
  mode: $\{{ env.__MELOS_NONEXISTENT ?? "create" }}

run:
  engine: auto

workflow:
  start: x
  phases:
    x:
      task: "mode=$\{{ mode }}"
      on:
        pass: stop
`);

    const recipe = loadYamlRoute(routePath);
    expect(recipe.workflow.phases.x.task).toBe('mode=create');
  });

  it('preserves block scalar task content with backticks', () => {
    const dir = createTempDir();
    const routePath = writeYamlRoute(dir, `
run:
  engine: auto

workflow:
  start: fix
  phases:
    fix:
      task: |
        ## Task: Convert \`check\` fields to \`validate.shell\`

        In \`routes/learn-article.route.ts\`, fix the fields.

        \`\`\`ts
        validate: { shell: ["python3 script.py"] }
        \`\`\`
      on:
        pass: stop
`);

    const recipe = loadYamlRoute(routePath);
    expect(recipe.workflow.phases.fix.task).toContain('Convert `check` fields to `validate.shell`');
    expect(recipe.workflow.phases.fix.task).toContain('```ts');
    expect(recipe.workflow.phases.fix.task).not.toContain('\\`');
  });

  it('normalizes transition shorthands', () => {
    const dir = createTempDir();
    const routePath = writeYamlRoute(dir, `
run:
  engine: auto

workflow:
  start: a
  phases:
    a:
      task: "phase a"
      validate:
        shell:
          - "true"
      on:
        pass: b
        fail: a
    b:
      task: "phase b"
      on:
        pass: stop
`);

    const recipe = loadYamlRoute(routePath);
    const phaseA = recipe.workflow.phases.a;
    expect(phaseA.on?.pass).toEqual({ goto: 'b' });
    expect(phaseA.on?.fail).toEqual({ goto: 'a' });
  });

  it('loads !include data files', () => {
    const dir = createTempDir();
    writeFileSync(join(dir, 'entries.yaml'), `
gosashu:
  slug: gosashu
  lang: ja
`, 'utf-8');

    const routePath = writeYamlRoute(dir, `
vars:
  entries: !include entries.yaml
  lang: $\{{ entries.gosashu.lang }}

run:
  engine: auto

workflow:
  start: x
  phases:
    x:
      task: "lang=$\{{ lang }}"
      on:
        pass: stop
`);

    const recipe = loadYamlRoute(routePath);
    expect(recipe.workflow.phases.x.task).toBe('lang=ja');
  });

  it('rejects !include paths that escape the route directory', () => {
    const baseDir = createTempDir();
    const routeDir = join(baseDir, 'route');
    mkdirSync(routeDir);
    writeFileSync(join(baseDir, 'secret.yaml'), 'token: leaked\n', 'utf-8');

    const routePath = writeYamlRoute(routeDir, `
vars:
  secret: !include ../secret.yaml

run:
  engine: auto

workflow:
  start: x
  phases:
    x:
      task: "x"
      on:
        pass: stop
`);

    expect(() => loadYamlRoute(routePath)).toThrow(/escapes the route directory/i);
  });

  it('rejects circular !include references with a descriptive error', () => {
    const dir = createTempDir();
    writeFileSync(join(dir, 'a.yaml'), 'value: !include b.yaml\n', 'utf-8');
    writeFileSync(join(dir, 'b.yaml'), 'value: !include a.yaml\n', 'utf-8');

    const routePath = writeYamlRoute(dir, `
vars:
  data: !include a.yaml

run:
  engine: auto

workflow:
  start: x
  phases:
    x:
      task: "x"
      on:
        pass: stop
`);

    expect(() => loadYamlRoute(routePath)).toThrow(/circular reference detected/i);
  });

  it('supports skills and validate config', () => {
    const dir = createTempDir();
    const routePath = writeYamlRoute(dir, `
run:
  engine: auto
skills: [pseo-learn-article]

workflow:
  start: research
  phases:
    research:
      skills: [seo-serp-research]
      task: "Research"
      validate:
        shell:
          - "python3 validate.py"
      on:
        pass: stop
        fail: research
`);

    const recipe = loadYamlRoute(routePath);
    // Skills are compiled into context providers
    expect(recipe.workflow.phases.research.context.length).toBeGreaterThan(0);
  });

  it('supports limit, report, and commit config', () => {
    const dir = createTempDir();
    const routePath = writeYamlRoute(dir, `
run:
  engine: auto

workflow:
  start: x
  phases:
    x:
      task: "x"
      on:
        pass: stop

limit: 30
report:
  path: .melos/report.json
  stdout: true
commit:
  when: never
`);

    const recipe = loadYamlRoute(routePath);
    expect(recipe.limits?.maxIterations).toBe(30);
    expect(recipe.report?.path).toBe('.melos/report.json');
    expect(recipe.commit?.when).toBe('never');
  });

  it('rejects invalid commit.when values', () => {
    const dir = createTempDir();
    const routePath = writeYamlRoute(dir, `
run:
  engine: auto

workflow:
  start: x
  phases:
    x:
      task: "x"
      on:
        pass: stop

commit:
  when: typo
`);

    expect(() => loadYamlRoute(routePath)).toThrow(/commit\.when must be one of/i);
  });

  it('rejects invalid run.engine values', () => {
    const dir = createTempDir();
    const routePath = writeYamlRoute(dir, `
run:
  engine: typo

workflow:
  start: x
  phases:
    x:
      task: "x"
      on:
        pass: stop
`);

    expect(() => loadYamlRoute(routePath)).toThrow(/run\.engine must be one of/i);
  });

  it('rejects invalid limit values', () => {
    const dir = createTempDir();
    const routePath = writeYamlRoute(dir, `
run:
  engine: auto

workflow:
  start: x
  phases:
    x:
      task: "x"
      on:
        pass: stop

limit: nope
`);

    expect(() => loadYamlRoute(routePath)).toThrow(/limit must be a positive integer/i);
  });

  it('translates YAML next shorthand into on.pass before compilation', () => {
    const dir = createTempDir();
    const routePath = writeYamlRoute(dir, `
run:
  engine: auto

workflow:
  start: draft
  phases:
    draft:
      task: "draft"
      next: review
    review:
      task: "review"
      on:
        pass: stop
`);

    const recipe = loadYamlRoute(routePath);
    expect(recipe.workflow.phases.draft.next).toEqual({ goto: 'review' });
  });

  it('supports dynamic key access in vars with bracket notation', () => {
    const dir = createTempDir();
    process.env.__MELOS_TEST_KEY = 'alpha';
    writeFileSync(join(dir, 'data.yaml'), `
alpha:
  slug: alpha-slug
  lang: en
beta:
  slug: beta-slug
  lang: ja
`, 'utf-8');

    const routePath = writeYamlRoute(dir, `
vars:
  key: $\{{ env.__MELOS_TEST_KEY }}
  entries: !include data.yaml
  entry: $\{{ entries[key] }}
  slug: $\{{ entry.slug }}
  lang: $\{{ entry.lang }}

run:
  engine: auto

workflow:
  start: x
  phases:
    x:
      task: "slug=$\{{ slug }} lang=$\{{ lang }}"
      on:
        pass: stop
`);

    const recipe = loadYamlRoute(routePath);
    expect(recipe.workflow.phases.x.task).toBe('slug=alpha-slug lang=en');

    delete process.env.__MELOS_TEST_KEY;
  });

  it('supports quoted bracket access for literal object keys', () => {
    const dir = createTempDir();
    writeFileSync(join(dir, 'entries.yaml'), `
alpha:
  lang: en
beta:
  lang: ja
`, 'utf-8');

    const routePath = writeYamlRoute(dir, `
vars:
  entries: !include entries.yaml
  lang: $\{{ entries["alpha"].lang }}

run:
  engine: auto

workflow:
  start: x
  phases:
    x:
      task: "lang=$\{{ lang }}"
      on:
        pass: stop
`);

    const recipe = loadYamlRoute(routePath);
    expect(recipe.workflow.phases.x.task).toBe('lang=en');
  });

  it('supports numeric bracket access for list indexes', () => {
    const dir = createTempDir();
    const routePath = writeYamlRoute(dir, `
vars:
  list:
    - zero
    - one
  second: $\{{ list[1] }}

run:
  engine: auto

workflow:
  start: x
  phases:
    x:
      task: "value=$\{{ second }}"
      on:
        pass: stop
`);

    const recipe = loadYamlRoute(routePath);
    expect(recipe.workflow.phases.x.task).toBe('value=one');
  });

  it('rejects invalid skills entries during YAML loading', () => {
    const dir = createTempDir();
    const routePath = writeYamlRoute(dir, `
run:
  engine: auto
skills:
  - ok
  - 1

workflow:
  start: x
  phases:
    x:
      task: "x"
      on:
        pass: stop
`);

    expect(() => loadYamlRoute(routePath)).toThrow(/skills\[1\].*string or \{ path: string \}/i);
  });

  it('rejects invalid repos values during YAML loading', () => {
    const dir = createTempDir();
    const routePath = writeYamlRoute(dir, `
run:
  engine: auto
repos:
  shared: 1

workflow:
  start: x
  phases:
    x:
      task: "x"
      on:
        pass: stop
`);

    expect(() => loadYamlRoute(routePath)).toThrow(/repos\.shared must be a string/i);
  });

  it('rejects YAML with missing required fields', () => {
    const dir = createTempDir();
    const routePath = writeYamlRoute(dir, `
run:
  engine: auto
`);

    expect(() => loadYamlRoute(routePath)).toThrow(/workflow/);
  });
});
