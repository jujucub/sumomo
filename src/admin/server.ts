/**
 * sumomo - 管理サーバー
 * ホワイトリストとリポジトリ設定を管理するWeb UI用サーバー
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import type { AdminConfig } from '../types/index.js';
import { GetAdminConfig, SaveAdminConfig, OnConfigChange } from './store.js';
import { UpdateAllowedUsers as UpdateSlackAllowedUsers } from '../slack/handlers.js';
import { UpdateAllowedUsers as UpdateGitHubAllowedUsers, UpdateRepos } from '../github/poller.js';

// __dirname の代替（ESM用）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * publicフォルダのパスを取得する
 * 開発モード(tsx)とビルドモード(node dist/)の両方で動作する
 */
function GetPublicPath(): string {
  // まず現在のディレクトリからの相対パスを試す
  const localPublic = path.join(__dirname, 'public');
  if (fs.existsSync(localPublic)) {
    return localPublic;
  }

  // srcディレクトリのパスを試す（開発モード用）
  const srcPublic = path.resolve(__dirname, '../../src/admin/public');
  if (fs.existsSync(srcPublic)) {
    return srcPublic;
  }

  // デフォルト
  return localPublic;
}

// サーバー状態
let _server: Server | undefined;
let _app: Express | undefined;

// 認証トークンファイルパス（承認サーバーと共有）
const AUTH_TOKEN_FILE = path.join(os.homedir(), '.sumomo', 'auth-token');

/**
 * 認証トークンを取得する
 */
function GetAuthToken(): string | undefined {
  try {
    if (fs.existsSync(AUTH_TOKEN_FILE)) {
      return fs.readFileSync(AUTH_TOKEN_FILE, 'utf-8').trim();
    }
  } catch (error) {
    console.error('Failed to read auth token:', error);
  }
  return undefined;
}

/**
 * 認証トークンを検証するミドルウェア
 */
function AuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // 静的ファイル（HTML/CSS/JS）は認証不要
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  const token = req.headers['x-auth-token'] as string | undefined;
  const authToken = GetAuthToken();

  if (!token || !authToken) {
    console.warn(`Unauthorized request to ${req.path} from ${req.ip}`);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // タイミング攻撃を防ぐため、ハッシュ化してから定数時間比較を使用
  // これにより、トークン長の情報漏洩を防ぐ
  const tokenHash = crypto.createHash('sha256').update(token).digest();
  const authTokenHash = crypto.createHash('sha256').update(authToken).digest();

  if (!crypto.timingSafeEqual(tokenHash, authTokenHash)) {
    console.warn(`Unauthorized request to ${req.path} from ${req.ip}`);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

/**
 * 設定変更時に各モジュールに通知する
 */
function NotifyConfigChange(config: AdminConfig): void {
  // Slackホワイトリストを更新
  UpdateSlackAllowedUsers(config.allowedSlackUsers);

  // GitHubホワイトリストを更新
  UpdateGitHubAllowedUsers(config.allowedGithubUsers);

  // リポジトリ設定を更新（ポーラー再起動を含む）
  UpdateRepos(config.githubRepos);
}

/**
 * 管理サーバーを初期化する
 */
export function InitAdminServer(): Express {
  _app = express();
  _app.use(express.json({ limit: '10kb' })); // DoS攻撃対策

  // 認証ミドルウェアを追加
  _app.use(AuthMiddleware);

  // 静的ファイル配信（index.html, style.css, app.js）
  const publicPath = GetPublicPath();
  console.log(`Admin server serving static files from: ${publicPath}`);
  _app.use(express.static(publicPath));

  // 設定取得API
  _app.get('/api/config', (_req: Request, res: Response) => {
    try {
      const config = GetAdminConfig();
      res.json(config);
    } catch (error) {
      console.error('Failed to get config:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 設定更新API
  _app.put('/api/config', (req: Request, res: Response) => {
    try {
      const newConfig = req.body as Partial<AdminConfig>;
      const currentConfig = GetAdminConfig();

      // 配列の中身が文字列であることを検証するヘルパー関数
      const isStringArray = (arr: unknown): arr is string[] => {
        return Array.isArray(arr) && arr.every((item) => typeof item === 'string');
      };

      // 文字列配列を正規化（トリム、空文字除去）
      const normalizeStringArray = (arr: string[]): string[] => {
        return arr.map((s) => s.trim()).filter((s) => s !== '');
      };

      // 現在の設定とマージ（入力値バリデーション付き）
      const updatedConfig: AdminConfig = {
        allowedGithubUsers: isStringArray(newConfig.allowedGithubUsers)
          ? normalizeStringArray(newConfig.allowedGithubUsers)
          : currentConfig.allowedGithubUsers,
        allowedSlackUsers: isStringArray(newConfig.allowedSlackUsers)
          ? normalizeStringArray(newConfig.allowedSlackUsers)
          : currentConfig.allowedSlackUsers,
        githubRepos: isStringArray(newConfig.githubRepos)
          ? normalizeStringArray(newConfig.githubRepos)
          : currentConfig.githubRepos,
      };

      // 保存（コールバックで各モジュールに通知される）
      SaveAdminConfig(updatedConfig);

      res.json({ success: true, config: updatedConfig });
    } catch (error) {
      console.error('Failed to update config:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 設定変更コールバックを登録
  OnConfigChange(NotifyConfigChange);

  return _app;
}

/**
 * 管理サーバーを起動する
 * セキュリティのため 127.0.0.1 のみにバインド
 */
export function StartAdminServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!_app) {
      _app = InitAdminServer();
    }

    // 127.0.0.1 のみにバインド（外部からのアクセスを防止）
    _server = _app.listen(port, '127.0.0.1', () => {
      console.log(`Admin server started on http://127.0.0.1:${port} (localhost only)`);
      resolve();
    });

    _server.on('error', reject);
  });
}

/**
 * 管理サーバーを停止する
 */
export function StopAdminServer(): Promise<void> {
  return new Promise((resolve) => {
    if (_server) {
      _server.close(() => {
        console.log('Admin server stopped');
        _server = undefined;
        resolve();
      });
    } else {
      resolve();
    }
  });
}
