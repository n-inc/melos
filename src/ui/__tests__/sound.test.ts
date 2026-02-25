import { describe, test, expect } from '@jest/globals';

import {
  resolveSoundPlaybackPlan,
  shouldPlaySystemSound,
} from '../sound.js';

describe('sound.ts', () => {
  describe('shouldPlaySystemSound', () => {
    test('returns false when MELOS_NO_SOUND=1', () => {
      expect(shouldPlaySystemSound({ MELOS_NO_SOUND: '1' })).toBe(false);
    });

    test('returns true when MELOS_SOUND=1 even in CI', () => {
      expect(shouldPlaySystemSound({ CI: '1', MELOS_SOUND: '1' })).toBe(true);
    });

    test('returns false in CI by default', () => {
      expect(shouldPlaySystemSound({ CI: '1' })).toBe(false);
    });

    test('returns true when no controls are specified', () => {
      expect(shouldPlaySystemSound({})).toBe(true);
    });
  });

  describe('resolveSoundPlaybackPlan', () => {
    test('uses afplay on macOS when system sound exists', () => {
      const plan = resolveSoundPlaybackPlan(
        'escalation_required',
        'darwin',
        () => true
      );

      expect(plan.mode).toBe('command');
      if (plan.mode === 'command') {
        expect(plan.command).toBe('afplay');
        expect(plan.args[0]).toContain('/System/Library/Sounds/Purr.aiff');
      }
    });

    test('falls back to bell on macOS when sound file is missing', () => {
      const plan = resolveSoundPlaybackPlan(
        'iteration_completed',
        'darwin',
        () => false
      );

      expect(plan).toEqual({
        mode: 'bell',
        bellCount: 1,
      });
    });

    test('uses bell fallback on non-mac platforms with event-specific count', () => {
      const escalation = resolveSoundPlaybackPlan('escalation_required', 'linux');
      const completion = resolveSoundPlaybackPlan('run_completed', 'linux');

      expect(escalation).toEqual({ mode: 'bell', bellCount: 2 });
      expect(completion).toEqual({ mode: 'bell', bellCount: 3 });
    });
  });
});
