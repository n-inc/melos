# Melos Agents Guide

Melos は route runner です。

## Core Rules

1. 実行面の source of truth は `melos run --route` / `--prompt`。
2. 停止条件は prompt ではなく route field (`check`, `pass`, `measure`, `until`, `plateau`, `limit`) に置く。
3. 実行結果の source of truth は `.melos/events.jsonl` と `.melos/final-report.json`。
4. final report は main task の最後の一言ではなく、終了後の report phase が生成する。

## Git Workflow Skills

Git 運用の詳細は `.claude/skills/` 配下の skill を正とする。

- コミット: `/git-commit`
- 同期: `/git-sync`
- PR 作成: `/git-new-pull-request`
- 一括 ship: `/git-ship`
- review/CI 修正: `/git-fix-review-ci-on-pull-request`
- handoff 作成: `/handoff`
