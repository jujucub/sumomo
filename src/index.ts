/**
 * sumomo - メインエントリーポイント
 * GitHub Issue / Slack 連携 Claude 自動対応システム
 */

import { LoadConfig } from './config.js';
import type { Config, GitHubTaskMetadata, SlackTaskMetadata, Task } from './types/index.js';
import { GetTaskQueue, type TaskQueue } from './queue/taskQueue.js';
import { GetClaudeRunner, type ClaudeRunner } from './claude/runner.js';
import { GetSessionStore } from './session/store.js';
import {
  InitSlackBot,
  StartSlackBot,
  StopSlackBot,
  GetSlackBot,
} from './slack/bot.js';
import {
  RegisterSlackHandlers,
  NotifyTaskCompleted,
  NotifyError,
  NotifyProgress,
  CreateIssueThread,
} from './slack/handlers.js';
import {
  InitGitHubPoller,
  StartGitHubPoller,
  StopGitHubPoller,
  PostIssueComment,
} from './github/poller.js';
import {
  InitApprovalServer,
  StartApprovalServer,
  StopApprovalServer,
  SetCurrentTaskId,
  ClearCurrentTaskId,
} from './approval/server.js';
import {
  CommitAndPush,
  CreatePullRequest,
  CleanupAllWorktrees,
  GetOrCreateWorktree,
  RemoveWorktree,
} from './git/worktree.js';
import { CleanupAllSessions } from './tmux/session.js';
import {
  InitAdminServer,
  StartAdminServer,
  StopAdminServer,
} from './admin/server.js';

// アプリケーション状態
let _isRunning = false;
let _config: Config | undefined;
let _taskQueue: TaskQueue | undefined;
let _claudeRunner: ClaudeRunner | undefined;
let _isProcessing = false;

/**
 * アプリケーションを起動する
 */
async function Start(): Promise<void> {
  console.log('🍑 すももを起動するのでーす！');

  // 設定を読み込む
  _config = LoadConfig();

  // コンポーネントを初期化
  _taskQueue = GetTaskQueue();
  _claudeRunner = GetClaudeRunner();

  // Slack Bot を初期化・起動
  const slackApp = InitSlackBot(_config);
  RegisterSlackHandlers(slackApp, _config.slackChannelId, HandleSlackMention, _config.allowedUsers);
  await StartSlackBot();

  // 承認サーバーを初期化・起動
  InitApprovalServer(slackApp, _config.slackChannelId);
  await StartApprovalServer(_config.approvalServerPort);

  // GitHub Poller を初期化・開始
  InitGitHubPoller(_config);
  StartGitHubPoller(_config, HandleGitHubIssue, HandleIssueClosed);

  // 管理サーバーを初期化・起動
  InitAdminServer();
  await StartAdminServer(_config.adminServerPort);

  // タスクキューのイベントを監視
  _taskQueue.On('added', OnTaskAdded);

  _isRunning = true;
  console.log('🍑 すももの起動完了であります！');
}

/**
 * アプリケーションを停止する
 */
async function Stop(): Promise<void> {
  console.log('🍑 すももを停止するのでーす...');

  _isRunning = false;

  // 各コンポーネントを停止
  StopGitHubPoller();
  await StopAdminServer();
  await StopApprovalServer();
  await StopSlackBot();

  // worktree をクリーンアップ
  await CleanupAllWorktrees();

  // tmuxセッションをクリーンアップ
  CleanupAllSessions();

  console.log('🍑 すもも、おやすみなさいなのです！');
}

/**
 * Slack メンションを処理する
 */
async function HandleSlackMention(
  metadata: SlackTaskMetadata,
  prompt: string
): Promise<void> {
  if (!_taskQueue || !_config) return;

  // タスクをキューに追加
  const task = _taskQueue.AddTask('slack', prompt, metadata);

  console.log(`Task added from Slack: ${task.id}`);
}

/**
 * GitHub Issue を処理する
 */
