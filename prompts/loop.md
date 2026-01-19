## Marathon 統一ループ - イテレーション {ITERATION} / {MAX_ITERATIONS}

**PRD**: @PRD.md
**Plan file**: @{PLAN_FILE}
**Progress file**: @{PROGRESS_FILE}

---

## 品質ゲート（コミット前必須）

タスクを完了（`passes: true`）としてマークする前に、以下を必ず実行:

1. **型チェック**: `cd frontend && bun run typecheck` / `cd api && bundle exec srb tc`
2. **テスト**: 関連するテストが全てパス
3. **Lint**: `cd frontend && bun run lint` / `cd api && bundle exec rubocop --format simple`
4. **UI変更時**: `browser-test` スキルでスクリーンショット確認

**重要**: 品質ゲートが失敗した場合:
- ❌ コミットしない
- ❌ `passes: true` にしない
- ✅ {PROGRESS_FILE} に失敗内容と試行した修正を記録
- ✅ `<promise>TASK_DONE</promise>` を出力して次のイテレーションで再試行

---

## Plan File Format

プランファイルはJSON形式で `passes` フィールドを持つ:

```json
[
  {"id": "1", "description": "Task description", "passes": false},
  {"id": "2", "description": "Another task", "passes": false}
]
```

- タスク完了時に `passes: false` → `passes: true` に更新

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

1. **Pick ONE task**（`passes: false` のもの、リスク順に優先）

2. **Implement it**
   - 変更は小さく、焦点を絞る
   - 既存パターンに従う

3. **Run feedback loops**
{FEEDBACK_INSTRUCTIONS}
   - 次に進む前にすべての問題を修正

4. **Update plan file**: `passes: true` に設定

5. **Record in {PROGRESS_FILE}**: 何をしたか、重要な判断

6. **Commit**: `git-commit` スキルを使用

7. **Output `<promise>TASK_DONE</promise>`**

---

### Step 2: 全タスク完了 → Run Review

1. **Launch 2 review agents in parallel**:
   - comprehensive-reviewer（履歴分析、パターン認識、アーキテクチャ、セキュリティ、パフォーマンス、データ整合性、シンプル性の7観点を統合）
   - general-purpose (run `Skill codex-review`)

2. **Extract findings from agents**:
   - 各エージェントが報告した重大度（P1/P2/P3+）を使用

3. **Filter by scope** (`git diff main --name-only` を実行):
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
   {"id": "review-1", "description": "[P1] agent-name: finding", "passes": false}
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

## Codebase Insights

実装中に発見した知見は {PROGRESS_FILE} に「## Codebase Insights」セクションを作成し、追記すること。
後続のイテレーションや将来の開発者が恩恵を受ける情報を記録する。

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

---

## 失敗時の進捗記録

タスクが完了しなかった場合でも、必ず {PROGRESS_FILE} に以下を記録してから Promise を出力:

```markdown
### Iteration {ITERATION} - 未完了

**試行内容:**
- 何を実装/修正しようとしたか
- どのファイルを変更したか

**発生した問題:**
- エラーメッセージや失敗内容
- なぜ解決できなかったか

**次のイテレーションへの提案:**
- 推奨される対処方針
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
# Marathon 引き継ぎレポート

**生成日時**: {現在日時}
**終了理由**: {正常完了 | エスカレーション | 上限到達}

## ユーザー確認が必要な項目

### 1. {確認項目のタイトル}
{なぜ確認が必要か、選択肢とその判断基準、修正が必要な場合の影響範囲}

## 気づいた点・提案
{実装中に発見した改善提案、スコープ外だが将来対応すべき事項}

## テスト状況

### 自動テスト（実施済み）
{実行したテストと結果}

### 手動テストをお願いしたい項目
{手順、期待結果を具体的に記載}

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
