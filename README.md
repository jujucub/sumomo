# sumomo 🍑

GitHub Issue / Slack 連携 Claude 自動対応システム

## これは何？

`[sumomo]` タグを付けるだけで、Claude が自動でコード修正・PR作成を行うBotです。

- **GitHub Issue** に `[sumomo]` タグ → Issue を分析してコード修正、PR作成
- **Slack** で `@sumomo` → 指示に従ってタスク実行
- **危険な操作** → Slack モーダルで承認を求める（コメント入力可）
- **判断が必要な時** → Slack で質問してくる

## 主な機能

| 機能 | 説明 |
|------|------|
| **worktree分離** | Issue毎に独立したworktreeで作業、メインブランチに影響なし |
| **自動PR作成** | 作業完了後に自動でコミット・プッシュ・PR作成 |
| **tmux制御** | Claude CLIを対話モードで実行、権限制御も可能 |
| **Slackスレッド** | Issue処理の進捗をスレッドでリアルタイム通知 |
| **モーダル承認** | 許可/拒否時にコメント入力可能 |

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

# ビルド
npm run build

# 起動
npm start
```

## 必要な環境

- **Node.js** 18+
- **Claude CLI** インストール済み
- **tmux** インストール済み
- **Git** 2.20+ (worktree機能)
- **GitHub CLI (gh)** インストール済み

## 必要な認証情報

| 項目 | 取得方法 |
|------|---------|
| `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com/) |
| `SLACK_BOT_TOKEN` | Slack App 設定 (xoxb-...) |
| `SLACK_APP_TOKEN` | Slack App 設定 - Socket Mode (xapp-...) |
| `SLACK_CHANNEL_ID` | 通知先チャンネルID |
| `GITHUB_TOKEN` | GitHub Settings > Developer settings |
| `GITHUB_OWNER` | リポジトリオーナー名 |
| `GITHUB_REPO` | リポジトリ名 |
| `APPROVAL_SERVER_PORT` | 承認サーバーポート (デフォルト: 3001) |

## 使い方

### GitHub Issue から自動対応

1. Issue を作成
2. タイトルまたは本文に `[sumomo]` を含める
3. sumomo が自動検知して処理開始
4. 完了後、PRが自動作成される

```markdown
# Issue タイトル例
[sumomo] ログイン画面のバグを修正

# Issue 本文例
ログインボタンが反応しない問題を修正してください。
```

### Slack から指示

```
@sumomo このファイルのテストを書いて
```

## ドキュメント

- [設計書](./docs/DESIGN.md) - システム構成、処理フロー、実装詳細

## ライセンス

MIT

Hello
