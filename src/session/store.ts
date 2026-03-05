/**
 * claps - セッションストア
 * Slackスレッド/GitHub IssueとClaudeセッションIDを管理する
 * ~/.claps/sessions.json に永続化してプロセス再起動に対応する
 */

import fs from 'fs';
import path from 'path';
import type { TaskSource, UserMapping } from '../types/index.js';
import { GetClapsDir } from '../git/repo.js';

// セッション取得時の戻り値型
export interface SessionResult {
  readonly sessionId: string;
  readonly workingDirectory?: string;
}

// セッション情報
interface SessionInfo {
  readonly sessionId: string;
  readonly workingDirectory?: string;
  readonly createdAt: Date;
  lastUsedAt: Date;
}

// Issue情報（スレッドとIssueの紐付け用）
interface IssueInfo {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
}

// セッションキー
// Slack: slack:{threadTs}:{userId}
// GitHub: github:{owner}/{repo}#{issueNumber}
type SessionKey = string;

// 永続化用のシリアライズ形式
interface SerializedSessionInfo {
  readonly sessionId: string;
  readonly workingDirectory?: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

interface SerializedStore {
  readonly sessions: Record<string, SerializedSessionInfo>;
  readonly threadToIssue: Record<string, IssueInfo>;
  readonly threadToTargetRepo: Record<string, string>;
}

// 永続化ファイルパスを取得する（遅延評価）
function GetSessionsFile(): string {
  return path.join(GetClapsDir(), 'sessions.json');
}

/**
 * セッションストアクラス
 */
class SessionStore {
  private _sessions: Map<SessionKey, SessionInfo>;
  private _threadToIssue: Map<string, IssueInfo>; // threadTs -> IssueInfo
  private _threadToTargetRepo: Map<string, string>; // threadTs -> targetRepo (owner/repo)
  private readonly _maxAge: number; // セッションの最大有効期間（ミリ秒）

  constructor(maxAgeHours: number = 24) {
    this._sessions = new Map();
    this._threadToIssue = new Map();
    this._threadToTargetRepo = new Map();
    this._maxAge = maxAgeHours * 60 * 60 * 1000;
    this._load();
  }

  /**
   * ファイルからセッションデータを読み込む
   */
  private _load(): void {
    try {
      if (!fs.existsSync(GetSessionsFile())) {
        return;
      }

      const data = fs.readFileSync(GetSessionsFile(), 'utf-8');
      const parsed = JSON.parse(data) as Partial<SerializedStore>;
      const now = Date.now();

      // セッションを復元（期限切れは除外）
      if (parsed.sessions && typeof parsed.sessions === 'object') {
        for (const [key, info] of Object.entries(parsed.sessions)) {
          const lastUsedAt = new Date(info.lastUsedAt);
          if (now - lastUsedAt.getTime() <= this._maxAge) {
            this._sessions.set(key, {
              sessionId: info.sessionId,
              workingDirectory: info.workingDirectory,
              createdAt: new Date(info.createdAt),
              lastUsedAt,
            });
          }
        }
      }

      // スレッド→Issue紐付けを復元
      if (parsed.threadToIssue && typeof parsed.threadToIssue === 'object') {
        for (const [threadTs, issueInfo] of Object.entries(parsed.threadToIssue)) {
          this._threadToIssue.set(threadTs, issueInfo);
        }
      }

      // スレッド→ターゲットリポジトリ紐付けを復元
      if (parsed.threadToTargetRepo && typeof parsed.threadToTargetRepo === 'object') {
        for (const [threadTs, targetRepo] of Object.entries(parsed.threadToTargetRepo)) {
          this._threadToTargetRepo.set(threadTs, targetRepo);
        }
      }

      console.log(`Sessions loaded: ${this._sessions.size} sessions, ${this._threadToIssue.size} issue links, ${this._threadToTargetRepo.size} repo links`);
    } catch (error) {
      console.error('Failed to load sessions:', error);
    }
  }

  /**
   * セッションデータをファイルに保存する
   */
  private _save(): void {
    try {
      if (!fs.existsSync(GetClapsDir())) {
        fs.mkdirSync(GetClapsDir(), { recursive: true, mode: 0o700 });
      }

      const serialized: SerializedStore = {
        sessions: Object.fromEntries(
          Array.from(this._sessions.entries()).map(([key, info]) => [
            key,
            {
              sessionId: info.sessionId,
              workingDirectory: info.workingDirectory,
              createdAt: info.createdAt.toISOString(),
              lastUsedAt: info.lastUsedAt.toISOString(),
            },
          ])
        ),
        threadToIssue: Object.fromEntries(this._threadToIssue),
        threadToTargetRepo: Object.fromEntries(this._threadToTargetRepo),
      };

      fs.writeFileSync(GetSessionsFile(), JSON.stringify(serialized, null, 2), { mode: 0o600 });
    } catch (error) {
      console.error('Failed to save sessions:', error);
    }
  }

