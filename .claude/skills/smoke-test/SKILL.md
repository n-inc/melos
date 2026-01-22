---
name: smoke-test
description: リリース前にMarathonが実際に動作することを確認する最小動作確認テスト。実際のClaude CLIを使用して約$0.02-0.03のコストで30-70秒で完了。
---

# Smoke Test

## 概要

このスキルは、リリース前に Marathon が実際に動作することを確認するための最小動作確認テストを実行する。

実際の Claude CLI を呼び出すため、API コスト（約 $0.02-0.03）が発生する。

## 実行手順

### 1. .smoke-test ディレクトリの準備

`.smoke-test/` ディレクトリが存在しない場合、作成してデフォルトの PRD と PLAN を配置する。

```bash
# ディレクトリ確認・作成
if [ ! -d ".smoke-test" ]; then
  mkdir -p .smoke-test
  echo "Created .smoke-test directory"
fi

# PRD.md の確認・作成
if [ ! -f ".smoke-test/PRD.md" ]; then
  cat > .smoke-test/PRD.md << 'PRDEOF'
# Smoke Test PRD

このタスクは正常終了することが目的です。

## 受入基準

- PLAN.json の passes を true に更新する
PRDEOF
  echo "Created .smoke-test/PRD.md"
fi

# PLAN.json の確認・作成
if [ ! -f ".smoke-test/PLAN.json" ]; then
  cat > .smoke-test/PLAN.json << 'PLANEOF'
[
  {
    "id": "1",
    "description": "PLAN.json の passes を true に更新する",
    "passes": false
  }
]
PLANEOF
  echo "Created .smoke-test/PLAN.json"
fi
```

### 2. Git リポジトリの初期化

`.smoke-test/` が Git リポジトリでない場合、初期化する。

```bash
cd .smoke-test
if [ ! -d ".git" ]; then
  git init
  git add -A
  git commit -m "Initial commit for smoke test"
  echo "Initialized git repository"
fi
cd ..
```

### 3. PLAN.json のリセット

テストを再実行可能にするため、PLAN.json の passes を false にリセットする。

```bash
# PLAN.json を読み込んで passes を false にリセット
cat > .smoke-test/PLAN.json << 'PLANEOF'
[
  {
    "id": "1",
    "description": "PLAN.json の passes を true に更新する",
    "passes": false
  }
]
PLANEOF
echo "Reset PLAN.json passes to false"
```

### 4. Marathon 実行

最小イテレーション（2回）で Marathon を実行する。

```bash
# .smoke-test/.marathon.json で model: haiku, maxIterations: 2 がデフォルト設定済み
cd .smoke-test && npx marathon
```

### 5. 結果の確認

実行結果を確認し、ユーザーに報告する。

- COMPLETE で終了 → 成功
- ESCALATE で終了 → 失敗（要調査）
- max_iterations で終了 → 失敗（COMPLETE が出力されなかった）

```bash
# PLAN.json の passes を確認
cat .smoke-test/PLAN.json | jq '.[0].passes'
```

## 出力例

### 成功時

```
✅ Smoke Test 成功

Marathon は正常に動作しています。
- 終了理由: COMPLETE
- PLAN.json passes: true
- 所要時間: 約45秒
- 推定コスト: ~$0.02

リリースを続行できます。
```

### 失敗時

```
❌ Smoke Test 失敗

Marathon の動作に問題があります。
- 終了理由: max_iterations
- PLAN.json passes: false

問題を調査してください:
- .smoke-test/PROGRESS.md を確認
- .smoke-test/STATUS.json を確認
```

## 注意事項

- `.smoke-test/` ディレクトリは `.gitignore` に追加されており、コミットされない
- 実際の Claude API を呼び出すため、コスト（約 $0.02-0.03/回）が発生する
- ネットワーク接続と Claude CLI の設定が必要
