## Melos 実装確認フェーズ

**PRD**: @PRD.md
**Progress file**: @{PROGRESS_FILE}

---

## 目的

PRD.md に記載された要件が全て実装されているかを確認する。

## 確認項目

1. PRD.md に明記された機能要件が全て実装されているか
2. 基本的な動作が期待通りか
3. 明らかな不足がないか

## 確認方法

1. PRD.md を読み込む
2. 各機能要件について、実装状況を確認
3. コードベースを調査して実装を検証
4. テストが存在する場合は実行して確認

## 出力フォーマット

### 全て実装済みの場合:
<promise>VERIFICATION_PASS</promise>

### 未実装がある場合:
<promise>VERIFICATION_FAIL</promise>
<verification_issues>
- [未実装要件1]: 説明
- [未実装要件2]: 説明
</verification_issues>

## 注意事項

- 厳密すぎる判定は避ける（完璧主義にならない）
- 明らかな不足のみを指摘
- コードスタイルや最適化は判定対象外
