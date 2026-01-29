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
  CreateWorktree,
  RemoveWorktree,
  CommitAndPush,
  CreatePullRequest,
  CleanupAllWorktrees,
  type WorktreeInfo,
} from './git/worktree.js';
import {
  CreateTmuxSession,
  KillSession,
  CapturePane,
  IsClaudeFinished,
  CleanupAllSessions,
  GetSessionNameForIssue,
} from './tmux/session.js';

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
  console.log('🍑 sumomo を起動しています...');

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
  StartGitHubPoller(_config, HandleGitHubIssue);

  // タスクキューのイベントを監視
  _taskQueue.On('added', OnTaskAdded);

  _isRunning = true;
  console.log('🍑 sumomo が起動しました');
}

/**
 * アプリケーションを停止する
 */
async function Stop(): Promise<void> {
  console.log('🍑 sumomo を停止しています...');

  _isRunning = false;

  // 各コンポーネントを停止
  StopGitHubPoller();
  await StopApprovalServer();
  await StopSlackBot();

  // worktree をクリーンアップ
  await CleanupAllWorktrees();

  // tmuxセッションをクリーンアップ
  CleanupAllSessions();

  console.log('🍑 sumomo を停止しました');
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

  // タスクをキューに追加
  const task = _taskQueue.AddTask('github', prompt, metadataWithThread);

  console.log(`Task added from GitHub: ${task.id} (thread: ${threadTs})`);
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
      // Slack の場合は通常の処理（出力をスレッドに投稿）
      const slackApp = GetSlackBot();
      const slackMeta = task.metadata;
      const sessionStore = GetSessionStore();

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

      result = runResult;

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
 * GitHub Issue タスクを tmux + worktree で処理する
 */
async function ProcessGitHubTask(
  task: Task
): Promise<{ success: boolean; output: string; prUrl?: string; error?: string }> {
  if (!_config) {
    return { success: false, output: '', error: 'Not initialized' };
  }

  const meta = task.metadata as GitHubTaskMetadata;
  const slackApp = GetSlackBot();
  const threadTs = meta.slackThreadTs;
  let worktreeInfo: WorktreeInfo | undefined;
  let sessionName: string | undefined;

  try {
    // worktree を作成
    console.log(`Creating worktree for issue #${meta.issueNumber}...`);
    await NotifyProgress(slackApp, _config.slackChannelId, 'worktree を作成中...', threadTs);

    worktreeInfo = await CreateWorktree(
      process.cwd(),
      meta.owner,
      meta.repo,
      meta.issueNumber
    );

    await NotifyProgress(
      slackApp,
      _config.slackChannelId,
      `ブランチ \`${worktreeInfo.branchName}\` で作業を開始します`,
      threadTs
    );

    // Claude 用のプロンプトを構築
    const worktreePrompt = `${task.prompt}

作業ディレクトリ: ${worktreeInfo.worktreePath}
ブランチ: ${worktreeInfo.branchName}

注意事項:
- コードの修正を行ってください
- コミットやPR作成は不要です（システムが自動で行います）
- 修正が完了したら、変更内容の概要を報告してください`;

    // tmuxセッションを作成してClaude CLIを起動
    sessionName = GetSessionNameForIssue(meta.owner, meta.repo, meta.issueNumber);
    await NotifyProgress(slackApp, _config.slackChannelId, 'Claude を起動中...', threadTs);

    await CreateTmuxSession(
      sessionName,
      worktreeInfo.worktreePath,
      meta.issueNumber,
      worktreePrompt
    );

    // セッションの出力を監視
    let lastOutput = '';
    let lastPostTime = 0;
    const postInterval = 5000; // 5秒ごとに投稿

    const result = await new Promise<{ success: boolean; output: string }>((resolve) => {
      const checkInterval = setInterval(async () => {
        const currentOutput = CapturePane(sessionName!, 500);

        // 新しい出力があればSlackに投稿
        if (currentOutput !== lastOutput) {
          const newContent = currentOutput.slice(lastOutput.length);
          lastOutput = currentOutput;

          const now = Date.now();
          if (now - lastPostTime >= postInterval && newContent.trim()) {
            lastPostTime = now;
            try {
              // 最後の50行だけ投稿
              const lines = newContent.split('\n').slice(-50).join('\n');
              if (lines.trim()) {
                await NotifyProgress(
                  slackApp,
                  _config!.slackChannelId,
                  `\`\`\`\n${lines.slice(0, 1500)}\n\`\`\``,
                  threadTs
                );
              }
            } catch (e) {
              console.error('Failed to post to Slack:', e);
            }
          }
        }

        // Claude CLIが終了したかチェック
        if (IsClaudeFinished(currentOutput)) {
          clearInterval(checkInterval);
          resolve({
            success: true,
            output: currentOutput,
          });
        }
      }, 2000); // 2秒ごとにチェック

      // タイムアウト（10分）
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve({
          success: false,
          output: CapturePane(sessionName!, 500),
        });
      }, 600000);
    });

    // セッションを終了
    KillSession(sessionName);
    sessionName = undefined;

    if (!result.success) {
      return {
        success: false,
        output: result.output,
        error: 'Claude CLI timed out',
      };
    }

    // 変更をコミット＆プッシュ
    await NotifyProgress(slackApp, _config.slackChannelId, 'コミット＆プッシュ中...', threadTs);

    const commitMessage = `fix: Issue #${meta.issueNumber} - ${meta.issueTitle}`;
    const hasChanges = await CommitAndPush(worktreeInfo, commitMessage);

    if (!hasChanges) {
      return {
        success: true,
        output: result.output + '\n\n（変更なし - PRは作成されませんでした）',
      };
    }

    // PR を作成
    await NotifyProgress(slackApp, _config.slackChannelId, 'PR を作成中...', threadTs);

    const prTitle = `fix: Issue #${meta.issueNumber} - ${meta.issueTitle}`;
    const prBody = `## 概要
Issue #${meta.issueNumber} に対応しました。

## 変更内容
${result.output.slice(0, 1000)}

---
🍑 Generated by sumomo`;

    const prUrl = await CreatePullRequest(worktreeInfo, prTitle, prBody);

    return {
      success: true,
      output: result.output,
      prUrl,
    };
  } finally {
    // セッションを終了
    if (sessionName) {
      KillSession(sessionName);
    }
    // worktree を削除
    if (worktreeInfo) {
      await RemoveWorktree(meta.owner, meta.repo, meta.issueNumber);
    }
  }
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
      message = '処理が完了しました（出力なし）';
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
      let comment = '🍑 sumomo が処理を完了しました。';
      if (result.prUrl) {
        comment += `\n\nPR: ${result.prUrl}`;
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
        text: '🍑 sumomo が起動しました。@sumomo でメンションしてください。',
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
