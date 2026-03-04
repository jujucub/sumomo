# Data Model: チャネル横断メモリシステム

**Date**: 2026-02-21
**Feature**: 002-cross-conversation-memory

## Entities

### MemoryCategory

記憶の内容に基づく階層分類を表すエンティティ。

| Field | Type | Description |
|-------|------|-------------|
| abstractCategory | `string` | 抽象カテゴリ名（例: `development`, `operations`） |
| concreteCategory | `string` | 具体カテゴリ名（例: `backend`, `frontend`） |

**バリデーション**: 各カテゴリ名は `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/` に適合

### ProjectMemory

プロジェクト単位のメモリ全体を表すエンティティ。
`~/.claps/memory/{abstractCategory}/{concreteCategory}/{projectName}/`
ディレクトリに対応する。

| Field | Type | Description |
|-------|------|-------------|
| projectName | `string` | プロジェクトの一意識別子。kebab-case、ASCII のみ |
| category | `MemoryCategory` | 所属するカテゴリ階層 |
| description | `string` | プロジェクトの一行概要（カタログ用） |
| createdAt | `string` (ISO 8601) | プロジェクトメモリの作成日時 |
| lastUpdatedAt | `string` (ISO 8601) | 最終更新日時 |
| memoryFilePath | `string` | MEMORY.md の絶対パス |
| pinnedFilePath | `string` | pinned.md の絶対パス |
| sessionMemoryFiles | `string[]` | MEMORY_<session_id>.md ファイルパス群 |

**一意性**: カテゴリパス + `projectName` の組み合わせでグローバルに一意
**バリデーション**: `projectName` は `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/` に適合

### MemoryEntry

MEMORY.md 内の個別記憶エントリ。

| Field | Type | Description |
|-------|------|-------------|
| timestamp | `string` (ISO 8601) | 記録日時 |
| content | `string` | 記憶内容のテキスト |
| source | `MemorySource` | 記憶の発生元情報 |
| isSummarized | `boolean` | 概要化済みかどうか |
| summarizedAt | `string \| null` | 概要化された日時 |

### SessionMemory

セッション単位のメモリファイル `MEMORY_<session_id>.md` を表す。
Claude CLI のセッション ID と対応し、
任意のチャネルからセッションを復帰可能にする。

| Field | Type | Description |
|-------|------|-------------|
| sessionId | `string` | Claude CLI のセッション ID |
| projectName | `string` | 所属プロジェクト名 |
| filePath | `string` | `MEMORY_<session_id>.md` の絶対パス |
| createdAt | `string` (ISO 8601) | セッションメモリの作成日時 |
| lastUpdatedAt | `string` (ISO 8601) | 最終更新日時 |
| platformInfo | `MemorySource` | セッション開始元のプラットフォーム情報 |
| content | `string` | 対話の経緯・コンテキスト |

**一意性**: `sessionId` はグローバルに一意

### PinnedEntry

pinned.md 内のユーザー明示指示による固定記憶。

| Field | Type | Description |
|-------|------|-------------|
| timestamp | `string` (ISO 8601) | 記録日時 |
| content | `string` | 固定記憶の内容 |
| originalPrompt | `string` | ユーザーの原文（「覚えておいて: ...」） |
| source | `MemorySource` | 記憶の発生元情報 |

### MemorySource

記憶の発生元を示す判別共用体。

```typescript
interface SlackMemorySource {
  readonly channel: 'slack';
  readonly channelId: string;
  readonly threadTs: string;
}

interface LineMemorySource {
  readonly channel: 'line';
  readonly groupId?: string;
  readonly replyToken?: string;
}

interface GitHubMemorySource {
  readonly channel: 'github';
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
}

type MemorySource = SlackMemorySource | LineMemorySource
  | GitHubMemorySource;
```

### MemoryRoutingResult

ルーティング機構の出力。

| Field | Type | Description |
|-------|------|-------------|
| primaryPath | `MemoryCategoryPath` | 主プロジェクトのフルパス |
| secondary | `MemoryCategoryPath[]` | 副次的に参照されたプロジェクトのパス |
| isNew | `boolean` | 新規プロジェクトかどうか |
| suggestedName | `string \| null` | 新規時の提案プロジェクト名 |
| suggestedCategory | `MemoryCategory \| null` | 新規時の提案カテゴリ |
| suggestedDescription | `string \| null` | 新規時の提案概要 |
| confidence | `'high' \| 'medium' \| 'low'` | 推定の信頼度 |
| reasoning | `string` | 判定理由（1 文） |
| pinnedContent | `string \| null` | LLMが抽出した固定記憶内容（記憶リクエストでなければ null） |

```typescript
interface MemoryCategoryPath {
  readonly abstractCategory: string;
  readonly concreteCategory: string;
  readonly projectName: string;
}
```

### MemoryEvent

作業履歴に記録されるメモリ操作イベント。

