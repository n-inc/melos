---
name: melos-review-loop
description: Melosを使用してコードレビュー→修正のサイクルを自動実行。PRレビュー指摘への対応時に使用。
allowed-tools: Bash
---

<objective>
Melos CLIの `--review-only` モードを実行し、コードレビュー→修正のサイクルを自動化する。
複数のレビューエージェントによる指摘検出と修正を繰り返し、コード品質を向上させる。
</objective>

<quick_start>
```bash
# 基本実行（5イテレーション）
npx melos --review-only

# イテレーション数を指定
npx melos --review-only --max-iterations 10
```
</quick_start>

<workflow>
<step number="1" name="execute">
Bashツールを使用してMelosを実行する。

```bash
cd "$(git rev-parse --show-toplevel)" && npx melos --review-only --max-iterations 5
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
```
</step>

<step number="3" name="complete">
完了後、結果をユーザーに報告する。

- 実行されたイテレーション数
- 修正されたレビュー指摘
- 最終的なステータス
</step>
</workflow>

<options>
| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--max-iterations <n>` | 最大イテレーション数 | 5 |
| `--engine <engine>` | エンジン選択（claude/codex） | claude |
</options>

<success_criteria>
- Melosが正常に完了
- レビュー指摘が解消される
- PROGRESS.mdに実行結果が記録される
</success_criteria>

<constraints>
- PLAN.jsonが存在する必要がある
- 長時間実行となる可能性がある
</constraints>
