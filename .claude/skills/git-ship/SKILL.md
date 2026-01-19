---
name: git-ship
description: Sync, commit, push, and create PR in one command
skills: git-commit, git-sync, git-new-pull-request
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
