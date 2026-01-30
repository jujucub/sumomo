/**
 * sumomo - リポジトリ管理
 * 監視対象リポジトリの自動クローン・管理機能を提供する
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * .sumomo ディレクトリのパスを取得する
 * すべてのデータは ~/.sumomo/ に保存される
 */
export function GetSumomoDir(): string {
  return path.join(os.homedir(), '.sumomo');
}

/**
 * リポジトリのローカルパスを取得する
 * @param owner リポジトリオーナー
 * @param repo リポジトリ名
 * @returns .sumomo/repos/{owner}/{repo} のパス
 */
export function GetRepoPath(owner: string, repo: string): string {
  return path.join(GetSumomoDir(), 'repos', owner, repo);
}

/**
 * リポジトリをクローンまたは更新する
 * - リポジトリがクローン済みなら fetch して最新化
 * - 未クローンなら git clone を実行
 * @param owner リポジトリオーナー
 * @param repo リポジトリ名
 * @param githubToken GitHub トークン
 * @returns クローンしたリポジトリのパス
 */
export async function GetOrCloneRepo(
  owner: string,
  repo: string,
  githubToken: string
): Promise<string> {
  const repoPath = GetRepoPath(owner, repo);
  const repoUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`;

  if (fs.existsSync(path.join(repoPath, '.git'))) {
    // 既にクローン済みの場合は fetch して最新化
    console.log(`Fetching existing repo: ${owner}/${repo}`);
    try {
      execSync('git fetch --all', {
        cwd: repoPath,
        stdio: 'pipe',
      });
      console.log(`Fetched repo: ${owner}/${repo}`);
    } catch (error) {
      console.error(`Failed to fetch repo: ${error}`);
      throw new Error(`Failed to fetch repository ${owner}/${repo}`);
    }
  } else {
    // クローンする
    console.log(`Cloning repo: ${owner}/${repo}`);

    // 親ディレクトリを作成
    const parentDir = path.dirname(repoPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    try {
      execSync(`git clone "${repoUrl}" "${repoPath}"`, {
        stdio: 'pipe',
      });
      console.log(`Cloned repo: ${owner}/${repo} to ${repoPath}`);
    } catch (error) {
      console.error(`Failed to clone repo: ${error}`);
      throw new Error(`Failed to clone repository ${owner}/${repo}`);
    }
  }

  return repoPath;
}

/**
 * リポジトリがクローン済みかどうかを確認する
 * @param owner リポジトリオーナー
 * @param repo リポジトリ名
 * @returns クローン済みなら true
 */
export function IsRepoCloned(owner: string, repo: string): boolean {
  const repoPath = GetRepoPath(owner, repo);
  return fs.existsSync(path.join(repoPath, '.git'));
}
