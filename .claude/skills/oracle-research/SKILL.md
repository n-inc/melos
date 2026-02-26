---
name: oracle-research
description: >-
  ChatGPT Pro（GPT-5 Pro等）にリサーチを委託するスキル。
  意思決定に必要な情報を幅広く深く集めるリサーチエンジンとして使う。
  ベストプラクティス調査、深い専門知識が必要な調査、ハルシネーション最小化が重要な場合に使用。
  「ChatGPTに聞いて」「Oracleで調べて」「深く調査して」などのリクエストで起動。
argument-hint: "[リサーチトピック]"
---

# Oracle Research（ChatGPT Pro 委託リサーチ）

ChatGPT Pro（GPT-5 Pro 等）にリサーチを委託する。ChatGPT Pro は意思決定するためではなく、意思決定に必要な情報を幅広く深く集めるリサーチエンジンとして使う。

ChatGPT Pro には時間をかけた徹底的な調査を求める。表面的な概要ではなく、網羅的に掘り下げ、可能な限り多くの関連情報・事例・データポイントを収集させる。事例は幅広く調べ、できるだけ多く提示させる。

出力に求めるのは「〇〇すべき」という推奨ではなく、「こういう事実・事例・データがある」というファクト。その上で構造的な分析やインサイトは含めてよい。

## いつ使うか

- ベストプラクティスの調査（最適解を見つける必要があるとき）
- 深い専門知識が必要な調査（正確性と網羅性が重要なとき）
- ハルシネーションを最小化したい調査（事実の正確性が最重要なとき）
- 戦略検討に必要な市場情報・競合情報の収集

エージェント自身の検索（web-research, x-research）で十分な場合はこのスキルを使わない。

## ワークフロー

### Step 1: コンテキスト収集

リサーチテーマに関連する情報をプロジェクト内から収集する。

- PROGRESS.md、PRD.md から現状と過去の決定事項を把握
- 関連ファイルの内容を読み込む
- 必要なコードスニペットやデータを抽出

### Step 2: 対話で詳細を詰める

AskUserQuestion を使って、プロンプト構成に必要な情報を確認する。

確認すべきポイント:
- 調査の目的（何を知りたいか、何の判断材料にするか）
- 調査の範囲（どこまで深く、どの領域を含めるか）
- 特に知りたい情報の種類（統計、事例、比較、トレンド等）
- 出力形式の希望があれば

すべてを毎回聞く必要はない。コンテキストから明らかなものは省略し、曖昧な点だけ確認する。

### Step 3: プロンプト構成

ChatGPT が単体で理解できる自己完結的なプロンプトを構成する。品質チェックリストに沿って構成する。

### Step 4: クリップボードにコピー

`oracle_prompt.py` スクリプトを使って、プロンプト本文と参照ファイルを結合してクリップボードにコピーする。

```bash
python3 .claude/skills/oracle-research/scripts/oracle_prompt.py \
  --files PROGRESS.md PRD.md [その他関連ファイル] \
  --prompt "プロンプト本文（参照ファイルの内容を除いた部分）"
```

**重要**: プロンプト本文にファイル内容をインラインで含めない。参照したいファイルは `--files` で指定する。スクリプトが `<reference-file>` タグで自動的に付与する。

オプション:
- `--files`: 参照ファイルのパス（必須）。シェルのグロブ展開可（例: `src/ui/*.ts`）
- `--prompt`: プロンプト本文。省略時は stdin から読む（heredoc で渡す場合に便利）
- `--save DIR`: 構成済みプロンプトを保存（監査用）。通常は不要
- `--no-copy`: クリップボードにコピーせず stdout に出力（確認用）
- `--dry-run`: ファイル一覧とサイズのみ表示

ユーザーに以下を伝える:
- プロンプトがクリップボードにコピーされたこと
- ChatGPT で `Cmd+V` で貼り付けるよう案内
- 回答を共有してもらうよう依頼

### Step 5: 回答の活用

ユーザーが ChatGPT の回答を共有したら:
- 回答内容を現在のタスクに適用する
- 得られた知見で MEMORY.md に記録すべきものがあれば記録する
- 必要に応じて web-research で裏取りする

## プロンプト品質チェックリスト

プロンプト構成時に以下を満たしているか確認する。

### 必須要素

| 要素 | 説明 |
|---|---|
| 調査目的 | 何を知りたいか、何の判断に使うか |
| 調査対象 | 誰・何について調査するか |
| 必要な情報 | 統計、事例、比較、トレンド等の種類 |
| 調査範囲 | 公式ソース、ソーシャルメディア（Reddit, X 等）、業界レポート等 |
| 出力形式 | 詳細レポート、比較表、リスト等。事例は幅広く、できるだけ多く |

### 原則

- **自己完結的**: ファイルパスや外部参照を使わない。必要な情報はすべてインラインで含める
- **英語で検索を指示**: 英語圏の情報の方が質が高い。プロンプト内で "Search in English" を明記する。日本語検索は日本市場調査等、日本語でないと得られない情報に限定
- **ファクトベース＋インサイト**: 事実・データ・事例を求め、その上で構造的な分析やインサイトを含める。「〇〇すべき」という推奨は求めない
- **ソース要求**: 主張にはソース・出典を付けるよう明示
- **徹底的な調査**: 時間をかけた網羅的な調査を明示的に指示する。「Take your time」「exhaustive」「as many as possible」等の表現で、表面的な回答ではなく深掘りを求める。事例は幅広く調べ、できるだけ多く提示させる
- **多様なソース**: 公式レポート、学術論文、業界分析、ブログ記事、ソーシャルメディア（Reddit, X, HackerNews）を横断的にカバーするよう指示
- **具体性**: 「調べて」ではなく「X について Y の観点から Z の形式で」のように具体的に指定

### プロンプトテンプレート

```
# [調査タイトル]

## Background
[プロジェクトの背景、現状をインラインで記述]

## Research Objective
[何を知りたいか、何の判断に使うか]

## Research Areas
[調査してほしい領域を具体的にリストアップ]

### 1. [領域1]
- [具体的に知りたいこと]
- [具体的に知りたいこと]

### 2. [領域2]
...

## Research Guidelines
- Take your time. Conduct a thorough, exhaustive investigation — depth and breadth matter more than speed
- Search in English for better quality sources (use Japanese only for Japan-specific market data)
- Provide sources/references for all claims and data points
- Gather as many concrete examples and case studies as possible — the more the better
- Cover diverse source types: official reports, academic papers, industry analyses, blog posts, and social media (Reddit, X/Twitter, HackerNews) for practitioner insights
- When investigating a topic, go beyond the first page of results — dig into less obvious but potentially valuable sources

## Output Format
- Detailed report in Japanese
- Be as detailed and comprehensive as possible — do not summarize where elaboration would be more useful
- Fact-based with structural analysis and insights
- Do NOT include prescriptive recommendations ("you should do X")
- Instead, present facts, patterns, and analysis that inform decision-making
```
