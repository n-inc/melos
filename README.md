# Melos CLI

Melos は route module または single prompt を実行するための CLI です。

公開実行面は `melos run` と `melos route` です。

## Setup

```bash
npm install
```

## Usage

route を実行:

```bash
npx melos route ./path/to/route.ts
```

prompt を 1 回だけ実行:

```bash
npx melos run --prompt "この diff を要約して"
```

主なオプション:

- `route <path>`
- `--route <path>`
- `--prompt <text>`
- `--cwd <dir>`
- `--model <model>`
- `--effort <level>`
- `--output-format text|json|stream-json`
- `--no-ask`
- `--always-ask`

`context` は公開 API から削除されました。動的な prompt 文面が必要な場合は `task(ctx)` で組み立ててください。

`review.path` は既定で `.melos/review-result.json`、`report.path` は既定で `.melos/final-report.json` を使います。保存先を変えたいときだけ指定してください。

`report` 自体も省略できます。省略時でも final report は既定で生成されて保存され、標準出力にも表示されます。標準出力だけ止めたい場合は `report: { stdout: false }` を指定してください。

## Runtime Artifacts

`cwd/.melos/` 配下に以下を保存します。

- `events.jsonl`
- `final-report.json`

標準 output の truth source は route 実行結果と `.melos/final-report.json` です。
