export type KeyAction =
  | { type: 'next_view' }
  | { type: 'prev_view' }
  | { type: 'goto_view'; view: 'overview' | 'features' | 'workers' | 'models' | 'prd' | 'task' }
  | { type: 'abort' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'steer_mode' }
  | { type: 'overview' }
  | { type: 'cursor_up' }
  | { type: 'cursor_down' }
  | { type: 'page_up' }
  | { type: 'page_down' }
  | { type: 'scroll_top' }
  | { type: 'scroll_bottom' }
  | { type: 'select' }
  | { type: 'toggle_log_source' }
  | { type: 'toggle_secondary' }
  | { type: 'none' };

export function parseKey(chunk: string): KeyAction {
  switch (chunk) {
    case '\t':
      return { type: 'next_view' };
    case '\u001b[Z':
    case '\u001b[1;2Z':
      return { type: 'prev_view' };
    case 'f':
    case 'F':
      return { type: 'goto_view', view: 'features' };
    case 'w':
    case 'W':
      return { type: 'goto_view', view: 'workers' };
    case 'm':
    case 'M':
      return { type: 'goto_view', view: 'models' };
    case 'd':
    case 'D':
      return { type: 'goto_view', view: 'prd' };
    case 't':
    case 'T':
      return { type: 'goto_view', view: 'task' };
    case 'l':
    case 'L':
      return { type: 'toggle_log_source' };
    case 'o':
    case 'O':
      return { type: 'toggle_secondary' };
    case 'p':
    case 'P':
      return { type: 'pause' };
    case '\u0003':
      return { type: 'abort' };
    case 'r':
    case 'R':
      return { type: 'resume' };
    case '\u0007':
      return { type: 'steer_mode' };
    case '\u001b':
      return { type: 'overview' };
    case '\u001b[A':
    case '\u001bOA':
    case 'k':
    case 'K':
      return { type: 'cursor_up' };
    case '\u001b[B':
    case '\u001bOB':
    case 'j':
    case 'J':
      return { type: 'cursor_down' };
    case '\u001b[5~':
      return { type: 'page_up' };
    case '\u001b[6~':
      return { type: 'page_down' };
    case '\u001b[H':
    case '\u001b[1~':
    case '\u001bOH':
      return { type: 'scroll_top' };
    case '\u001b[F':
    case '\u001b[4~':
    case '\u001bOF':
      return { type: 'scroll_bottom' };
    case '\r':
    case '\n':
      return { type: 'select' };
    default:
      return { type: 'none' };
  }
}