async function HandleGitHubIssue(
  metadata: GitHubTaskMetadata,
  prompt: string
): Promise<void> {
  if (!_taskQueue || !_config) return;

  // Slack にスレッドを作成
  const slackApp = GetSlackBot();
  const threadTs = await CreateIssueThread(
    slackApp,
    _config.slackChannelId,
    metadata.owner,
    metadata.repo,
    metadata.issueNumber,
    metadata.issueTitle,
    metadata.issueUrl
  );

  // スレッドTsをmetadataに保存
  const metadataWithThread: GitHubTaskMetadata = {
    ...metadata,
    slackThreadTs: threadTs,
  };

  // スレッドとIssueを紐付け（スレッドでの追加メンション用）
  const sessionStore = GetSessionStore();
  sessionStore.LinkThreadToIssue(threadTs, metadata.owner, metadata.repo, metadata.issueNumber);

  // タスクをキューに追加
  const task = _taskQueue.AddTask('github', prompt, metadataWithThread);

  console.log(`Task added from GitHub: ${task.id} (thread: ${threadTs})`);
}

/**
 * GitHub Issue がクローズされたときの処理
 */
async function HandleIssueClosed(
  owner: string,
  repo: string,
  issueNumber: number
): Promise<void> {
  console.log(`Issue closed: ${owner}/${repo}#${issueNumber}`);

  const sessionStore = GetSessionStore();

  // スレッドとIssueの紐付けを解除
  sessionStore.UnlinkThreadForIssue(owner, repo, issueNumber);

  // セッションを削除
  const hadSession = sessionStore.DeleteForIssue(owner, repo, issueNumber);
  if (hadSession) {
    console.log(`Session deleted for issue #${issueNumber}`);
  }

  // worktree を削除
  try {
    await RemoveWorktree(owner, repo, issueNumber);
    console.log(`Worktree removed for issue #${issueNumber}`);
  } catch (error) {
    console.error(`Failed to remove worktree for issue #${issueNumber}:`, error);
  }
}

/**
 * タスクが追加されたときの処理
 */
function OnTaskAdded(_task: Task): void {
  // タスク処理を開始
  void ProcessNextTask();
}

/**
 * 次のタスクを処理する
 */
