/**
 * claps - メモリルーター
 * LLMベースのカテゴリ・プロジェクト分類
 */

import type {
  MemoryCategoryPath,
  MemoryConfig,
  MemoryRoutingResult,
  ProjectSummary,
} from '../types/index.js';
import { GetMemoryStore } from './store.js';
import { GetClaudeRunner } from '../claude/runner.js';
import { GetWorkspacePath } from '../git/repo.js';

// プロジェクト名のバリデーションパターン
const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * メモリルータークラス
 */
export class MemoryRouter {
  private readonly _config: MemoryConfig;

  constructor(config: MemoryConfig) {
    this._config = config;
  }

  /**
   * 会話メッセージを分析し、該当するカテゴリ階層とプロジェクトを推定する
   */
  async RouteConversation(
    message: string,
    currentPath?: MemoryCategoryPath
  ): Promise<MemoryRoutingResult> {
    const store = GetMemoryStore(this._config);
    const projects = store.ListProjects();

    // プロジェクトが存在しない場合は新規作成を提案
    if (projects.length === 0) {
      return this._suggestNewProject(message);
    }

    // カタログを構築
    const catalogue = this.BuildCatalogue(projects);

    // ルーティングプロンプトを構築
    const prompt = this._buildRoutingPrompt(message, catalogue, currentPath);

    try {
      const claudeRunner = GetClaudeRunner();
      const result = await claudeRunner.Run(`memory-route-${Date.now()}`, prompt, {
        workingDirectory: GetWorkspacePath(),
        timeout: 30000,      // 30秒タイムアウト（ルーティングは軽量な分類タスク）
        maxTurns: 1,         // 1ターンで完了
        sanitizeEnv: true,   // Slack関連env変数を除外してMCPサーバーの不要な起動を防ぐ
      });

      if (!result.success) {
        console.error('Memory routing failed:', result.error);
        return this._fallback(currentPath, message);
      }

      // JSON レスポンスをパース
      const parsed = this._parseRoutingResponse(result.output);
      if (parsed) {
        // 新規プロジェクト名のバリデーション (T015)
        if (parsed.isNew && parsed.suggestedName) {
          const validatedName = this._validateProjectName(parsed.suggestedName);
          if (validatedName !== parsed.suggestedName) {
            return {
              ...parsed,
              suggestedName: validatedName,
              primaryPath: {
                ...parsed.primaryPath,
                projectName: validatedName,
              },
            };
          }
        }
        return parsed;
      }

      return this._fallback(currentPath, message);
    } catch (error) {
      console.error('Memory routing error:', error);
      return this._fallback(currentPath, message);
    }
  }

  /**
   * プロジェクト一覧をルーティングプロンプト用の番号付きリスト文字列に変換する
   */
  BuildCatalogue(projects: ProjectSummary[]): string {
    if (projects.length === 0) {
      return '(プロジェクトなし)';
    }

    return projects
      .map((p, i) => {
        const catPath = `${p.categoryPath.abstractCategory}/${p.categoryPath.concreteCategory}`;
        return `${i + 1}. **${p.projectName}** [${catPath}] - ${p.description}`;
      })
      .join('\n');
  }

  /**
   * ルーティングプロンプトを構築する
   * T013: secondary フィールドによるプロジェクト横断参照
   * T014: 信頼度に基づくルーティング動作
   */
  private _buildRoutingPrompt(
    message: string,
    catalogue: string,
    currentPath?: MemoryCategoryPath
  ): string {
    const currentInfo = currentPath
      ? `\n現在のプロジェクト: ${currentPath.abstractCategory}/${currentPath.concreteCategory}/${currentPath.projectName}`
      : '';

    return `以下のユーザーメッセージを分析し、適切なプロジェクトメモリにルーティングしてください。

## 既存プロジェクト一覧
${catalogue}
${currentInfo}

## ユーザーメッセージ
${message}

## 指示
1. メッセージの内容から最も関連するプロジェクトを **primaryPath** に設定してください
2. メッセージが他のプロジェクトも参照している場合（例: 「プロジェクトBのあの実装を参考にしたい」）、それらを **secondary** 配列に含めてください
3. 既存プロジェクトに該当しない場合は isNew=true として新規プロジェクトを提案してください
4. 新規プロジェクト名は kebab-case（/^[a-z0-9][a-z0-9-]*[a-z0-9]$/）で、カテゴリは記憶の内容に基づく抽象→具体の2階層で提案してください
5. **固定記憶の検出**: ユーザーが情報の永続的な記憶を依頼している場合、**pinnedContent** に記憶すべき具体的な内容を抽出してください。例: 「覚えておいて」「メモリに入れておいて」「記録して」「保存しておいて」「忘れないで」「remember」「save this」「keep in mind」など。指示部分は除外し、記憶すべき内容のみを入れてください。記憶リクエストでなければ null にしてください。

## 信頼度の判定基準
- **high**: メッセージが明確に特定のプロジェクトに関連している
- **medium**: プロジェクトの推定はできるが確実ではない。ルーティングは行うが、応答でプロジェクト名を明示してユーザーに認識させる
- **low**: 既存プロジェクトへの関連が薄い。新規プロジェクト作成を提案する

## 出力フォーマット（厳密にこのJSON形式で出力してください）

\`\`\`json
{
  "primaryPath": {
    "abstractCategory": "development",
    "concreteCategory": "backend",
    "projectName": "auth-service"
  },
  "secondary": [],
  "isNew": false,
  "suggestedName": null,
  "suggestedCategory": null,
  "suggestedDescription": null,
  "confidence": "high",
  "reasoning": "メッセージがauth-serviceプロジェクトに直接関連",
  "pinnedContent": null
}
\`\`\`

JSONのみを出力してください。JSONの前後に説明文は不要です。`;
  }

