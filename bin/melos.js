#!/usr/bin/env node
/**
 * Melos CLI ラッパー
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

let signalHandled = false;
const signalToExitCode = (signal) => {
  if (signal === 'SIGTERM') return 143;
  return 130; // SIGINT
};

const forwardSignal = (signal) => {
  if (signalHandled) {
    process.exit(signalToExitCode(signal));
    return;
  }

  signalHandled = true;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }

  setTimeout(() => {
    process.exit(signalToExitCode(signal));
  }, 5000).unref();
};

process.on('SIGINT', () => {
  forwardSignal('SIGINT');
});

process.on('SIGTERM', () => {
  forwardSignal('SIGTERM');
});

child.on('close', (code, signal) => {
  if (signal === 'SIGINT' || signal === 'SIGTERM') {
    process.exit(signalToExitCode(signal));
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('Failed to start Melos:', err.message);
  process.exit(1);
});
