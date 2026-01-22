---
name: git-sync
description: origin/main との同期を自動化。リモートブランチの auto-fix コミットにも対応。
---

# Git Syncer

origin/main との同期を行い、ローカルブランチを最新に保つ。

## 前提条件

- 未コミット変更がないこと（ある場合は先にコミットを促す）
- main/master ブランチでないこと

## 事前確認

```bash
git fetch origin
git status -sb
git log --oneline -5
```

## 処理フロー

### 1. 未コミット変更の確認

`git status --porcelain` で未コミット変更がある場合：
- 「未コミットの変更があります。先にコミットしてください。」と警告して終了

### 2. ブランチ確認

- main/master ブランチの場合は警告して終了
- origin/main が存在しない場合は origin/master を試行

### 3. 同期パターンの判定

```bash
# リモートブランチとの差分を確認
git rev-list --count HEAD..origin/<current-branch> 2>/dev/null || echo "0"

# origin/main との差分を確認
git rev-list --count HEAD..origin/main
```

| リモートブランチ差分 | origin/main差分 | パターン | 対応 |
|---------------------|-----------------|----------|------|
| 0 | 0 | 最新 | 「既に最新です」と報告して終了 |
| 0 | >0 | パターン1 | origin/main で rebase |
| >0 | 0 | パターン2a | リモートブランチで rebase のみ |
| >0 | >0 | パターン2b | リモートブランチで rebase → origin/main で rebase |

### 4. パターン1: origin/main のみ進んでいる

```bash
git rebase origin/main
```

### 5. パターン2a: リモートブランチのみ進んでいる（auto-fix等）

```bash
git pull --rebase origin <current-branch>
```

### 6. パターン2b: 両方進んでいる

```bash
# Step 1: リモートブランチの変更を取り込む
git pull --rebase origin <current-branch>

# Step 2: origin/main で rebase
git rebase origin/main
```

### 7. コンフリクト発生時

rebase 中にコンフリクトが発生した場合、ユーザーに選択肢を提示：

- **[a] 中止する**: `git rebase --abort` で元の状態に戻す
- **[b] 解決する**: 処理を中断し、`/git:resolve-merge-conflicts` の実行を案内

### 8. 完了報告

同期完了後、以下を報告：
- 取り込んだコミット数
- 現在の状態（`git log --oneline -3`）
