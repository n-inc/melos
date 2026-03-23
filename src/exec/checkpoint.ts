import { execSync } from 'node:child_process';

import type { CheckpointController } from './recipe.js';

export interface GitCheckpointOptions {
  refPrefix?: string;
}

export function gitCheckpoint(options: GitCheckpointOptions = {}): CheckpointController {
  const refPrefix = options.refPrefix ?? 'refs/melos/exec';

  return {
    async create(ctx) {
      const ref = `${refPrefix}/${Date.now()}-${process.pid}-${ctx.state.iteration + 1}`;
      execSync(`git update-ref ${ref} HEAD`, {
        cwd: ctx.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return ref;
    },
    async rollback(ctx, ref) {
      execSync(`git reset --hard ${ref}`, {
        cwd: ctx.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
    async keep() {
      // v1 keeps the checkpoint ref as-is. Cleanup can be added later.
    },
  };
}
