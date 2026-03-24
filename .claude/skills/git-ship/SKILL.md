---
name: git-ship
description: Sync, commit, push, and create PR in one command
skills: git-commit, git-sync
---

変更内容を確認し、以下の順序で処理を実行する：

## 1. コミット作成

**git-commit スキル**を起動してコミットを作成。

## 2. origin/main と同期

**git-sync スキル**を起動して origin/main と同期。

- リモートブランチに auto-fix コミットがある場合も自動で対応
- コンフリクト発生時はユーザーに対処方法を選択させる

## 3. PR作成

**git-new-pull-request スキル**を起動してプッシュとPR作成（または更新）を実行。

## 次のステップ

| いまやりたいこと | 参照先 | 参照先に書いてある内容 |
| --- | --- | --- |
| `git-commit` スキルの手順も確認したい | `../git-commit/SKILL.md` | `git-commit` スキル。Analyze Git changes and create commits with appropriate commit messages following project conventions. Use when creating commits for staged changes. |
| `git-sync` スキルの手順も確認したい | `../git-sync/SKILL.md` | `git-sync` スキル。origin/main との同期を自動化。リモートブランチの auto-fix コミットにも対応。 |
| `git-new-pull-request` スキルの手順も確認したい | `../git-new-pull-request/SKILL.md` | `git-new-pull-request` スキル。Analyze git changes and commit history to create or update GitHub Pull Requests with appropriate titles and descriptions. Use when creating PRs, updating PR content, or managing PR workflow. |
