#!/usr/bin/env node
/**
 * Marathon CLI ラッパー
 *
 * bun を使用して TypeScript を直接実行することで、
 * 事前のビルドステップ（npx tsc）を不要にする。
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const entryPoint = join(__dirname, '..', 'src', 'index.ts');

const child = spawn('bun', [entryPoint, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('Failed to start Marathon:', err.message);
  process.exit(1);
});
