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
    expect(() => resolveRoutePath('route.js', cwd)).toThrow(/\.ts/);
  });

  it('writes stdin route to a temporary ts file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-stdin-'));
    const resolved = await resolveRouteSource({
      routePath: '-',
      cwd,
      stdinText: 'export default { task: "x" };\n',
    });

    expect(resolved.fromStdin).toBe(true);
    expect(resolved.path.endsWith('.ts')).toBe(true);
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
        context: [],
        run: { engine: 'codex' },
        evaluate: () => ({ ok: true, summary: 'ok' }),
        policy: () => ({ kind: 'stop', success: true }),
      };
    `, 'utf-8');

    await expect(loadRouteModule(routePath)).rejects.toThrow(/apiVersion|createRoute/);
  });

  itIfBun('imports a declarative ts route module through Bun-compatible dynamic import', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-bun-'));
    const routePath = join(cwd, 'route.ts');
    writeFileSync(routePath, `
      import { createRoute } from ${JSON.stringify(join(process.cwd(), 'src/exec/index.ts'))};
      export default createRoute({
        task: 'hello',
        run: { engine: 'codex' },
      });
    `, 'utf-8');

    const result = spawnSync('bun', ['-e', `
      const { loadRouteModule } = await import(${JSON.stringify(join(process.cwd(), 'src/exec/loader.ts'))});
      const route = await loadRouteModule(${JSON.stringify(routePath)});
      process.stdout.write(route.prompt + "\\n");
    `], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  itIfBun('rejects declarative ts route modules that still use context', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-context-removed-'));
    const routePath = join(cwd, 'route.ts');
    writeFileSync(routePath, `
      import { createRoute } from ${JSON.stringify(join(process.cwd(), 'src/exec/index.ts'))};
      export default createRoute({
        task: 'hello',
        context: [],
        run: { engine: 'codex' },
      });
    `, 'utf-8');

    const result = spawnSync('bun', ['-e', `
      const { loadRouteModule } = await import(${JSON.stringify(join(process.cwd(), 'src/exec/loader.ts'))});
      try {
        await loadRouteModule(${JSON.stringify(routePath)});
        process.exit(1);
      } catch (error) {
        process.stdout.write(String(error instanceof Error ? error.message : error));
      }
    `], {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/context .*removed/i);
  });

  itIfBun('fills in route defaults for minimal declarative route modules', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'melos-exec-loader-defaults-'));
    const routePath = join(cwd, 'route.ts');
    writeFileSync(routePath, `
      import { createRoute } from ${JSON.stringify(join(process.cwd(), 'src/exec/index.ts'))};
      export default createRoute({
        task: 'hello',
        run: { engine: 'codex' },
      });
    `, 'utf-8');

    const result = spawnSync('bun', ['-e', `
      const { loadRouteModule } = await import(${JSON.stringify(join(process.cwd(), 'src/exec/loader.ts'))});
      const route = await loadRouteModule(${JSON.stringify(routePath)});
      process.stdout.write(JSON.stringify({
        report: route.report,
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
    });
  });
});
