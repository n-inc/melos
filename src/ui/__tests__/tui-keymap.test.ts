import { consumeKeyStream, parseKey } from '../tui-keymap.js';

describe('ui/tui-keymap', () => {
  it('parses mission control hotkeys', () => {
    expect(parseKey('\t')).toEqual({ type: 'next_view' });
    expect(parseKey('\u001b[Z')).toEqual({ type: 'prev_view' });
    expect(parseKey('\u001b[1;2Z')).toEqual({ type: 'prev_view' });
    expect(parseKey('f')).toEqual({ type: 'goto_view', view: 'features' });
    expect(parseKey('W')).toEqual({ type: 'goto_view', view: 'workers' });
    expect(parseKey('m')).toEqual({ type: 'goto_view', view: 'models' });
    expect(parseKey('D')).toEqual({ type: 'goto_view', view: 'prd' });
    expect(parseKey('T')).toEqual({ type: 'goto_view', view: 'task' });
    expect(parseKey('L')).toEqual({ type: 'toggle_log_source' });
    expect(parseKey('o')).toEqual({ type: 'toggle_secondary' });
    expect(parseKey('p')).toEqual({ type: 'pause' });
    expect(parseKey('\u0003')).toEqual({ type: 'abort' });
    expect(parseKey('R')).toEqual({ type: 'resume' });
    expect(parseKey('\u0007')).toEqual({ type: 'steer_mode' });
    expect(parseKey('\u001b')).toEqual({ type: 'overview' });
    expect(parseKey('\u001bOA')).toEqual({ type: 'cursor_up' });
    expect(parseKey('\u001bOB')).toEqual({ type: 'cursor_down' });
    expect(parseKey('k')).toEqual({ type: 'cursor_up' });
    expect(parseKey('j')).toEqual({ type: 'cursor_down' });
    expect(parseKey('\u001b[5~')).toEqual({ type: 'page_up' });
    expect(parseKey('\u001b[6~')).toEqual({ type: 'page_down' });
    expect(parseKey('\u001b[H')).toEqual({ type: 'scroll_top' });
    expect(parseKey('\u001b[F')).toEqual({ type: 'scroll_bottom' });
  });

  it('returns none for unknown keys', () => {
    expect(parseKey('x')).toEqual({ type: 'none' });
  });

  it('consumes combined key chunks into individual keys', () => {
    const parsed = consumeKeyStream('\u001b[B\u001b[Bjj');
    expect(parsed.keys).toEqual(['\u001b[B', '\u001b[B', 'j', 'j']);
    expect(parsed.remainder).toBe('');
  });

  it('keeps incomplete escape sequence as remainder', () => {
    const parsed = consumeKeyStream('\u001b[');
    expect(parsed.keys).toEqual([]);
    expect(parsed.remainder).toBe('\u001b[');
  });
});
