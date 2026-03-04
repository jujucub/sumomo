/**
 * claps - メモリインジェクター
 * プロンプトへのメモリ注入
 */

import type {
  MemoryConfig,
  MemoryRoutingResult,
} from '../types/index.js';
import { GetMemoryStore } from './store.js';

/**
 * メモリインジェクタークラス
 */
export class MemoryInjector {
  private readonly _config: MemoryConfig;

  constructor(config: MemoryConfig) {
    this._config = config;
  }

  /**
   * ルーティング結果に基づき、プロンプトに注入するメモリコンテキスト文字列を構築する
   */
  async BuildMemoryContext(routingResult: MemoryRoutingResult): Promise<string> {
    const store = GetMemoryStore(this._config);
    const maxSize = this._config.maxInjectionSize;
    let context = '';
    let currentSize = 0;

    // プライマリプロジェクトのメモリを読み込む
    const primaryMemory = store.ReadMemory(routingResult.primaryPath);
    if (primaryMemory) {
      // MEMORY.md の内容
      let primaryContent = `---\n## プロジェクトメモリ: ${primaryMemory.projectName}\n\n`;
      primaryContent += primaryMemory.memoryContent;

      // pinned.md の内容（あれば）
      if (primaryMemory.pinnedContent.trim()) {
        primaryContent += '\n### 固定記憶\n';
        primaryContent += primaryMemory.pinnedContent;
      }

      // 最新セッションの MEMORY_<session_id>.md を含める (T022: 直近N件で横断的な継続性)
      if (primaryMemory.sessionMemories.length > 0) {
        // 最終更新日時でソートして直近3件を取得
        const sortedSessions = [...primaryMemory.sessionMemories].sort(
          (a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime()
        );
        const recentSessions = sortedSessions.slice(0, 3);
        for (const session of recentSessions) {
          const sessionBlock = `\n### セッション (${session.sessionId})\n${session.content}\n`;
          if (currentSize + primaryContent.length + sessionBlock.length <= maxSize) {
            primaryContent += sessionBlock;
          } else {
            break; // サイズ制限に達したら残りのセッションはスキップ
          }
        }
      }

      primaryContent += '\n---\n';

      // サイズチェック
      if (currentSize + primaryContent.length <= maxSize) {
        context += primaryContent;
        currentSize += primaryContent.length;
      } else {
        // 収まらない場合は切り詰め
        const available = maxSize - currentSize;
        if (available > 100) {
          context += primaryContent.slice(0, available - 10) + '\n...(省略)\n---\n';
          currentSize = maxSize;
        }
      }
    }

    // セカンダリプロジェクトの概要のみ読み込む
    for (const secondaryPath of routingResult.secondary) {
      if (currentSize >= maxSize) break;

      const secondaryMemory = store.ReadMemory(secondaryPath);
      if (secondaryMemory) {
        // MEMORY.md の概要セクションのみを抽出
        const summary = this._extractSummarySection(secondaryMemory.memoryContent);
        const secondaryContent = `\n---\n## 参照プロジェクト: ${secondaryMemory.projectName}\n${summary}\n---\n`;

        if (currentSize + secondaryContent.length <= maxSize) {
          context += secondaryContent;
          currentSize += secondaryContent.length;
        }
      }
    }

    return context;
  }

  /**
   * 既存のプロンプトにメモリコンテキストを結合する
   */
  InjectIntoPrompt(prompt: string, memoryContext: string): string {
    if (!memoryContext.trim()) {
      return prompt;
    }

    return prompt + '\n\n' + memoryContext;
  }

  /**
   * MEMORY.md から概要セクションのみを抽出する
   */
  private _extractSummarySection(content: string): string {
    // 「## 概要」セクションを抽出
    const summaryMatch = content.match(/## 概要\n([\s\S]*?)(?=\n## |\n\[最終更新:)/);
    if (summaryMatch?.[1]) {
      return summaryMatch[1].trim();
    }

    // セクションが見つからない場合は先頭200文字
    return content.slice(0, 200);
  }
}

// シングルトンインスタンス
let _instance: MemoryInjector | undefined;

/**
 * メモリインジェクターのシングルトンインスタンスを取得する
 */
export function GetMemoryInjector(config?: MemoryConfig): MemoryInjector {
  if (!_instance) {
    if (!config) {
      throw new Error('MemoryInjector requires config on first initialization');
    }
    _instance = new MemoryInjector(config);
  }
  return _instance;
}
