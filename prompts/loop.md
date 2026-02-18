## Melos 統一ループ - イテレーション {ITERATION} / {MAX_ITERATIONS}

**PRD**: @PRD.md
**Task file**: @{TASK_FILE}
**Progress file**: @{PROGRESS_FILE}

---

## Task File Format

タスクファイルはJSON形式で `passes` フィールドと `checks` フィールドを持つ:

```json
[
  {
    "id": "1",
    "description": "Task description",
    "checks": [
      { "text": "APIが200を返す", "type": "auto:jest", "passed": false },
      { "text": "UIが正しく表示される", "type": "browser", "passed": false, "screenshot": "" }
    ],
    "passes": false
  }
]
```

### Check Types

| type | 説明 | 証拠 |
|------|------|------|
| `auto:jest` | Jest で自動検証 | 不要 |
| `auto:rspec` | RSpec で自動検証 | 不要 |
| `auto:lint` | lint で自動検証 | 不要 |
| `auto:typecheck` | 型チェックで自動検証 | 不要 |
| `browser` | ブラウザで確認 | **必須**（screenshot または video） |
| `manual` | 手動確認 | 不要 |

### Browser Check の証拠

`type: "browser"` のチェック項目は、完了時に証拠（R2 URL）が必須:

```json
{
  "text": "ログインフォームが表示される",
  "type": "browser",
  "passed": true,
  "screenshot": "https://r2.example.com/evidence/login-form.png"
}
```

- `screenshot`: スクリーンショットのR2 URL
- `video`: 動画のR2 URL
- どちらか一方が必須（空文字は無効）
- キーがない場合は `screenshot: ""` を追加してデフォルトとする

### 検証フロー

- 各検証項目を順番に検証し、完了したら `passed: true` に更新
- `browser` タイプは証拠URLを設定してから `passed: true` に
- 全チェック完了後に `passes: true` に更新

---

## Instructions

**FIRST**: {PROGRESS_FILE} を読んで、すでに完了した内容を確認。

**THEN**: PRD.md を読んで、理想像を把握。

**THEN**: 以下の判定フローに従ってアクションを実行:

---

## 判定フロー

```
1. 未完了タスクあり？
   → YES: タスク実行へ
   → NO: 2へ

2. レビュー実行
   → P1/P2あり: タスク追加して続行
   → P1/P2なし: 3へ

3. PRあり？
   → YES: PR対応へ
   → NO: 完了
```

---

## エスカレーション

**同じ箇所で3回失敗した場合**、人間の介入が必要と判断し、エスカレーションする。

**判断基準**:
- 同一タスク/同一ファイル/同一問題で3回連続して解決できなかった
- 試行錯誤を繰り返しても根本的な解決に至らない
- 外部情報や人間の判断が必要な状況

**エスカレーション時の手順**:
1. {PROGRESS_FILE} にエスカレーション詳細を記録（試行内容、失敗理由、調査が必要な点）
2. `<promise>ESCALATE</promise>` を出力

---

### Step 1: 未完了タスクがある場合 → Implement ONE task

1. **タスク {CURRENT_TASK_ID}** を実行する

2. **Implement it**
   - 変更は小さく、焦点を絞る
   - 既存パターンに従う

3. **Verify checks** (if `checks` exists):
   - 各チェック項目を順番に検証
   - `browser` タイプは証拠（screenshot/video URL）を必ず設定
   - 検証完了した項目は `passed: true` に更新
   - 全チェック完了後に `passes: true` に設定

4. **Update task file**: `passes: true` に設定

5. **Record in {PROGRESS_FILE}**: 何をしたか、重要な判断

6. **Commit**: `git-commit` スキルを使用

7. **Output `<promise>TASK_DONE</promise>`**

---

### Step 2: 全タスク完了 → Run Review

1. **差分を取得**:
   ```bash
   git diff origin/main
   ```

2. **以下の観点に従って直接レビュー**:

   **7つの観点でレビュー**:
   - 履歴分析: 変更の意図と一貫性
   - パターン認識: コードベースの慣例との整合性
   - アーキテクチャ: 設計の適切さ
   - セキュリティ: 脆弱性の有無
   - パフォーマンス: 効率性の問題
   - データ整合性: データの正確性と一貫性
   - シンプル性: 不要な複雑さがないか

   **重大度の分類**:
   - **P1（必須修正）**: バグ、セキュリティ、データ損失、重大なロジックエラー
   - **P2（推奨修正）**: パフォーマンス、可読性、保守性の問題

3. **結果をスコープで分類**（`git diff main --name-only` を実行）:
   - IN_SCOPE = ファイルが差分に含まれる → 対象
   - OUT_OF_SCOPE = ファイルが差分に含まれない → 除外

4. **Add tasks if needed**:
   - IN-SCOPE の P1 または P2 がある場合:
     → 各 P1/P2 を個別タスクとして追加
     → `<promise>TASK_DONE</promise>` を出力
   - P3+ のみ（または指摘なし）の場合:
     → Step 3 へ進む

5. **Task format** (追加する場合):
   ```json
   {"id": "review-1", "description": "[P1] finding description", "passes": false}
   ```

6. **Record in {PROGRESS_FILE}**: すべての指摘事項と重大度、スコープ