async function ProcessNextTask(): Promise<void> {
  if (!_taskQueue || !_claudeRunner || !_config) return;
  if (_isProcessing) return;
  if (!_isRunning) return;

  const task = _taskQueue.GetNextTask();
  if (!task) return;

  _isProcessing = true;
  const threadTs = GetThreadTs(task);
  SetCurrentTaskId(task.id, threadTs);

  console.log(`Processing task: ${task.id}`);

  try {
    let result: { success: boolean; output: string; prUrl?: string; error?: string };

    if (task.metadata.source === 'github') {
      // GitHub Issue の場合は worktree で処理
      result = await ProcessGitHubTask(task);
    } else {
      // Slack の場合
      const slackApp = GetSlackBot();
      const slackMeta = task.metadata;
      const sessionStore = GetSessionStore();

      // Issue用スレッドかどうかをチェック
      const linkedIssue = sessionStore.GetIssueForThread(slackMeta.threadTs);

      if (linkedIssue) {
        // Issue用スレッドの場合: Issueのセッションとworktreeを使用
        console.log(`Thread ${slackMeta.threadTs} is linked to issue #${linkedIssue.issueNumber}`);
        result = await ProcessSlackAsIssueTask(task, linkedIssue);
      } else {
        // 通常のSlackタスク
        // 同じスレッドの既存セッションを取得
        const existingSessionId = sessionStore.Get(slackMeta.threadTs, slackMeta.userId);
        if (existingSessionId) {
          console.log(`Resuming existing session for thread ${slackMeta.threadTs}: ${existingSessionId}`);
        } else {
          console.log(`Creating new session for thread ${slackMeta.threadTs}`);
        }

        let lastPostTime = 0;
        let outputBuffer = '';
        const postInterval = 3000;

        const onOutput = async (chunk: string, _type: 'stdout' | 'stderr') => {
          outputBuffer += chunk;
          const now = Date.now();

          if (now - lastPostTime >= postInterval && outputBuffer.trim()) {
            lastPostTime = now;
            const message = outputBuffer.slice(0, 1500);
            outputBuffer = '';

            try {
              await NotifyProgress(
                slackApp,
                _config!.slackChannelId,
                `\`\`\`\n${message}\n\`\`\``,
                slackMeta.threadTs
              );
            } catch (e) {
              console.error('Failed to post to Slack:', e);
            }
          }
        };

        const runResult = await _claudeRunner.Run(task.id, task.prompt, {
          workingDirectory: process.cwd(),
          onOutput,
          resumeSessionId: existingSessionId,
        });

        // 新しいセッションIDが返された場合は保存
        if (runResult.sessionId) {
          sessionStore.Set(slackMeta.threadTs, slackMeta.userId, runResult.sessionId);
          console.log(`Session saved for thread ${slackMeta.threadTs}: ${runResult.sessionId}`);
        }

        // 残りのバッファを投稿
        if (outputBuffer.trim()) {
          try {
            await NotifyProgress(
              slackApp,
              _config!.slackChannelId,
              `\`\`\`\n${outputBuffer.slice(0, 1500)}\n\`\`\``,
              slackMeta.threadTs
            );
          } catch (e) {
            console.error('Failed to post final output to Slack:', e);
          }
        }

        result = runResult;
      }
    }

    // タスクを完了としてマーク
    _taskQueue.CompleteTask(task.id, result);

    // 結果を通知
    await NotifyResult(task, result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Task failed: ${task.id}`, error);

    _taskQueue.CompleteTask(task.id, {
      success: false,
      output: '',
      error: errorMessage,
    });

    // エラーを通知
    await NotifyError(
      GetSlackBot(),
      _config.slackChannelId,
      task.id,
      errorMessage,
      GetThreadTs(task)
    );
  } finally {
    ClearCurrentTaskId();
    _isProcessing = false;

    // 次のタスクを処理
    void ProcessNextTask();
  }
}

/**
 * Issue用スレッドでのSlackメンションをIssueとして処理する
 */
async function ProcessSlackAsIssueTask(
  task: Task,
  issueInfo: { owner: string; repo: string; issueNumber: number }
): Promise<{ success: boolean; output: string; prUrl?: string; error?: string }> {
  if (!_config || !_claudeRunner) {
    return { success: false, output: '', error: 'Not initialized' };
  }

  const slackMeta = task.metadata as SlackTaskMetadata;
  const slackApp = GetSlackBot();
  const sessionStore = GetSessionStore();

  try {
    // 既存の worktree を取得（なければ作成）
    const { worktreeInfo, isExisting } = await GetOrCreateWorktree(
      process.cwd(),
      issueInfo.owner,
      issueInfo.repo,
      issueInfo.issueNumber
    );

    if (isExisting) {
      await NotifyProgress(
        slackApp,
        _config.slackChannelId,
        `Issue #${issueInfo.issueNumber} の作業を継続するのでーす！`,
        slackMeta.threadTs
      );
    }

    // Issueのセッションを取得
    const existingSessionId = sessionStore.GetForIssue(
      issueInfo.owner,
      issueInfo.repo,
      issueInfo.issueNumber
    );
    if (existingSessionId) {
      console.log(`Resuming issue session: ${existingSessionId}`);
    } else {
      console.log(`Creating new session for issue #${issueInfo.issueNumber}`);
    }

    // 出力コールバック
    let lastPostTime = 0;
    let outputBuffer = '';
    const postInterval = 3000;

    const onOutput = async (chunk: string, _type: 'stdout' | 'stderr') => {
      outputBuffer += chunk;
      const now = Date.now();

      if (now - lastPostTime >= postInterval && outputBuffer.trim()) {
        lastPostTime = now;
        const message = outputBuffer.slice(0, 1500);
        outputBuffer = '';

        try {
          await NotifyProgress(
            slackApp,
            _config!.slackChannelId,
            `\`\`\`\n${message}\n\`\`\``,
            slackMeta.threadTs
          );
        } catch (e) {
          console.error('Failed to post to Slack:', e);
        }
      }
    };

    // Claude CLI を実行
    const runResult = await _claudeRunner.Run(task.id, task.prompt, {
      workingDirectory: worktreeInfo.worktreePath,
      onOutput,
      resumeSessionId: existingSessionId,
    });

    // セッションIDを保存
    if (runResult.sessionId) {
      sessionStore.SetForIssue(
        issueInfo.owner,
        issueInfo.repo,
        issueInfo.issueNumber,
        runResult.sessionId
      );
      console.log(`Session saved for issue #${issueInfo.issueNumber}: ${runResult.sessionId}`);
    }

    // 残りのバッファを投稿
    if (outputBuffer.trim()) {
      try {
        await NotifyProgress(
          slackApp,
          _config.slackChannelId,
          `\`\`\`\n${outputBuffer.slice(0, 1500)}\n\`\`\``,
          slackMeta.threadTs
        );
      } catch (e) {
        console.error('Failed to post final output to Slack:', e);
      }
    }

    // 変更があればコミット＆プッシュ
    const commitMessage = `fix: Issue #${issueInfo.issueNumber} - additional changes`;
    const hasChanges = await CommitAndPush(worktreeInfo, commitMessage);

    if (hasChanges) {
      await NotifyProgress(
        slackApp,
        _config.slackChannelId,
        '変更をコミット＆プッシュしたのでーす！',
        slackMeta.threadTs
      );
    }

    return {
      success: runResult.success,
      output: runResult.output,
      error: runResult.error,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`ProcessSlackAsIssueTask error: ${errorMessage}`);
    return {
      success: false,
      output: '',
      error: errorMessage,
    };
  }
}

