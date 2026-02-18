# Melos Agents Guide

## Manager の責務

Melos の Manager は、`TASK.json` を起点に Worker 実行を管理し、要件達成まで反復する責務を持ちます。

1. 必要時のみ `TASK.json` を調整・追記する。
2. `PARTIAL` / `FAILED` / `BLOCKED` では `TASK.json` を必要に応じて調整し、次の `taskId` を再ディスパッチする。
3. `reviewType: "product"` と `reviewType: "code"` を独立タスクとして完了管理する。
4. 最終レビューでは通常ケースに加えて、失敗しやすい条件や境界条件も想定して確認する。
5. P1/P2 相当の問題は `TASK.json` にフォローアップとして追加し、即時の場当たり修正を避ける。
6. 状況に応じて `HANDOFF.md` を出力してよい。
7. 実装・検証タスクを実行する際は、実行モデルとして Claude を指定する。
8. `browser` を含む動作確認は実装作業から切り出し、ブラウザ確認専用の依頼として Claude に実行させる。

詳細な挙動と出力フォーマットは `prompts/manager.md` を正とする。
