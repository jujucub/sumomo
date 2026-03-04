/**
 * claps - 型定義
 */

// タスクの種類
export type TaskSource = 'github' | 'slack' | 'line' | 'http';

// タスクの状態
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

// タスク定義
export interface Task {
  readonly id: string;
  readonly source: TaskSource;
  readonly createdAt: Date;
  readonly prompt: string;
  readonly metadata: TaskMetadata;
  status: TaskStatus;
  startedAt?: Date;
  completedAt?: Date;
  result?: TaskResult;
}

// GitHub Issue からのタスクメタデータ
export interface GitHubTaskMetadata {
  readonly source: 'github';
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly issueUrl: string;
  readonly requestingUser?: string; // [botName]タグを投稿したGitHubユーザー
  slackThreadTs?: string; // Issue用のSlackスレッド
}

// Slack からのタスクメタデータ
export interface SlackTaskMetadata {
  readonly source: 'slack';
  readonly channelId: string;
  readonly threadTs: string;
  readonly userId: string;
  readonly messageText: string;
  readonly targetRepo?: string; // owner/repo 形式。指定されたリポジトリのworktreeで作業
}

// LINE からのタスクメタデータ
export interface LineTaskMetadata {
  readonly source: 'line';
  readonly userId: string;
  readonly replyToken?: string;
  readonly messageText: string;
  readonly targetRepo?: string;
}

// HTTP (M5 Stack等) からのタスクメタデータ
export interface HttpTaskMetadata {
  readonly source: 'http';
  readonly correlationId: string;
  readonly deviceId?: string;
  readonly messageText: string;
  readonly targetRepo?: string;
}

export type TaskMetadata = GitHubTaskMetadata | SlackTaskMetadata | LineTaskMetadata | HttpTaskMetadata;

// タスク実行結果
export interface TaskResult {
  readonly success: boolean;
  readonly output: string;
  readonly prUrl?: string;
  readonly error?: string;
}

// 承認リクエスト
export interface ApprovalRequest {
  readonly id: string;
  readonly taskId: string;
  readonly tool: string;
  readonly command: string;
  readonly timestamp: Date;
}

// 承認決定
export type ApprovalDecision = 'allow' | 'deny';

// 承認結果（コメント付き）
export interface ApprovalResult {
  readonly decision: ApprovalDecision;
  readonly comment?: string;
  readonly respondedBy?: string;
}

export interface ApprovalResponse {
  readonly requestId: string;
  readonly decision: ApprovalDecision;
  readonly comment?: string;
  readonly respondedBy?: string;
  readonly timestamp: Date;
}

// 質問リクエスト（ask-human MCP用）
export interface QuestionRequest {
  readonly id: string;
  readonly taskId: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly timestamp: Date;
}

export interface QuestionResponse {
  readonly requestId: string;
  readonly answer: string;
  readonly respondedBy?: string;
  readonly timestamp: Date;
}

// ホワイトリスト設定（将来的に管理UIから設定可能にする）
export interface AllowedUsers {
  readonly github: readonly string[];  // GitHubユーザー名
  readonly slack: readonly string[];   // SlackユーザーID
  readonly line: readonly string[];    // LINEユーザーID
  readonly http: readonly string[];    // HTTPデバイスID
}

// ユーザーマッピング（各チャネルのID紐付け）
export interface UserMapping {
  github: string;
  slack: string;
  line?: string;
  http?: string;
}

// 管理設定（Slackコマンドで管理、~/.claps/admin-config.json に永続化）
export interface AdminConfig {
  allowedGithubUsers: string[];
  allowedSlackUsers: string[];
  githubRepos: string[];
  userMappings: UserMapping[];
}

// 設定
export interface Config {
  readonly anthropicApiKey?: string; // Max Plan 使用時は不要
  readonly slackBotToken: string;
  readonly slackAppToken: string;
  readonly slackChannelId: string;
  readonly githubToken: string;
  readonly githubRepos: readonly string[];
  readonly approvalServerPort: number;
  readonly githubPollInterval: number;
  readonly allowedUsers: AllowedUsers;
  readonly reflectionConfig: ReflectionConfig;
  readonly channelConfig: ChannelConfig;
  readonly memoryConfig: MemoryConfig;
}

// Slack メッセージブロック
export interface SlackBlock {
  readonly type: string;
  readonly text?: {
    readonly type: string;
    readonly text: string;
    readonly emoji?: boolean;
  };
  readonly accessory?: {
    readonly type: string;
    readonly action_id: string;
    readonly text?: {
      readonly type: string;
      readonly text: string;
      readonly emoji?: boolean;
    };
    readonly value?: string;
    readonly style?: string;
  };
  readonly elements?: readonly SlackBlockElement[];
}

export interface SlackBlockElement {
  readonly type: string;
  readonly text?: {
    readonly type: string;
    readonly text: string;
    readonly emoji?: boolean;
  };
  readonly action_id?: string;
  readonly value?: string;
  readonly style?: string;
}

// 作業履歴レコード
export interface WorkHistoryRecord {
  readonly id: string;
  readonly timestamp: string;
  readonly source: TaskSource;
  readonly sourceChannel: TaskSource;
  readonly userId: string;
  readonly prompt: string;
  readonly result: 'success' | 'failure';
  readonly duration: number;
  readonly repo?: string;
  readonly issueNumber?: number;
  readonly prUrl?: string;
  readonly summary: string;
  readonly memoryEvent?: MemoryEvent;
}

// チャネル設定
export interface ChannelConfig {
  readonly line?: {
    readonly channelSecret: string;
    readonly channelToken: string;
    readonly webhookPort: number;
  };
  readonly http?: {
    readonly enabled: boolean;
    readonly port?: number;
  };
}