/**
 * GitHub Issue タスクを worktree で処理する（セッション継続対応）
 */
async function ProcessGitHubTask(
  task: Task
): Promise<{ success: boolean; output: string; prUrl?: string; error?: string }> {
  if (!_config || !_claudeRunner) {
    return { success: false, output: '', error: 'Not initialized' };
  }

  const meta = task.metadata as GitHubTaskMetadata;
  const slackApp = GetSlackBot();
  const threadTs = meta.slackThreadTs;
  const sessionStore = GetSessionStore();

  try {
    // 既存の worktree があれば再利用、なければ新規作成
    console.log(`Getting or creating worktree for issue #${meta.issueNumber}...`);

    const { worktreeInfo, isExisting } = await GetOrCreateWorktree(
      process.cwd(),
      meta.owner,
      meta.repo,
      meta.issueNumber
    );

    if (isExisting) {
      await NotifyProgress(
        slackApp,
        _config.slackChannelId,
        `既存のブランチ \`${worktreeInfo.branchName}\` で作業を継続するのでーす！`,
        threadTs
      );
    } else {
      await NotifyProgress(
        slackApp,
        _config.slackChannelId,
        `ブランチ \`${worktreeInfo.branchName}\` で作業を開始するのです！`,
        threadTs
      );
    }

    // 同じIssueの既存セッションを取得
    const existingSessionId = sessionStore.GetForIssue(meta.owner, meta.repo, meta.issueNumber);
    if (existingSessionId) {
      console.log(`Resuming existing session for issue #${meta.issueNumber}: ${existingSessionId}`);
      await NotifyProgress(
        slackApp,
        _config.slackChannelId,
        '前回のセッションを継続するのでーす！',
        threadTs
      );
    } else {
      console.log(`Creating new session for issue #${meta.issueNumber}`);
    }

    // Claude 用のプロンプトを構築
    const worktreePrompt = `${task.prompt}

作業ディレクトリ: ${worktreeInfo.worktreePath}
ブランチ: ${worktreeInfo.branchName}

注意事項:
- コードの修正を行ってください
- コミットやPR作成は不要です（システムが自動で行います）
- 修正が完了したら、変更内容の概要を報告してください`;

    await NotifyProgress(slackApp, _config.slackChannelId, 'Claude を起動中なのでーす！', threadTs);

    // 出力を Slack に投稿するコールバック
    let lastPostTime = 0;
    let outputBuffer = '';
    const postInterval = 3000;

    const onOutput = async (chunk: string, _type: 'stdout' | 'stderr') => {
      outputBuffer += chunk;
      const now = Date.now();

      if (now - lastPostTime >= postInterval && outputBuffer.trim()) {
        lastPostTime = now;
        const message = outputBuffer.slice(0, 1500);
        outputBuffer = '';

        try {
          await NotifyProgress(
            slackApp,
            _config!.slackChannelId,
            `\`\`\`\n${message}\n\`\`\``,
            threadTs
          );
        } catch (e) {
          console.error('Failed to post to Slack:', e);
        }
      }
    };

    // Claude CLI を実行（非対話モード + セッション継続）
    const runResult = await _claudeRunner.Run(task.id, worktreePrompt, {
      workingDirectory: worktreeInfo.worktreePath,
      onOutput,
      resumeSessionId: existingSessionId,
    });

    // 新しいセッションIDが返された場合は保存
    if (runResult.sessionId) {
      sessionStore.SetForIssue(meta.owner, meta.repo, meta.issueNumber, runResult.sessionId);
      console.log(`Session saved for issue #${meta.issueNumber}: ${runResult.sessionId}`);
    }

    // 残りのバッファを投稿
    if (outputBuffer.trim()) {
      try {
        await NotifyProgress(
          slackApp,
          _config.slackChannelId,
          `\`\`\`\n${outputBuffer.slice(0, 1500)}\n\`\`\``,
          threadTs
        );
      } catch (e) {
        console.error('Failed to post final output to Slack:', e);
      }
    }

    if (!runResult.success) {
      return {
        success: false,
        output: runResult.output,
        error: runResult.error ?? 'Claude CLI failed',
      };
    }

    // 変更をコミット＆プッシュ
    await NotifyProgress(slackApp, _config.slackChannelId, 'コミット＆プッシュするのでーす！', threadTs);

    const commitMessage = `fix: Issue #${meta.issueNumber} - ${meta.issueTitle}`;
    const hasChanges = await CommitAndPush(worktreeInfo, commitMessage);

    if (!hasChanges) {
      return {
        success: true,
        output: runResult.output + '\n\n（変更なしなのです - PRは作成されませんでした）',
      };
    }

    // PR を作成
    await NotifyProgress(slackApp, _config.slackChannelId, 'PR を作成するのでーす！', threadTs);

    const prTitle = `fix: Issue #${meta.issueNumber} - ${meta.issueTitle}`;
    const prBody = `## 概要
Issue #${meta.issueNumber} に対応したのでーす！

## 変更内容
${runResult.output.slice(0, 1000)}

---
🍑 すももが一生懸命お仕事したのです！`;

    const prUrl = await CreatePullRequest(worktreeInfo, prTitle, prBody);

    return {
      success: true,
      output: runResult.output,
      prUrl,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`ProcessGitHubTask error: ${errorMessage}`);
    return {
      success: false,
      output: '',
      error: errorMessage,
    };
  }
  // 注意: worktreeは削除せずに維持（セッション継続のため）
}

