# Melos Agents Guide

Melos は route runner です。

## Core Rules

1. 実行面の source of truth は `melos run --route` / `--prompt`。
2. 停止条件は prompt ではなく route field (`validate.shell`, `validate.llm`, `validate.metrics`, `limit`) に置く。
3. 実行結果の source of truth は `.melos/events.jsonl` と `.melos/final-report.json`。
4. final report は main task の最後の一言ではなく、終了後の report phase が生成する。

## Public Repository Hygiene

- この repo には project-local agent skills や個人用 agent 設定を置かない。
- Route examples and docs must work from the published package surface.
- Runtime artifacts (`.melos/`, handoff files, work reports) must stay out of git.
