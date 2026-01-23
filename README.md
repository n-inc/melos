# Melos CLI

Melos は自律的なエージェントループシステムです。PLAN.json に定義されたタスクを順次実行し、PRD.md の受入基準に従って検証を行います。

## 前提

- Bun がインストール済みであること（CLI の実行に使用）

## インストール

```bash
cd scripts/melos
npm install
```

## 基本的な使い方

### plan モード（デフォルト）

PLAN.json のタスクを順次実行します。

```bash
npx melos
```

### watch モード

PLAN.json を監視し、新しいタスクが追加されると自動的に Melos ループを開始します。

```bash
npx melos watch
```

## オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--engine <engine>` | エンジン選択（`claude` または `codex`） | `claude` |
| `--max-iterations <n>` | 最大イテレーション数（1〜1000） | モードによる |
| `--hitl` | 対話モード（1イテレーションずつ実行） | `false` |
| `--pr-fix` | PR 対応モード（5イテレーション） | - |
| `--review-fix` | レビュー修正モード（5イテレーション） | - |
| `-v, --version` | バージョンを表示 | - |
| `-h, --help` | ヘルプを表示 | - |

## 実行例

### Claude エンジンで実行

```bash
npx melos --engine claude
```

### Codex エンジンで10イテレーション実行

```bash
npx melos --engine codex --max-iterations 10
```

### 対話モードで動作確認

```bash
npx melos --hitl
```

### PR 対応モード

```bash
npx melos --pr-fix
```

## ファイル構成

Melos は以下のファイルを使用します：

- **PLAN.json**: タスク定義ファイル
- **PRD.md**: 要件定義・受入基準
- **PROGRESS.md**: 進捗ログ

## 関連スキル

- `/melos-add-task`: 自然言語でタスクを追加する Claude Code スキル
