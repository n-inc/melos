---
name: release
description: バージョンを上げてpackage.jsonを更新し、コミット・タグ作成・プッシュしてリリースワークフローをトリガーする。通常は0.0.1、大きなリリースは0.1.0上げる。
---

# Release

## 概要

このスキルは、セマンティックバージョニングに従ってバージョンを上げ、package.jsonを更新し、コミット・タグ作成・プッシュまでを一連で実行してリリースワークフローをトリガーする。

このスキルを使用する場面：
- 新しいバージョンをリリースしたい
- GitHub Packagesにパッケージを公開したい

## 実行手順

### 1. 現在の状態を確認

現在のバージョンと未コミットの変更を確認：

```bash
cat package.json | jq -r '.version'
git status --short
git log --oneline -5
```

### 2. バージョンの決定

現在のバージョンをユーザーに提示し、次のバージョンを確認する。

**バージョンアップの目安：**
- **patch (0.0.1)**: バグ修正、小さな改善、ドキュメント更新
- **minor (0.1.0)**: 新機能追加、後方互換性のある変更
- **major (1.0.0)**: 破壊的変更、大幅なAPI変更

直近のコミット履歴を見て、変更内容に基づいてpatchかminorかを提案する。ユーザーに確認してから進める。

### 3. package.jsonのバージョン更新

```bash
npm version <patch|minor|major> --no-git-tag-version
```

または、Editツールでpackage.jsonのversionフィールドを直接更新。

### 4. 変更をコミット

```bash
git add package.json
git commit -m "$(cat <<'EOF'
chore: Bump version to X.Y.Z
EOF
)"
```

### 5. タグの作成とプッシュ

```bash
VERSION=$(cat package.json | jq -r '.version')
git tag "v${VERSION}"
git push origin HEAD "v${VERSION}"
```

### 6. 結果の報告

以下の情報を報告：
- 旧バージョン → 新バージョン
- 作成したタグ名
- プッシュ先のリモート
- GitHub ActionsのURL

#### 出力例

```
✅ リリース完了
バージョン: 0.1.1 → 0.1.2
タグ: v0.1.2

GitHub Actionsのpublishワークフローがトリガーされました。
進捗: https://github.com/{owner}/{repo}/actions
```

## 注意事項

### 未コミットの変更がある場合

`git status` で未コミットの変更がある場合は、先にコミットするか、変更を stash するよう促す。

### タグが既に存在する場合

同じバージョンのタグが既に存在する場合は、バージョンを再度上げる必要がある。

### mainブランチでの実行を推奨

リリースは通常mainブランチから行う。他のブランチにいる場合は確認を求める。
