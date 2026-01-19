---
name: git-worktree
description: This skill manages Git worktrees for isolated parallel development. It handles creating, listing, switching, and cleaning up worktrees with a simple interactive interface, following KISS principles.
---

# Git Worktree Manager

開発ワークフロー全体でGit worktreeを管理するための統一インターフェースを提供するスキル。PRを分離してレビューする場合でも、機能を並行して作業する場合でも、このスキルがすべての複雑さを処理する。

## このスキルが行うこと

- mainブランチから明確なブランチ名で**worktreeを作成**
- 作成後に**VS Codeで自動的に開く**
- 現在のステータスで**worktreeを一覧表示**
- 並行作業のために**worktree間を切り替え**
- 完了したworktreeを自動的に**クリーンアップ**
- 各ステップで**インタラクティブな確認**
- worktreeディレクトリの**自動.gitignore管理**
- **環境ファイルの自動コピー** (`.env`など)
- **plansディレクトリの自動コピー** (作業に関連するプランを持ち込み)
- **mise自動セットアップ** (プロジェクトルートで`mise trust`を実行)

## このスキルを使用するタイミング

以下のシナリオでこのスキルを使用：

1. **コードレビュー (`/review`)**: PRブランチにいない場合、分離レビュー用にworktreeを提案
2. **機能作業 (`/work`)**: ユーザーが並行worktreeかライブブランチ作業を望むか常に確認
3. **並行開発**: 複数の機能を同時に作業する場合
4. **クリーンアップ**: worktreeでの作業完了後

## 使用方法

### Claude Codeワークフロー内

スキルは`/review`と`/work`コマンドから自動的に呼び出される：

```
# レビュー時: PRブランチにいなければworktreeを提案
# 作業時: 常に確認 - 新規ブランチかworktreeか？
```

### 手動使用

bashから直接スキルを呼び出すことも可能：

```bash
# 新しいworktreeを作成
bash .claude/skills/git-worktree/scripts/worktree-manager.sh create feature-login

# すべてのworktreeを一覧表示
bash .claude/skills/git-worktree/scripts/worktree-manager.sh list

# worktreeに切り替え
bash .claude/skills/git-worktree/scripts/worktree-manager.sh switch feature-login

# 完了したworktreeをクリーンアップ
bash .claude/skills/git-worktree/scripts/worktree-manager.sh cleanup
```

## コマンド

### `create <branch-name> [from-branch]`

指定されたブランチ名で新しいworktreeを作成。

**オプション:**
- `branch-name` (必須): 新しいブランチとworktreeの名前
- `from-branch` (オプション): 作成元のベースブランチ（デフォルトは`main`）

**例:**
```bash
bash .claude/skills/git-worktree/scripts/worktree-manager.sh create feature-login
```

**何が起こるか:**
1. worktreeが既に存在するかチェック
2. リモートからベースブランチを更新
3. 新しいworktreeとブランチを作成
4. 環境ファイル（`.env`）をメインリポジトリからコピー
5. `.claude/plans/`ディレクトリをメインリポジトリからコピー
6. miseセットアップ（プロジェクトルートで`mise trust`を実行）
7. VS Codeで新しいworktreeを自動的に開く（`git worktree list`から絶対パスを取得して`code <absolute-path>`を実行）
8. worktreeへのcdパスを表示

**注意**: VS Codeで開く際は、`git worktree list`の出力から正確な絶対パスを使用すること。相対パスや推測したパスは使用しない。

### `list` または `ls`

利用可能なすべてのworktreeをブランチと現在のステータスとともに一覧表示。

**例:**
```bash
bash .claude/skills/git-worktree/scripts/worktree-manager.sh list
```

**出力表示:**
- Worktree名
- ブランチ名
- 現在のもの（✓でマーク）
- メインリポジトリステータス

### `switch <name>` または `go <name>`

既存のworktreeに切り替えてcdする。

**例:**
```bash
bash .claude/skills/git-worktree/scripts/worktree-manager.sh switch feature-login
```

**オプション:**
- 名前が提供されない場合、利用可能なworktreeを一覧表示して選択を促す

### `cleanup` または `clean`

インタラクティブに確認しながら非アクティブなworktreeをクリーンアップ。

**例:**
```bash
bash .claude/skills/git-worktree/scripts/worktree-manager.sh cleanup
```

**何が起こるか:**
1. すべての非アクティブなworktreeを一覧表示
2. 確認を求める
3. 選択したworktreeを削除
4. 空のディレクトリをクリーンアップ