  /**
   * Slackスレッド用のキーを生成
   */
  private _makeSlackKey(threadTs: string, userId: string): SessionKey {
    return `slack:${threadTs}:${userId}`;
  }

  /**
   * GitHub Issue用のキーを生成
   */
  private _makeGitHubKey(owner: string, repo: string, issueNumber: number): SessionKey {
    return `github:${owner}/${repo}#${issueNumber}`;
  }

  /**
   * キーからセッションを取得（共通処理）
   */
  private _getByKey(key: SessionKey): SessionResult | undefined {
    const session = this._sessions.get(key);

    if (!session) {
      return undefined;
    }

    // 有効期限チェック
    const now = Date.now();
    if (now - session.lastUsedAt.getTime() > this._maxAge) {
      this._sessions.delete(key);
      this._save();
      return undefined;
    }

    // 最終使用時刻を更新
    session.lastUsedAt = new Date();
    this._save();
    return {
      sessionId: session.sessionId,
      workingDirectory: session.workingDirectory,
    };
  }

  /**
   * キーにセッションを保存（共通処理）
   */
  private _setByKey(key: SessionKey, sessionId: string, workingDirectory?: string): void {
    const now = new Date();
    this._sessions.set(key, {
      sessionId,
      workingDirectory,
      createdAt: now,
      lastUsedAt: now,
    });
    console.log(`Session stored: ${key} -> ${sessionId}${workingDirectory ? ` (dir: ${workingDirectory})` : ''}`);
    this._save();
  }

  /**
   * Slackスレッドのセッションを取得
   */
  Get(threadTs: string, userId: string): SessionResult | undefined {
    const key = this._makeSlackKey(threadTs, userId);
    return this._getByKey(key);
  }

  /**
   * Slackスレッドのセッションを保存
   */
  Set(threadTs: string, userId: string, sessionId: string, workingDirectory?: string): void {
    const key = this._makeSlackKey(threadTs, userId);
    this._setByKey(key, sessionId, workingDirectory);
  }

  /**
   * Slackスレッドのセッションを削除
   */
  Delete(threadTs: string, userId: string): boolean {
    const key = this._makeSlackKey(threadTs, userId);
    const result = this._sessions.delete(key);
    if (result) {
      this._save();
    }
    return result;
  }

  /**
   * GitHub Issueのセッションを取得
   */
  GetForIssue(owner: string, repo: string, issueNumber: number): SessionResult | undefined {
    const key = this._makeGitHubKey(owner, repo, issueNumber);
    return this._getByKey(key);
  }

  /**
   * GitHub Issueのセッションを保存
   */
  SetForIssue(owner: string, repo: string, issueNumber: number, sessionId: string, workingDirectory?: string): void {
    const key = this._makeGitHubKey(owner, repo, issueNumber);
    this._setByKey(key, sessionId, workingDirectory);
  }

  /**
   * GitHub Issueのセッションを削除
   */
  DeleteForIssue(owner: string, repo: string, issueNumber: number): boolean {
    const key = this._makeGitHubKey(owner, repo, issueNumber);
    const result = this._sessions.delete(key);
    if (result) {
      this._save();
    }
    return result;
  }

  /**
   * SlackスレッドとGitHub Issueを紐付ける
   */
  LinkThreadToIssue(threadTs: string, owner: string, repo: string, issueNumber: number): void {
    this._threadToIssue.set(threadTs, { owner, repo, issueNumber });
    console.log(`Thread ${threadTs} linked to issue ${owner}/${repo}#${issueNumber}`);
    this._save();
  }

  /**
   * SlackスレッドからGitHub Issue情報を取得
   */
  GetIssueForThread(threadTs: string): IssueInfo | undefined {
    return this._threadToIssue.get(threadTs);
  }

  /**
   * GitHub Issueに紐付いたスレッドの紐付けを解除
   */
  UnlinkThreadForIssue(owner: string, repo: string, issueNumber: number): void {
    for (const [threadTs, info] of this._threadToIssue) {
      if (info.owner === owner && info.repo === repo && info.issueNumber === issueNumber) {
        this._threadToIssue.delete(threadTs);
        console.log(`Thread ${threadTs} unlinked from issue ${owner}/${repo}#${issueNumber}`);
        this._save();
        break;
      }
    }
  }

