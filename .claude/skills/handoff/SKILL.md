---
name: handoff
description: Generate a structured handoff summary for continuing work in a new session. Supports topic-specific handoffs via argument.
argument-hint: "[topic or next action to focus on]"
---

# Handoff

会話セッションのコンテキストを分析し、新しいセッションで作業を継続するための構造化サマリーを生成する。

## 使い方

| パターン | 例 | 動作 |
|----------|-----|------|
| 次のアクション指示 | `/handoff implement tests` | 指定アクションに関連するコンテキストを抽出 |
| トピック名 | `/handoff 認証フロー` | 該当トピック関連のコンテキストを抽出 |
| 引数なし | `/handoff` | 会話全体のサマリーを生成 |

## ワークフロー

### Step 1: コンテキスト収集

現在の状態情報を収集する：

```bash
# 現在のブランチ
git branch --show-current

# 未コミットの変更
git status --porcelain

# 最近のコミット（直近10件）
git log --oneline -10

# 最近変更されたファイル
git diff --name-only HEAD~5..HEAD 2>/dev/null || git diff --name-only HEAD
```

追加で確認すべき情報：
- PROGRESS.md（プロジェクトルートに存在する場合）
- 会話中で言及された重要なファイル
- セッション中に行った決定事項

### Step 2: セッション分析

会話履歴から以下を抽出：

1. **主要タスク**: 主な目標は何だったか？
2. **完了した作業**: 何を達成したか？
3. **重要な決定**: どのような選択をし、なぜそうしたか？
4. **現在の状態**: どこまで進んだか？
5. **ブロッカー**: 未解決の問題はあるか？

### Step 3: サマリー生成

`$ARGUMENTS` が指定されている場合、そのトピック/アクションに関連するコンテキストのみをフィルタリングする。

出力フォーマット：

```markdown
# Handoff Summary

## Context
[このハンドオフの目的と背景を1-2文で説明]

## Task Overview
**Main Task**: [主要タスクの簡潔な説明]
**Current Status**: [🟢 On Track | 🟡 In Progress | 🔴 Blocked]
**Branch**: [現在のブランチ名]

## What Was Done
- [完了した作業1]
- [完了した作業2]

## Key Decisions Made
| Decision | Rationale |
|----------|-----------|
| [決定事項1] | [理由] |

## Current State

### Modified Files
- `path/to/file.ts` - [変更内容の概要]

### Uncommitted Changes
[git status の出力、または「None」]

## Next Steps
1. **Immediate**: [すぐにやるべきこと]
2. **Then**: [その次にやるべきこと]

## Open Questions / Blockers
- [ ] [未解決の質問や課題]

## Critical Files to Review
- `path/to/important.ts` - [なぜ重要か]
```

### Step 4: クリップボードにコピー

サマリー生成後、クリップボードにコピーする：

```bash
# macOS
echo "$HANDOFF_SUMMARY" | pbcopy
```

### Step 5: 完了通知

完了メッセージを表示：

```
✅ Handoff Summary をクリップボードにコピーしました。

新しいセッションで Cmd+V で貼り付けて作業を継続できます。
```

## 使用例

### 例1: 引数なし（セッション全体のサマリー）

ユーザー: `/handoff`

セッションで行ったすべての作業、決定、次のステップを含む包括的なサマリーを生成する。

### 例2: トピック指定

ユーザー: `/handoff authentication refactor`

認証関連の作業にフォーカスしたサマリーを生成：
- 認証関連ファイルの変更のみを含める
- 認証に関する決定にフォーカス
- 次のステップは認証固有のものに

### 例3: 次のアクション指定

ユーザー: `/handoff write tests`

テスト作成者向けに最適化されたサマリーを生成：
- テスト可能なコンポーネントをハイライト
- 発見した関連テストパターンを含める
- 実装中に発見したエッジケースを記載

## 注意事項

- クリップボードコピーには `pbcopy` を使用（macOS環境）
- サマリーは簡潔かつ完全に
- アクション可能な情報を優先
- ファイルパスには変更内容の簡潔な説明を添える
- スキャンしやすいフォーマット（箇条書き、テーブル、見出し）を使用
