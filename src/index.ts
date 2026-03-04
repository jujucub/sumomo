/**
 * claps - メインエントリーポイント
 * GitHub Issue / 各チャネル連携 Claude 自動対応システム
 */

import { LoadConfig } from './config.js';
import type { Config, GitHubTaskMetadata, SlackTaskMetadata, LineTaskMetadata, HttpTaskMetadata, TaskMetadata, Task } from './types/index.js';
import { GetTaskQueue, type TaskQueue } from './queue/taskQueue.js';
import { GetClaudeRunner, type ClaudeRunner, type WorkLog } from './claude/runner.js';
import { GetSessionStore } from './session/store.js';
import { GetSlackBot } from './slack/bot.js';
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
  CleanupAllWorktrees,
  GetOrCreateWorktree,
  RemoveWorktree,
  InitializeWorkspace,
} from './git/worktree.js';
import { GetOrCloneRepo, GetWorkspacePath } from './git/repo.js';
import {
  GetSlackUserForGitHub,
  GetAdminSlackUser,
  GetAdminConfig,
} from './admin/store.js';
import { SetupGlobalMcpConfig } from './mcp/setup.js';
import { RecordTaskCompletion, RecordMemoryEvent } from './history/recorder.js';
import { GetMemoryStore } from './memory/store.js';
import { GetMemoryRouter } from './memory/router.js';
import { GetMemoryInjector } from './memory/injector.js';
import { GetMemorySummarizer } from './memory/summarizer.js';
import type {
  MemoryRoutingResult,
  MemorySource,
} from './types/index.js';
import {
  InitReflectionScheduler,
  StartReflectionScheduler,
  StopReflectionScheduler,
} from './reflection/scheduler.js';
import { SetProcessingRef } from './reflection/engine.js';
import { Msg } from './messages.js';

// Channel abstraction
import { AdapterRegistry } from './channel/registry.js';
import { NotificationRouter } from './channel/router.js';
import { SlackAdapter } from './slack/adapter.js';
import { LineAdapter } from './line/adapter.js';
import { HttpAdapter } from './http/adapter.js';

// 作業ログの投稿間隔（ミリ秒）
const WORK_LOG_INTERVAL_MS = 10000;

// アプリケーション状態
let _isRunning = false;
let _config: Config | undefined;
let _taskQueue: TaskQueue | undefined;
let _claudeRunner: ClaudeRunner | undefined;
let _isProcessing = false;

// チャネル抽象化
let _registry: AdapterRegistry | undefined;
let _router: NotificationRouter | undefined;

/**
 * アプリケーションを起動する
 */
async function Start(): Promise<void> {
  console.log(Msg('console.startup'));

  // 設定を読み込む
  _config = LoadConfig();

  // MCP設定をセットアップ（~/.claude.jsonに追加）
  SetupGlobalMcpConfig();

  // 汎用ワークスペースを初期化（hook設定を注入）
  const workspacePath = GetWorkspacePath();
  await InitializeWorkspace(workspacePath);

  // コンポーネントを初期化
  _taskQueue = GetTaskQueue();
  _claudeRunner = GetClaudeRunner();

  // アダプタレジストリを初期化
  _registry = new AdapterRegistry();
  _router = new NotificationRouter(_registry);

  // Slack アダプタを登録（常に有効）
  const slackAdapter = new SlackAdapter(_config);
  _registry.register(slackAdapter);

  // LINE アダプタを条件付きで登録
  if (_config.channelConfig.line) {
    const lineAdapter = new LineAdapter(_config);
    _registry.register(lineAdapter);
    console.log('LINE adapter registered (channel token present)');
  }

  // HTTP アダプタを条件付きで登録
  if (_config.channelConfig.http) {
    const httpAdapter = new HttpAdapter(_config, _registry);
    _registry.register(httpAdapter);
    console.log('HTTP adapter registered (HTTP_CHANNEL_ENABLED=true)');
  }

  // 全アダプタを初期化（SDK初期化、コールバック登録）
  await _registry.initAll({
    onMessage: HandleChannelMessage,
  });

  // 承認サーバーを初期化・起動（HTTP アダプタがルートをマウントする前に必要）
  InitApprovalServer(_router);
  await StartApprovalServer(_config.approvalServerPort);

  // 全アダプタを起動（HTTP アダプタは承認サーバーの Express にマウントする場合がある）
  await _registry.startAll();

  // Slackアダプタが正常起動したことを検証（起動失敗は致命的）
  const slackHealth = slackAdapter.getHealth();
  if (slackHealth.status !== 'healthy') {
    throw new Error('Slack adapter failed to start - cannot continue without Slack');
  }

  // GitHub Poller を初期化・開始
  InitGitHubPoller(_config);
  StartGitHubPoller(_config, HandleGitHubIssue, HandleIssueClosed);

  // タスクキューのイベントを監視
  _taskQueue.On('added', OnTaskAdded);

  // 内省スケジューラを初期化・起動
  SetProcessingRef(() => _isProcessing);
  InitReflectionScheduler(_config, async (result) => {
    await _router!.postReflectionResult(result);
  });
  StartReflectionScheduler();

  _isRunning = true;
  console.log(Msg('console.startupComplete'));
}

/**
 * アプリケーションを停止する
 */
async function Stop(): Promise<void> {
  console.log(Msg('console.shutdown'));

  _isRunning = false;

  // 各コンポーネントを停止
  StopReflectionScheduler();
  StopGitHubPoller();
  await StopApprovalServer();

  // 全アダプタを停止
  if (_registry) {
    await _registry.stopAll();
  }

  // worktree をクリーンアップ
  await CleanupAllWorktrees();

  console.log(Msg('console.shutdownComplete'));
}

