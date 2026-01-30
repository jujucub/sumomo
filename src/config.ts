/**
 * sumomo - 設定管理
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Config, AllowedUsers } from './types/index.js';
import { LoadAdminConfig, HasAdminConfig } from './admin/store.js';

// ~/.sumomo/.env を優先的に読み込む（存在する場合）
const sumomoEnvPath = path.join(os.homedir(), '.sumomo', '.env');
if (fs.existsSync(sumomoEnvPath)) {
  dotenv.config({ path: sumomoEnvPath });
} else {
  // プロジェクトルートの .env を読み込む
  dotenv.config();
}

/**
 * カンマ区切りの文字列を配列に変換する（空の場合は空配列）
 */
function ParseCommaSeparatedList(value: string | undefined): readonly string[] {
  if (!value || value.trim() === '') {
    return [];
  }
  return value.split(',').map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * 環境変数から設定を読み込む
 */
export function LoadConfig(): Config {
  // ANTHROPIC_API_KEY は 認証して使用する時は不要（任意）
  const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
  const slackBotToken = process.env['SLACK_BOT_TOKEN'];
  const slackAppToken = process.env['SLACK_APP_TOKEN'];
  const slackChannelId = process.env['SLACK_CHANNEL_ID'];
  const githubToken = process.env['GITHUB_TOKEN'];
  const githubReposStr = process.env['GITHUB_REPOS'];

  // 必須項目のバリデーション
  if (!slackBotToken) {
    throw new Error('SLACK_BOT_TOKEN is required');
  }
  if (!slackAppToken) {
    throw new Error('SLACK_APP_TOKEN is required');
  }
  if (!slackChannelId) {
    throw new Error('SLACK_CHANNEL_ID is required');
  }
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN is required');
  }
  if (!githubReposStr) {
    throw new Error('GITHUB_REPOS is required');
  }

  // 環境変数からのリポジトリ設定
  const envGithubRepos = githubReposStr.split(',').map((repo) => repo.trim());

  const approvalServerPort = parseInt(
    process.env['APPROVAL_SERVER_PORT'] ?? '3001',
    10
  );
  const adminServerPort = parseInt(
    process.env['ADMIN_SERVER_PORT'] ?? '3002',
    10
  );
  const githubPollInterval = parseInt(
    process.env['GITHUB_POLL_INTERVAL'] ?? '300000',
    10
  );

  // admin-config.json が存在する場合は優先的に読み込む
  let allowedUsers: AllowedUsers;
  let githubRepos: readonly string[];

  if (HasAdminConfig()) {
    const adminConfig = LoadAdminConfig();
    console.log('📋 Using admin-config.json for whitelist and repos');

    allowedUsers = {
      github: adminConfig.allowedGithubUsers.length > 0
        ? adminConfig.allowedGithubUsers
        : ParseCommaSeparatedList(process.env['ALLOWED_GITHUB_USERS']),
      slack: adminConfig.allowedSlackUsers.length > 0
        ? adminConfig.allowedSlackUsers
        : ParseCommaSeparatedList(process.env['ALLOWED_SLACK_USERS']),
    };

    githubRepos = adminConfig.githubRepos.length > 0
      ? adminConfig.githubRepos
      : envGithubRepos;
  } else {
    // 環境変数から読み込む（従来の動作）
    allowedUsers = {
      github: ParseCommaSeparatedList(process.env['ALLOWED_GITHUB_USERS']),
      slack: ParseCommaSeparatedList(process.env['ALLOWED_SLACK_USERS']),
    };
    githubRepos = envGithubRepos;
  }

  // ホワイトリストが空の場合は警告
  if (allowedUsers.github.length === 0) {
    console.warn('⚠️ ALLOWED_GITHUB_USERS is empty - all GitHub requests will be denied');
  }
  if (allowedUsers.slack.length === 0) {
    console.warn('⚠️ ALLOWED_SLACK_USERS is empty - all Slack requests will be denied');
  }

  return {
    anthropicApiKey,
    slackBotToken,
    slackAppToken,
    slackChannelId,
    githubToken,
    githubRepos,
    approvalServerPort,
    adminServerPort,
    githubPollInterval,
    allowedUsers,
  };
}
