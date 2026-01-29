/**
 * sumomo - GitHub Poller
 * GitHub Issue を定期的にポーリングして [sumomo] タグを検出する
 */

import { Octokit } from '@octokit/rest';
import type { Config, GitHubTaskMetadata, AllowedUsers } from '../types/index.js';
import { GetTaskQueue } from '../queue/taskQueue.js';

// ポーラー状態
interface PollerState {
  isRunning: boolean;
  intervalId: NodeJS.Timeout | null;
  lastPollTime: Date | null;
}

let _octokit: Octokit | undefined;
let _allowedUsers: AllowedUsers | undefined;
let _currentConfig: Config | undefined;
let _currentOnIssueFound:
  | ((metadata: GitHubTaskMetadata, prompt: string) => Promise<void>)
  | undefined;
let _state: PollerState = {
  isRunning: false,
  intervalId: null,
  lastPollTime: null,
};

// 処理済み Issue の追跡（再起動時にリセット）
const _processedIssues = new Set<string>();

/**
 * GitHubホワイトリストを動的に更新する
 */
export function UpdateAllowedUsers(githubUsers: readonly string[]): void {
  if (!_allowedUsers) {
    _allowedUsers = { github: githubUsers, slack: [] };
  } else {
    _allowedUsers = {
      ..._allowedUsers,
      github: githubUsers,
    };
  }
  console.log(`GitHub allowed users updated: ${githubUsers.length} users`);
}

/**
 * リポジトリ設定を更新してポーラーを再起動する
 */
export function UpdateRepos(repos: readonly string[]): void {
  if (!_currentConfig || !_currentOnIssueFound) {
    console.warn('Cannot update repos: Poller not initialized');
    return;
  }

  // 設定を更新
  _currentConfig = {
    ..._currentConfig,
    githubRepos: repos,
  };

  // ポーラーを再起動
  if (_state.isRunning) {
    console.log('Restarting GitHub poller with new repos...');
    StopGitHubPoller();
    StartGitHubPoller(_currentConfig, _currentOnIssueFound, _onIssueClosed);
  }

  console.log(`GitHub repos updated: ${repos.length} repos`);
}

/**
 * GitHubユーザーがホワイトリストに含まれているかチェック
 * GitHubユーザー名は大文字小文字を区別しないため、小文字に正規化して比較
 */
function IsUserAllowed(username: string): boolean {
  if (!_allowedUsers) return false;
  // ホワイトリストが空の場合は全員拒否
  if (_allowedUsers.github.length === 0) return false;
  const lowerUsername = username.toLowerCase();
  return _allowedUsers.github.some(
    (allowed) => allowed.toLowerCase() === lowerUsername
  );
}

/**
 * GitHub Poller を初期化する
 */
export function InitGitHubPoller(config: Config): void {
  _octokit = new Octokit({
    auth: config.githubToken,
  });
  _allowedUsers = config.allowedUsers;
}

// Issueクローズ時のコールバック
type OnIssueClosedCallback = (owner: string, repo: string, issueNumber: number) => Promise<void>;
let _onIssueClosed: OnIssueClosedCallback | undefined;

/**
 * GitHub Poller を開始する
 */
export function StartGitHubPoller(
  config: Config,
  onIssueFound: (metadata: GitHubTaskMetadata, prompt: string) => Promise<void>,
  onIssueClosed?: OnIssueClosedCallback
): void {
  if (_state.isRunning) {
    console.log('GitHub Poller is already running');
    return;
  }

  if (!_octokit) {
    InitGitHubPoller(config);
  }

  // 設定とコールバックを保存（UpdateRepos用）
  _currentConfig = config;
  _currentOnIssueFound = onIssueFound;

  _state.isRunning = true;
  _onIssueClosed = onIssueClosed;
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
      // クローズされたIssueをチェック
      await CheckClosedIssues(owner, repo);
    } catch (error) {
      console.error(`Error polling ${repoStr}:`, error);
    }
  }
}

/**
 * 処理済みIssueがクローズされたかチェックする
 */
async function CheckClosedIssues(owner: string, repo: string): Promise<void> {
  if (!_octokit || !_onIssueClosed) return;

  // 処理済みIssueの中からこのリポジトリのものを抽出
  const repoPrefix = `${owner}/${repo}#`;
  const issueNumbers: number[] = [];

  for (const issueKey of _processedIssues) {
    if (issueKey.startsWith(repoPrefix)) {
      const num = parseInt(issueKey.slice(repoPrefix.length), 10);
      if (!isNaN(num)) {
        issueNumbers.push(num);
      }
    }
  }

  // 各Issueのステータスをチェック
  for (const issueNumber of issueNumbers) {
    try {
      const { data: issue } = await _octokit.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });

      if (issue.state === 'closed') {
        const issueKey = `${owner}/${repo}#${issueNumber}`;
        console.log(`Issue closed: ${issueKey}`);

        // クローズコールバックを呼び出し
        await _onIssueClosed(owner, repo, issueNumber);

        // 処理済みリストから削除（次回検知しないため）
        _processedIssues.delete(issueKey);
      }
    } catch (error) {
      // Issueが見つからない場合（削除された等）も処理済みから削除
      const issueKey = `${owner}/${repo}#${issueNumber}`;
      console.error(`Error checking issue ${issueKey}:`, error);
      _processedIssues.delete(issueKey);
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
    const issueAuthor = issue.user?.login ?? '';

    let requestingUser: string | undefined;

    if (ContainsSumomoMention(body)) {
      // Issue本文に[sumomo]がある場合、Issue作成者をチェック
      requestingUser = issueAuthor;
    } else {
      // コメントに[sumomo]があるかチェック（投稿者も取得）
      requestingUser = await FindAllowedUserInComments(owner, repo, issue.number);
    }

    // [sumomo]タグが見つからない場合はスキップ
    if (!requestingUser) continue;

    // ホワイトリストチェック
    if (!IsUserAllowed(requestingUser)) {
      console.log(`Denied GitHub request from ${requestingUser} (not in whitelist): ${issueKey}`);
      _processedIssues.add(issueKey); // 再処理を防ぐため記録
      continue;
    }

    // タスクキューに既に存在する場合はスキップ
    const taskQueue = GetTaskQueue();
    if (taskQueue.IsIssueProcessed(owner, repo, issue.number)) {
      _processedIssues.add(issueKey);
      continue;
    }

    // 処理対象として記録
    _processedIssues.add(issueKey);

    console.log(`Found issue with [sumomo] tag from ${requestingUser}: ${issueKey}`);

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
 * コメントに [sumomo] が含まれているかチェックし、投稿者を返す
 * 複数のコメントに[sumomo]がある場合は最初に見つかったものを返す
 */
async function FindAllowedUserInComments(
  owner: string,
  repo: string,
  issueNumber: number
): Promise<string | undefined> {
  if (!_octokit) return undefined;

  try {
    const { data: comments } = await _octokit.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 50,
    });

    for (const comment of comments) {
      if (ContainsSumomoMention(comment.body ?? '')) {
        const login = comment.user?.login;
        // loginがない場合は次のコメントをチェック
        if (login) {
          return login;
        }
      }
    }
  } catch (error) {
    console.error(`Error checking comments for ${owner}/${repo}#${issueNumber}:`, error);
  }

  return undefined;
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
