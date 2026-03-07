import { normalizeLogMessage } from '../log-entry.js';

describe('log entry normalization', () => {
  it('unwraps phase prefixes and nested tags for display', () => {
    const command = 'planning: [BASH] /bin/zsh -lc "rg -n \\"frontend-lp-hydration-e2e|pnpm relay|pnpm test|pnpm build|pnpm test:e2e|PLAYWRIGHT_BASE_URL\\" .github frontend apps -g \'*.{yml,yaml,json,md}\'"';

    const normalized = normalizeLogMessage(command, 'INFO', {
      maxMessageWidth: 80,
      maxWrappedMessageLines: 6,
    });

    const combined = [normalized.message, ...(normalized.detailLines ?? [])].join(' ');
    expect(normalized.kind).toBe('BASH');
    expect(normalized.message).not.toContain('planning:');
    expect(combined).toContain('PLAYWRIGHT_BASE_URL');
    expect(combined).not.toContain('...');
  });

  it('wraps long commentary into detail lines without losing the text', () => {
    const normalized = normalizeLogMessage(
      'planning: 依頼は MissionPlan JSON の作成です。まず TASK.json と関連実装を読み、今回のスコープで参照が閉じるまで QA スキル、対象 LP、設定ファイル周辺を追います。',
      'INFO',
      {
        maxMessageWidth: 28,
        maxWrappedMessageLines: 6,
      }
    );

    expect(normalized.kind).toBe('INFO');
    expect(normalized.message).not.toContain('planning:');
    expect(normalized.detailLines?.length).toBeGreaterThan(0);
    expect([normalized.message, ...(normalized.detailLines ?? [])].join('')).toContain('MissionPlan JSON');
  });
});
