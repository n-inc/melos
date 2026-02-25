---
name: melos-run-review
description: Melosを使用してコードレビュー→修正のサイクルを自動実行。PRレビュー指摘への対応時に使用。
allowed-tools: Bash
---

<objective>
Melos CLIの `--review-only` モードを実行し、コードレビュー→修正のサイクルを自動化する。
複数のレビューエージェントによる指摘検出と修正を繰り返し、コード品質を向上させる。
コンテキスト効率化のため階層化監視を行い、問題検出時のみ詳細情報を取得する。
</objective>

<quick_start>
```bash
# 基本実行（5イテレーション）
npx melos --plain --review-only

# イテレーション数を指定
npx melos --plain --review-only --max-iterations 10
```
</quick_start>

<workflow>
<step number="1" name="execute">
Bashツールを使用してMelosをバックグラウンドで実行する。

```bash
cd "$(git rev-parse --show-toplevel)" && npx melos --plain --review-only --max-iterations 5
```

**重要**: `run_in_background: true` で実行し、task_id を記録する。
</step>

<step number="2" name="monitor">
イベントドリブンで効率的に監視する。**変化があった場合のみ報告する。**

### 状態の追跡
以下の値を追跡し、前回と比較する:
- `lastIteration`: 前回確認時のイテレーション番号
- `lastTaskId`: 前回確認時の currentTask.id
- `lastStatus`: 前回確認時の status
- `sameTaskCount`: 同一タスクが連続した回数
- `lastReviewFindings`: 前回の reviewFindings

### 監視ループ

#### 1. 完了を待つ（イベントドリブン）
TaskOutput（block=true, timeout=60000）で完了または更新を待つ。

#### 2. L1 チェック（毎回実行、~500トークン）
STATUS.json を読み込み、前回と比較:

```bash
cat "$(git rev-parse --show-toplevel)/STATUS.json"
```

#### 3. 変化検出と報告

**報告するケース（これらの場合のみコメント出力）:**
- `iteration` が増加 → 「Iteration N 完了。Iteration N+1 を開始」
- `currentTask.id` が変化 → 「Task X 完了。Task Y を開始」
- `status` が変化 → ステータス変更を報告
- `reviewFindings` が変化 → 指摘数の変化を報告
- 異常検出（後述）→ L2/L3 チェックへ進み報告

**報告しないケース:**
- 上記いずれにも該当しない → **コメントなしで**次のループへ

#### 4. 異常検出判定（変化なしの場合）
変化がない状態が続く場合のみ L2 チェックに進む:
- `status == "paused"` または `status == "error"`
- `currentTask` が 3 回連続で同じ（進捗停滞、`sameTaskCount >= 3`）
- 同じ指摘が 3 回連続で検出されている

#### 5. L2 チェック（問題検出時のみ、~800トークン）
最新イテレーションの詳細を確認:

```bash
tail -50 "$(git rev-parse --show-toplevel)/PROGRESS.md" | grep -A 30 "^### Iteration"
```

#### 6. L3 チェック（介入判断時のみ、~2000トークン）
以下の場合に全コンテキストを取得:
- 3 回連続で同一指摘
- P1/P2 が 3 件以上未対応

```bash
cat "$(git rev-parse --show-toplevel)/PROGRESS.md"
# Open Questions / Risks セクションのみ
sed -n '/^## Open Questions/,/^## /p' "$(git rev-parse --show-toplevel)/PROGRESS.md" | head -20
```
</step>

<step number="3" name="intervene">
介入が必要な場合、ユーザーに選択肢を提示する。

### レビュー固有の介入トリガー

| トリガー | 条件 | アクション |
|----------|------|------------|
| 同一指摘反復 | 同じ指摘が 3 回連続検出 | 指摘分割提案 |
| 指摘過多 | P1/P2 が 3 件以上未対応 | 優先度再編成提案 |
| 進捗停滞 | 同一タスクが 3 回連続 | 介入提案 |
| 品質基準未達 | レビューパス条件未満 | 追加修正提案 |

### 介入アクション
ユーザーに AskUserQuestion で選択肢を提示:

1. **指摘を分割して対応**: 優先度の高い指摘から順に対応
2. **手動で修正してから続行**: Melos を一時停止し、手動修正後に再開
3. **現状のまま続行**: 警告を無視して継続
4. **中止**: Melos を停止
</step>

<step number="4" name="complete">
完了後、結果をユーザーに報告する。

- 実行されたイテレーション数
- 修正されたレビュー指摘（P1/P2/P3別）
- 最終的なステータス
- 介入が発生した場合はその内容
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
- Melosが正常に完了
- レビュー指摘が解消される
- PROGRESS.mdに実行結果が記録される
</success_criteria>

<constraints>
- TASK.jsonが存在する必要がある
- 長時間実行となる可能性がある
</constraints>

<context_efficiency>
### トークン消費の目安

| チェックレベル | 実行条件 | トークン消費 |
|---------------|----------|--------------|
| L1（軽量） | 毎回 | ~500 |
| L2（詳細） | 問題検出時 | ~800 |
| L3（深堀り） | 介入判断時 | ~2000 |

### 従来との比較
- **従来**: 毎回 PROGRESS.md 全文読み込み → 監視1回あたり ~2000+ トークン
- **改善後**: L1 中心の監視 → 監視1回あたり ~500 トークン（75%削減）
</context_efficiency>
