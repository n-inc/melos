---
name: melos-ci-fix-loop
description: PR 作成後の feedback と CI を監視し、actionable な指摘だけを修正して quiet window まで追従する。
allowed-tools: Bash
---

<objective>
現在の Melos worker 実行の中で GitHub PR の feedback と required checks を監視し、actionable な指摘だけを自律的に修正する。
`gh pr view --json ...`、`gh api graphql`、`gh pr checks` を使って PR 状態を取得し、最後の push または最後の外部 feedback から 30 分静穏かつ required checks green になるまでループする。
</objective>

<quick_start>
```bash
# PR 概要と reviews / comments を取得
gh pr view --json number,url,title,body,headRefName,baseRefName,isDraft,updatedAt
gh api graphql -f query='query($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner, name:$repo) { pullRequest(number:$number) { reviewThreads(first:100) { nodes { isResolved comments(first:100) { nodes { id author { login } body createdAt updatedAt path line state url } } } } reviews(first:100) { nodes { id author { login } body state submittedAt updatedAt url } } comments(first:100) { nodes { id author { login } body createdAt updatedAt url } } commits(last:1) { nodes { commit { committedDate statusCheckRollup { state } } } } } } }'

# required checks を確認
gh pr checks --required
```
</quick_start>

<workflow>
<step number="1" name="preflight">
以下を確認する。

```bash
gh --version
gh auth status
git remote get-url origin
git branch --show-current
```

`gh` 未導入、未認証、origin 不在、PR 不在なら `BLOCKED` として終了する。
</step>

<step number="2" name="collect-feedback">
監視対象は「自分以外すべて」の feedback とする。

- issue comment
- review body
- inline review comment
- required checks

reviewer / commenter / bot を区別せず、自分自身の comment だけ除外する。
</step>

<step number="3" name="classify">
各 feedback を `actionable` または `off-target` に分類する。

- `actionable`: 実際のバグ、CI failure、仕様逸脱、明確な改善要求
- `off-target`: 仕様外要求、誤読、既に解決済み、根拠が薄い指摘

`off-target` は修正しない。その理由を worker report の `warnings` に残す。
</step>

<step number="4" name="fix-and-push">
`actionable` な feedback または failing CI がある場合は修正する。

- 既存の branch / working tree をそのまま使う
- 必要な検証を実行する
- commit が必要なら `git-commit` スキルを使う
- push が必要なら通常の `git push` を行う

別の `melos` プロセスや `npx melos --ci-fix-only` は起動しない。
</step>

<step number="5" name="wait-for-quiet-window">
次の条件を両方満たすまで監視を続ける。

- required checks が green
- 最後の push または最後の外部 feedback の遅い方から 30 分経過

新しい push または外部 feedback が来たら 30 分タイマーをリセットする。
</step>

<step number="6" name="report">
最終的に JSON report を返す。

- `pullRequest`: 最新 PR 情報
- `pullRequestFollowUp.handledFeedbackIds`: 今回対応済みと判断した feedback ID 一覧
- `pullRequestFollowUp.lastExternalActivityAt`: 最後の外部活動時刻
- `pullRequestFollowUp.quietUntil`: 現在の quiet window 期限
- `warnings`: off-target 判定や未解消 caveat
</step>
</workflow>

<success_criteria>
- actionable な feedback に対して必要な修正が反映されている
- off-target な feedback は修正せず、理由が記録されている
- required checks が green で、quiet window が満了している
- worker report に `pullRequest` と `pullRequestFollowUp` が入っている
</success_criteria>

<constraints>
- PRが存在する必要がある
- GitHub CLIがインストール・認証済みであること
- 長時間実行となる可能性がある
- nested Melos 実行は禁止
- ユーザー確認は原則不要。自身の判断で修正する
</constraints>
