# Melos CLI

Melos は自律的なエージェントループシステムです。TASK.json に定義されたタスクを順次実行し、PRD.md の受入基準に従って検証を行います。

## 前提

- Bun がインストール済みであること（CLI の実行に使用）

## インストール

```bash
cd scripts/melos
npm install
```

## 基本的な使い方

### plan モード（デフォルト）

TASK.json のタスクを順次実行します。
`TASK.json` が存在しない場合は、`PRD.md` を元に初期タスクを生成してから実行します。

```bash
npx melos
```

### watch モード

TASK.json を監視し、新しいタスクが追加されると自動的に Melos ループを開始します。

```bash
npx melos watch
```

### 外部停止（kill）

同一プロジェクト（同一 `cwd`）で実行中の Melos に `SIGTERM` を送信します。

```bash
npx melos kill
```

## オプション

| オプション | 説明 | デフォルト |
|-----------|------|-----------|
| `--model <model>` | 共通モデル候補（`manager.*` / `worker.*` が優先） | - |
| `--max-iterations <n>` | 最大イテレーション数（1〜1000） | `30` |
| `--effort <level>` | Claude effort レベル（`low` / `medium` / `high` / `max`） | `max` |
| `--reasoning-effort <level>` | Codex 推論努力レベル（`minimal` / `low` / `medium` / `high` / `xhigh`） | `high` |
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

- **TASK.json**: タスク定義ファイル
- **PRD.md**: 要件定義・受入基準
- **PROGRESS.md**: 進捗ログ
- **.melos.json**: プロジェクト設定ファイル（オプション）
- **.melos/RUN.json**: 実行中プロセス情報（`melos kill` が参照）

## Manager の責務

Manager は `TASK.json` を更新しながら、要件達成まで反復実行を管理します。

- Worker が `PARTIAL` / `FAILED` / `BLOCKED` の場合は、必要に応じて `TASK.json` を調整して再実行を継続する
- `reviewType: "product"` と `reviewType: "code"` を独立して完了管理する
- 最終レビューでは通常ケースに加えて、失敗しやすい条件や境界条件も確認する
- `TASK.json` の `task.model`（`claude` / `codex`）指定がある場合は最優先で従う
- `task.model` 未指定の実装・検証タスクは Codex を指定して扱う
- フロントエンド実装（UI デザイン、スタイリング、レイアウト調整）が主目的のタスクは `task.model: "claude"` を明示する
- `browser` を含む動作確認は実装から切り出し、`task.model: "claude"` を明示したブラウザ確認タスクとして扱う
- 状況に応じて `HANDOFF.md` を出力できる

詳細ルールは `prompts/manager.md` を参照してください。

## レビュータスクの自動追加

実装タスク（`reviewType` 未指定）がすべて完了すると、Melos は `TASK.json` に以下のレビュータスクを自動追加します。

- `reviewType: "product"`: PRD.md との整合性レビュー
- `reviewType: "code"`: 変更差分中心のコードレビュー

レビューで見つかった問題は `discoveredTasks` からフォローアップ実装タスクとして追加されます。  
フォローアップ完了後は次 generation の product/code レビューが再度自動追加されます。

## 関連スキル

- `/melos-add-task`: 自然言語でタスクを追加する Claude Code スキル
- `/handoff-next-task`: HANDOFF.md の有無に応じて次タスクを継続実行するスキル
