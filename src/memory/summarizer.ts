/**
 * claps - メモリサマライザー
 * 概要化・圧縮処理
 */

import type {
  MemoryCategoryPath,
  MemoryConfig,
  SummarizeResult,
} from '../types/index.js';
import { GetMemoryStore } from './store.js';
import { GetClaudeRunner } from '../claude/runner.js';
import { GetWorkspacePath } from '../git/repo.js';

/**
 * メモリサマライザークラス
 */
export class MemorySummarizer {
  private readonly _config: MemoryConfig;

  constructor(config: MemoryConfig) {
    this._config = config;
  }

  /**
   * 指定プロジェクトのメモリサイズが概要化閾値を超えているか判定する (T017)
   */
  ShouldSummarize(categoryPath: MemoryCategoryPath): boolean {
    const store = GetMemoryStore(this._config);
    const size = store.GetMemorySize(categoryPath);
    return size > this._config.maxMemoryFileSize;
  }

  /**
   * メモリを概要化する (T018, T019)
   */
  async Summarize(categoryPath: MemoryCategoryPath): Promise<SummarizeResult> {
    const store = GetMemoryStore(this._config);

    // 1. バックアップ作成
    let backupPath: string;
    try {
      backupPath = store.BackupMemory(categoryPath);
    } catch (error) {
      console.error('Memory summarization: Failed to create backup', error);
      return {
        success: false,
        originalSize: 0,
        newSize: 0,
        entriesSummarized: 0,
        entriesPreserved: 0,
        backupPath: '',
      };
    }

    try {
      // 2. メモリ内容を読み取る
      const memory = store.ReadMemory(categoryPath);
      if (!memory) {
        return {
          success: false,
          originalSize: 0,
          newSize: 0,
          entriesSummarized: 0,
          entriesPreserved: 0,
          backupPath,
        };
      }

      const originalSize = memory.totalSizeBytes;

      // 3. 保護対象エントリを分離 (T019)
      const protectionDaysAgo = new Date();
      protectionDaysAgo.setDate(protectionDaysAgo.getDate() - this._config.recencyProtectionDays);

      // セッションメモリを日付でフィルタ
      const recentSessions: string[] = [];
      const oldSessions: { sessionId: string; content: string }[] = [];

      for (const session of memory.sessionMemories) {
        const sessionDate = new Date(session.lastUpdatedAt);
        if (sessionDate > protectionDaysAgo) {
          recentSessions.push(session.sessionId);
        } else {
          oldSessions.push({ sessionId: session.sessionId, content: session.content });
        }
      }

      // 概要化対象のテキストを構築
      const contentToSummarize: string[] = [];
      let entriesSummarized = 0;

      // 古いセッションの内容を概要化対象に追加
      for (const session of oldSessions) {
        contentToSummarize.push(`### セッション ${session.sessionId}\n${session.content}`);
        entriesSummarized++;
      }

      // MEMORY.md の活動セクションから古いエントリを抽出
      const { protectedLines, oldLines } = this._separateMemoryEntries(
        memory.memoryContent,
        protectionDaysAgo
      );
      contentToSummarize.push(...oldLines);
      entriesSummarized += oldLines.length;

      if (contentToSummarize.length === 0) {
        console.log('Memory summarization: No content to summarize');
        return {
          success: true,
          originalSize,
          newSize: originalSize,
          entriesSummarized: 0,
          entriesPreserved: protectedLines.length + recentSessions.length,
          backupPath,
        };
      }

      // 4. LLM で概要化
      const targetSize = Math.floor(this._config.maxMemoryFileSize * this._config.compressionTarget);
      const summarized = await this._llmSummarize(
        contentToSummarize.join('\n\n'),
        targetSize
      );

      if (!summarized) {
        // 概要化失敗時はバックアップから復元
        console.error('Memory summarization: LLM summarization failed, restoring from backup');
        store.RestoreFromBackup(categoryPath, backupPath);
        return {
          success: false,
          originalSize,
          newSize: originalSize,
          entriesSummarized: 0,
          entriesPreserved: 0,
          backupPath,
        };
      }

      // 5. 新しい MEMORY.md を構築
      const newContent = this._buildSummarizedMemory(
        memory.memoryContent,
        summarized,
        protectedLines
      );

      // 6. 概要化済みセッションファイルを削除
      for (const session of oldSessions) {
        store.DeleteSessionFile(categoryPath, session.sessionId);
      }

      // 7. 書き戻し
      store.ReplaceMemoryContent(categoryPath, newContent);

      const newSize = Buffer.byteLength(newContent, 'utf-8');
      console.log(`Memory summarization: ${originalSize} -> ${newSize} bytes (${entriesSummarized} entries summarized)`);

      return {
        success: true,
        originalSize,
        newSize,
        entriesSummarized,
        entriesPreserved: protectedLines.length + recentSessions.length,
        backupPath,
      };
    } catch (error) {
      // 失敗時はバックアップから復元
      console.error('Memory summarization error, restoring from backup:', error);
      try {
        store.RestoreFromBackup(categoryPath, backupPath);
      } catch (restoreError) {
        console.error('Failed to restore from backup:', restoreError);
      }
      return {
        success: false,
        originalSize: 0,
        newSize: 0,
        entriesSummarized: 0,
        entriesPreserved: 0,
        backupPath,
      };
    }
  }

