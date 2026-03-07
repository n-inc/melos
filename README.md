# Melos CLI v0.8.0

Melos は MissionPlan 状態機械を中心に、長時間の自律実行を管理する CLI です。
`TASK.json` は v3 MissionPlan（`mission > milestones > features`）を唯一の実行ソースとして扱います。

## セットアップ

```bash
npm install
```

## 実行

```bash
npx melos run
```

主要オプション:

- `--interactive`: 対話型 planning
- `--auto-approve`: plan 承認を自動化
- `--git-strategy`: feature branch ハンドオフを有効化
- `--base-branch <branch>`: Git 戦略のベースブランチ
- `--mission-id <id>`: ミッションID
- `--planner-model <model>` / `--worker-model <model>`
- `--dry-run`: 実装を実行せず状態遷移のみ確認

再開:

```bash
npx melos resume
```

停止:

```bash
npx melos kill
```

## Headless Agent Runtime

TUI を使わず、エージェント/スクリプトから監視・承認・停止する場合は `--headless` を使います。

起動（バックグラウンド実行）:

```bash
npx melos run --headless --detach
```

再開（バックグラウンド実行）:

```bash
npx melos resume --headless --detach
```

状態取得（JSON標準 / `--plain` は補助表示）:

```bash
npx melos status
npx melos status --plain
```

ログ取得（差分監視は `--after-seq` 推奨）:

```bash
npx melos logs --after-seq 120
npx melos logs --tail 50 --actor worker
npx melos logs --plain
```

承認待ち制御:

```bash
npx melos approve
npx melos reject
```

停止:

```bash
npx melos cancel
```

## 状態管理

`.melos/` 配下に以下を保存します。

- `events.jsonl`: 追記専用イベントログ
- `state.json`: スナップショット
- `git-strategy.json`: ブランチ状態
- `validations/*.json`: milestone validation レポート
- `reviews/*.json`: final review レポート
- `RUN.json`: 実行中プロセス情報

## Git Hygiene

以下は実行時に生成されるローカル運用ファイルのため、コミット対象外です。

- `HANDOFF.md`
- `.melos/` 配下の全ファイル

## 設定 (`.melos.json`)

```json
{
  "maxIterations": 400,
  "models": {
    "planner": "codex-latest",
    "worker": "codex-latest"
  },
  "git": {
    "enabled": true,
    "baseBranch": "main",
    "autoPush": false,
    "preMergeValidation": true,
    "validationCommands": ["npm run typecheck", "npm test"]
  }
}
```
