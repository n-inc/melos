---
name: git-fix-review-ci-on-pull-request
description: GitHub CLIを使用してPRのレビューコメントとCIエラーを修正
---

# PRの修正

## 現在のPR状況
- PR詳細情報: `!gh pr view --json title,body,reviews,reviewDecision,commits,url,number || echo "PRが見つかりません"`
- CIチェック状況: `!gh pr checks || echo "CIチェックが設定されていません"`

あなたは GitHub CLI を使用して、現在のブランチに対応する PR をレビュー・修正してください。

## 実行モード（デフォルト）
- **オートフィックスモード（既定）**: ユーザー確認を待たず、最小差分で自動修正する。
- 判断に迷いが少ない指摘（パス修正、リンク修正、Lint/型エラー、明確なCI失敗要因）は即時適用する。
- 破壊的変更・仕様変更の可能性がある場合のみ、例外的にユーザーへ確認する。
- さらに、リポジトリの `AGENTS.md` で「事前確認が必要」と定義された変更カテゴリに該当する場合は、必ずユーザー確認を行う。

## 1. 状況分析

### レビューコメントの取得（GraphQL 2段階方式）

**必ず以下の GraphQL クエリでレビューコメントを取得すること。** REST API (`pulls/comments`) は `isResolved` / `isOutdated` が取得できないため、コメント一覧の取得には使用しない（Step 2 の個別コメント body 全文取得には REST を使用する）。

コンテキスト消費を最小化するため、**2段階**で取得する。

#### Step 1: サマリー取得（軽量）

未解決・最新のコメントだけを、body先頭120文字に切り詰めて取得する。`--jq` で必ずフィルタすること。

```bash
cat > /tmp/review_threads.graphql << 'GRAPHQL'
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated
          path line
          comments(first: 1) {
            nodes {
              databaseId body
              author { login }
            }
          }
          latestComments: comments(last: 1) {
            nodes {
              databaseId body
              author { login }
            }
          }
        }
      }
    }
  }
}
GRAPHQL

gh api graphql -F query=@/tmp/review_threads.graphql \
  -f owner=OWNER -f repo=REPO -F number=NUMBER \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[]
    | select(.isResolved == false and .isOutdated == false)
    | {threadId: .id, path, line,
       firstComment: (.comments.nodes[0] | {author: .author.login, body: (.body | split("\n")[0][:120]), id: .databaseId}),
       latestComment: (if .latestComments.nodes[0].databaseId != .comments.nodes[0].databaseId then (.latestComments.nodes[0] | {author: .author.login, body: (.body | split("\n")[0][:120]), id: .databaseId}) else null end)}'

rm -f /tmp/review_threads.graphql
```

> **ページネーション**: `pageInfo.hasNextPage` が `true` の場合、`endCursor` を `$cursor` に渡して全ページ取得すること。

#### Step 2: 詳細取得（必要なコメントのみ）

Step 1 で対応が必要と判断したコメントについてのみ、`databaseId` を使って body 全文を取得する。

```bash
gh api repos/OWNER/REPO/pulls/comments/COMMENT_ID --jq '{id: .id, body: .body, path: .path, line: .line}'
```

#### 対応すべきコメントの判断基準

Step 1 の結果を以下の基準でフィルタする：

1. `isResolved: false` かつ `isOutdated: false`
2. 自分自身のコメント（返信）は除外
3. bot の `Resolved` 系コメントは対応不要

### CIエラーの確認

- 上記の「現在のPR状況」から CI チェック結果を分析する
- 失敗がある場合は `gh run view {run_id} --log-failed` で詳細を取得する

## 2. 変更意図の把握（指摘対応の前に必ず実施）

レビュー指摘に対応する前に、**このPRが何を意図した変更なのか**を把握する。指摘が技術的に正しくても、PRの意図と矛盾する修正は適用してはならない。

### 2.1 意図の確認ソース（優先順）

1. `PRD.md` があれば必ず読む
2. PR description
3. コミットメッセージ
4. 会話の文脈

### 2.2 指摘ごとの判断基準

