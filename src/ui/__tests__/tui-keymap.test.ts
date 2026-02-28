import { parseKey } from '../tui-keymap.js';

describe('ui/tui-keymap', () => {
  it('parses mission control hotkeys', () => {
    expect(parseKey('\t')).toEqual({ type: 'next_view' });
    expect(parseKey('\u001b[Z')).toEqual({ type: 'prev_view' });
    expect(parseKey('f')).toEqual({ type: 'goto_view', view: 'features' });
    expect(parseKey('W')).toEqual({ type: 'goto_view', view: 'workers' });
    expect(parseKey('m')).toEqual({ type: 'goto_view', view: 'models' });
    expect(parseKey('C')).toEqual({ type: 'goto_view', view: 'costs' });
    expect(parseKey('p')).toEqual({ type: 'pause' });
    expect(parseKey('\u0003')).toEqual({ type: 'abort' });
    expect(parseKey('R')).toEqual({ type: 'resume' });
    expect(parseKey('\u0007')).toEqual({ type: 'steer_mode' });
    expect(parseKey('\u001b')).toEqual({ type: 'overview' });
  });

  it('returns none for unknown keys', () => {
    expect(parseKey('x')).toEqual({ type: 'none' });
  });
});
