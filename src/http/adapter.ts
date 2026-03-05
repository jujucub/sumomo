/**
 * claps - HTTP チャネルアダプタ (M5 Stack 等のデバイス向け)
 * REST API ベースのポーリング型チャネル
 */

import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  TaskSource,
  Config,
  HttpTaskMetadata,
  ApprovalResult,
  ApprovalDecision,
  ReflectionResult,
  HealthStatus,
  NotificationContext,
  AdapterCallbacks,
} from '../types/index.js';
import type { ChannelAdapter } from '../channel/adapter.js';
import { CreateHttpApiRouter, type PendingTaskState, type PendingApprovalInfo, type PendingQuestionInfo } from './routes.js';
import type { AdapterRegistry } from '../channel/registry.js';
import type { Express } from 'express';
import type { Server } from 'http';
import { GetClapsDir } from '../git/repo.js';

// 認証トークンファイルパスを取得する（遅延評価）
function GetAuthTokenFile(): string {
  return path.join(GetClapsDir(), 'auth-token');
}

/**
 * Deferred Promise
 */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function CreateDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * HttpAdapter
 * REST API ベースの HTTP チャネル（M5 Stack 等のデバイス向け）
 * 承認サーバーの Express インスタンスにルートをマウントするか、独立サーバーを起動する
 */
export class HttpAdapter implements ChannelAdapter {
  private readonly _config: Config;
  private _registry: AdapterRegistry | undefined;
  private _callbacks: AdapterCallbacks | undefined;
  private _started = false;
  private _expressApp: Express | undefined;
  private _server: Server | undefined;

  // タスク状態の in-memory マップ（ポーリング用）
  private readonly _taskStates = new Map<string, PendingTaskState>();

  // 承認/質問の Deferred Promise マップ
  private readonly _pendingApprovals = new Map<string, Deferred<ApprovalResult>>();
  private readonly _pendingQuestions = new Map<string, Deferred<string>>();

  constructor(config: Config, registry: AdapterRegistry) {
    this._config = config;
    this._registry = registry;
  }

  getName(): string {
    return 'http';
  }

  getSource(): TaskSource {
    return 'http';
  }

  // --- Lifecycle ---

  async init(callbacks: AdapterCallbacks): Promise<void> {
    this._callbacks = callbacks;
    console.log('[HttpAdapter] Initialized');
  }

  async start(): Promise<void> {
    if (!this._callbacks || !this._registry) {
      throw new Error('HttpAdapter not initialized');
    }

    const httpConfig = this._config.channelConfig.http;
    if (!httpConfig) {
      throw new Error('HTTP channel config is not set');
    }

    // Express アプリを作成
    this._expressApp = express();
    this._expressApp.use(express.json());

    // HTTP API ルーターをマウント
    const apiRouter = CreateHttpApiRouter({
      getTaskState: (taskId) => this._taskStates.get(taskId),
      onMessage: (message, deviceId, targetRepo) => this._handleMessage(message, deviceId, targetRepo),
      onApprovalResponse: (taskId, requestId, decision, comment) =>
        this._handleApprovalResponse(taskId, requestId, decision, comment),
      onAnswerResponse: (taskId, requestId, answer) =>
        this._handleAnswerResponse(taskId, requestId, answer),
      registry: this._registry,
      validateToken: (token) => this._validateToken(token),
      isDeviceAllowed: (deviceId) => this.isUserAllowed(deviceId ?? ''),
    });
    this._expressApp.use('/api/v1', apiRouter);

    // 独立ポートで起動（httpConfig.port が指定されている場合）、なければ承認サーバーと同じポートに相乗り
    const port = httpConfig.port;
    if (port) {
      await new Promise<void>((resolve, reject) => {
        this._server = this._expressApp!.listen(port, () => {
          console.log(`[HttpAdapter] HTTP API server started on port ${port}`);
          resolve();
        });
        this._server.on('error', reject);
      });
    } else {
      // 承認サーバーの Express にマウント
      const { GetExpressApp } = await import('../approval/server.js');
      const approvalApp = GetExpressApp();
      if (approvalApp) {
        approvalApp.use('/api/v1', apiRouter);
        console.log('[HttpAdapter] HTTP API routes mounted on approval server');
      } else {
        throw new Error('Approval server Express app not available for mounting HTTP routes');
      }
    }

    this._started = true;
    console.log('[HttpAdapter] Started successfully');
  }