/**
 * 結果を通知する
 */
async function NotifyResult(
  task: Task,
  result: { success: boolean; output: string; prUrl?: string; error?: string }
): Promise<void> {
  if (!_config) return;

  const slackApp = GetSlackBot();
  const threadTs = GetThreadTs(task);

  if (result.success) {
    // Claudeの出力を送信（長すぎる場合は切り詰め）
    const maxLength = 3000;
    let message = result.output.trim();
    if (message.length > maxLength) {
      message = message.slice(0, maxLength) + '\n...(省略)';
    }
    if (!message) {
      message = '処理が完了したのでーす！（出力なしなのです）';
    }

    await NotifyTaskCompleted(
      slackApp,
      _config.slackChannelId,
      task.id,
      message,
      result.prUrl,
      threadTs
    );

    // GitHub Issue の場合はコメントを投稿
    if (task.metadata.source === 'github') {
      const meta = task.metadata;
      let comment = '🍑 すももが処理を完了したのでーす！お疲れ様でした！';
      if (result.prUrl) {
        comment += `\n\nPRを作成したのです: ${result.prUrl}`;
      }
      await PostIssueComment(meta.owner, meta.repo, meta.issueNumber, comment);
    }
  } else {
    await NotifyError(
      slackApp,
      _config.slackChannelId,
      task.id,
      result.error ?? '不明なエラー',
      threadTs
    );
  }
}

/**
 * タスクからスレッドタイムスタンプを取得する
 */
function GetThreadTs(task: Task): string | undefined {
  if (task.metadata.source === 'slack') {
    return task.metadata.threadTs;
  }
  if (task.metadata.source === 'github') {
    return task.metadata.slackThreadTs;
  }
  return undefined;
}

/**
 * シグナルハンドラーを設定する
 */
function SetupSignalHandlers(): void {
  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT');
    await Stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM');
    await Stop();
    process.exit(0);
  });

  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    void Stop().then(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
  });
}

/**
 * メインエントリーポイント
 */
async function Main(): Promise<void> {
  SetupSignalHandlers();

  try {
    await Start();

    // 起動通知を送信
    if (_config) {
      const slackApp = GetSlackBot();
      await slackApp.client.chat.postMessage({
        channel: _config.slackChannelId,
        text: '🍑 朝でーす！すももが起動したのでーす！@sumomo でメンションしてくださいなのです！',
      });
    }
  } catch (error) {
    console.error('Failed to start sumomo:', error);
    process.exit(1);
  }
}

Main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
