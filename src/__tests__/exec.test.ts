import { parseSignal, extractQuestion, buildPrompt, createEngine, buildEngineOptions, type ExecOptions } from '../exec.js';
import { ClaudeEngine } from '../engines/claude.js';
import { AppServerEngine } from '../engines/app-server.js';

describe('parseSignal', () => {
  it('complete タグを検出', () => {
    expect(parseSignal('done\n<complete></complete>\n')).toBe('complete');
  });

  it('question タグを検出', () => {
    expect(parseSignal('<question>JWT？</question>')).toBe('question');
  });

  it('シグナルなしなら continue', () => {
    expect(parseSignal('作業を進めています...')).toBe('continue');
  });

  it('両方ある場合は question を優先', () => {
    expect(parseSignal('<complete></complete>\n<question>本当に？</question>')).toBe('question');
  });
});

describe('extractQuestion', () => {
  it('question タグ内のテキストを抽出', () => {
    const output = 'text\n<question>JWT か session か？</question>\nmore';
    expect(extractQuestion(output)).toBe('JWT か session か？');
  });

  it('タグなしなら空文字', () => {
    expect(extractQuestion('no question here')).toBe('');
  });
});

describe('buildPrompt', () => {
  it('初回イテレーションのプロンプト', () => {
    const p = buildPrompt('認証を追加', 'テスト通過', '', '', 1, false);
    expect(p).toContain('認証を追加');
    expect(p).toContain('テスト通過');
    expect(p).toContain('<complete>');
    expect(p).toContain('<question>');
    expect(p).toContain('Git Commit Convention');
    expect(p).toContain('prefix:');
  });

  it('ハンドオフ付き（2回目以降）', () => {
    const p = buildPrompt('認証を追加', 'テスト通過', 'src/auth.ts | 10 +++', '', 2, false);
    expect(p).toContain('src/auth.ts | 10 +++');
  });

  it('ステアリング', () => {
    const p = buildPrompt('認証を追加', 'テスト通過', '', 'JWT を使って', 1, false);
    expect(p).toContain('JWT を使って');
    expect(p).toContain('Steering');
  });

  it('noAsk=true で question 指示なし', () => {
    const p = buildPrompt('認証を追加', 'テスト通過', '', '', 1, true);
    expect(p).not.toContain('<question>');
  });

  it('progressLog 付き', () => {
    const p = buildPrompt('認証を追加', 'テスト通過', '', '', 2, false, '## Iteration 1\nテスト失敗: assert error');
    expect(p).toContain('Progress Log');
    expect(p).toContain('テスト失敗');
  });

  it('progressLog なしなら表示しない', () => {
    const p = buildPrompt('認証を追加', 'テスト通過', '', '', 1, false);
    expect(p).not.toContain('Progress Log');
  });
});

describe('createEngine', () => {
  it('Claude → ClaudeEngine', () => {
    expect(createEngine('opus')).toBeInstanceOf(ClaudeEngine);
  });

  it('Codex → AppServerEngine', () => {
    expect(createEngine('codex-latest')).toBeInstanceOf(AppServerEngine);
  });
});

describe('buildEngineOptions', () => {
  const base: ExecOptions = {
    model: 'codex-latest', cwd: '/tmp', effort: 'high',
    criteria: 'test', maxIterations: 50, noAsk: false, steering: '',
  };

  it('Codex → reasoningEffort + runtimeModel 解決', () => {
    const r = buildEngineOptions('codex-latest', base);
    expect(r).toMatchObject({ cwd: '/tmp', model: 'gpt-5.4', reasoningEffort: 'high' });
    expect(r).not.toHaveProperty('effort');
  });

  it('Claude → effort + runtimeModel 解決', () => {
    const r = buildEngineOptions('opus', base);
    expect(r).toMatchObject({ cwd: '/tmp', model: 'opus', effort: 'high' });
    expect(r).not.toHaveProperty('reasoningEffort');
  });
});
