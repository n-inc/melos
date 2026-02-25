import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type MelosSoundEvent =
  | 'escalation_required'
  | 'iteration_completed'
  | 'run_completed';

type PlaybackPlan =
  | {
    mode: 'command';
    command: string;
    args: string[];
    fallbackBellCount: number;
  }
  | {
    mode: 'bell';
    bellCount: number;
  };

const MAC_SOUND_NAMES: Record<MelosSoundEvent, string> = {
  escalation_required: 'Purr',
  iteration_completed: 'Pop',
  run_completed: 'Bottle',
};

export function shouldPlaySystemSound(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.MELOS_NO_SOUND === '1') {
    return false;
  }
  if (env.MELOS_SOUND === '1') {
    return true;
  }
  return env.CI !== '1';
}

export function resolveSoundPlaybackPlan(
  event: MelosSoundEvent,
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync
): PlaybackPlan {
  const bellCount = getBellCount(event);
  if (platform === 'darwin') {
    const soundFile = join('/System/Library/Sounds', `${MAC_SOUND_NAMES[event]}.aiff`);
    if (fileExists(soundFile)) {
      return {
        mode: 'command',
        command: 'afplay',
        args: [soundFile],
        fallbackBellCount: bellCount,
      };
    }
  }
  return {
    mode: 'bell',
    bellCount,
  };
}

export function playSystemSound(event: MelosSoundEvent): void {
  if (!shouldPlaySystemSound()) {
    return;
  }

  const plan = resolveSoundPlaybackPlan(event);
  if (plan.mode === 'bell') {
    playTerminalBell(plan.bellCount);
    return;
  }

  try {
    const child = spawn(plan.command, plan.args, {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {
      playTerminalBell(plan.fallbackBellCount);
    });
    child.unref();
  } catch {
    playTerminalBell(plan.fallbackBellCount);
  }
}

function getBellCount(event: MelosSoundEvent): number {
  switch (event) {
    case 'iteration_completed':
      return 1;
    case 'escalation_required':
      return 2;
    case 'run_completed':
      return 3;
  }
}

function playTerminalBell(count: number): void {
  if (count <= 0) {
    return;
  }
  process.stderr.write('\u0007'.repeat(count));
}
