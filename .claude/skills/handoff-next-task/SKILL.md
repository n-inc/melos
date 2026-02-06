---
name: handoff-next-task
description: HANDOFF.md の有無に応じて次タスクを継続実行するスキル。HITL継続・引き継ぎ対応・「次のタスクを進めて」系の依頼で使用。HANDOFF.md があれば内容を読んでユーザーと合意しながら進め、なければ即座に次タスクを実行する。
---

<objective>
次のタスクを止めずに進める。HANDOFF.md がある場合は引き継ぎ内容を読み、ユーザーと同期しながら実行する。
</objective>

<workflow>
<step number="1" name="detect_handoff">
リポジトリルートを基準に `HANDOFF.md` の有無を確認する。

```bash
ROOT="$(git rev-parse --show-toplevel)"
if [ -f "$ROOT/HANDOFF.md" ]; then
  echo "handoff_exists"
else
  echo "handoff_absent"
fi
```
</step>

<step number="2" name="handoff_exists">
`HANDOFF.md` がある場合は内容を読み、次タスクに必要な情報を抽出する。

抽出対象:
- 未完了事項
- ブロッカー
- 次に実行すべき具体アクション

そのうえで、ユーザーに短く共有してから次タスクを実行する。
共有時は「何を理解し、次に何をするか」を1回で明示する。
</step>

<step number="3" name="handoff_absent">
`HANDOFF.md` がない場合は追加確認を挟まず、次タスクをそのまま実行する。

優先順:
1. `PLAN.json` の未完了タスク
2. ユーザーが直近で明示したタスク
3. すぐ着手できる最小実装単位
</step>

<step number="4" name="execute">
タスク実行時は以下を徹底する。

- 実装前に対象ファイルと方針を短く共有する
- 実装後にテスト/検証を実行する
- 結果を「変更内容」「検証結果」「残課題」で報告する
</step>
</workflow>

<success_criteria>
- HANDOFF.md がある場合: 内容を反映して次タスクが進む
- HANDOFF.md がない場合: 停止せず次タスクを進める
- どちらの場合も、最終的に具体的な変更または検証結果を返す
</success_criteria>

<constraints>
- HANDOFF.md の有無確認だけで停止しない
- 不明点が致命的でない限り、仮説を置いて前進する
- 進捗共有は簡潔に行い、説明だけで終わらない
</constraints>