## ワークフロー例

### Worktreeを使用したコードレビュー

```bash
# Claude CodeがPRブランチにいないことを認識
# 提案: "Use worktree for isolated review? (y/n)"

# 応答: yes
# スクリプト実行:
bash .claude/skills/git-worktree/scripts/worktree-manager.sh create pr-123-feature-name

# レビュー用の分離されたworktree内にいる
cd .worktrees/pr-123-feature-name

# レビュー後、mainに戻る:
cd ../..
bash .claude/skills/git-worktree/scripts/worktree-manager.sh cleanup
```

### 並行機能開発

```bash
# 最初の機能用:
bash .claude/skills/git-worktree/scripts/worktree-manager.sh create feature-login

# 後で、2番目の機能を開始:
bash .claude/skills/git-worktree/scripts/worktree-manager.sh create feature-notifications

# 持っているものを一覧表示:
bash .claude/skills/git-worktree/scripts/worktree-manager.sh list

# 必要に応じて切り替え:
bash .claude/skills/git-worktree/scripts/worktree-manager.sh switch feature-login

# mainに戻り、完了時にクリーンアップ:
cd .
bash .claude/skills/git-worktree/scripts/worktree-manager.sh cleanup
```

## 主要な設計原則

### KISS (Keep It Simple, Stupid)

- **1つのマネージャースクリプト**がすべてのworktree操作を処理
- 合理的なデフォルトを持つ**シンプルなコマンド**
- 偶発的な操作を防ぐ**インタラクティブなプロンプト**
- ブランチ名を直接使用する**明確な命名**

### 意見のあるデフォルト

- Worktreeは常に**main**から作成（指定されない限り）
- Worktreeは**.worktrees/**ディレクトリに保存
- ブランチ名がworktree名になる
- **.gitignore**は自動的に管理

### 安全第一

- worktree作成前に**確認**
- 偶発的な削除を防ぐためにクリーンアップ前に**確認**
- **現在のworktreeは削除しない**
- 問題に対する**明確なエラーメッセージ**

## ワークフローとの統合

### `/review`

常にworktreeを作成する代わりに：

```
1. 現在のブランチをチェック
2. すでにPRブランチにいる場合 → そこに留まる、worktree不要
3. 異なるブランチの場合 → worktreeを提案:
   "Use worktree for isolated review? (y/n)"
   - yes → git-worktreeスキルを呼び出す
   - no → 現在のブランチでPR diffを進める
```

### `/work`

常に選択を提供：

```
1. 尋ねる: "How do you want to work?
   1. New branch on current worktree (live work)
   2. Worktree (parallel work)"

2. 選択1の場合 → 通常通り新しいブランチを作成
3. 選択2の場合 → mainからworktreeを作成するgit-worktreeスキルを呼び出す
```

## トラブルシューティング

### "Worktree already exists"

これが表示された場合、スクリプトは代わりに切り替えるかどうかを尋ねる。

### "Cannot remove worktree: it is the current worktree"

まずworktreeから離れてからクリーンアップ：

```bash
cd /path/to/main/repo
bash .claude/skills/git-worktree/scripts/worktree-manager.sh cleanup
```

### Worktreeで迷った場合

現在地を確認：

```bash
bash .claude/skills/git-worktree/scripts/worktree-manager.sh list
```

mainに戻る：

```bash
cd $(git rev-parse --show-toplevel)
```

### メインリポジトリのファイルを誤って編集

**予防**: ファイルパスは常にworktreeのフルパスを使用。作業前に`pwd`で確認。

## 技術詳細

### ディレクトリ構造

```
.worktrees/
├── feature-login/          # Worktree 1
│   ├── .git
│   ├── app/
│   └── ...
├── feature-notifications/  # Worktree 2
│   ├── .git
│   ├── app/
│   └── ...
└── ...

.gitignore (.worktreesを含むように更新)
```

### 仕組み

- 分離環境のために`git worktree add`を使用
- 各worktreeには独自のブランチがある
- 1つのworktreeの変更は他に影響しない
- メインリポジトリとgit履歴を共有
- どのworktreeからもプッシュ可能

### パフォーマンス

- Worktreeは軽量（ファイルシステムリンクのみ）
- リポジトリの複製なし
- 効率のためにgitオブジェクトを共有
- クローンやstash/スイッチよりもはるかに高速
