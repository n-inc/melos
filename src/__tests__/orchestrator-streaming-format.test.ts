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

  it('includes diff context lines for completed file changes', () => {
    const detail = formatAgentEventDetail('codex/event/item_completed', {
      msg: {
        item: {
          type: 'fileChange',
          changes: [{
            path: '/tmp/src/auth.ts',
            diff: [
              '--- a/src/auth.ts',
              '+++ b/src/auth.ts',
              '@@ -10,5 +10,5 @@',
              ' export function auth() {',
              '-  return oldMode;',
              '+  return newMode;',
              ' }',
            ].join('\n'),
          }],
        },
      },
    });

    expect(detail).toContain('[DONE] write /tmp/src/auth.ts (+1 -1)');
    expect(detail).toContain('@@ -10,5 +10,5 @@');
    expect(detail).toContain(' export function auth() {');
    expect(detail).toContain('-  return oldMode;');
    expect(detail).toContain('+  return newMode;');
  });

  it('keeps long command lines readable without collapsing them to ellipsis', () => {
    const command = '/bin/zsh -lc "rg -n \\"frontend-lp-hydration-e2e|pnpm relay|pnpm test|pnpm build|pnpm test:e2e|PLAYWRIGHT_BASE_URL\\" .github frontend apps -g \'*.{yml,yaml,json,md}\'"';

    const detail = formatAgentEventDetail('item/started', {
      item: { type: 'commandExecution', command },
    });

    expect(detail).toContain('[BASH]');
    expect(detail).toContain('PLAYWRIGHT_BASE_URL');
    expect(detail).not.toContain('...');
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

  it('surfaces reasoning summaries as think logs', () => {
    expect(formatAgentEventDetail('item/reasoning/summaryTextDelta', {
      delta: 'Analyzing requirements',
    })).toBe('[THINK] Analyzing requirements');
  });

  it('formats manager fallback events for visibility', () => {
    expect(formatAgentEventDetail('manager/fallback', {
      reason: 'planner output parse failed',
      detail: 'unexpected token at position 12',
    })).toContain('[FALLBACK] planner output parse failed');

    expect(formatAgentEventDetail('manager/fallback', {
      reason: 'planner engine execution failed',
      outputPreview: "There's an issue with the selected model (gpt-5.4).",
    })).toContain('selected model');
  });
});