  async stop(): Promise<void> {
    if (this._server) {
      await new Promise<void>((resolve) => {
        this._server!.close(() => {
          console.log('[HttpAdapter] HTTP API server stopped');
          resolve();
        });
      });
      this._server = undefined;
    }
    this._started = false;
  }

  getHealth(): HealthStatus {
    return {
      name: this.getName(),
      status: this._started ? 'healthy' : 'stopped',
    };
  }

  // --- Auth ---

  isUserAllowed(deviceId: string): boolean {
    // ホワイトリストが空の場合は全デバイスを許可（ローカル環境想定）
    if (this._config.allowedUsers.http.length === 0) return true;
    return this._config.allowedUsers.http.includes(deviceId);
  }

  // --- Internal Handlers ---

  /**
   * 新規メッセージの処理 → タスク起動
   * @returns 生成されたタスクID（correlationId）
   */
  private _handleMessage(message: string, deviceId: string | undefined, targetRepo: string | undefined): string {
    const correlationId = uuidv4();

    // タスク状態を初期化
    this._taskStates.set(correlationId, {
      taskId: correlationId,
      status: 'queued',
      progressMessages: [],
    });

    // メタデータを構築
    const metadata: HttpTaskMetadata = {
      source: 'http',
      correlationId,
      deviceId,
      messageText: message,
      targetRepo,
    };

    // タスクをキューに追加
    if (this._callbacks) {
      void this._callbacks.onMessage(metadata, message);
    }

    return correlationId;
  }

  /**
   * 承認応答の処理
   */
  private _handleApprovalResponse(
    _taskId: string,
    requestId: string,
    decision: ApprovalDecision,
    comment?: string
  ): boolean {
    const deferred = this._pendingApprovals.get(requestId);
    if (!deferred) return false;

    this._pendingApprovals.delete(requestId);
    deferred.resolve({ decision, comment });

    // タスク状態を更新
    for (const state of this._taskStates.values()) {
      if (state.pending && state.pending.type === 'approval' && state.pending.id === requestId) {
        state.status = 'processing';
        state.pending = null;
        break;
      }
    }

    console.log(`[HttpAdapter] Approval ${decision} for ${requestId}`);
    return true;
  }

  /**
   * 質問応答の処理
   */
  private _handleAnswerResponse(_taskId: string, requestId: string, answer: string): boolean {
    const deferred = this._pendingQuestions.get(requestId);
    if (!deferred) return false;

    this._pendingQuestions.delete(requestId);
    deferred.resolve(answer);

    // タスク状態を更新
    for (const state of this._taskStates.values()) {
      if (state.pending && state.pending.type === 'question' && state.pending.id === requestId) {
        state.status = 'processing';
        state.pending = null;
        break;
      }
    }

    console.log(`[HttpAdapter] Answer "${answer}" for ${requestId}`);
    return true;
  }

  /**
   * Bearer token を検証する
   */
  private _validateToken(token: string): boolean {
    try {
      if (!fs.existsSync(GetAuthTokenFile())) return false;
      const storedToken = fs.readFileSync(GetAuthTokenFile(), 'utf-8').trim();
      if (storedToken.length === 0) return false;

      // タイミング攻撃を防ぐため定数時間比較
      const tokenBuffer = Buffer.from(token);
      const storedBuffer = Buffer.from(storedToken);
      if (tokenBuffer.length !== storedBuffer.length) return false;
      return crypto.timingSafeEqual(tokenBuffer, storedBuffer);
    } catch {
      return false;
    }
  }

