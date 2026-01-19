---
name: marathon-add-task
description: 自然言語でMarathonタスクを追加。PLAN.jsonへの変換・追記とPRD.md受入基準の自動追記を行う。タスク追加、新機能リクエスト時に使用。
---

<objective>
自然言語でタスクを記述すると、適切なPLAN.jsonフォーマットに変換し、既存のプランに追加する。不明点があればインタビュー形式で確認し、曖昧さを解消する。PRD.mdにも該当する受入基準を追記する。
</objective>

<input>
<feature_description> #$ARGUMENTS </feature_description>
</input>

<quick_start>
1. ユーザーの自然言語入力を受け取る
2. 必要に応じてインタビューで詳細を確認
3. PLAN.jsonフォーマットに変換
4. 既存PLAN.jsonに追記（上書きしない）
5. PRD.mdの受入基準にも追記
</quick_start>

<workflow>
<step number="1" name="understand">
ユーザーの入力を解析し、何を実装したいのかを理解する。

**確認すべき観点**:
- 目的：何を達成したいか
- 範囲：どこまでやるか
- 検証方法：どう確認するか
</step>

<step number="2" name="clarify">
不明点がある場合は`AskUserQuestion`で確認。

**質問の観点**:
- 実装の詳細が曖昧な場合
- 複数のアプローチがあり得る場合
- 検証方法が不明確な場合

**質問の作法**:
- 提案込みで質問する（「〜でよいですか？」）
- 選択肢を提示する
- 1-2問に絞る（長いインタビューは避ける）
</step>

<step number="3" name="load_plan">
既存のPLAN.jsonを読み込み、次のIDを計算する。

```bash
# Worktreeルートを取得
WORKTREE_ROOT=$(git rev-parse --show-toplevel)
```

**ID採番ルール**:
- 既存の数値IDの最大値 + 1
- review-*やresearch-*は数値IDとは別管理
</step>

<step number="4" name="create_task">
タスクを作成する。

**必須フィールド**:
```json
{
  "id": "自動採番",
  "description": "タスクの説明",
  "category": "task",
  "stepsToVerify": ["検証ステップ"],
  "passes": false
}
```

**categoryの許可値（厳守）**:
| category | 用途 |
|----------|------|
| `task` | 新機能、ドキュメント作成、改善など（デフォルト） |
| `research` | 調査・リサーチタスク |
| `review-fix` | レビュー指摘への対応 |

⚠️ **注意**: 上記3つ以外の値（`docs`, `feature` 等）は使用不可。

**stepsToVerifyプレフィックス**:
| プレフィックス | 用途 |
|---------------|------|
| `[auto:rspec]` | RSpecで自動検証 |
| `[auto:jest]` | Jestで自動検証 |
| `[auto:typecheck]` | 型チェック |
| `[browser]` | ブラウザ確認 |
| `[manual]` | 手動確認 |
</step>

<step number="5" name="append_plan">
PLAN.jsonに追記する（上書きしない）。

```typescript
// 既存のプランを読み込んで追記
const plan = JSON.parse(await readFile('PLAN.json', 'utf-8'));
plan.push(newTask);
await writeFile('PLAN.json', JSON.stringify(plan, null, 2) + '\n');
```
</step>

<step number="6" name="update_prd">
PRD.mdの受入基準セクションに該当項目を追記。

**追記フォーマット**:
```markdown
### {タスクタイトル}

- [ ] 受入基準1
- [ ] 受入基準2
```

**注意**:
- 既存の内容は変更しない
- 適切なセクションに追記する
- チェックボックス形式で記述
</step>

<step number="7" name="confirm">
追加したタスクをユーザーに報告。

**出力形式**:
```
以下のタスクをPLAN.jsonに追加しました：

{追加したタスクのJSON}

PRD.mdにも受入基準を追記しました。
```
</step>
</workflow>

<examples>
<example number="1">
<input>/marathon-add-task ログインに2FAを追加したい</input>
<interview>
```
2FA追加について確認させてください：
- 認証方式はTOTP（Google Authenticator等）でよいですか？
- リカバリーコードは必要ですか？
```
</interview>
<user_response>TOTPで、リカバリーコードも必要</user_response>
<output>
```
以下のタスクをPLAN.jsonに追加しました：

{
  "id": "5",
  "description": "ログインに2FA（TOTP）を追加。リカバリーコード機能も含む",
  "category": "task",
  "stepsToVerify": [
    "[auto:rspec] 2FA有効化・無効化のAPIが動作する",
    "[auto:jest] 2FA設定UIが正しく動作する",
    "[browser] 2FA設定フローが完了できる"
  ],
  "passes": false
}

PRD.mdにも受入基準を追記しました。
```
</output>
</example>

<example number="2">
<input>/marathon-add-task 検索結果のキャッシュを実装</input>
<output>
```
以下のタスクをPLAN.jsonに追加しました：

{
  "id": "3",
  "description": "検索結果のキャッシュ実装。Redis使用、TTL設定可能",
  "category": "task",
  "stepsToVerify": [
    "[auto:rspec] キャッシュが正しく保存・取得される",
    "[auto:rspec] TTL経過後にキャッシュが無効化される",
    "[manual] 検索レスポンスタイムが改善される"
  ],
  "passes": false
}

PRD.mdにも受入基準を追記しました。
```
</output>
</example>
</examples>

<success_criteria>
- 自然言語入力からPLAN.jsonフォーマットへ正しく変換される
- 既存PLAN.jsonの内容が保持され、新タスクが追記される
- 新タスクのIDが既存最大ID + 1で自動採番される
- stepsToVerifyに適切なプレフィックスが付与される
- PRD.mdの受入基準に該当項目が追記される
- 不明点がある場合はインタビューで確認される
</success_criteria>

<constraints>
- **コーディングは行わない**: タスク追加とPRD更新のみ
- **上書きしない**: 既存内容は必ず保持
- **短いインタビュー**: 質問は1-2問に絞る
- **絶対パス使用**: `$(git rev-parse --show-toplevel)` でルート取得
</constraints>