  /**
   * ルーティングレスポンスをパースする
   */
  private _parseRoutingResponse(output: string): MemoryRoutingResult | null {
    try {
      // コードブロック内のJSONを抽出
      const jsonMatch = output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : output.trim();

      if (!jsonStr) return null;

      const parsed = JSON.parse(jsonStr);

      // 必須フィールドのバリデーション
      if (!parsed.primaryPath || typeof parsed.primaryPath.projectName !== 'string') {
        return null;
      }

      // secondary のバリデーション (T013)
      const secondary: MemoryCategoryPath[] = [];
      if (Array.isArray(parsed.secondary)) {
        for (const s of parsed.secondary) {
          if (s && typeof s.projectName === 'string') {
            secondary.push({
              abstractCategory: s.abstractCategory ?? 'general',
              concreteCategory: s.concreteCategory ?? 'general',
              projectName: s.projectName,
            });
          }
        }
      }

      return {
        primaryPath: {
          abstractCategory: parsed.primaryPath.abstractCategory ?? 'general',
          concreteCategory: parsed.primaryPath.concreteCategory ?? 'general',
          projectName: parsed.primaryPath.projectName,
        },
        secondary,
        isNew: parsed.isNew === true,
        suggestedName: parsed.suggestedName ?? null,
        suggestedCategory: parsed.suggestedCategory ?? null,
        suggestedDescription: parsed.suggestedDescription ?? null,
        confidence: parsed.confidence ?? 'medium',
        reasoning: parsed.reasoning ?? '',
        pinnedContent: typeof parsed.pinnedContent === 'string' ? parsed.pinnedContent : null,
      };
    } catch (error) {
      console.error('Failed to parse routing response:', error);
      return null;
    }
  }

  /**
   * プロジェクト名をバリデーションし、不正な場合は修正する (T015)
   */
  private _validateProjectName(name: string): string {
    // kebab-case に変換
    let sanitized = name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    // 最低2文字が必要
    if (sanitized.length < 2) {
      sanitized = 'new-project';
    }

    // パターンに適合するか検証
    if (!PROJECT_NAME_PATTERN.test(sanitized)) {
      sanitized = 'new-project';
    }

    return sanitized;
  }

  /**
   * エラー時のフォールバック
   */
  private _fallback(
    currentPath: MemoryCategoryPath | undefined,
    message: string
  ): MemoryRoutingResult {
    if (currentPath) {
      return {
        primaryPath: currentPath,
        secondary: [],
        isNew: false,
        suggestedName: null,
        suggestedCategory: null,
        suggestedDescription: null,
        confidence: 'medium',
        reasoning: '前回のプロジェクトにフォールバック',
        pinnedContent: null,
      };
    }

    return this._suggestNewProject(message);
  }

  /**
   * 新規プロジェクト作成を提案する
   */
  private _suggestNewProject(message: string): MemoryRoutingResult {
    // メッセージから簡易的にプロジェクト名を生成
    const words = message
      .replace(/[^\w\sぁ-んァ-ヶ一-龠]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .slice(0, 3);
    let suggestedName = words.length > 0
      ? words.join('-').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
      : '';
    suggestedName = this._validateProjectName(suggestedName || 'new-project');

    return {
      primaryPath: {
        abstractCategory: 'general',
        concreteCategory: 'general',
        projectName: suggestedName,
      },
      secondary: [],
      isNew: true,
      suggestedName,
      suggestedCategory: { abstractCategory: 'general', concreteCategory: 'general' },
      suggestedDescription: message.slice(0, 100),
      confidence: 'low',
      reasoning: '既存プロジェクトなし、新規作成を提案',
      pinnedContent: null,
    };
  }
}

// シングルトンインスタンス
let _instance: MemoryRouter | undefined;

/**
 * メモリルーターのシングルトンインスタンスを取得する
 */
export function GetMemoryRouter(config?: MemoryConfig): MemoryRouter {
  if (!_instance) {
    if (!config) {
      throw new Error('MemoryRouter requires config on first initialization');
    }
    _instance = new MemoryRouter(config);
  }
  return _instance;
}
