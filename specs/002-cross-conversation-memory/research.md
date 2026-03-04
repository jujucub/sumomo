# Research: チャネル横断メモリシステム

**Date**: 2026-02-21
**Feature**: 002-cross-conversation-memory

## 1. タスク実行パイプラインの統合ポイント

### Decision: メモリ読み書きの挿入箇所

**選択**: タスク処理パイプライン内の Claude CLI 実行前後に統合する

**根拠**:
- `index.ts` の `ProcessNextTask()` が全タスクのオーケストレーションを担う
- Claude CLI 実行前: `promptWithContext` 構築後、
  `_claudeRunner.Run()` 呼び出し前にメモリコンテキストを注入
- Claude CLI 実行後: `RecordTaskCompletion()` 直後に
  メモリ更新処理を実行
- 4箇所の `_claudeRunner.Run()` 呼び出し
  （Slack直接、Slackイシュースレッド、Slackターゲットリポ、GitHub）
  すべてに共通のメモリ注入ロジックを適用

**検討した代替案**:
- Claude CLI の system-prompt に直接注入 → プロンプト構築が
  runner.ts 内に分散し、関心の分離が崩れる
- MCP サーバーとしてメモリを公開 → 過剰な複雑性、
  現時点ではファイル読み込みで十分

### Decision: プロンプトへのメモリ注入方式

**選択**: 既存の `BuildSlackContext()` / `BuildGitHubContext()` パターンに
倣い、`BuildMemoryContext()` 関数を追加して
`promptWithContext` に結合する

**根拠**:
- 既存のコンテキスト構築パターンと一貫性がある
- system-prompt ではなく user prompt の末尾に追加することで、
  メモリ内容がタスクのコンテキストとして自然に機能する
- `--system-prompt` パラメータは既に character.md で使用されており、
  競合を避ける

**検討した代替案**:
- system-prompt への注入 → 既存の character.md と競合
- 別途 MCP リソースとして公開 → 現時点では過剰

## 2. メモリルーティング方式

### Decision: LLM ベースのプロジェクト分類

**選択**: Claude CLI を軽量プロンプトで呼び出し、
構造化 JSON 出力でプロジェクトを分類する

**根拠**:
- 既存の `reflection/engine.ts` が同様のパターン
  （LLM に構造化出力を要求し JSON をパース）を実装済み
- プロジェクト一覧が動的に変化するため、
  ルールベースやキーワードマッチでは不十分
- 100 件のプロジェクトでもカタログは約 3,000 トークンで収まり、
  単一 API コールで処理可能

**検討した代替案**:
- キーワードマッチング → 日本語の多義性に弱く、精度不足
- ベクトル埋め込み検索 → 外部依存が増え、
  ファイルベースシステムとの整合性が低い
- 二段階検索（事前フィルタ + LLM）→ 100 件程度では不要、
  将来のスケール時に検討

### Decision: プロジェクトカタログ形式

**選択**: MEMORY.md のブロック引用行から抽出した
コンパクトな番号付きリスト形式

**根拠**:
- 1 プロジェクトあたり約 30 トークンで効率的
- MEMORY.md に規約化された記述位置（ブロック引用行）から
  自動抽出が容易
- LLM が番号付きリストを正確に参照できる

**カタログ例**:
```
1. **api-refactoring** - REST API設計の見直し、Express移行
2. **mobile-app-v2** - モバイルアプリ次期版、React Native
```

### Decision: 曖昧性への対処

**選択**: 3 段階の信頼度（high / medium / low）に基づく
段階的エスカレーション

**根拠**:
- high: 直接ルーティング（ユーザー介入なし）
- medium: ベストな推測でルーティングし、
  ロードしたプロジェクトを回答内で明示
- low: 新規プロジェクト作成、またはユーザーに確認
- 仕様のエッジケース（複数プロジェクトに該当しうる発言）に対応

## 3. メモリ概要化戦略

### Decision: 増分アンカード概要化