| 判断 | 条件 | アクション | 例 |
|------|------|-----------|-----|
| **即時適用** | 意図と無関係な客観的誤り | コード修正 -> コメント返信 | タイポ、Lint、型エラー |
| **即時却下** | PRの意図に照らして現状が正しい | コメント返信のみ | 意図的な設計判断への bot 指摘 |
| **ユーザー確認** | 意図との整合性が判断できない、または `AGENTS.md` の事前確認必須カテゴリ | ユーザーに確認 | 仕様変更の可能性がある指摘 |

## 3. 修正判断と実装

### 3.1 自動判断フェーズ
取得したレビューコメントと CI エラーを、**Step 2 で把握した変更意図**に照らして解析し、
- 各指摘を適用すべきか
- 即時却下すべきか
- 適用する場合、どう適用すれば最小差分で問題を解決できるか
を自律的に判断する。

### 3.2 意思決定
- 意図と矛盾しない客観的修正は即時適用する
- 意図と明確に矛盾する指摘は即時却下し、理由をコメント返信する
- 意図との整合性が判断できない指摘は、ユーザーに確認する

## 4. 修正プラン提示
- 変更対象ファイルと変更の概要を Markdown 箇条書きで示す
- 変更理由を各項目ごとに1行で添える
- 各指摘に対する判断（即時適用 / ユーザー確認 / 意図的に維持）とその理由を明示する

## 5. 実装ワークフロー
- 通常は承認待ち不要。修正プラン提示後、直ちに実装する
- ただし `AGENTS.md` の事前確認必須カテゴリに当たる場合は、実装前に確認を取る
- 変更は最小差分を原則とし、不要なリファクタリングは行わない

## 6. テスト & 再実行
失敗が続く場合は原因を要約し、追加修正プランを提示して自動で再実行する。

## 6.5. レビューコメントへの返信

修正完了後、各レビューコメントに GitHub 上で返信する。

### 返信フォーマット

**修正した場合：**

```text
✅ **修正済み**

[何をしたかを簡潔に記載]
```

**スキップした場合：**

```text
⏭️ **対応スキップ**

[スキップした理由を記載]
```

**サジェストと異なる対応をした場合：**

```text
🔄 **別の方法で対応**

[どのように対応したか、なぜその方法を選んだかを記載]
```

**意図的に維持する場合：**

```text
⏸️ **意図的に維持**

[なぜ現状のままが適切かを記載]
```

### 返信コマンド

```bash
gh api repos/{owner}/{repo}/pulls/{PR番号}/comments/{コメントID}/replies -F body="返信内容"
```

### スレッドの Resolve

返信後、対応済みのスレッドを resolve する。Step 1 で取得した `threadId` を使用する。

```bash
gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "THREAD_NODE_ID"}) { thread { isResolved } } }'
```

- ✅ 修正済み -> resolve する
- 🔄 別の方法で対応 -> resolve する
- ⏸️ 意図的に維持 -> resolve しない
- ⏭️ 対応スキップ -> resolve しない

## 7. プッシュ後の自動レビュー待機

修正をコミット＆プッシュした後、自動レビューボットの新規コメントを待ち受ける。

### ポーリング仕様

1. 最後のプッシュ時刻を記録する
2. 10分間隔で未解決・最新のコメントを再取得する
3. 新規コメントがある場合は Step 1 から再実行する
4. 新規コメントがない場合はポーリングを継続する
5. 最後のプッシュから30分間新規コメントがなければ終了する

### ポーリング中の出力

```text
⏳ 自動レビュー待機中... (最後のプッシュから {経過分}分 / 30分)
   未解決スレッド: {件数}件 / 未対応: {件数}件
```

## 8. 完了報告

ポーリング終了後、またはCIがグリーンかつ未対応コメントがない場合：
1. 全てのレビューコメントに返信済みであることを確認
2. 対応サマリーをユーザーに報告し、コマンドを終了

# 出力フォーマット

- 通常は質問せず、自動修正の進捗と結果を簡潔に報告する
- 例外的に確認が必要な場合のみ、質問は **Q:** で始める