  /**
   * Slackスレッドにターゲットリポジトリを紐付ける
   */
  LinkThreadToTargetRepo(threadTs: string, targetRepo: string): void {
    this._threadToTargetRepo.set(threadTs, targetRepo);
    console.log(`Thread ${threadTs} linked to target repo ${targetRepo}`);
    this._save();
  }

  /**
   * Slackスレッドからターゲットリポジトリを取得
   */
  GetTargetRepoForThread(threadTs: string): string | undefined {
    return this._threadToTargetRepo.get(threadTs);
  }

  // --- チャネル横断セッション ---

  /**
   * 正規ユーザーID用のキーを生成
   */
  private _makeUserKey(canonicalUserId: string, targetRepo?: string): SessionKey {
    return targetRepo
      ? `user:${canonicalUserId}:${targetRepo}`
      : `user:${canonicalUserId}`;
  }

  /**
   * LINE用のキーを生成
   */
  private _makeLineKey(userId: string): SessionKey {
    return `line:${userId}`;
  }

  /**
   * HTTP用のキーを生成
   */
  private _makeHttpKey(correlationId: string): SessionKey {
    return `http:${correlationId}`;
  }

  /**
   * 正規ユーザーIDでセッションを取得
   */
  GetForUser(canonicalUserId: string, targetRepo?: string): SessionResult | undefined {
    const key = this._makeUserKey(canonicalUserId, targetRepo);
    return this._getByKey(key);
  }

  /**
   * 正規ユーザーIDでセッションを保存
   */
  SetForUser(canonicalUserId: string, sessionId: string, targetRepo?: string, workingDirectory?: string): void {
    const key = this._makeUserKey(canonicalUserId, targetRepo);
    this._setByKey(key, sessionId, workingDirectory);
  }

  /**
   * LINE用セッションを取得
   */
  GetForLine(userId: string): SessionResult | undefined {
    const key = this._makeLineKey(userId);
    return this._getByKey(key);
  }

  /**
   * LINE用セッションを保存
   */
  SetForLine(userId: string, sessionId: string, workingDirectory?: string): void {
    const key = this._makeLineKey(userId);
    this._setByKey(key, sessionId, workingDirectory);
  }

  /**
   * HTTP用セッションを取得
   */
  GetForHttp(correlationId: string): SessionResult | undefined {
    const key = this._makeHttpKey(correlationId);
    return this._getByKey(key);
  }

  /**
   * HTTP用セッションを保存
   */
  SetForHttp(correlationId: string, sessionId: string, workingDirectory?: string): void {
    const key = this._makeHttpKey(correlationId);
    this._setByKey(key, sessionId, workingDirectory);
  }

  /**
   * プラットフォーム固有のユーザーIDから正規ユーザーIDを解決する
   */
  ResolveCanonicalUserId(
    source: TaskSource,
    platformUserId: string,
    userMappings: readonly UserMapping[]
  ): string | undefined {
    for (const mapping of userMappings) {
      switch (source) {
        case 'slack':
          if (mapping.slack === platformUserId) return mapping.github;
          break;
        case 'github':
          if (mapping.github.toLowerCase() === platformUserId.toLowerCase()) return mapping.github;
          break;
        case 'line':
          if (mapping.line === platformUserId) return mapping.github;
          break;
        case 'http':
          if (mapping.http === platformUserId) return mapping.github;
          break;
      }
    }
    return undefined;
  }

  /**
   * 期限切れセッションをクリーンアップ
   */
  Cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, session] of this._sessions) {
      if (now - session.lastUsedAt.getTime() > this._maxAge) {
        this._sessions.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`Cleaned up ${cleaned} expired sessions`);
      this._save();
    }

    return cleaned;
  }

  /**
   * すべてのセッションをクリア
   */
  Clear(): void {
    this._sessions.clear();
    this._save();
  }

  /**
   * セッション数を取得
   */
  get Size(): number {
    return this._sessions.size;
  }
}

// シングルトンインスタンス
let _instance: SessionStore | undefined;

/**
 * セッションストアのシングルトンインスタンスを取得
 */
export function GetSessionStore(): SessionStore {
  if (!_instance) {
    _instance = new SessionStore();

    // 1時間ごとに期限切れセッションをクリーンアップ
    setInterval(() => {
      _instance?.Cleanup();
    }, 60 * 60 * 1000);
  }
  return _instance;
}
