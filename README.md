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
| `--model <model>` | 共通モデル候補（`manager.*` / `worker.*` が優先） | - |
| `--max-iterations <n>` | 最大イテレーション数（1〜1000） | `30` |
| `--effort <level>` | Claude effort レベル（`low` / `medium` / `high` / `max`） | `max` |
| `--reasoning-effort <level>` | Codex 推論努力レベル（`minimal` / `low` / `medium` / `high` / `xhigh`） | - |
| `--thinking-budget <n>` | Claude thinking budget（旧モデル向け、1024〜31999） | - |
| `--dry-run` | ドライラン（計画のみ、Worker 実行しない） | - |
| `--plain` | プレーン出力モード（スピナー無効） | - |
| `-v, --version` | バージョンを表示 | - |
| `-h, --help` | ヘルプを表示 | - |

## 設定ファイル（`.melos.json`）

プロジェクトルートに `.melos.json` を配置することで、デフォルト設定をカスタマイズできます。

### スキーマ

```json
{
  "model": "opus",
  "maxIterations": 30,
  "manager": {
    "model": "sonnet",
    "effort": "high"
  },
  "worker": {
    "model": "gpt-5.3-codex",
    "effort": "high"
  }
}
```

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `model` | `string` | Manager/Worker 共通のモデル候補（`manager.*` / `worker.*` が優先） |
| `maxIterations` | `number` | 最大イテレーション数（1〜1000） |
| `manager.model` | `string` | Manager モデル名（`model` より優先） |
| `manager.effort` | `string` | Claude effort レベル（`low` / `medium` / `high` / `max`） |
| `worker.model` | `string` | Worker モデル名（`model` より優先） |
| `worker.effort` | `string` | Codex effort レベル（`minimal` / `low` / `medium` / `high` / `xhigh`） |

### 優先順位

CLI オプション > `.melos.json` の個別設定（`manager.*` / `worker.*`） > `.melos.json` の `model` > デフォルト値

### 設定例

Manager に Claude Sonnet、Worker に Codex を使う場合：

```json
{
  "manager": {
    "model": "sonnet",
    "effort": "high"
  },
  "worker": {
    "model": "gpt-5.3-codex",
    "effort": "high"
  }
}
```

全体のデフォルトモデルのみ指定する場合：

```json
{
  "model": "opus"
}
```

## 実行例

### デフォルト設定で実行

```bash
npx melos
```

### モデルを指定して実行

```bash
npx melos --model opus
```

### ドライランで計画のみ確認

```bash
npx melos --dry-run
```

## ファイル構成

Melos は以下のファイルを使用します：

- **PLAN.json**: タスク定義ファイル
- **PRD.md**: 要件定義・受入基準
- **PROGRESS.md**: 進捗ログ
- **.melos.json**: プロジェクト設定ファイル（オプション）

## 関連スキル

- `/melos-add-task`: 自然言語でタスクを追加する Claude Code スキル
- `/handoff-next-task`: HANDOFF.md の有無に応じて次タスクを継続実行するスキル
