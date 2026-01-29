/**
 * sumomo - 管理設定ストア
 * ~/.sumomo/admin-config.json に設定を永続化する
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { AdminConfig } from '../types/index.js';

// 設定ファイルパス
const CONFIG_DIR = path.join(os.homedir(), '.sumomo');
const CONFIG_FILE = path.join(CONFIG_DIR, 'admin-config.json');

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
  };
}

/**
 * 設定をファイルから読み込む
 */
export function LoadAdminConfig(): AdminConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
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
      };

      console.log('Loaded admin config from', CONFIG_FILE);
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
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { mode: 0o700 });
    }

    // 設定をファイルに保存（所有者のみ読み書き可能）
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });

    _currentConfig = config;
    console.log('Saved admin config to', CONFIG_FILE);

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
  return fs.existsSync(CONFIG_FILE);
}