---

### Step 3: PR対応チェック

1. **PRが存在するか確認**:
   ```bash
   gh pr view --json number,url
   ```

2. **PRがない場合**: `<promise>COMPLETE</promise>` を出力

3. **PRがある場合**:

   a. **CI状態を確認**:
   ```bash
   gh pr checks
   ```

   b. **レビューコメントを確認**:
   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr}/comments --jq '.[] | select(.in_reply_to_id == null) | {id, body, user: .user.login, path, line}'
   ```

4. **問題がある場合**:
   - CIエラー: 修正してコミット
   - レビューコメント: 修正または返信
   - タスクを追加して `<promise>TASK_DONE</promise>` を出力

5. **問題がない場合**: `<promise>COMPLETE</promise>` を出力

---

## PROGRESS.md のセクション

{PROGRESS_FILE} には以下のセクションを記録する。

### Current Objective

現在のイテレーションで達成しようとしている目標を記載。
目標が変わった場合は更新する。

```markdown
## Current Objective

- Melos v0.2.2 の安定化と機能拡張
```

### Codebase Patterns

実装中に発見した知見を記録。後続のイテレーションや将来の開発者が恩恵を受ける情報。

**記録すべき3種類の情報:**

1. **パターン** - このコードベースでの慣例
   - 例：「フロントエンドのAPIクライアントはsrc/lib/api/に配置する」
   - 例：「GraphQLミューテーションはuseXxxMutationのフック形式で定義」

2. **落とし穴** - 遭遇した問題と回避策
   - 例：「Userモデルを変更する際はUserPolicyのテストも更新が必要」
   - 例：「i18nキーを追加したらfrontend/とapi/両方の翻訳ファイルを更新」

3. **コンテキスト** - コードベースのナビゲーションに役立つ情報
   - 例：「設定パネルはsrc/features/settings/SettingsPanel.tsx」
   - 例：「認証ロジックはapi/app/services/auth/に集約」

### Learnings

実装中に学んだこと、失敗から得た教訓、将来のガードレール候補を記録。

```markdown
## Learnings

- Codex の filterCodexOutput で ANSI コードを strip しないと Promise 検出に失敗
- Display width ベースで truncate しないと日本語でレイアウト崩れ
```

### Open Questions / Risks

未解決の疑問、リスク、今後の調査が必要な事項を記録。

```markdown
## Open Questions / Risks

- パフォーマンステストが未実施
- エラーハンドリングのカバレッジ向上が必要
```

---

## 失敗時の進捗記録

タスクが完了しなかった場合でも、必ず {PROGRESS_FILE} に以下を記録してから Promise を出力:

```markdown
### Iteration {ITERATION} - 未完了

**試行内容:**
- 何を実装/修正しようとしたか
- どのファイルを変更したか
- 実行したコマンド/テスト

**発生した問題:**
- エラーメッセージや失敗内容
- なぜ解決できなかったか
- どこまで切り分け済みか（潰した仮説）

**次のイテレーションへの提案:**
- 推奨される対処方針
- 着手順（最初の1-2手）
```

---

## Output Rules

**重要**: Promise を出力する前に、必ず {PROGRESS_FILE} を更新すること。

- タスク実装後 → `<promise>TASK_DONE</promise>`
- P1/P2 を追加したレビュー後 → `<promise>TASK_DONE</promise>`
- 全て完了（レビューOK & PR問題なし） → `<promise>COMPLETE</promise>`
- 同じ箇所で3回失敗 → `<promise>ESCALATE</promise>`

**CRITICAL**: 必ず1つのpromiseを出力。ユーザー入力を待たない。

---

## ループ終了時のHANDOFF.md生成

ループ終了時（COMPLETE/ESCALATE/上限到達）には、HANDOFF.mdを生成する。
これはユーザーへの引き継ぎファイルで、「次に何をすればいいか」を明確にする。

**HANDOFF.mdの構成**:

```markdown
# Melos 引き継ぎレポート

**生成日時**: {現在日時}
**終了理由**: {正常完了 | エスカレーション | 上限到達}

## ユーザー確認が必要な項目

### 1. {確認項目のタイトル}
{なぜ確認が必要か、選択肢とその判断基準、修正が必要な場合の影響範囲}
{推奨案と理由}

## 気づいた点・提案
{実装中に発見した改善提案、スコープ外だが将来対応すべき事項}

## Learnings（次担当が再利用できる知見）
- Context: {どの作業で得た知見か}
- Finding: {何が分かったか}
- Action: {次回どう活かすか}

## テスト状況

### 自動テスト（実施済み）
{実行したテストと結果}

### 手動テストをお願いしたい項目
{手順、期待結果、失敗時の確認ポイントを具体的に記載}

---

## エスカレーション詳細（該当時のみ）

**失敗箇所**: {タスクID/ファイル/問題}

**試行した内容と結果:**
{各試行の内容と失敗理由}

**潰した可能性:**
{調査済みで問題なかったこと}

**調査が必要な点:**
{人間が調査すべきこと}

**代替案:**
{可能な回避策}
```

**重要**: HANDOFF.mdの内容はactionableに。ユーザーが読んですぐ行動できるよう具体的に書く。
