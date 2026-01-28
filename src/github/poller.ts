/**
 * sumomo - GitHub Poller
 * GitHub Issue を定期的にポーリングして [sumomo] タグを検出する
 */

import { Octokit } from '@octokit/rest';
import type { Config, GitHubTaskMetadata } from '../types/index.js';
import { GetTaskQueue } from '../queue/taskQueue.js';

// ポーラー状態
interface PollerState {
  isRunning: boolean;
  intervalId: NodeJS.Timeout | null;
  lastPollTime: Date | null;
}

let _octokit: Octokit | undefined;
let _state: PollerState = {
  isRunning: false,
  intervalId: null,
  lastPollTime: null,
};

// 処理済み Issue の追跡（再起動時にリセット）
const _processedIssues = new Set<string>();

/**
 * GitHub Poller を初期化する
 */
export function InitGitHubPoller(config: Config): void {
  _octokit = new Octokit({
    auth: config.githubToken,
  });
}

/**
 * GitHub Poller を開始する
 */
export function StartGitHubPoller(
  config: Config,
  onIssueFound: (metadata: GitHubTaskMetadata, prompt: string) => Promise<void>
): void {
  if (_state.isRunning) {
    console.log('GitHub Poller is already running');
    return;
  }

  if (!_octokit) {
    InitGitHubPoller(config);
  }

  _state.isRunning = true;
  console.log(`GitHub Poller started (interval: ${config.githubPollInterval}ms)`);

  // 即座に最初のポーリングを実行
  void PollIssues(config, onIssueFound);

  // 定期的にポーリング
  _state.intervalId = setInterval(() => {
    void PollIssues(config, onIssueFound);
  }, config.githubPollInterval);
}

/**
 * GitHub Poller を停止する
 */
export function StopGitHubPoller(): void {
  if (_state.intervalId) {
    clearInterval(_state.intervalId);
    _state.intervalId = null;
  }
  _state.isRunning = false;
  console.log('GitHub Poller stopped');
}

/**
 * Issue をポーリングする
 */
export async function PollIssues(
  config: Config,
  onIssueFound: (metadata: GitHubTaskMetadata, prompt: string) => Promise<void>
): Promise<void> {
  if (!_octokit) {
    console.error('GitHub Poller not initialized');
    return;
  }

  _state.lastPollTime = new Date();

  for (const repoStr of config.githubRepos) {
    const [owner, repo] = repoStr.split('/');
    if (!owner || !repo) {
      console.error(`Invalid repo format: ${repoStr}`);
      continue;
    }

    try {
      await PollRepoIssues(owner, repo, onIssueFound);
    } catch (error) {
      console.error(`Error polling ${repoStr}:`, error);
    }
  }
}

/**
 * 特定リポジトリの Issue をポーリングする
 */
async function PollRepoIssues(
  owner: string,
  repo: string,
  onIssueFound: (metadata: GitHubTaskMetadata, prompt: string) => Promise<void>
): Promise<void> {
  if (!_octokit) return;

  // オープンな Issue を取得
  const { data: issues } = await _octokit.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    sort: 'created',
    direction: 'desc',
    per_page: 20,
  });

  for (const issue of issues) {
    // PR は除外
    if (issue.pull_request) continue;

    const issueKey = `${owner}/${repo}#${issue.number}`;

    // 既に処理済みの場合はスキップ
    if (_processedIssues.has(issueKey)) continue;

    // Issue 本文に [sumomo] が含まれているかチェック
    const body = issue.body ?? '';
    if (!ContainsSumomoMention(body)) {
      // コメントもチェック
      const hasMentionInComments = await CheckCommentsForMention(
        owner,
        repo,
        issue.number
      );
      if (!hasMentionInComments) continue;
    }

    // タスクキューに既に存在する場合はスキップ
    const taskQueue = GetTaskQueue();
    if (taskQueue.IsIssueProcessed(owner, repo, issue.number)) {
      _processedIssues.add(issueKey);
      continue;
    }

    // 処理対象として記録
    _processedIssues.add(issueKey);

    console.log(`Found issue with [sumomo] tag: ${issueKey}`);

    const metadata: GitHubTaskMetadata = {
      source: 'github',
      owner,
      repo,
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueUrl: issue.html_url,
    };

    // Issue の内容をプロンプトとして使用
    const prompt = BuildPromptFromIssue(issue.title, body);

    await onIssueFound(metadata, prompt);
  }
}

/**
 * コメントに [sumomo] が含まれているかチェックする
 */
async function CheckCommentsForMention(
  owner: string,
  repo: string,
  issueNumber: number
): Promise<boolean> {
  if (!_octokit) return false;

  try {
    const { data: comments } = await _octokit.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 50,
    });

    for (const comment of comments) {
      if (ContainsSumomoMention(comment.body ?? '')) {
        return true;
      }
    }
  } catch (error) {
    console.error(`Error checking comments for ${owner}/${repo}#${issueNumber}:`, error);
  }

  return false;
}

/**
 * テキストに [sumomo] タグが含まれているかチェックする
 */
function ContainsSumomoMention(text: string): boolean {
  // [sumomo] タグを検出（大文字小文字を区別しない）
  return text.toLowerCase().includes('[sumomo]');
}

/**
 * Issue からプロンプトを構築する
 */
function BuildPromptFromIssue(title: string, body: string): string {
  return `GitHub Issue: ${title}

${body}

この Issue の内容に従って、コードの分析と修正を行ってください。
必要に応じてPRを作成してください。`;
}

/**
 * Issue にコメントを投稿する
 */
export async function PostIssueComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string
): Promise<void> {
  if (!_octokit) {
    console.error('GitHub Poller not initialized');
    return;
  }

  await _octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body,
  });
}

/**
 * ポーラーの状態を取得する
 */
export function GetPollerStatus(): {
  isRunning: boolean;
  lastPollTime: Date | null;
  processedCount: number;
} {
  return {
    isRunning: _state.isRunning,
    lastPollTime: _state.lastPollTime,
    processedCount: _processedIssues.size,
  };
}
