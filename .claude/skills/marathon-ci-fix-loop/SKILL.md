---
name: marathon-ci-fix-loop
description: Marathonを使用してCI失敗とPRコメントの修正を自動実行。CI修正、レビュー対応時に使用。
allowed-tools: Bash
---

<objective>
Marathon CLIの `--ci-fix-only` モードを実行し、CI失敗とPRレビューコメントへの対応を自動化する。
GitHub CLIを使用してCI状態とコメントを取得し、修正を繰り返す。
</objective>

<quick_start>
```bash
# 基本実行（5イテレーション）
npx marathon --ci-fix-only

# イテレーション数を指定
npx marathon --ci-fix-only --max-iterations 10
```
</quick_start>

<workflow>
<step number="1" name="execute">
Bashツールを使用してMarathonを実行する。

```bash
cd "$(git rev-parse --show-toplevel)" && npx marathon --ci-fix-only --max-iterations 5
```

長時間実行となるため、`run_in_background: true` で実行し、定期的に結果を確認する。
</step>

<step number="2" name="monitor">
実行中は進捗を監視する。

```bash
# 進捗ファイルを確認
cat "$(git rev-parse --show-toplevel)/PROGRESS.md"

# ステータスを確認
cat "$(git rev-parse --show-toplevel)/STATUS.json"

# CI状態を確認
gh pr checks
```
</step>

<step number="3" name="complete">
完了後、結果をユーザーに報告する。

- 実行されたイテレーション数
- 修正されたCI失敗・PRコメント
- 最終的なCI状態
</step>
</workflow>

<options>
| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--max-iterations <n>` | 最大イテレーション数 | 5 |
| `--hitl` | 対話モード（1イテレーションずつ） | false |
| `--engine <engine>` | エンジン選択（claude/codex） | claude |
</options>

<success_criteria>
- CIが全てグリーンになる
- PRコメントへの対応が完了
- PROGRESS.mdに実行結果が記録される
</success_criteria>

<constraints>
- PRが存在する必要がある
- GitHub CLIがインストール・認証済みであること
- 長時間実行となる可能性がある
</constraints>
