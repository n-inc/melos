export type KeyAction =
  | { type: 'next_view' }
  | { type: 'goto_view'; view: 'overview' | 'features' | 'workers' | 'models' | 'costs' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'steer_mode' }
  | { type: 'overview' }
  | { type: 'cursor_up' }
  | { type: 'cursor_down' }
  | { type: 'select' }
  | { type: 'none' };

export function parseKey(chunk: string): KeyAction {
  switch (chunk) {
    case '\t':
      return { type: 'next_view' };
    case 'f':
    case 'F':
      return { type: 'goto_view', view: 'features' };
    case 'w':
    case 'W':
      return { type: 'goto_view', view: 'workers' };
    case 'm':
    case 'M':
      return { type: 'goto_view', view: 'models' };
    case 'c':
    case 'C':
      return { type: 'goto_view', view: 'costs' };
    case 'p':
    case 'P':
      return { type: 'pause' };
    case 'r':
    case 'R':
      return { type: 'resume' };
    case '\u0007':
      return { type: 'steer_mode' };
    case '\u001b':
      return { type: 'overview' };
    case '\u001b[A':
      return { type: 'cursor_up' };
    case '\u001b[B':
      return { type: 'cursor_down' };
    case '\r':
    case '\n':
      return { type: 'select' };
    default:
      return { type: 'none' };
  }
}
