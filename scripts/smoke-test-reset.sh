#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SMOKE_TEST_DIR="$PROJECT_DIR/.smoke-test"

echo "🔄 Smoke Test リセット..."

# ディレクトリ作成
mkdir -p "$SMOKE_TEST_DIR"

# PRD.md 作成（存在しない場合）
if [ ! -f "$SMOKE_TEST_DIR/PRD.md" ]; then
  cat > "$SMOKE_TEST_DIR/PRD.md" << 'EOF'
# Smoke Test PRD

このタスクは正常終了することが目的です。

## 受入基準

- PLAN.json の passes を true に更新する
- <promise>COMPLETE</promise> を出力する
EOF
  echo "  Created PRD.md"
fi

# PLAN.json リセット
cat > "$SMOKE_TEST_DIR/PLAN.json" << 'EOF'
[
  {
    "id": "1",
    "description": "PLAN.jsonのpasses: trueに更新し、<promise>COMPLETE</promise>を出力する",
    "passes": false
  }
]
EOF
echo "  Reset PLAN.json"

# PROGRESS.md 削除（存在する場合）
if [ -f "$SMOKE_TEST_DIR/PROGRESS.md" ]; then
  rm "$SMOKE_TEST_DIR/PROGRESS.md"
  echo "  Removed PROGRESS.md"
fi

# STATUS.json 削除（存在する場合）
if [ -f "$SMOKE_TEST_DIR/STATUS.json" ]; then
  rm "$SMOKE_TEST_DIR/STATUS.json"
  echo "  Removed STATUS.json"
fi

# Git 初期化（存在しない場合）
if [ ! -d "$SMOKE_TEST_DIR/.git" ]; then
  cd "$SMOKE_TEST_DIR"
  git init -q
  git add -A
  git commit -q -m "Initial commit for smoke test"
  echo "  Initialized git repository"
fi

echo ""
echo "✅ リセット完了"
echo ""
echo "実行コマンド:"
echo "  cd .smoke-test && npx marathon --max-iterations 2"
