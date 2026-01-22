## Marathon 統一ループ（HITL）

**Plan file**: @{PLAN_FILE}
**Progress file**: @{PROGRESS_FILE}

---

## Plan File Format

プランファイルはJSON形式で `passes` フィールドと `checks` フィールドを持つ:

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

**FIRST**: Read {PROGRESS_FILE} to understand what has already been completed.
This prevents you from re-doing work or re-exploring the codebase unnecessarily.

**THEN**: Follow the decision flow below:

---

## 判定フロー

```
1. 未完了タスクあり？
   → YES: タスク実行へ
   → NO: 2へ

2. レビュー実行
   → P1/P2あり: タスク追加して終了
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

1. **Decide which task to work on next**
   - Look for tasks with `passes: false`
   - Prioritize by RISK, not by list order:
     1. Architectural decisions
     2. Integration points
     3. Unknown unknowns / spikes
     4. Standard features
     5. Polish and quick wins

2. **Implement ONE task only**
   - Keep changes small and focused
   - Follow existing patterns in the codebase
   - Write tests for new functionality

3. **Verify checks** (if `checks` exists):
   - 各チェック項目を順番に検証
   - `browser` タイプは証拠（screenshot/video URL）を必ず設定
   - 検証完了した項目は `passed: true` に更新
   - 全チェック完了後に `passes: true` に設定

4. **Update the plan file**
   - Set `passes: true` for the completed task

5. **Append your progress to {PROGRESS_FILE}**
   - What task you completed
   - Key decisions made
   - Any blockers or notes for next iteration

6. **Make a git commit**
   - Use the `git-commit` skill

---

### Step 2: 全タスク完了 → Run Review

1. **Launch 2 review agents in parallel**:
   - comprehensive-reviewer（履歴分析、パターン認識、アーキテクチャ、セキュリティ、パフォーマンス、データ整合性、シンプル性の7観点を統合）
   - general-purpose (run `Skill codex-review`)

2. **Extract findings** (P1/P2/P3+)

3. **Filter by scope** (`git diff main --name-only`)

4. **Add tasks if P1/P2 found**:
   ```json
   {"id": "review-1", "description": "[P1] agent: finding", "passes": false}
   ```

5. **Record in {PROGRESS_FILE}**

---

### Step 3: PR対応チェック

1. **Check PR status**:
   ```bash
   gh pr view --json number,url
   gh pr checks
   ```

2. **If issues exist**:
   - Fix CI errors
   - Respond to review comments

---

## Completion Messages

**After completing work**, output the appropriate message:

### If there are remaining tasks or P1/P2 found:
```
======================================
✅ タスク完了
======================================

完了したタスク: [タスクID] - [タスク説明]

次のステップ:
  - 変更内容を確認
  - 問題なければ再実行: marathon --hitl
```

### If ALL tasks complete AND review passes AND PR OK:
```
======================================
🎉 全タスク完了！
======================================

次のステップ:
  - PRをマージ
```

---

## 失敗時の進捗記録

タスクが完了しなかった場合でも、必ず {PROGRESS_FILE} に以下を記録:

```markdown
### タスク未完了

**試行内容:**
- 何を実装/修正しようとしたか

**発生した問題:**
- エラーメッセージや失敗内容

**次回への提案:**
- 推奨される対処方針
```

**重要**: 完了メッセージを出力する前に、必ず {PROGRESS_FILE} を更新すること。

---

## PROGRESS.md のセクション

{PROGRESS_FILE} には以下のセクションを記録する。

### Current Objective

現在のイテレーションで達成しようとしている目標を記載。
目標が変わった場合は更新する。

```markdown
## Current Objective

- Marathon v0.2.2 の安定化と機能拡張
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

## Important Rules

- ONLY WORK ON A SINGLE TASK
- Do NOT skip feedback loops
- Do NOT commit if feedback loops fail
- Quality over speed
- 同じ箇所で3回失敗したら `<promise>ESCALATE</promise>` を出力

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