  // --- Task State Management ---

  /**
   * correlationId からタスク状態を検索する
   */
  private _findState(context: NotificationContext): PendingTaskState | undefined {
    if (context.metadata.source !== 'http') return undefined;
    const httpMeta = context.metadata as HttpTaskMetadata;
    return this._taskStates.get(httpMeta.correlationId);
  }

  // --- Messaging ---

  async sendMessage(context: NotificationContext, message: string): Promise<void> {
    const state = this._findState(context);
    if (state) {
      state.progressMessages.push(message);
    }
  }

  async sendSplitMessage(context: NotificationContext, message: string): Promise<void> {
    // HTTP はポーリング型なので分割不要、そのまま蓄積
    await this.sendMessage(context, message);
  }

  // --- Approval ---

  async requestApproval(
    context: NotificationContext,
    requestId: string,
    tool: string,
    command: string,
    _requestedByUserId?: string
  ): Promise<ApprovalResult> {
    const state = this._findState(context);
    if (!state) {
      return { decision: 'deny' };
    }

    // Deferred Promise を作成
    const deferred = CreateDeferred<ApprovalResult>();
    this._pendingApprovals.set(requestId, deferred);

    // タスク状態を awaiting_approval に更新
    const pendingInfo: PendingApprovalInfo = {
      type: 'approval',
      id: requestId,
      tool,
      command: command.slice(0, 500),
      timestamp: new Date().toISOString(),
    };
    state.status = 'awaiting_approval';
    state.pending = pendingInfo;

    return deferred.promise;
  }

  // --- Question ---

  async askQuestion(
    context: NotificationContext,
    requestId: string,
    question: string,
    options: readonly string[]
  ): Promise<string> {
    const state = this._findState(context);
    if (!state) {
      return '';
    }

    // Deferred Promise を作成
    const deferred = CreateDeferred<string>();
    this._pendingQuestions.set(requestId, deferred);

    // タスク状態を awaiting_answer に更新
    const pendingInfo: PendingQuestionInfo = {
      type: 'question',
      id: requestId,
      question,
      options,
      timestamp: new Date().toISOString(),
    };
    state.status = 'awaiting_answer';
    state.pending = pendingInfo;

    return deferred.promise;
  }

  // --- Notifications ---

  async notifyTaskStarted(context: NotificationContext, description: string): Promise<void> {
    const state = this._findState(context);
    if (state) {
      state.status = 'processing';
      state.progressMessages.push(`Task started: ${description}`);
    }
  }

  async notifyTaskCompleted(context: NotificationContext, message: string, prUrl?: string): Promise<void> {
    const state = this._findState(context);
    if (state) {
      state.status = 'completed';
      state.result = {
        success: true,
        output: message,
        prUrl,
      };
      state.pending = null;
    }
  }

  async notifyError(context: NotificationContext, error: string): Promise<void> {
    const state = this._findState(context);
    if (state) {
      state.status = 'failed';
      state.result = {
        success: false,
        output: '',
        error,
      };
      state.pending = null;
    }
  }

  async notifyProgress(context: NotificationContext, message: string): Promise<void> {
    const state = this._findState(context);
    if (state) {
      state.progressMessages.push(message);
    }
  }

  async notifyWorkLog(
    context: NotificationContext,
    _logType: string,
    message: string,
    _details?: string
  ): Promise<void> {
    const state = this._findState(context);
    if (state) {
      state.progressMessages.push(message);
    }
  }

  // --- Special ---

  async postReflectionResult(_result: ReflectionResult): Promise<void> {
    // HTTP チャネルでは内省レポートはポーリング対象外（no-op）
  }

  async createIssueThread(
    _owner: string,
    _repo: string,
    _issueNumber: number,
    _issueTitle: string,
    _issueUrl: string
  ): Promise<string> {
    // HTTP にはスレッド概念がないため no-op
    return '';
  }
}