/**
 * 各チャネルからのメッセージを処理する（統一エントリーポイント）
 */
async function HandleChannelMessage(
  metadata: TaskMetadata,
  prompt: string
): Promise<void> {
  console.log(`HandleChannelMessage called: source=${metadata.source}, prompt="${prompt.slice(0, 50)}"`);
  if (!_taskQueue || !_config) return;

  // タスクをキューに追加
  const task = _taskQueue.AddTask(metadata.source, prompt, metadata);

  console.log(`Task added from ${metadata.source}: ${task.id}`);
}

/**
 * GitHub Issue を処理する
 */
async function HandleGitHubIssue(
  metadata: GitHubTaskMetadata,
  prompt: string
): Promise<void> {
  if (!_taskQueue || !_config || !_router) return;

  // ルーター経由でIssueスレッドを作成
  const threadTs = await _router.createIssueThread(
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
  console.log(`ProcessNextTask called: isProcessing=${_isProcessing}, isRunning=${_isRunning}, pendingTasks=${_taskQueue?.GetPendingCount() ?? 'N/A'}`);
  if (!_taskQueue || !_claudeRunner || !_config || !_router) return;
  if (_isProcessing) return;
  if (!_isRunning) return;

  const task = _taskQueue.GetNextTask();
  if (!task) return;

  _isProcessing = true;
  const requestedByUserId = GetRequestedByUserId(task);
  SetCurrentTaskId(task.id, task.metadata, requestedByUserId);

  console.log(`Processing task: ${task.id} (requestedBy: ${requestedByUserId ?? 'none'})`);

  // メモリ関連の状態
  let memoryRoutingResult: MemoryRoutingResult | null = null;
  let memorySessionId: string | null = null;

  try {
    let result: { success: boolean; output: string; prUrl?: string; error?: string };

    // メモリの実行前処理: ルーティング + コンテキスト構築
    const memoryResult = await BuildMemoryContextForTask(task);
    memoryRoutingResult = memoryResult.routingResult;
    memorySessionId = memoryResult.sessionId;
    const memoryContext = memoryResult.memoryContext;

    if (task.metadata.source === 'github') {
      // GitHub Issue の場合は worktree で処理
      result = await ProcessGitHubTask(task, memoryContext);
    } else if (task.metadata.source === 'slack') {
      // Slack の場合
      const slackMeta = task.metadata as SlackTaskMetadata;
      const sessionStore = GetSessionStore();

      // Issue用スレッドかどうかをチェック
      const linkedIssue = sessionStore.GetIssueForThread(slackMeta.threadTs);

      if (linkedIssue) {
        // Issue用スレッドの場合: Issueのセッションとworktreeを使用
        console.log(`Thread ${slackMeta.threadTs} is linked to issue #${linkedIssue.issueNumber}`);
        result = await ProcessSlackAsIssueTask(task, linkedIssue, memoryContext);
      } else if (slackMeta.targetRepo) {
        // targetRepoが指定されている場合: そのリポジトリのworktreeで作業
        console.log(`Processing with target repo: ${slackMeta.targetRepo}`);
        result = await ProcessSlackWithTargetRepo(task, slackMeta.targetRepo, memoryContext);
      } else {
        // スレッドにtargetRepoが紐づいているかチェック（スラッシュコマンドで開始したスレッド）
        const linkedTargetRepo = sessionStore.GetTargetRepoForThread(slackMeta.threadTs);
        if (linkedTargetRepo) {
          console.log(`Thread ${slackMeta.threadTs} is linked to target repo: ${linkedTargetRepo}`);
          result = await ProcessSlackWithTargetRepo(task, linkedTargetRepo, memoryContext);
        } else {
        // 通常のSlackタスク
        // 同じスレッドの既存セッションを取得（チャネル固有 → canonical userフォールバック）
        const existingSession = sessionStore.Get(slackMeta.threadTs, slackMeta.userId)
          ?? GetCrossChannelSession(task.metadata);
        const existingSessionId = existingSession?.sessionId;
        if (existingSessionId) {
          console.log(`Resuming existing session for thread ${slackMeta.threadTs}: ${existingSessionId}`);
        } else {
          console.log(`Creating new session for thread ${slackMeta.threadTs}`);
        }

        const onWorkLog = CreateWorkLogCallback(task);

        // Slackコンテキスト + メモリコンテキストをプロンプトに追加
        const promptWithContext = task.prompt + BuildSlackContext(
          slackMeta.userId,
          slackMeta.channelId,
          slackMeta.threadTs,
          _config.githubRepos
        ) + memoryContext;

        const workingDirectory = existingSession?.workingDirectory ?? GetWorkspacePath();
        const runResult = await _claudeRunner.Run(task.id, promptWithContext, {
          workingDirectory,
          onWorkLog,
          resumeSessionId: existingSessionId,
          approvalServerPort: _config.approvalServerPort,
        });

        // 新しいセッションIDが返された場合は保存
        if (runResult.sessionId) {
          sessionStore.Set(slackMeta.threadTs, slackMeta.userId, runResult.sessionId, workingDirectory);
          SaveCrossChannelSession(task.metadata, runResult.sessionId, undefined, workingDirectory);
          console.log(`Session saved for thread ${slackMeta.threadTs}: ${runResult.sessionId}`);
        }

        result = runResult;
        }
      }
    } else if (task.metadata.source === 'line') {
      // LINE の場合
      result = await ProcessLineTask(task);
    } else if (task.metadata.source === 'http') {
      // HTTP (M5 Stack等) の場合
      result = await ProcessHttpTask(task);
    } else {
      const _exhaustiveCheck: never = task.metadata;
      result = { success: false, output: '', error: `Unsupported task source: ${(_exhaustiveCheck as TaskMetadata).source}` };
    }

    // タスクを完了としてマーク
    _taskQueue.CompleteTask(task.id, result);

    // 結果を通知（ルーター経由）
    await NotifyResult(task, result);

    // 作業履歴を記録
    RecordTaskCompletion(task, result);

    // メモリの実行後処理: タスク結果のメモリ記録
    RecordMemoryForTask(task, result, memoryRoutingResult, memorySessionId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`Task failed: ${task.id}`, error);

    _taskQueue.CompleteTask(task.id, {
      success: false,
      output: '',
      error: errorMessage,
    });

    // エラーを通知（ルーター経由）
    await _router.notifyError(task.id, task.metadata, errorMessage);
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
  issueInfo: { owner: string; repo: string; issueNumber: number },
  memoryContext: string = ''
): Promise<{ success: boolean; output: string; prUrl?: string; error?: string }> {
  if (!_config || !_claudeRunner || !_router) {
    return { success: false, output: '', error: 'Not initialized' };
  }

  const slackMeta = task.metadata as SlackTaskMetadata;
  const sessionStore = GetSessionStore();

  try {
    // リポジトリをクローン（または更新）
    const repoPath = await GetOrCloneRepo(
      issueInfo.owner,
      issueInfo.repo,
      _config.githubToken
    );

    // 既存の worktree を取得（なければ作成）
    const { worktreeInfo, isExisting } = await GetOrCreateWorktree(
      repoPath,
      issueInfo.owner,
      issueInfo.repo,
      issueInfo.issueNumber
    );

    if (isExisting) {
      await _router.notifyProgress(
        task.id,
        task.metadata,
        Msg('task.resumeIssue', { issueNumber: String(issueInfo.issueNumber) })
      );
    }

    // Issueのセッションを取得
    const existingSession = sessionStore.GetForIssue(
      issueInfo.owner,
      issueInfo.repo,
      issueInfo.issueNumber
    );
    const existingSessionId = existingSession?.sessionId;
    if (existingSessionId) {
      console.log(`Resuming issue session: ${existingSessionId}`);
    } else {
      console.log(`Creating new session for issue #${issueInfo.issueNumber}`);
    }

    const onWorkLog = CreateWorkLogCallback(task);

    // Slackコンテキスト + メモリコンテキストをプロンプトに追加して Claude CLI を実行
    const promptWithContext = task.prompt + BuildSlackContext(
      slackMeta.userId,
      slackMeta.channelId,
      slackMeta.threadTs,
      _config!.githubRepos
    ) + memoryContext;

    const runResult = await _claudeRunner.Run(task.id, promptWithContext, {
      workingDirectory: worktreeInfo.worktreePath,
      onWorkLog,
      resumeSessionId: existingSessionId,
      approvalServerPort: _config.approvalServerPort,
    });

    // セッションIDを保存
    if (runResult.sessionId) {
      sessionStore.SetForIssue(issueInfo.owner, issueInfo.repo, issueInfo.issueNumber, runResult.sessionId, worktreeInfo.worktreePath);
      SaveCrossChannelSession(task.metadata, runResult.sessionId, `${issueInfo.owner}/${issueInfo.repo}`, worktreeInfo.worktreePath);
    }

    // 変更があればコミット＆プッシュ
    const commitMessage = `fix: Issue #${issueInfo.issueNumber} - additional changes`;
    const hasChanges = await CommitAndPush(worktreeInfo, commitMessage);

    if (hasChanges) {
      await _router.notifyProgress(
        task.id,
        task.metadata,
        Msg('task.commitPush')
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
 * 指定されたリポジトリのworktreeでSlackタスクを処理する
 */
async function ProcessSlackWithTargetRepo(
  task: Task,
  targetRepo: string,
  memoryContext: string = ''
): Promise<{ success: boolean; output: string; prUrl?: string; error?: string }> {
  if (!_config || !_claudeRunner || !_router) {
    return { success: false, output: '', error: 'Not initialized' };
  }

  const slackMeta = task.metadata as SlackTaskMetadata;
  const sessionStore = GetSessionStore();

  // owner/repo を分離（バリデーション済みなので必ず2要素）
  const parts = targetRepo.split('/');
  const owner = parts[0] as string;
  const repo = parts[1] as string;

  try {
    // リポジトリをクローン（または更新）
    console.log(`Getting or cloning repo ${targetRepo}...`);
    const repoPath = await GetOrCloneRepo(owner, repo, _config.githubToken);

    // スレッドにtargetRepoを紐づける（同じスレッドでのメンションも同じworktreeで作業するため）
    sessionStore.LinkThreadToTargetRepo(slackMeta.threadTs, targetRepo);

    // スレッドIDからworktree用の識別子を生成（短いハッシュ）
    const threadHash = slackMeta.threadTs.replace('.', '').slice(-8);
    const worktreeIdentifier = parseInt(threadHash, 10) || Date.now();

    // worktree を取得または作成
    const { worktreeInfo, isExisting } = await GetOrCreateWorktree(
      repoPath,
      owner,
      repo,
      worktreeIdentifier
    );

    if (isExisting) {
      await _router.notifyProgress(
        task.id,
        task.metadata,
        Msg('task.resumeBranch', { branch: worktreeInfo.branchName })
      );
    } else {
      await _router.notifyProgress(
        task.id,
        task.metadata,
        Msg('task.startBranch', { branch: worktreeInfo.branchName })
      );
    }

    // セッションを取得（スレッド+ユーザー → canonical userフォールバック）
    const existingSession = sessionStore.Get(slackMeta.threadTs, slackMeta.userId)
      ?? GetCrossChannelSession(task.metadata, targetRepo);
    const existingSessionId = existingSession?.sessionId;
    if (existingSessionId) {
      console.log(`Resuming existing session: ${existingSessionId}`);
    } else {
      console.log(`Creating new session for thread ${slackMeta.threadTs}`);
    }

    const onWorkLog = CreateWorkLogCallback(task);

    // コンテキスト + メモリをプロンプトに追加
    const promptWithContext = task.prompt + BuildSlackRepoContext(
      slackMeta.userId,
      slackMeta.channelId,
      slackMeta.threadTs,
      targetRepo,
      worktreeInfo.branchName
    ) + memoryContext;

    // セッション再開時は既存の作業ディレクトリを使用し、新規時はworktreeパスを使用
    const workingDirectory = existingSession?.workingDirectory ?? worktreeInfo.worktreePath;
    const runResult = await _claudeRunner.Run(task.id, promptWithContext, {
      workingDirectory,
      onWorkLog,
      resumeSessionId: existingSessionId,
      approvalServerPort: _config.approvalServerPort,
    });

    // セッションIDを保存（同じスレッドでの次回メッセージで再開するため）
    if (runResult.sessionId) {
      sessionStore.Set(slackMeta.threadTs, slackMeta.userId, runResult.sessionId, workingDirectory);
      SaveCrossChannelSession(task.metadata, runResult.sessionId, targetRepo, workingDirectory);
      console.log(`Session saved for thread ${slackMeta.threadTs}: ${runResult.sessionId}`);
    }

    return {
      success: runResult.success,
      output: runResult.output,
      prUrl: runResult.prUrl,
      error: runResult.error,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`ProcessSlackWithTargetRepo error: ${errorMessage}`);
    return {
      success: false,
      output: '',
      error: errorMessage,
    };
  }
}

/**
 * LINE タスクを処理する（汎用ワークスペースでセッション継続）
 */
async function ProcessLineTask(
  task: Task
): Promise<{ success: boolean; output: string; prUrl?: string; error?: string }> {
  if (!_config || !_claudeRunner || !_router) {
    return { success: false, output: '', error: 'Not initialized' };
  }

  const lineMeta = task.metadata as LineTaskMetadata;
  const sessionStore = GetSessionStore();

  try {
    // targetRepo が指定されている場合はそのリポジトリの worktree で作業
    if (lineMeta.targetRepo) {
      const parts = lineMeta.targetRepo.split('/');
      const owner = parts[0] as string;
      const repo = parts[1] as string;

      const repoPath = await GetOrCloneRepo(owner, repo, _config.githubToken);
      const worktreeIdentifier = Date.now();
      const { worktreeInfo } = await GetOrCreateWorktree(repoPath, owner, repo, worktreeIdentifier);

      await _router.notifyProgress(
        task.id,
        task.metadata,
        `ブランチ \`${worktreeInfo.branchName}\` で作業を開始いたしますわ`
      );

      // セッションを取得（LINE userId → canonical userフォールバック）
      const existingSession = sessionStore.GetForLine(lineMeta.userId)
        ?? GetCrossChannelSession(task.metadata, lineMeta.targetRepo);
      const existingSessionId = existingSession?.sessionId;

      const onWorkLog = CreateWorkLogCallback(task);
      const promptWithContext = task.prompt + BuildLineContext(lineMeta, _config.githubRepos, lineMeta.targetRepo, worktreeInfo.branchName);
      const workingDirectory = existingSession?.workingDirectory ?? worktreeInfo.worktreePath;

      const runResult = await _claudeRunner.Run(task.id, promptWithContext, {
        workingDirectory,
        onWorkLog,
        resumeSessionId: existingSessionId,
        approvalServerPort: _config.approvalServerPort,
      });

      if (runResult.sessionId) {
        sessionStore.SetForLine(lineMeta.userId, runResult.sessionId, workingDirectory);
        SaveCrossChannelSession(task.metadata, runResult.sessionId, lineMeta.targetRepo, workingDirectory);
      }

      return {
        success: runResult.success,
        output: runResult.output,
        prUrl: runResult.prUrl,
        error: runResult.error,
      };
    }

    // targetRepo なし: 汎用ワークスペースで実行
    // セッション取得（LINE userId → canonical userフォールバック）
    const existingSession = sessionStore.GetForLine(lineMeta.userId)
      ?? GetCrossChannelSession(task.metadata);
    const existingSessionId = existingSession?.sessionId;
    if (existingSessionId) {
      console.log(`Resuming LINE session for ${lineMeta.userId}: ${existingSessionId}`);
    } else {
      console.log(`Creating new LINE session for ${lineMeta.userId}`);
    }

    const onWorkLog = CreateWorkLogCallback(task);
    const promptWithContext = task.prompt + BuildLineContext(lineMeta, _config.githubRepos);
    const workingDirectory = existingSession?.workingDirectory ?? GetWorkspacePath();

    const runResult = await _claudeRunner.Run(task.id, promptWithContext, {
      workingDirectory,
      onWorkLog,
      resumeSessionId: existingSessionId,
      approvalServerPort: _config.approvalServerPort,
    });

    if (runResult.sessionId) {
      sessionStore.SetForLine(lineMeta.userId, runResult.sessionId, workingDirectory);
      SaveCrossChannelSession(task.metadata, runResult.sessionId, undefined, workingDirectory);
      console.log(`LINE session saved for ${lineMeta.userId}: ${runResult.sessionId}`);
    }

    return runResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`ProcessLineTask error: ${errorMessage}`);
    return {
      success: false,
      output: '',
      error: errorMessage,
    };
  }
}

/**
 * HTTP タスクを処理する（汎用ワークスペースでセッション継続）
 */
async function ProcessHttpTask(
  task: Task
): Promise<{ success: boolean; output: string; prUrl?: string; error?: string }> {
  if (!_config || !_claudeRunner || !_router) {
    return { success: false, output: '', error: 'Not initialized' };
  }

  const httpMeta = task.metadata as HttpTaskMetadata;
  const sessionStore = GetSessionStore();

  try {
    // targetRepo が指定されている場合はそのリポジトリの worktree で作業
    if (httpMeta.targetRepo) {
      const parts = httpMeta.targetRepo.split('/');
      const owner = parts[0] as string;
      const repo = parts[1] as string;

      const repoPath = await GetOrCloneRepo(owner, repo, _config.githubToken);
      const worktreeIdentifier = Date.now();
      const { worktreeInfo } = await GetOrCreateWorktree(repoPath, owner, repo, worktreeIdentifier);

      await _router.notifyProgress(task.id, task.metadata, `Branch: ${worktreeInfo.branchName}`);

      // セッション取得（HTTP correlationId → canonical userフォールバック）
      const existingSession = sessionStore.GetForHttp(httpMeta.correlationId)
        ?? GetCrossChannelSession(task.metadata, httpMeta.targetRepo);
      const existingSessionId = existingSession?.sessionId;

      const onWorkLog = CreateWorkLogCallback(task);
      const promptWithContext = task.prompt + BuildHttpContext(httpMeta, _config.githubRepos, httpMeta.targetRepo, worktreeInfo.branchName);
      const workingDirectory = existingSession?.workingDirectory ?? worktreeInfo.worktreePath;

      const runResult = await _claudeRunner.Run(task.id, promptWithContext, {
        workingDirectory,
        onWorkLog,
        resumeSessionId: existingSessionId,
        approvalServerPort: _config.approvalServerPort,
      });

      if (runResult.sessionId) {
        sessionStore.SetForHttp(httpMeta.correlationId, runResult.sessionId, workingDirectory);
        SaveCrossChannelSession(task.metadata, runResult.sessionId, httpMeta.targetRepo, workingDirectory);
      }

      return {
        success: runResult.success,
        output: runResult.output,
        prUrl: runResult.prUrl,
        error: runResult.error,
      };
    }

    // targetRepo なし: 汎用ワークスペースで実行
    // セッション取得（HTTP correlationId → canonical userフォールバック）
    const existingSession = sessionStore.GetForHttp(httpMeta.correlationId)
      ?? GetCrossChannelSession(task.metadata);
    const existingSessionId = existingSession?.sessionId;

    const onWorkLog = CreateWorkLogCallback(task);
    const promptWithContext = task.prompt + BuildHttpContext(httpMeta, _config.githubRepos);
    const workingDirectory = existingSession?.workingDirectory ?? GetWorkspacePath();

    const runResult = await _claudeRunner.Run(task.id, promptWithContext, {
      workingDirectory,
      onWorkLog,
      resumeSessionId: existingSessionId,
      approvalServerPort: _config.approvalServerPort,
    });

    if (runResult.sessionId) {
      sessionStore.SetForHttp(httpMeta.correlationId, runResult.sessionId, workingDirectory);
      SaveCrossChannelSession(task.metadata, runResult.sessionId, undefined, workingDirectory);
    }

    return runResult;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`ProcessHttpTask error: ${errorMessage}`);
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
  task: Task,
  memoryContext: string = ''
): Promise<{ success: boolean; output: string; prUrl?: string; error?: string }> {
  if (!_config || !_claudeRunner || !_router) {
    return { success: false, output: '', error: 'Not initialized' };
  }

  const meta = task.metadata as GitHubTaskMetadata;
  const threadTs = meta.slackThreadTs;
  const sessionStore = GetSessionStore();

  try {
    // リポジトリをクローン（または更新）
    console.log(`Getting or cloning repo ${meta.owner}/${meta.repo}...`);
    const repoPath = await GetOrCloneRepo(meta.owner, meta.repo, _config.githubToken);

    // 既存の worktree があれば再利用、なければ新規作成
    console.log(`Getting or creating worktree for issue #${meta.issueNumber}...`);

    const { worktreeInfo, isExisting } = await GetOrCreateWorktree(
      repoPath,
      meta.owner,
      meta.repo,
      meta.issueNumber
    );

    if (isExisting) {
      await _router.notifyProgress(
        task.id,
        task.metadata,
        Msg('task.resumeBranch', { branch: worktreeInfo.branchName })
      );
    } else {
      await _router.notifyProgress(
        task.id,
        task.metadata,
        Msg('task.startBranch', { branch: worktreeInfo.branchName })
      );
    }

    // 同じIssueの既存セッションを取得
    const existingSession = sessionStore.GetForIssue(meta.owner, meta.repo, meta.issueNumber);
    const existingSessionId = existingSession?.sessionId;
    if (existingSessionId) {
      console.log(`Resuming existing session for issue #${meta.issueNumber}: ${existingSessionId}`);
      await _router.notifyProgress(
        task.id,
        task.metadata,
        Msg('task.resumeSession')
      );
    } else {
      console.log(`Creating new session for issue #${meta.issueNumber}`);
    }

    // Claude 用のプロンプトを構築（GitHub情報とSlack情報 + メモリを含む）
    const worktreePrompt = task.prompt + BuildGitHubContext(
      meta,
      worktreeInfo.branchName,
      _config.slackChannelId,
      threadTs
    ) + memoryContext;

    await _router.notifyProgress(task.id, task.metadata, Msg('task.startClaude'));

    const onWorkLog = CreateWorkLogCallback(task);

    const runResult = await _claudeRunner.Run(task.id, worktreePrompt, {
      workingDirectory: worktreeInfo.worktreePath,
      onWorkLog,
      resumeSessionId: existingSessionId,
      approvalServerPort: _config.approvalServerPort,
    });

    // セッションIDを保存
    if (runResult.sessionId) {
      sessionStore.SetForIssue(meta.owner, meta.repo, meta.issueNumber, runResult.sessionId, worktreeInfo.worktreePath);
      SaveCrossChannelSession(task.metadata, runResult.sessionId, `${meta.owner}/${meta.repo}`, worktreeInfo.worktreePath);
    }

    // Claude CLIの結果をそのまま返す（コミット・PR作成はLLMが判断して実行）
    return {
      success: runResult.success,
      output: runResult.output,
      prUrl: runResult.prUrl,
      error: runResult.error,
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
 * 結果を通知する（ルーター経由）
 */
async function NotifyResult(
  task: Task,
  result: { success: boolean; output: string; prUrl?: string; error?: string }
): Promise<void> {
  if (!_config || !_router) return;

  if (result.success) {
    // Claudeの出力を送信（長すぎる場合は切り詰め）
    const maxLength = 3000;
    let message = result.output.trim();
    if (message.length > maxLength) {
      message = message.slice(0, maxLength) + '\n...(省略)';
    }
    if (!message) {
      message = Msg('task.completeNoOutput');
    }

    await _router.notifyTaskCompleted(
      task.id,
      task.metadata,
      message,
      result.prUrl
    );

    // GitHub Issue の場合はコメントを投稿
    if (task.metadata.source === 'github') {
      const meta = task.metadata as GitHubTaskMetadata;
      let comment = Msg('task.completeComment');
      if (result.prUrl) {
        comment += Msg('task.completeCommentPr', { prUrl: result.prUrl });
      }
      await PostIssueComment(meta.owner, meta.repo, meta.issueNumber, comment);
    }
  } else {
    await _router.notifyError(
      task.id,
      task.metadata,
      result.error ?? '不明なエラー'
    );
  }
}

/**
 * タスクから承認権限を持つユーザーIDを取得する
 */
function GetRequestedByUserId(task: Task): string | undefined {
  if (task.metadata.source === 'slack') {
    // Slackからのリクエストはそのユーザーが承認権限を持つ
    return task.metadata.userId;
  }

  if (task.metadata.source === 'github') {
    // GitHubからのリクエストはマッピングから解決
    const githubUser = task.metadata.requestingUser;
    if (githubUser) {
      const slackUserId = GetSlackUserForGitHub(githubUser);
      if (slackUserId) {
        return slackUserId;
      }
    }
    // マッピングがない場合は管理者に通知
    return GetAdminSlackUser();
  }

  if (task.metadata.source === 'line') {
    // LINEからのリクエストは LINE userId（承認は LINE アダプタ経由で処理）
    return (task.metadata as LineTaskMetadata).userId;
  }

  if (task.metadata.source === 'http') {
    // HTTPからのリクエストは deviceId（承認は HTTP アダプタ経由で処理）
    return (task.metadata as HttpTaskMetadata).deviceId;
  }

  return undefined;
}

/**
 * Slackコンテキスト情報をプロンプトに追加する
 */
function BuildSlackContext(
  userId: string,
  channelId: string,
  threadTs: string,
  githubRepos: readonly string[]
): string {
  const reposList = githubRepos.map(repo => `  - ${repo}`).join('\n');
  return `
---
Slackコンテキスト情報:
- Channel ID: ${channelId}
- Thread TS: ${threadTs}
- User ID: ${userId}
- このユーザーへの返信は <@${userId}> でメンションできます

監視対象GitHubリポジトリ:
${reposList}
---`;
}

/**
 * 指定リポジトリでのSlackコンテキスト情報をプロンプトに追加する
 */
function BuildSlackRepoContext(
  userId: string,
  channelId: string,
  threadTs: string,
  targetRepo: string,
  branchName: string
): string {
  return `
---
Slackコンテキスト情報:
- Channel ID: ${channelId}
- Thread TS: ${threadTs}
- User ID: ${userId}
- このユーザーへの返信は <@${userId}> でメンションできます

作業リポジトリ:
- リポジトリ: ${targetRepo}
- 作業ブランチ: ${branchName}

目標:
- リクエストされた内容を実装してください
- 実装が完了したら、コミットしてPull Requestを作成してください
---`;
}

/**
 * GitHub Issueコンテキスト情報をプロンプトに追加する
 */
function BuildGitHubContext(
  meta: GitHubTaskMetadata,
  branchName: string,
  slackChannelId: string,
  slackThreadTs?: string
): string {
  return `
---
GitHub Issue コンテキスト:
- リポジトリ: ${meta.owner}/${meta.repo}
- Issue: #${meta.issueNumber} - ${meta.issueTitle}
- Issue URL: ${meta.issueUrl}
- 作業ブランチ: ${branchName}
${meta.requestingUser ? `- リクエストユーザー: ${meta.requestingUser}` : ''}

Slack通知先:
- Channel ID: ${slackChannelId}
${slackThreadTs ? `- Thread TS: ${slackThreadTs}` : ''}

目標:
- このIssueを解決するコードを実装してください
- 実装が完了したら、コミットしてPull Requestを作成してください
- PRのタイトルには Issue番号を含めてください（例: fix: #${meta.issueNumber} - 説明）
---`;
}

/**
 * LINEコンテキスト情報をプロンプトに追加する
 */
function BuildLineContext(
  meta: LineTaskMetadata,
  githubRepos: readonly string[],
  targetRepo?: string,
  branchName?: string
): string {
  const reposList = githubRepos.map(repo => `  - ${repo}`).join('\n');
  let context = `
---
LINEコンテキスト情報:
- ソース: LINE Bot
- User ID: ${meta.userId}

監視対象GitHubリポジトリ:
${reposList}`;

  if (targetRepo && branchName) {
    context += `

作業リポジトリ:
- リポジトリ: ${targetRepo}
- 作業ブランチ: ${branchName}

目標:
- リクエストされた内容を実装してください
- 実装が完了したら、コミットしてPull Requestを作成してください`;
  }

  context += '\n---';
  return context;
}

/**
 * HTTPコンテキスト情報をプロンプトに追加する
 */
function BuildHttpContext(
  meta: HttpTaskMetadata,
  githubRepos: readonly string[],
  targetRepo?: string,
  branchName?: string
): string {
  const reposList = githubRepos.map(repo => `  - ${repo}`).join('\n');
  let context = `
---
HTTPコンテキスト情報:
- ソース: HTTP API
- Correlation ID: ${meta.correlationId}
${meta.deviceId ? `- Device ID: ${meta.deviceId}` : ''}

監視対象GitHubリポジトリ:
${reposList}`;

  if (targetRepo && branchName) {
    context += `

作業リポジトリ:
- リポジトリ: ${targetRepo}
- 作業ブランチ: ${branchName}

目標:
- リクエストされた内容を実装してください
- 実装が完了したら、コミットしてPull Requestを作成してください`;
  }

  context += '\n---';
  return context;
}

/**
 * 作業ログをチャネルに投稿するコールバックを生成する（ルーター経由）
 */
function CreateWorkLogCallback(
  task: Task
): (log: WorkLog) => void {
  let lastWorkLogTime = 0;

  return async (log: WorkLog) => {
    // 投稿するログタイプを絞る：現在何をしているか（tool_start）と許可・不許可（approval_pending）のみ
    if (log.type !== 'tool_start' && log.type !== 'approval_pending') {
      return;
    }

    const now = Date.now();
    // approval_pending は常に投稿、それ以外は間隔を空ける
    if (log.type !== 'approval_pending') {
      if (now - lastWorkLogTime < WORK_LOG_INTERVAL_MS) return;
    }
    lastWorkLogTime = now;

    try {
      await _router?.notifyWorkLog(
        task.id,
        task.metadata,
        log.type,
        log.message,
        log.details
      );
    } catch (e) {
      console.error('Failed to post work log:', e);
    }
  };
}

/**
 * チャネル横断セッション: タスク完了時にcanonical userキーにもセッションを保存する
 */
function SaveCrossChannelSession(
  metadata: TaskMetadata,
  sessionId: string,
  targetRepo?: string,
  workingDirectory?: string
): void {
  const sessionStore = GetSessionStore();
  const config = GetAdminConfig();
  const platformUserId = GetPlatformUserId(metadata);
  if (!platformUserId) return;

  const canonicalUserId = sessionStore.ResolveCanonicalUserId(
    metadata.source,
    platformUserId,
    config.userMappings
  );
  if (!canonicalUserId) return;

  sessionStore.SetForUser(canonicalUserId, sessionId, targetRepo, workingDirectory);
  console.log(`Cross-channel session saved: user:${canonicalUserId}:${targetRepo ?? 'default'} -> ${sessionId}`);
}

/**
 * チャネル横断セッション: canonical userキーからセッションを検索する（フォールバック用）
 */
function GetCrossChannelSession(
  metadata: TaskMetadata,
  targetRepo?: string
): import('./session/store.js').SessionResult | undefined {
  const sessionStore = GetSessionStore();
  const config = GetAdminConfig();
  const platformUserId = GetPlatformUserId(metadata);
  if (!platformUserId) return undefined;

  const canonicalUserId = sessionStore.ResolveCanonicalUserId(
    metadata.source,
    platformUserId,
    config.userMappings
  );
  if (!canonicalUserId) return undefined;

  return sessionStore.GetForUser(canonicalUserId, targetRepo);
}

/**
 * メタデータからプラットフォーム固有のユーザーIDを取得する
 */
function GetPlatformUserId(metadata: TaskMetadata): string | undefined {
  switch (metadata.source) {
    case 'slack': return (metadata as SlackTaskMetadata).userId;
    case 'github': return (metadata as GitHubTaskMetadata).requestingUser;
    case 'line': return (metadata as LineTaskMetadata).userId;
    case 'http': return (metadata as HttpTaskMetadata).deviceId;
  }
}

/**
 * タスクメタデータからメモリソースを構築する
 */
function BuildMemorySource(task: Task): MemorySource {
  if (task.metadata.source === 'slack') {
    const meta = task.metadata as SlackTaskMetadata;
    return {
      channel: 'slack',
      channelId: meta.channelId,
      threadTs: meta.threadTs,
    };
  }
  const meta = task.metadata as GitHubTaskMetadata;
  return {
    channel: 'github',
    owner: meta.owner,
    repo: meta.repo,
    issueNumber: meta.issueNumber,
  };
}

/**
 * タスクからユーザーIDを取得する
 */
function GetUserId(task: Task): string {
  if (task.metadata.source === 'slack') {
    return (task.metadata as SlackTaskMetadata).userId;
  }
  const meta = task.metadata as GitHubTaskMetadata;
  return meta.requestingUser ?? 'unknown';
}

/**
 * メモリの実行前処理: ルーティング + コンテキスト構築
 */
async function BuildMemoryContextForTask(
  task: Task
): Promise<{ memoryContext: string; routingResult: MemoryRoutingResult | null; sessionId: string | null }> {
  if (!_config?.memoryConfig.enabled) {
    return { memoryContext: '', routingResult: null, sessionId: null };
  }

  try {
    const router = GetMemoryRouter(_config.memoryConfig);
    const injector = GetMemoryInjector(_config.memoryConfig);
    const store = GetMemoryStore(_config.memoryConfig);
    const source = BuildMemorySource(task);

    // ルーティング
    console.log(`BuildMemoryContextForTask: starting RouteConversation for task ${task.id}`);
    const routingResult = await router.RouteConversation(task.prompt);
    console.log(`BuildMemoryContextForTask: RouteConversation completed for task ${task.id}, project=${routingResult.primaryPath.projectName}, confidence=${routingResult.confidence}`);

    // 新規プロジェクトの場合は作成
    if (routingResult.isNew) {
      const description = routingResult.suggestedDescription ?? task.prompt.slice(0, 100);
      store.CreateProject(routingResult.primaryPath, description);

      RecordMemoryEvent({
        type: 'memory_created',
        projectName: routingResult.primaryPath.projectName,
        timestamp: new Date().toISOString(),
        details: `新規プロジェクト作成: ${routingResult.primaryPath.abstractCategory}/${routingResult.primaryPath.concreteCategory}/${routingResult.primaryPath.projectName}`,
      }, GetUserId(task));
    }

    // 固定記憶検出（LLMベース）
    if (routingResult.pinnedContent) {
      store.AppendPinned(routingResult.primaryPath, {
        content: routingResult.pinnedContent,
        originalPrompt: task.prompt.slice(0, 200),
        source,
      });
      console.log(`Memory: Pinned content detected by LLM and saved for ${routingResult.primaryPath.projectName}`);
    }

    // セッションメモリを作成（新規セッション）
    const sessionId = `task-${task.id}`;
    store.CreateSessionMemory(routingResult.primaryPath, sessionId, source);

    // ルーティングイベントを記録
    RecordMemoryEvent({
      type: 'memory_routed',
      projectName: routingResult.primaryPath.projectName,
      timestamp: new Date().toISOString(),
      details: `ルーティング: confidence=${routingResult.confidence}, isNew=${routingResult.isNew}`,
    }, GetUserId(task));

    // メモリコンテキストを構築
    const memoryContext = await injector.BuildMemoryContext(routingResult);

    return { memoryContext, routingResult, sessionId };
  } catch (error) {
    console.error('Memory pre-processing error (continuing without memory):', error);
    return { memoryContext: '', routingResult: null, sessionId: null };
  }
}

/**
 * メモリの実行後処理: タスク結果のメモリ記録
 */
function RecordMemoryForTask(
  task: Task,
  result: { success: boolean; output: string },
  routingResult: MemoryRoutingResult | null,
  sessionId: string | null
): void {
  if (!_config?.memoryConfig.enabled || !routingResult || !sessionId) return;

  try {
    const store = GetMemoryStore(_config.memoryConfig);
    const source = BuildMemorySource(task);

    // セッションメモリにタスク結果の要約を追記
    const summary = result.output.trim().slice(0, 300);
    store.AppendSessionMemory(routingResult.primaryPath, sessionId, {
      content: `タスク${result.success ? '完了' : '失敗'}: ${summary}`,
      source,
    });

    // MEMORY.md の活動セクションに追記
    const activitySummary = result.success
      ? `タスク完了: ${task.prompt.slice(0, 100)}`
      : `タスク失敗: ${task.prompt.slice(0, 100)}`;
    store.AppendMemory(routingResult.primaryPath, {
      content: activitySummary,
      source,
    });

    // メモリ更新イベントを記録
    RecordMemoryEvent({
      type: 'memory_updated',
      projectName: routingResult.primaryPath.projectName,
      timestamp: new Date().toISOString(),
      details: `タスク結果を記録: ${result.success ? '成功' : '失敗'}`,
    }, GetUserId(task));

    // 概要化トリガー (T020)
    const summarizer = GetMemorySummarizer(_config.memoryConfig);
    if (summarizer.ShouldSummarize(routingResult.primaryPath)) {
      console.log(`Memory: Triggering summarization for ${routingResult.primaryPath.projectName}`);
      // 非同期で概要化を実行（タスク完了をブロックしない）
      void summarizer.Summarize(routingResult.primaryPath).then((summarizeResult) => {
        if (summarizeResult.success) {
          RecordMemoryEvent({
            type: 'memory_summarized',
            projectName: routingResult!.primaryPath.projectName,
            timestamp: new Date().toISOString(),
            details: `概要化完了: ${summarizeResult.originalSize} -> ${summarizeResult.newSize} bytes`,
          }, GetUserId(task));
        }
      }).catch((err) => {
        console.error('Memory summarization failed:', err);
      });
    }
  } catch (error) {
    // メモリの失敗がタスク完了を阻害しないよう保護
    console.error('Memory post-processing error (task completion unaffected):', error);
  }
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
        text: Msg('morning.greeting'),
      });
    }
  } catch (error) {
    console.error('Failed to start claps:', error);
    process.exit(1);
  }
}

Main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
