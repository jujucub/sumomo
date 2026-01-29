/**
 * sumomo - Git Worktree 管理
 * Issue ごとに独立した作業ディレクトリを提供する
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface WorktreeInfo {
  readonly branchName: string;
  readonly worktreePath: string;
  readonly issueNumber: number;
  readonly owner: string;
  readonly repo: string;
}

const _activeWorktrees = new Map<string, WorktreeInfo>();

/**
 * Issue 用の worktree を作成する
 */
export async function CreateWorktree(
  baseDir: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<WorktreeInfo> {
  const branchName = `sumomo/issue-${issueNumber}`;
  const worktreeDir = path.join(baseDir, '.worktrees', `issue-${issueNumber}`);
  const worktreeKey = `${owner}/${repo}#${issueNumber}`;

  // 既存の worktree がある場合は削除
  if (_activeWorktrees.has(worktreeKey)) {
    await RemoveWorktree(owner, repo, issueNumber);
  }

  // .worktrees ディレクトリを作成
  const worktreesRoot = path.join(baseDir, '.worktrees');
  if (!fs.existsSync(worktreesRoot)) {
    fs.mkdirSync(worktreesRoot, { recursive: true });
  }

  // 最新の main/master を取得
  const defaultBranch = GetDefaultBranch(baseDir);
  execSync(`git fetch origin ${defaultBranch}`, {
    cwd: baseDir,
    stdio: 'pipe',
  });

  // リモートブランチが存在する場合は削除
  try {
    execSync(`git push origin --delete ${branchName}`, {
      cwd: baseDir,
      stdio: 'pipe',
    });
  } catch {
    // ブランチが存在しない場合は無視
  }

  // ローカルブランチが存在する場合は削除
  try {
    execSync(`git branch -D ${branchName}`, {
      cwd: baseDir,
      stdio: 'pipe',
    });
  } catch {
    // ブランチが存在しない場合は無視
  }

  // 既存の worktree ディレクトリを削除
  if (fs.existsSync(worktreeDir)) {
    try {
      execSync(`git worktree remove --force "${worktreeDir}"`, {
        cwd: baseDir,
        stdio: 'pipe',
      });
    } catch {
      // worktree が存在しない場合は無視
    }
    // ディレクトリが残っている場合は強制削除
    if (fs.existsSync(worktreeDir)) {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
  }

  // 新しいブランチで worktree を作成
  execSync(
    `git worktree add -b ${branchName} "${worktreeDir}" origin/${defaultBranch}`,
    {
      cwd: baseDir,
      stdio: 'pipe',
    }
  );

  const info: WorktreeInfo = {
    branchName,
    worktreePath: worktreeDir,
    issueNumber,
    owner,
    repo,
  };

  _activeWorktrees.set(worktreeKey, info);

  console.log(`Created worktree: ${worktreeDir} (branch: ${branchName})`);

  return info;
}

/**
 * worktree を削除する
 */
export async function RemoveWorktree(
  owner: string,
  repo: string,
  issueNumber: number
): Promise<void> {
  const worktreeKey = `${owner}/${repo}#${issueNumber}`;
  const info = _activeWorktrees.get(worktreeKey);

  if (!info) {
    return;
  }

  try {
    // worktree を削除
    const baseDir = path.dirname(path.dirname(info.worktreePath));
    execSync(`git worktree remove --force "${info.worktreePath}"`, {
      cwd: baseDir,
      stdio: 'pipe',
    });
  } catch (error) {
    console.error(`Failed to remove worktree: ${error}`);
    // ディレクトリが残っている場合は強制削除
    if (fs.existsSync(info.worktreePath)) {
      fs.rmSync(info.worktreePath, { recursive: true, force: true });
    }
  }

  _activeWorktrees.delete(worktreeKey);

  console.log(`Removed worktree: ${info.worktreePath}`);
}

/**
 * worktree でコミットしてプッシュする
 */
export async function CommitAndPush(
  worktreeInfo: WorktreeInfo,
  commitMessage: string
): Promise<boolean> {
  try {
    // 変更があるか確認
    const status = execSync('git status --porcelain', {
      cwd: worktreeInfo.worktreePath,
      encoding: 'utf-8',
    });

    if (!status.trim()) {
      console.log('No changes to commit');
      return false;
    }

    // 全ての変更をステージング
    execSync('git add -A', {
      cwd: worktreeInfo.worktreePath,
      stdio: 'pipe',
    });

    // コミット
    execSync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
      cwd: worktreeInfo.worktreePath,
      stdio: 'pipe',
    });

    // プッシュ
    execSync(`git push -u origin ${worktreeInfo.branchName}`, {
      cwd: worktreeInfo.worktreePath,
      stdio: 'pipe',
    });

    console.log(`Pushed branch: ${worktreeInfo.branchName}`);
    return true;
  } catch (error) {
    console.error(`Failed to commit and push: ${error}`);
    return false;
  }
}

/**
 * PR を作成する
 */
export async function CreatePullRequest(
  worktreeInfo: WorktreeInfo,
  title: string,
  body: string
): Promise<string | undefined> {
  try {
    const defaultBranch = GetDefaultBranch(worktreeInfo.worktreePath);

    // gh コマンドで PR を作成
    const result = execSync(
      `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}" --base ${defaultBranch} --head ${worktreeInfo.branchName}`,
      {
        cwd: worktreeInfo.worktreePath,
        encoding: 'utf-8',
      }
    );

    const prUrl = result.trim();
    console.log(`Created PR: ${prUrl}`);
    return prUrl;
  } catch (error) {
    console.error(`Failed to create PR: ${error}`);
    return undefined;
  }
}

/**
 * デフォルトブランチを取得する
 */
function GetDefaultBranch(repoDir: string): string {
  try {
    const result = execSync(
      'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo "refs/remotes/origin/main"',
      {
        cwd: repoDir,
        encoding: 'utf-8',
      }
    );
    const branch = result.trim().replace('refs/remotes/origin/', '');
    return branch || 'main';
  } catch {
    return 'main';
  }
}

/**
 * アクティブな worktree 情報を取得する
 */
export function GetWorktreeInfo(
  owner: string,
  repo: string,
  issueNumber: number
): WorktreeInfo | undefined {
  const worktreeKey = `${owner}/${repo}#${issueNumber}`;
  return _activeWorktrees.get(worktreeKey);
}

/**
 * 既存の worktree があれば再利用し、なければ新規作成する
 */
export async function GetOrCreateWorktree(
  baseDir: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<{ worktreeInfo: WorktreeInfo; isExisting: boolean }> {
  const worktreeKey = `${owner}/${repo}#${issueNumber}`;
  const existing = _activeWorktrees.get(worktreeKey);

  if (existing && fs.existsSync(existing.worktreePath)) {
    console.log(`Reusing existing worktree: ${existing.worktreePath}`);
    return { worktreeInfo: existing, isExisting: true };
  }

  // 既存がない場合は新規作成
  const worktreeInfo = await CreateWorktree(baseDir, owner, repo, issueNumber);
  return { worktreeInfo, isExisting: false };
}

/**
 * 全ての worktree をクリーンアップする
 */
export async function CleanupAllWorktrees(): Promise<void> {
  for (const [_key, info] of _activeWorktrees) {
    try {
      const baseDir = path.dirname(path.dirname(info.worktreePath));
      execSync(`git worktree remove --force "${info.worktreePath}"`, {
        cwd: baseDir,
        stdio: 'pipe',
      });
    } catch {
      // 無視
    }
  }
  _activeWorktrees.clear();
  console.log('Cleaned up all worktrees');
}