| Field | Type | Description |
|-------|------|-------------|
| type | `MemoryEventType` | イベント種別 |
| projectName | `string` | 対象プロジェクト名 |
| timestamp | `string` (ISO 8601) | イベント発生日時 |
| details | `string` | 操作の詳細（概要化前後のサイズ等） |

```typescript
type MemoryEventType = 'memory_created' | 'memory_updated'
  | 'memory_summarized' | 'memory_routed';
```

### MemoryConfig

メモリシステムの設定。

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| enabled | `boolean` | `true` | メモリシステムの有効化 |
| memoryDir | `string` | `~/.claps/memory` | メモリ格納ディレクトリ |
| maxMemoryFileSize | `number` | `15000` | MEMORY.md の最大文字数（概要化閾値） |
| compressionTarget | `number` | `0.6` | 概要化後の目標サイズ比率 |
| maxInjectionSize | `number` | `10000` | プロンプト注入時の最大文字数 |
| recencyProtectionDays | `number` | `7` | 概要化対象外とする直近日数 |
| maxBackups | `number` | `3` | 概要化バックアップの保持数 |

## Relationships

```
MemoryCategory 1---* ProjectMemory     (カテゴリ配下)
ProjectMemory 1---* SessionMemory      (MEMORY_<session_id>.md)
ProjectMemory 1---* MemoryEntry        (MEMORY.md 内)
ProjectMemory 1---* PinnedEntry        (pinned.md 内)
ProjectMemory 1---* DetailFile         (detail-*.md)
MemoryRoutingResult *---1 ProjectMemory (primaryPath)
MemoryRoutingResult *---* ProjectMemory (secondary)
MemoryEvent *---1 ProjectMemory        (projectName で参照)
```

## State Transitions

### ProjectMemory ライフサイクル

```
[存在しない] ---(ルーティングで新規作成)---> [アクティブ]
[アクティブ] ---(タスク完了時)---> [アクティブ] (更新)
[アクティブ] ---(閾値超過)---> [概要化中]
[概要化中] ---(概要化完了)---> [アクティブ]
[概要化中] ---(概要化失敗)---> [アクティブ] (バックアップから復元)
```

### MEMORY.md サイズ管理

```
サイズ < 閾値 ──── 通常運用（追記のみ）
    │
サイズ >= 閾値 ── 概要化トリガー
    │
    ├── バックアップ作成
    ├── 古いエントリを LLM で概要化
    ├── pinned / 7日以内のエントリは保護
    └── 目標サイズ（閾値の60%）まで圧縮
```

## File Structure on Disk

```
~/.claps/memory/
├── development/                        # 抽象カテゴリ
│   ├── backend/                        # 具体カテゴリ
│   │   └── auth-service/               # プロジェクト
│   │       ├── MEMORY.md               # 目次・概要 + Session ID 一覧
│   │       ├── MEMORY_abc123.md        # セッション別メモリ
│   │       ├── MEMORY_def456.md        # セッション別メモリ
│   │       ├── pinned.md               # 固定記憶（概要化対象外）
│   │       ├── decisions.md            # 技術的決定事項
│   │       ├── detail-jwt-design.md    # トピック別詳細
│   │       └── MEMORY.md.bak.1708500000
│   └── frontend/
│       └── dashboard-app/
│           ├── MEMORY.md
│           ├── MEMORY_ghi789.md
│           └── pinned.md
└── operations/
    └── infrastructure/
        └── monitoring-setup/
            ├── MEMORY.md
            └── MEMORY_jkl012.md
```

## MEMORY.md フォーマット規約

```markdown
# Project: {project-name}
> {one-line description for catalogue}

## 概要
{2-3 sentence summary of the project's current state}

## セッション
- [MEMORY_abc123.md](./MEMORY_abc123.md) - 認証フロー設計セッション
- [MEMORY_def456.md](./MEMORY_def456.md) - JWT実装セッション

## 重要事項
- {key fact 1}
- {key fact 2}

## 詳細ファイル
- [pinned.md](./pinned.md) - 固定記憶（概要化対象外）
- [decisions.md](./decisions.md) - 技術的決定事項

## 最近の活動
- [概要化: 2026-02-15] 過去のAPIレビュー議論の概要
- [2026-02-20] 認証方式をJWTに変更決定
- [2026-02-21] フロントエンドのログイン画面を実装

[最終更新: 2026-02-21]
```

## MEMORY_<session_id>.md フォーマット規約

```markdown
# Session: {session_id}
> {session description}

## セッション情報
- **Session ID**: {session_id}
- **開始日時**: {created_at}
- **開始チャネル**: {channel} ({channel_specific_id})
- **プロジェクト**: {project-name}

## 対話の経緯
- [2026-02-20] 認証方式についてJWT vs セッションベースを検討
- [2026-02-20] JWTに決定（理由: ステートレスでスケール容易）

## プラットフォーム固有情報
- Slack: channel=C04SJ5HPZ6W, thread_ts=1771657100.287169
- LINE: groupId=Cab123...

[最終更新: 2026-02-21]
```
