# Melos CLI v0.8.0

Melos は MissionPlan 状態機械を中心に、長時間の自律実行を管理する CLI です。
`TASK.json` は v2 MissionPlan（`mission > milestones > features`）を唯一の実行ソースとして扱います。

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
- `--planner-model <model>` / `--worker-model <model>` / `--validator-model <model>` / `--research-model <model>`
- `--dry-run`: 実装を実行せず状態遷移のみ確認

再開:

```bash
npx melos resume
```

停止:

```bash
npx melos kill
```

## 状態管理

`.melos/` 配下に以下を保存します。

- `events.jsonl`: 追記専用イベントログ
- `state.json`: スナップショット
- `git-strategy.json`: ブランチ状態
- `validations/*.json`: milestone validation レポート
- `RUN.json`: 実行中プロセス情報

## 設定 (`.melos.json`)

```json
{
  "maxIterations": 400,
  "models": {
    "planner": "opus",
    "worker": "gpt-5.3-codex",
    "validator": "gpt-5.3-codex",
    "research": "opus"
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
