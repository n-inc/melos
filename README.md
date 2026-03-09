# Melos CLI v0.8.0

Melos は MissionPlan 状態機械を中心に、長時間の自律実行を管理する CLI です。
`TASK.json` は v3 MissionPlan（`mission > milestones > features`）を唯一の実行ソースとして扱います。
milestone ごとの QA は `validationContract.qaChecks` に定義し、Melos が dedicated `qa` feature を自動生成して実行します。

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
- `--git-strategy`: Git repo 以外でも feature branch ハンドオフを強制的に有効化
- `--base-branch <branch>`: Git 戦略のベースブランチ（未指定時は現在の checkout branch、取得できない場合は `main`）
- `--mission-id <id>`: ミッションID
- `--planner-model <model>` / `--worker-model <model>`
- `--dry-run`: 実装を実行せず状態遷移のみ確認

Git 管理下のリポジトリでは、`--git-strategy` や `.melos.json` がなくても Git strategy がデフォルトで有効になります。
無効化したい場合は `.melos.json` で `git.enabled: false` を明示してください。

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

- `git.enabled`:
  - 未指定なら Git repo で自動有効
  - `false` を指定すると明示 opt-out
- `git.baseBranch`:
  - 未指定なら現在の checkout branch を使い、取得できない場合のみ `main` を使います
