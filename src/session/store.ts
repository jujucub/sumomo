/**
 * sumomo - セッションストア
 * Slackスレッドとユーザーに紐づくClaudeセッションIDを管理する
 */

// セッション情報
interface SessionInfo {
  readonly sessionId: string;
  readonly createdAt: Date;
  lastUsedAt: Date;
}

// セッションキー（スレッドID + ユーザーID）
type SessionKey = `${string}:${string}`; // threadTs:userId

/**
 * セッションストアクラス
 */
class SessionStore {
  private _sessions: Map<SessionKey, SessionInfo>;
  private readonly _maxAge: number; // セッションの最大有効期間（ミリ秒）

  constructor(maxAgeHours: number = 24) {
    this._sessions = new Map();
    this._maxAge = maxAgeHours * 60 * 60 * 1000;
  }

  /**
   * セッションキーを生成
   */
  private _makeKey(threadTs: string, userId: string): SessionKey {
    return `${threadTs}:${userId}`;
  }

  /**
   * セッションを取得
   */
  Get(threadTs: string, userId: string): string | undefined {
    const key = this._makeKey(threadTs, userId);
    const session = this._sessions.get(key);

    if (!session) {
      return undefined;
    }

    // 有効期限チェック
    const now = Date.now();
    if (now - session.lastUsedAt.getTime() > this._maxAge) {
      this._sessions.delete(key);
      return undefined;
    }

    // 最終使用時刻を更新
    session.lastUsedAt = new Date();
    return session.sessionId;
  }

  /**
   * セッションを保存
   */
  Set(threadTs: string, userId: string, sessionId: string): void {
    const key = this._makeKey(threadTs, userId);
    const now = new Date();

    this._sessions.set(key, {
      sessionId,
      createdAt: now,
      lastUsedAt: now,
    });

    console.log(`Session stored: ${key} -> ${sessionId}`);
  }

  /**
   * セッションを削除
   */
  Delete(threadTs: string, userId: string): boolean {
    const key = this._makeKey(threadTs, userId);
    return this._sessions.delete(key);
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
    }

    return cleaned;
  }

  /**
   * すべてのセッションをクリア
   */
  Clear(): void {
    this._sessions.clear();
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
