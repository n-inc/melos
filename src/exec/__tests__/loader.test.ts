import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadRouteModule, resolveRoutePath, resolveRouteSource } from '../loader.js';

describe('exec loader', () => {
  it('resolves route path relative to cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-'));
    expect(resolveRoutePath('routes/sample.ts', cwd)).toBe(join(cwd, 'routes/sample.ts'));
  });

  it('rejects non-ts route path', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-ext-'));
    expect(() => resolveRoutePath('route.js', cwd)).toThrow(/\.ts.*\.yaml.*\.yml/);
  });

  it('writes stdin route to a temporary ts file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-stdin-'));
    const resolved = await resolveRouteSource({
      routePath: '-',
      cwd,
      stdinText: 'export default { workflow: { start: "x", phases: {} } };\n',
    });

    expect(resolved.fromStdin).toBe(true);
    expect(resolved.path.endsWith('.ts')).toBe(true);
    resolved.cleanup?.();
  });

  it('loads YAML routes from stdin through the YAML loader path', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-stdin-yaml-'));
    const resolved = await resolveRouteSource({
      routePath: '-',
      cwd,
      stdinText: `
run:
  engine: auto

workflow:
  start: research
  phases:
    research:
      task: "Research"
      on:
        pass: stop
`,
    });

    expect(resolved.path.endsWith('.yaml')).toBe(true);
    await expect(loadRouteModule(resolved.path)).resolves.toMatchObject({
      workflow: {
        start: 'research',
      },
    });
    resolved.cleanup?.();
  });

  it('loads YAML !include values from stdin relative to cwd', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-stdin-yaml-include-'));
    writeFileSync(join(cwd, 'entries.yaml'), `
gosashu:
  lang: ja
`, 'utf-8');

    const resolved = await resolveRouteSource({
      routePath: '-',
      cwd,
      stdinText: `
vars:
  entries: !include entries.yaml

run:
  engine: auto

workflow:
  start: research
  phases:
    research:
      task: "lang=\${{ entries.gosashu.lang }}"
      on:
        pass: stop
`,
    });

    expect(resolved.path.endsWith('.yaml')).toBe(true);
    await expect(loadRouteModule(resolved.path)).resolves.toMatchObject({
      workflow: {
        phases: {
          research: {
            task: 'lang=ja',
          },
        },
      },
    });
    resolved.cleanup?.();
  });

  it('fails when default export is missing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-module-'));
    const routePath = join(cwd, 'route.mjs');
    writeFileSync(routePath, 'export const value = 1;\n', 'utf-8');

    await expect(loadRouteModule(routePath)).rejects.toThrow(/default export/);
  });

  const itIfBun = spawnSync('bun', ['--version'], { encoding: 'utf-8' }).status === 0 ? it : it.skip;

  it('rejects legacy route modules that export the old runtime shape directly', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-legacy-'));
    const routePath = join(cwd, 'route.mjs');
    writeFileSync(routePath, `
      export default {
        prompt: 'hello',
        run: { engine: 'codex' },
        evaluate: () => ({ ok: true, summary: 'ok' }),
        policy: () => ({ kind: 'stop', success: true }),
      };
    `, 'utf-8');

    await expect(loadRouteModule(routePath)).rejects.toThrow(/apiVersion|createRoute/);
  });

  itIfBun('resolves __MELOS_EXEC_MODULE__ placeholder via MELOS_EXEC_MODULE_PATH env var', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-placeholder-'));
    const routePath = join(cwd, 'route.ts');
    writeFileSync(routePath, `
      import { createRoute } from "__MELOS_EXEC_MODULE__";
      export default createRoute({
        run: { engine: 'codex' },
        workflow: {
          start: 'research',
          phases: {
            research: {
              task: 'placeholder test',
              on: { pass: 'stop' },
            },
          },
        },
      });
    `, 'utf-8');

    const execModulePath = join(process.cwd(), 'src/exec/index.ts');
    const result = spawnSync('bun', ['-e', `
      process.env.MELOS_EXEC_MODULE_PATH = ${JSON.stringify(execModulePath)};
      const { loadRouteModule } = await import(${JSON.stringify(join(process.cwd(), 'src/exec/loader.ts'))});
      const route = await loadRouteModule(${JSON.stringify(routePath)});
      process.stdout.write(route.workflow.start + "\\n");
    `], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('research');
  });

  itIfBun('imports a workflow ts route module through Bun-compatible dynamic import', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-bun-'));
    const routePath = join(cwd, 'route.ts');
    writeFileSync(routePath, `
      import { createRoute } from ${JSON.stringify(join(process.cwd(), 'src/exec/index.ts'))};
      export default createRoute({
        run: { engine: 'codex' },
        workflow: {
          start: 'research',
          phases: {
            research: {
              task: 'hello',
              on: { pass: 'stop' },
            },
          },
        },
      });
    `, 'utf-8');

    const result = spawnSync('bun', ['-e', `
      const { loadRouteModule } = await import(${JSON.stringify(join(process.cwd(), 'src/exec/loader.ts'))});
      const route = await loadRouteModule(${JSON.stringify(routePath)});
      process.stdout.write(route.workflow.start + "\\n");
    `], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('research');
  });

  itIfBun('fills in route defaults for minimal workflow route modules', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-defaults-'));
    const routePath = join(cwd, 'route.ts');
    writeFileSync(routePath, `
      import { createRoute } from ${JSON.stringify(join(process.cwd(), 'src/exec/index.ts'))};
      export default createRoute({
        run: { engine: 'codex' },
        workflow: {
          start: 'research',
          phases: {
            research: {
              task: 'hello',
              on: { pass: 'stop' },
            },
          },
        },
      });
    `, 'utf-8');

    const result = spawnSync('bun', ['-e', `
      const { loadRouteModule } = await import(${JSON.stringify(join(process.cwd(), 'src/exec/loader.ts'))});
      const route = await loadRouteModule(${JSON.stringify(routePath)});
      process.stdout.write(JSON.stringify({
        report: route.report,
        context: route.workflow.phases.research.context,
      }));
    `], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      report: {
        path: '.melos/final-report.json',
        stdout: true,
      },
      context: [],
    });
  });
});
