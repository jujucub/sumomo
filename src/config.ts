/**
 * claps - 設定管理
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Config, AllowedUsers, ChannelConfig, ReflectionConfig } from './types/index.js';
import { LoadAdminConfig, HasAdminConfig } from './admin/store.js';

// ~/.claps/.env を優先的に読み込む（存在する場合）
const clapsEnvPath = path.join(os.homedir(), '.claps', '.env');
if (fs.existsSync(clapsEnvPath)) {
  dotenv.config({ path: clapsEnvPath });
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

  // 環境変数からのリポジトリ設定（未設定の場合は空配列）
  const envGithubRepos = githubReposStr
    ? githubReposStr.split(',').map((repo) => repo.trim()).filter((repo) => repo !== '')
    : [];

  // GITHUB_TOKEN が未設定でも起動可能（GitHub連携機能は無効になる）
  if (!githubToken && envGithubRepos.length > 0) {
    throw new Error('GITHUB_TOKEN is required when GITHUB_REPOS is configured');
  }

  const approvalServerPort = parseInt(
    process.env['APPROVAL_SERVER_PORT'] ?? '3001',
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
      line: ParseCommaSeparatedList(process.env['ALLOWED_LINE_USERS']),
      http: ParseCommaSeparatedList(process.env['ALLOWED_HTTP_DEVICES']),
    };

    githubRepos = adminConfig.githubRepos.length > 0
      ? adminConfig.githubRepos
      : envGithubRepos;
  } else {
    // 環境変数から読み込む（従来の動作）
    allowedUsers = {
      github: ParseCommaSeparatedList(process.env['ALLOWED_GITHUB_USERS']),
      slack: ParseCommaSeparatedList(process.env['ALLOWED_SLACK_USERS']),
      line: ParseCommaSeparatedList(process.env['ALLOWED_LINE_USERS']),
      http: ParseCommaSeparatedList(process.env['ALLOWED_HTTP_DEVICES']),
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

  // LINE チャネル設定（環境変数が設定されている場合のみ有効）
  const lineChannelSecret = process.env['LINE_CHANNEL_SECRET'];
  const lineChannelToken = process.env['LINE_CHANNEL_TOKEN'];
  const lineWebhookPort = parseInt(process.env['LINE_WEBHOOK_PORT'] ?? '3002', 10);

  // HTTP チャネル設定
  const httpChannelEnabled = process.env['HTTP_CHANNEL_ENABLED'] === 'true';
  const httpChannelPort = parseInt(process.env['HTTP_CHANNEL_PORT'] ?? '0', 10) || undefined;

  const channelConfig: ChannelConfig = {
    line: lineChannelSecret && lineChannelToken
      ? { channelSecret: lineChannelSecret, channelToken: lineChannelToken, webhookPort: lineWebhookPort }
      : undefined,
    http: httpChannelEnabled
      ? { enabled: true, port: httpChannelPort }
      : undefined,
  };

  // 内省機能の設定
  const reflectionConfig: ReflectionConfig = {
    enabled: process.env['REFLECTION_ENABLED'] === 'true',
    schedule: process.env['REFLECTION_SCHEDULE'] ?? '09:00',
    timezone: process.env['REFLECTION_TIMEZONE'] ?? 'Asia/Tokyo',
    historyDays: parseInt(process.env['REFLECTION_HISTORY_DAYS'] ?? '7', 10),
    maxRecordsPerUser: parseInt(process.env['REFLECTION_MAX_RECORDS'] ?? '50', 10),
  };

  return {
    anthropicApiKey,
    slackBotToken,
    slackAppToken,
    slackChannelId,
    githubToken,
    githubRepos,
    approvalServerPort,
    githubPollInterval,
    allowedUsers,
    reflectionConfig,
    channelConfig,
  };
}
