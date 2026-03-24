import { existsSync } from 'node:fs';

export function resolveShellExecutable(): string {
  const candidates = [
    process.env.SHELL,
    '/bin/bash',
    '/usr/bin/bash',
    '/bin/sh',
    '/usr/bin/sh',
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  for (const candidate of candidates) {
    if (!candidate.includes('/') || existsSync(candidate)) {
      return candidate;
    }
  }

  return process.platform === 'win32'
    ? process.env.ComSpec ?? 'cmd.exe'
    : 'sh';
}
