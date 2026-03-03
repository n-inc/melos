import { formatAgentEventDetail } from '../orchestrator.js';

describe('orchestrator streaming event formatting', () => {
  it('filters noisy codex internal events', () => {
    expect(formatAgentEventDetail('codex/event/agent_message_content_delta', { delta: '{' })).toBeNull();
    expect(formatAgentEventDetail('item/agentMessage/delta', { delta: 'a' })).toBeNull();
    expect(formatAgentEventDetail('codex/event/token_count', { total: 10 })).toBeNull();
    expect(formatAgentEventDetail('thread/tokenUsage/updated', { input: 1 })).toBeNull();
    expect(formatAgentEventDetail('codex/event/turn/completed', {})).toBeNull();
  });

  it('formats command/file activity into readable stream logs', () => {
    expect(formatAgentEventDetail('item/started', {
      item: { type: 'commandExecution', command: 'npm test -- auth' },
    })).toContain('Execute npm test -- auth');

    expect(formatAgentEventDetail('item/started', {
      item: { type: 'fileRead', filePath: 'src/auth.ts', limit: 120 },
    })).toBe('Read src/auth.ts (120 lines)');

    expect(formatAgentEventDetail('item/completed', {
      item: { type: 'commandExecution', exitCode: 0, durationMs: 3210 },
    })).toBe('Command finished (exit 0, 3210ms)');

    expect(formatAgentEventDetail('codex/event/item_started', {
      msg: {
        item: {
          type: 'fileChange',
          changes: [{ path: '/tmp/src/auth.ts' }],
        },
      },
    })).toBe('Write /tmp/src/auth.ts');

    expect(formatAgentEventDetail('codex/event/item_completed', {
      msg: {
        item: {
          type: 'mcpToolCall',
          tool: 'codebase-retrieval',
          status: 'completed',
        },
      },
    })).toBe('Tool completed codebase-retrieval');
  });

  it('formats tool use events and ignores punctuation-only deltas', () => {
    expect(formatAgentEventDetail('claude/tool_use', {
      name: 'Read',
      input: { file_path: 'src/index.ts', limit: 50 },
    })).toBe('Read src/index.ts (50 lines)');

    expect(formatAgentEventDetail('codex/event/delta', { delta: '}' })).toBeNull();
    expect(formatAgentEventDetail('codex/event/delta', { delta: 'running tests now' })).toBe('Message running tests now');
    expect(formatAgentEventDetail('item/commandExecution/outputDelta', { delta: 'ok' })).toBeNull();
    expect(formatAgentEventDetail('item/commandExecution/outputDelta', { delta: 'tests passed successfully' })).toBeNull();
  });
});
