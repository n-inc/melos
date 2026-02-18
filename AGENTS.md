# Melos Agents Guide

## Manager の責務

Melos の Manager は、Worker の実行結果を受け取って次の判断を行う責務を持ちます。

1. Worker の報告を `successCriteria` と照合し、根拠不足や不整合があれば追加の `WORK_ORDER` を出す。
2. `PARTIAL` / `FAILED` / `BLOCKED` ではログ確認と原因特定を行い、解決策を調査した上で再指示する。
3. `reviewType: "product"` と `reviewType: "code"` を独立タスクとして完了管理する。
4. P1/P2 相当の問題は `PLAN.json` にフォローアップとして追加し、即時の場当たり修正を避ける。
5. すべての未完了タスク解消後のみ `HANDOFF.md` を出力する。

詳細な挙動と出力フォーマットは `prompts/manager.md` を正とする。
