# sumomo 🍑

GitHub Issue / Slack 連携 Claude 自動対応システム

## これは何？

`@sumomo` とメンションするだけで、Claude が自動でコード修正・PR作成を行うBotです。

- **GitHub Issue** に `@sumomo` → Issue を分析してコード修正、PR作成
- **Slack** で `@sumomo` → 指示に従ってタスク実行
- **危険な操作** → Slack で承認を求める
- **判断が必要な時** → Slack で質問してくる

## 名前の由来

CLAMPの漫画「ちょびっツ」に登場するモバイルパソコン「すもも」から。
小さいけど一生懸命働くイメージ。

## クイックスタート

```bash
# 依存インストール
npm install

# 環境変数設定
cp .env.example .env
# .env を編集して認証情報を設定

# 起動
npm start
```

## 必要な認証情報

| 項目 | 取得方法 |
|------|---------|
| `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com/) |
| `SLACK_BOT_TOKEN` | Slack App 設定 |
| `SLACK_APP_TOKEN` | Slack App 設定 (Socket Mode) |
| `GITHUB_TOKEN` | GitHub Settings > Developer settings |

## ドキュメント

- [設計書](./docs/DESIGN.md) - システム構成、処理フロー、実装詳細

## ライセンス

MIT

Hello