  /**
   * MEMORY.md のエントリを保護対象と概要化対象に分離する (T019)
   */
  private _separateMemoryEntries(
    content: string,
    protectionDate: Date
  ): { protectedLines: string[]; oldLines: string[] } {
    const protectedLines: string[] = [];
    const oldLines: string[] = [];

    // 「最近の活動」セクションのエントリを処理
    const activityMatch = content.match(/## 最近の活動\n([\s\S]*?)(?=\n## |\n\[最終更新:|\n$)/);
    if (activityMatch?.[1]) {
      const lines = activityMatch[1].split('\n').filter((l) => l.startsWith('- '));

      for (const line of lines) {
        // [PINNED] タグ付きエントリは保護
        if (line.includes('[PINNED]')) {
          protectedLines.push(line);
          continue;
        }

        // 日付を抽出してチェック
        const dateMatch = line.match(/\[(\d{4}-\d{2}-\d{2})\]/);
        if (dateMatch?.[1]) {
          const entryDate = new Date(dateMatch[1]);
          if (entryDate > protectionDate) {
            protectedLines.push(line);
          } else {
            oldLines.push(line);
          }
        } else {
          // 日付がない場合は保護対象
          protectedLines.push(line);
        }
      }
    }

    return { protectedLines, oldLines };
  }

  /**
   * LLM を使って内容を概要化する
   */
  private async _llmSummarize(content: string, targetSize: number): Promise<string | null> {
    const prompt = `以下のプロジェクトメモリの内容を概要化してください。

## 概要化ルール
- 主要な事実、決定事項、重要なイベントは保持してください
- 会話の経緯や冗長な説明は省略してください
- 目標サイズ: 約${targetSize}文字以内
- 概要化した内容は「## 概要化された記録」セクションとしてフォーマットしてください
- [PINNED] タグ付きのエントリは絶対に省略しないでください

## 概要化対象の内容
${content}

## 出力フォーマット
概要化された記録のみを出力してください。マークダウン形式で、箇条書きで簡潔にまとめてください。`;

    try {
      const claudeRunner = GetClaudeRunner();
      const result = await claudeRunner.Run(`memory-summarize-${Date.now()}`, prompt, {
        workingDirectory: GetWorkspacePath(),
        timeout: 60000,      // 60秒タイムアウト（概要化はルーティングより重い）
        maxTurns: 1,         // 1ターンで完了
        sanitizeEnv: true,   // Slack関連env変数を除外してMCPサーバーの不要な起動を防ぐ
      });

      if (result.success && result.output.trim()) {
        return result.output.trim();
      }
      return null;
    } catch (error) {
      console.error('LLM summarization failed:', error);
      return null;
    }
  }

  /**
   * 概要化後の新しい MEMORY.md を構築する
   */
  private _buildSummarizedMemory(
    originalContent: string,
    summarized: string,
    protectedLines: string[]
  ): string {
    const now = new Date().toISOString().split('T')[0]!;

    // ヘッダー部分を保持（# Project:, > description, ## 概要）
    const headerMatch = originalContent.match(/([\s\S]*?)(## セッション|## 重要事項|## 最近の活動)/);
    const header = headerMatch?.[1] ?? (originalContent.split('\n').slice(0, 5).join('\n') + '\n\n');

    // セッションセクションを保持（最新のもののみ）
    const sessionMatch = originalContent.match(/(## セッション[\s\S]*?)(?=\n## )/);
    const sessionSection = sessionMatch?.[1] ?? '## セッション\n';

    // 重要事項セクションを保持
    const importantMatch = originalContent.match(/(## 重要事項[\s\S]*?)(?=\n## )/);
    const importantSection = importantMatch?.[1] ?? '## 重要事項\n';

    // 詳細ファイルセクションを保持
    const detailMatch = originalContent.match(/(## 詳細ファイル[\s\S]*?)(?=\n## |\n\[最終更新:)/);
    const detailSection = detailMatch?.[1] ?? '## 詳細ファイル\n- [pinned.md](./pinned.md) - 固定記憶（概要化対象外）\n';

    // 新しい MEMORY.md を組み立て
    let newContent = header;
    newContent += sessionSection + '\n\n';
    newContent += importantSection + '\n\n';
    newContent += detailSection + '\n\n';
    newContent += '## 最近の活動\n';
    newContent += `- [概要化: ${now}] 過去の記録を概要化\n`;

    // 保護対象のエントリを追加
    for (const line of protectedLines) {
      newContent += line + '\n';
    }

    newContent += '\n## 概要化された記録\n';
    newContent += summarized + '\n';
    newContent += `\n[最終更新: ${now}]\n`;

    return newContent;
  }
}

// シングルトンインスタンス
let _instance: MemorySummarizer | undefined;

/**
 * メモリサマライザーのシングルトンインスタンスを取得する
 */
export function GetMemorySummarizer(config?: MemoryConfig): MemorySummarizer {
  if (!_instance) {
    if (!config) {
      throw new Error('MemorySummarizer requires config on first initialization');
    }
    _instance = new MemorySummarizer(config);
  }
  return _instance;
}
