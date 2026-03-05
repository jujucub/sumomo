/**
 * claps - 管理設定ストア
 * ~/.claps/admin-config.json に設定を永続化する
 */

import fs from 'fs';
import path from 'path';
import type { AdminConfig } from '../types/index.js';
import { GetClapsDir } from '../git/repo.js';

// 設定ファイルパスを取得する（遅延評価）
function GetConfigFile(): string {
  return path.join(GetClapsDir(), 'admin-config.json');
}

// 変更通知コールバック
type ConfigChangeCallback = (config: AdminConfig) => void;
const _callbacks: ConfigChangeCallback[] = [];

// 現在の設定（キャッシュ）
let _currentConfig: AdminConfig | undefined;

/**
 * デフォルト設定を取得する
 */
function GetDefaultConfig(): AdminConfig {
  return {
    allowedGithubUsers: [],
    allowedSlackUsers: [],
    githubRepos: [],
    userMappings: [],
  };
}

/**
 * 設定をファイルから読み込む
 */
export function LoadAdminConfig(): AdminConfig {
  try {
    if (fs.existsSync(GetConfigFile())) {
      const data = fs.readFileSync(GetConfigFile(), 'utf-8');
      const parsed = JSON.parse(data) as Partial<AdminConfig>;

      // 型の検証とデフォルト値のマージ
      _currentConfig = {
        allowedGithubUsers: Array.isArray(parsed.allowedGithubUsers)
          ? parsed.allowedGithubUsers
          : [],
        allowedSlackUsers: Array.isArray(parsed.allowedSlackUsers)
          ? parsed.allowedSlackUsers
          : [],
        githubRepos: Array.isArray(parsed.githubRepos)
          ? parsed.githubRepos
          : [],
        userMappings: Array.isArray(parsed.userMappings)
          ? parsed.userMappings.filter(
              (m): m is { github: string; slack: string; line?: string; http?: string } =>
                typeof m === 'object' &&
                m !== null &&
                typeof m.github === 'string' &&
                typeof m.slack === 'string'
            )
          : [],
      };

      console.log('Loaded admin config from', GetConfigFile());
      return _currentConfig;
    }
  } catch (error) {
    console.error('Failed to load admin config:', error);
  }

  _currentConfig = GetDefaultConfig();
  return _currentConfig;
}

/**
 * 設定をファイルに保存する
 */
export function SaveAdminConfig(config: AdminConfig): void {
  try {
    // ディレクトリがなければ作成
    if (!fs.existsSync(GetClapsDir())) {
      fs.mkdirSync(GetClapsDir(), { mode: 0o700 });
    }

    // 設定をファイルに保存（所有者のみ読み書き可能）
    fs.writeFileSync(GetConfigFile(), JSON.stringify(config, null, 2), {
      mode: 0o600,
    });

    _currentConfig = config;
    console.log('Saved admin config to', GetConfigFile());

    // コールバックを呼び出し
    for (const callback of _callbacks) {
      try {
        callback(config);
      } catch (error) {
        console.error('Config change callback error:', error);
      }
    }
  } catch (error) {
    console.error('Failed to save admin config:', error);
    throw error;
  }
}

/**
 * 現在の設定を取得する
 */
export function GetAdminConfig(): AdminConfig {
  if (!_currentConfig) {
    _currentConfig = LoadAdminConfig();
  }
  return _currentConfig;
}

/**
 * 変更通知コールバックを登録する
 */
export function OnConfigChange(callback: ConfigChangeCallback): void {
  _callbacks.push(callback);
}

/**
 * 設定ファイルが存在するかチェックする
 */
export function HasAdminConfig(): boolean {
  return fs.existsSync(GetConfigFile());
}

/**
 * GitHubユーザー名からSlackユーザーIDを取得する
 */
export function GetSlackUserForGitHub(githubUsername: string): string | undefined {
  const config = GetAdminConfig();
  const mapping = config.userMappings.find(
    (m) => m.github.toLowerCase() === githubUsername.toLowerCase()
  );
  return mapping?.slack;
}

/**
 * 管理者のSlackユーザーIDを取得する（環境変数 ADMIN_SLACK_USER から読み込む）
 */
export function GetAdminSlackUser(): string | undefined {
  const adminUser = process.env['ADMIN_SLACK_USER'];
  return adminUser && adminUser.trim() !== '' ? adminUser.trim() : undefined;
}
