/**
 * claps - 作業履歴レコーダー
 * タスク完了時に作業履歴を記録する
 */

import type {
  Task,
  TaskSource,
  TaskResult,
  WorkHistoryRecord,
  SlackTaskMetadata,
  GitHubTaskMetadata,
  MemoryEvent,
} from '../types/index.js';
import { GetHistoryStore } from './store.js';
import { GetSlackUserForGitHub } from '../admin/store.js';

/**
 * プロンプトを指定文字数に切り詰める
 */
function TruncatePrompt(prompt: string, maxLength: number = 200): string {
  if (prompt.length <= maxLength) {
    return prompt;
  }
  return prompt.slice(0, maxLength);
}

/**
 * 出力のサマリーを生成する（先頭300文字）
 */
function TruncateSummary(output: string, maxLength: number = 300): string {
  const trimmed = output.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength);
}

/**
 * タスクからユーザーIDを解決する
 */
function ResolveUserId(task: Task): string | undefined {
  if (task.metadata.source === 'slack') {
    const meta = task.metadata as SlackTaskMetadata;
    return meta.userId;
  }

  if (task.metadata.source === 'github') {
    const meta = task.metadata as GitHubTaskMetadata;
    // GitHubユーザーからSlackユーザーIDにマッピング
    if (meta.requestingUser) {
      return GetSlackUserForGitHub(meta.requestingUser);
    }
  }

  if (task.metadata.source === 'line') {
    return task.metadata.userId;
  }

  if (task.metadata.source === 'http') {
    return task.metadata.deviceId ?? task.metadata.correlationId;
  }

  return undefined;
}

/**
 * タスクからソースチャネルを解決する
 */
function ResolveSourceChannel(task: Task): TaskSource {
  return task.metadata.source;
}

/**
 * タスクからリポジトリ情報を取得する
 */
function GetRepoInfo(task: Task): { repo?: string; issueNumber?: number } {
  if (task.metadata.source === 'github') {
    const meta = task.metadata as GitHubTaskMetadata;
    return {
      repo: `${meta.owner}/${meta.repo}`,
      issueNumber: meta.issueNumber,
    };
  }

  if (task.metadata.source === 'slack') {
    const meta = task.metadata as SlackTaskMetadata;
    return {
      repo: meta.targetRepo,
    };
  }

  return {};
}

/**
 * タスク完了時に作業履歴を記録する
 */
export function RecordTaskCompletion(task: Task, result: TaskResult): void {
  const userId = ResolveUserId(task);
  if (!userId) {
    console.log(`History: Skipping record for task ${task.id} (no userId resolved)`);
    return;
  }

  const { repo, issueNumber } = GetRepoInfo(task);

  // 実行時間を計算
  const startTime = task.startedAt?.getTime() ?? task.createdAt.getTime();
  const endTime = task.completedAt?.getTime() ?? Date.now();
  const duration = endTime - startTime;

  const record: WorkHistoryRecord = {
    id: task.id,
    timestamp: new Date().toISOString(),
    source: task.source,
    sourceChannel: ResolveSourceChannel(task),
    userId,
    prompt: TruncatePrompt(task.prompt),
    result: result.success ? 'success' : 'failure',
    duration,
    repo,
    issueNumber,
    prUrl: result.prUrl,
    summary: TruncateSummary(result.output),
  };

  const historyStore = GetHistoryStore();
  historyStore.Append(record);
}

/**
 * メモリイベントを作業履歴に記録する
 */
export function RecordMemoryEvent(event: MemoryEvent, userId: string): void {
  const record: WorkHistoryRecord = {
    id: `memory-${event.type}-${Date.now()}`,
    timestamp: event.timestamp,
    source: 'slack', // メモリイベントはタスクソースに依存しない
    sourceChannel: 'slack',
    userId,
    prompt: '',
    result: 'success',
    duration: 0,
    summary: `[Memory] ${event.type}: ${event.details}`,
    memoryEvent: event,
  };

  const historyStore = GetHistoryStore();
  historyStore.Append(record);
}
