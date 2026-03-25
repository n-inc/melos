# Melos CLI

Melos は route module または single prompt を実行するための CLI です。

公開実行面は `melos run` です。

## Setup

```bash
npm install
```

## Usage

route を実行:

```bash
npx melos run --route ./path/to/route.ts
```

prompt を 1 回だけ実行:

```bash
npx melos run --prompt "この diff を要約して"
```

主なオプション:

- `--route <path>`
- `--prompt <text>`
- `--cwd <dir>`
- `--model <model>`
- `--effort <level>`
- `--output-format text|json|stream-json`
- `--no-ask`
- `--always-ask`

## Runtime Artifacts

`cwd/.melos/` 配下に以下を保存します。

- `events.jsonl`
- `final-report.json`

標準 output の truth source は route 実行結果と `.melos/final-report.json` です。
