import {
  canUseColor,
  colorize,
  truncateDisplay,
  wrapPlainDisplay,
  stripAnsi,
} from '../tui-ansi.js';

describe('ui/tui-ansi', () => {
  const originalNoColor = process.env.NO_COLOR;

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  });

  it('disables color when NO_COLOR is set', () => {
    process.env.NO_COLOR = '1';
    expect(canUseColor(true)).toBe(false);
    expect(colorize('[READ]', 'kind_read', false)).toBe('[READ]');
  });

  it('adds ansi color code when enabled', () => {
    delete process.env.NO_COLOR;
    const value = colorize('[DONE]', 'kind_done', true);
    expect(value).toContain('\x1b[');
    expect(stripAnsi(value)).toBe('[DONE]');
  });

  it('preserves ansi sequences while truncating display width', () => {
    const colored = '\x1b[32m[DONE]\x1b[0m command finished with very long message';
    const truncated = truncateDisplay(colored, 20);
    expect(stripAnsi(truncated).length).toBeLessThanOrEqual(20);
    expect(truncated).toContain('\x1b[');
  });

  it('wraps plain display text by width', () => {
    const wrapped = wrapPlainDisplay('abcdefghijklmnopqrstuvwxyz', 8);
    expect(wrapped).toEqual(['abcdefgh', 'ijklmnop', 'qrstuvwx', 'yz']);
  });
});
