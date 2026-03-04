# Implementation Plan: チャネル横断メモリシステム

**Branch**: `002-cross-conversation-memory` | **Date**: 2026-02-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-cross-conversation-memory/spec.md`

## Summary

チャネル（Slack、LINE等）およびスレッドを横断して
プロジェクト単位の記憶を蓄積・参照する階層的メモリシステムを実装する。
記憶の内容に基づく「抽象カテゴリ → 具体カテゴリ → Project」の
階層構造、セッション単位のメモリファイル（`MEMORY_<session_id>.md`）
による Claude CLI セッション復帰、LLM ベースのルーティング、
および概要化によるコンテキストウィンドウ保護を
既存のタスク実行パイプラインに統合する。

## Technical Context

**Language/Version**: TypeScript 5.6+ / Node.js >= 20.0.0 (ESM, strict mode)
**Primary Dependencies**: @slack/bolt 4.1.0, @line/bot-sdk 10.6.0,
@octokit/rest 21.0.0, express 4.21.0, uuid 10.0.0
**Storage**: ローカルファイルシステム `~/.claps/memory/`、Markdown 形式
**Testing**: vitest（既存テストフレームワークに準拠）
**Target Platform**: Linux server (Node.js)
**Project Type**: single
**Performance Goals**: メモリルーティング + ロードが対話体験を阻害しない
応答時間（Claude CLI 呼び出し 1 回分以内）
**Constraints**: メモリファイル単体がコンテキストウィンドウの 10% 以下、
1 インスタンス = 1 ユーザー運用
**Scale/Scope**: 100+ プロジェクト、長期運用（概要化で容量制御）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 適合状況 | 根拠 |
|------|---------|------|
| I. チャネル非依存コア | ✅ 適合 | メモリモジュール (`src/memory/`) はコアパイプラインの一部として配置。チャネルアダプタからは独立して動作する |
| II. 承認優先実行 | ✅ 適合 | メモリの読み書きはファイル操作のみで、危険な操作（外部 API 変更等）を含まない。承認フローへの影響なし |
| III. チャネル横断セッション継続 | ✅ 適合 | セッション管理（短期）とメモリ（長期）が補完的に機能する設計 |
| IV. 拡張可能なチャネルインターフェース | ✅ 適合 | メモリシステムはチャネルアダプタに依存しない。新チャネル追加時もメモリ層の変更不要 |
| V. チャネル間統一セキュリティ | ✅ 適合 | メモリアクセスは既存の認証済みタスクパイプライン内でのみ発生。チャネルアダプタのセキュリティ制御を迂回しない |
| VI. 観測可能かつ監査可能な操作 | ✅ 適合 | メモリイベント（作成・更新・概要化・ルーティング）を WorkHistoryRecord に記録 |
| VII. 階層的メモリアーキテクチャ | ✅ 適合 | `~/.claps/memory/projects/{name}/MEMORY.md` の階層構造を実装。チャネル非依存 |
| VIII. メモリルーティングと探索性 | ✅ 適合 | LLM ベースのルーティング機構で既存プロジェクト走査、新規作成、横断参照を実現 |
| IX. コンテキスト管理とメモリライフサイクル | ✅ 適合 | 概要化（10% 閾値）、選択的保持（pinned.md）、コンテキスト注入量制御を実装 |

**ゲート判定**: 全原則に適合。Phase 0 進行可。

## Project Structure

### Documentation (this feature)

```text
specs/002-cross-conversation-memory/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── spec.md              # Feature specification
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── memory-api.md    # Internal API contracts
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── memory/
│   ├── router.ts        # MemoryRouter: LLMベースカテゴリ・プロジェクト分類
│   ├── store.ts         # MemoryStore: カテゴリ階層+セッション別CRUD操作
│   ├── summarizer.ts    # MemorySummarizer: 概要化・圧縮処理
│   └── injector.ts      # MemoryInjector: プロンプトへのメモリ注入
├── types/
│   └── index.ts         # 既存型定義にメモリ関連型を追加
├── index.ts             # メインオーケストレータ（統合ポイント）
├── claude/
│   └── runner.ts        # Claude CLI ランナー（変更なし）
├── history/
│   ├── recorder.ts      # メモリイベント記録の追加
│   └── store.ts         # 変更なし
├── session/
│   └── store.ts         # 変更なし（短期セッション継続）
└── (既存モジュール群)

tests/
├── unit/
│   ├── memory/
│   │   ├── router.test.ts
│   │   ├── store.test.ts
│   │   ├── summarizer.test.ts
│   │   └── injector.test.ts
│   └── (既存テスト群)
└── integration/
    ├── memory-pipeline.test.ts
    └── (既存テスト群)
```

**Structure Decision**: 既存の single project 構造を維持し、
`src/memory/` ディレクトリを新規追加する。
既存モジュール（`claude/`、`session/`、`history/`）は最小限の変更にとどめ、
メモリ固有のロジックはすべて `src/memory/` に集約する。

## Complexity Tracking

> 憲章違反なし。追跡不要。
