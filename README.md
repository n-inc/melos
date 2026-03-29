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

route phase は単一モデルです。すべての phase は `task` と `on.pass` を持ち、validation が必要な phase だけ `validate` を追加します。

```ts
export default createRoute({
  run: { engine: 'auto' },
  limit: 12,
  workflow: {
    start: 'implement',
    phases: {
      implement: {
        task: '仕様に沿って実装する',
        on: { pass: { goto: 'designReview' } },
      },
      designReview: {
        task: 'デザインレビューを行う',
        validate: {
          llm: [
            'デザイン方針が要件に整合している',
            'UI/UX の破綻がない',
          ],
        },
        on: {
          pass: { goto: 'codeReview' },
          fail: { goto: 'implement' },
        },
      },
      codeReview: {
        task: 'コードレビューを行う',
        validate: {
          shell: ['npm test'],
          llm: ['実装が要件を満たしている'],
        },
        on: {
          pass: 'stop',
          fail: { goto: 'implement' },
        },
      },
    },
  },
});
```

`validate` は次の 3 系統です。

- `validate.shell`: shell command による検証
- `validate.llm`: LLM criteria による検証
- `validate.metrics`: metric 抽出と `thresholds` / `plateau` による検証

`next`, `check`, `pass`, `measure`, `until`, `plateau` の phase 直下指定は公開 route API から削除されました。

`review.path` は既定で `.melos/review-result.json`、`report.path` は既定で `.melos/final-report.json` を使います。保存先を変えたいときだけ指定してください。

`report` 自体も省略できます。省略時でも final report は既定で生成されて保存され、標準出力にも表示されます。標準出力だけ止めたい場合は `report: { stdout: false }` を指定してください。

## Runtime Artifacts

`cwd/.melos/` 配下に以下を保存します。

- `events.jsonl`
- `final-report.json`

標準 output の truth source は route 実行結果と `.melos/final-report.json` です。