// アダプタ健全性
export interface HealthStatus {
  readonly name: string;
  readonly status: 'healthy' | 'unhealthy' | 'starting' | 'stopped';
  readonly message?: string;
}

// 通知コンテキスト
export interface NotificationContext {
  readonly taskId: string;
  readonly metadata: TaskMetadata;
}

// アダプタコールバック
export interface AdapterCallbacks {
  readonly onMessage: (metadata: TaskMetadata, prompt: string) => Promise<void>;
}

// 内省結果
export interface ReflectionResult {
  readonly date: string;
  readonly generatedAt: string;
  readonly userReflections: readonly UserReflection[];
}

export interface UserReflection {
  readonly userId: string;
  readonly summary: string;
  readonly suggestions: readonly TaskSuggestion[];
  readonly patterns: readonly string[];
}

// タスク提案
export interface TaskSuggestion {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly priority: 'high' | 'medium' | 'low';
  readonly estimatedEffort: string;
  readonly relatedRepo?: string;
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'completed';
  approvedBy?: string;
  approvedAt?: string;
}

// 内省設定
export interface ReflectionConfig {
  readonly enabled: boolean;
  readonly schedule: string;
  readonly timezone: string;
  readonly historyDays: number;
  readonly maxRecordsPerUser: number;
}

// ユーザーインテント（意図・目標）
export interface UserIntent {
  readonly userId: string;
  readonly updatedAt: string;
  readonly shortTermGoals: readonly IntentGoal[];
  readonly longTermGoals: readonly IntentGoal[];
}

export interface IntentGoal {
  readonly id: string;
  readonly description: string;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly evidence: readonly string[];
  readonly status: 'active' | 'completed' | 'stale';
}

// Hook の入出力
export interface HookInput {
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
}

export interface HookOutput {
  readonly permissionDecision?: ApprovalDecision;
  readonly message?: string;
}

// ==============================
// メモリシステム型定義
// ==============================

// メモリの発生元（判別共用体）
export interface SlackMemorySource {
  readonly channel: 'slack';
  readonly channelId: string;
  readonly threadTs: string;
}

export interface LineMemorySource {
  readonly channel: 'line';
  readonly groupId?: string;
  readonly replyToken?: string;
}

export interface GitHubMemorySource {
  readonly channel: 'github';
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
}

export type MemorySource = SlackMemorySource | LineMemorySource | GitHubMemorySource;

// メモリカテゴリ階層
export interface MemoryCategory {
  readonly abstractCategory: string;
  readonly concreteCategory: string;
}

// メモリカテゴリパス（プロジェクト名を含むフルパス）
export interface MemoryCategoryPath {
  readonly abstractCategory: string;
  readonly concreteCategory: string;
  readonly projectName: string;
}

// ルーティング結果
export interface MemoryRoutingResult {
  readonly primaryPath: MemoryCategoryPath;
  readonly secondary: MemoryCategoryPath[];
  readonly isNew: boolean;
  readonly suggestedName: string | null;
  readonly suggestedCategory: MemoryCategory | null;
  readonly suggestedDescription: string | null;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly reasoning: string;
  readonly pinnedContent: string | null;
}

// セッションメモリの内容
export interface SessionMemoryContent {
  readonly sessionId: string;
  readonly content: string;
  readonly lastUpdatedAt: string;
}

// セッションメモリ
export interface SessionMemory {
  readonly sessionId: string;
  readonly projectName: string;
  readonly filePath: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly platformInfo: MemorySource;
  readonly content: string;
}

// メモリエントリ
export interface MemoryEntry {
  readonly timestamp: string;
  readonly content: string;
  readonly source: MemorySource;
  readonly isSummarized: boolean;
  readonly summarizedAt: string | null;
}

// 固定記憶エントリ
export interface PinnedEntry {
  readonly timestamp: string;
  readonly content: string;
  readonly originalPrompt: string;
  readonly source: MemorySource;
}

// メモリイベント種別
export type MemoryEventType = 'memory_created' | 'memory_updated' | 'memory_summarized' | 'memory_routed';

// メモリイベント（作業履歴記録用）
export interface MemoryEvent {
  readonly type: MemoryEventType;
  readonly projectName: string;
  readonly timestamp: string;
  readonly details: string;
}

// メモリ設定
export interface MemoryConfig {
  readonly enabled: boolean;
  readonly memoryDir: string;
  readonly maxMemoryFileSize: number;
  readonly compressionTarget: number;
  readonly maxInjectionSize: number;
  readonly recencyProtectionDays: number;
  readonly maxBackups: number;
}

// プロジェクト概要（一覧用）
export interface ProjectSummary {
  readonly projectName: string;
  readonly categoryPath: MemoryCategoryPath;
  readonly description: string;
  readonly lastUpdatedAt: string;
  readonly sessionIds: string[];
}

// プロジェクトメモリ内容（読み取り結果）
export interface ProjectMemoryContent {
  readonly projectName: string;
  readonly categoryPath: MemoryCategoryPath;
  readonly memoryContent: string;
  readonly pinnedContent: string;
  readonly sessionMemories: SessionMemoryContent[];
  readonly totalSizeBytes: number;
}

// メモリエントリ入力
export interface MemoryEntryInput {
  readonly content: string;
  readonly source: MemorySource;
}

// 固定記憶入力
export interface PinnedEntryInput {
  readonly content: string;
  readonly originalPrompt: string;
  readonly source: MemorySource;
}

// 概要化結果
export interface SummarizeResult {
  readonly success: boolean;
  readonly originalSize: number;
  readonly newSize: number;
  readonly entriesSummarized: number;
  readonly entriesPreserved: number;
  readonly backupPath: string;
}
