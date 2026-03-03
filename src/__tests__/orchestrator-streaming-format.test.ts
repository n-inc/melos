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
    })).toContain('[BASH] npm test -- auth');

    expect(formatAgentEventDetail('item/started', {
      item: { type: 'fileRead', filePath: 'src/auth.ts', limit: 120 },
    })).toBe('[READ] src/auth.ts (120 lines)');

    expect(formatAgentEventDetail('item/completed', {
      item: { type: 'commandExecution', exitCode: 0, durationMs: 3210 },
    })).toBe('[DONE] exit=0 3210ms');

    expect(formatAgentEventDetail('codex/event/item_started', {
      msg: {
        item: {
          type: 'fileChange',
          changes: [{ path: '/tmp/src/auth.ts' }],
        },
      },
    })).toBe('[WRITE] /tmp/src/auth.ts (+0 -0)');

    expect(formatAgentEventDetail('codex/event/item_completed', {
      msg: {
        item: {
          type: 'mcpToolCall',
          tool: 'codebase-retrieval',
          status: 'completed',
        },
      },
    })).toBe('[DONE] tool completed codebase-retrieval');
  });

  it('formats tool use events and ignores punctuation-only deltas', () => {
    expect(formatAgentEventDetail('claude/tool_use', {
      name: 'Read',
      input: { file_path: 'src/index.ts', limit: 50 },
    })).toBe('[READ] src/index.ts (50 lines)');

    expect(formatAgentEventDetail('codex/event/delta', { delta: '}' })).toBeNull();
    expect(formatAgentEventDetail('codex/event/delta', { delta: 'running tests now' })).toBe('[INFO] running tests now');
    expect(formatAgentEventDetail('item/commandExecution/outputDelta', { delta: 'ok' })).toBeNull();
    expect(formatAgentEventDetail('item/commandExecution/outputDelta', { delta: 'tests passed successfully' })).toBeNull();
  });

  it('formats manager fallback events for visibility', () => {
    expect(formatAgentEventDetail('manager/fallback', {
      reason: 'planner output parse failed',
      detail: 'unexpected token at position 12',
    })).toContain('[FALLBACK] planner output parse failed');
  });
});