**選択**: MEMORY.md が閾値（コンテキストウィンドウの 10%）を超えた時、
LLM を使って古い情報を概要化し、60% まで圧縮する

**根拠**:
- 二重閾値モデル（圧縮トリガー / 圧縮後目標）により、
  毎回の追加で圧縮が走る問題を回避
- LLM ベースの概要化は事実と決定事項を保持しつつ
  会話の経緯を省略できる
- 概要化前のバックアップ（`MEMORY.md.bak.{timestamp}`、
  直近 3 件保持）で FR-013 の非破壊更新を実現

**圧縮対象外**:
- `pinned.md` に記載された項目（ユーザー明示指示）
- 7 日以内のエントリ（新鮮度保護）
- `[PINNED]` タグ付きエントリ

**検討した代替案**:
- 時間ベースの自動削除 → 重要な決定事項が失われるリスク
- 全件 LLM リライト → コスト高、毎回の圧縮が重い
- 手動概要化 → ユーザー負担が大きく非現実的

## 4. ファイル構造と命名規則

### Decision: プロジェクトディレクトリ構造

**選択**:
```
~/.claps/memory/projects/{project-name}/
  MEMORY.md                    # 目次・概要（コンテキストにロード）
  pinned.md                    # 固定記憶（概要化対象外）
  decisions.md                 # 技術的決定事項の記録
  timeline.md                  # 時系列イベントログ（概要化対象）
  detail-{topic}.md            # トピック別詳細ファイル
  MEMORY.md.bak.{timestamp}    # 概要化前バックアップ（直近3件）
```

**根拠**:
- Claude Code 自身の MEMORY.md パターンに準拠
- `pinned.md` を独立ファイルにすることで
  概要化処理から確実に除外
- `decisions.md` は技術的決定の追跡に特化
  （プロジェクト固有の ADR 的役割）
- `timeline.md` は時系列ログとして
  概要化の主要対象

### Decision: プロジェクト名の命名規則

**選択**: kebab-case、ASCII のみ、人間が判読可能

**根拠**:
- 既存の `history/store.ts` の
  `name.replace(/[^a-zA-Z0-9_-]/g, '_')` パターンと一貫性
- ファイルシステムの互換性を確保
- ルーティング LLM への指示で明示的に kebab-case を要求

## 5. 既存コードベースとの統合パターン

### Decision: モジュール構成

**選択**: `src/memory/` ディレクトリに 4 モジュールを配置

**根拠**:
- `router.ts` — LLM ベースのプロジェクト分類
- `store.ts` — メモリファイルの CRUD 操作
- `summarizer.ts` — 概要化・圧縮処理
- `injector.ts` — プロンプトへのメモリ注入

**パターン準拠**:
- シングルトンパターン（`GetMemoryStore()` 等）は
  `session/store.ts`、`history/store.ts` と同様
- ファイル I/O は `fs.writeFileSync` + `fs.readFileSync`
  （mode 0o600）で既存パターンに準拠
- 設定は `Config` インターフェースに `memoryConfig` を追加

### Decision: 型定義パターン

**選択**: 既存の readonly プロパティ + 判別共用体パターンに準拠

**根拠**:
- `WorkHistoryRecord` の拡張ではなく、
  専用の `MemoryEvent` 型を定義して履歴ストアに記録
- `MemoryRoutingResult` 型でルーティング結果を型安全に表現
- `ProjectMemory` 型でメモリの構造を定義

## 6. 観測可能性の統合

### Decision: 既存 WorkHistoryRecord への統合

**選択**: `WorkHistoryRecord` に任意のメモリイベントフィールドを追加し、
既存の JSONL 履歴ストアに統合記録する

**根拠**:
- 内省エンジンが単一のデータソースから
  メモリ活動を分析できる
- 新たな永続化インフラが不要
- 既存の日次振り返りフローに自然に組み込まれる

**検討した代替案**:
- 専用ログファイル → 内省エンジンとの統合が複雑になる
- 構造化ログ出力 → 既存パターンとの一貫性が低い
