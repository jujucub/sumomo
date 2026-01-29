/**
 * sumomo - 型定義
 */

// タスクの種類
export type TaskSource = 'github' | 'slack';

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
  slackThreadTs?: string; // Issue用のSlackスレッド
}

// Slack からのタスクメタデータ
export interface SlackTaskMetadata {
  readonly source: 'slack';
  readonly channelId: string;
  readonly threadTs: string;
  readonly userId: string;
  readonly messageText: string;
}

export type TaskMetadata = GitHubTaskMetadata | SlackTaskMetadata;

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
}

// 管理UI用設定
export interface AdminConfig {
  allowedGithubUsers: string[];
  allowedSlackUsers: string[];
  githubRepos: string[];
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
  readonly adminServerPort: number;
  readonly githubPollInterval: number;
  readonly allowedUsers: AllowedUsers;
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

// Hook の入出力
export interface HookInput {
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
}

export interface HookOutput {
  readonly permissionDecision?: ApprovalDecision;
  readonly message?: string;
}
