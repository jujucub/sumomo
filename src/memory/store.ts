/**
 * claps - メモリストア
 * カテゴリ階層+セッション別CRUD操作
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type {
  MemoryCategoryPath,
  MemoryConfig,
  MemoryEntryInput,
  MemorySource,
  PinnedEntryInput,
  ProjectMemoryContent,
  ProjectSummary,
  SessionMemoryContent,
} from '../types/index.js';

/**
 * メモリストアクラス
 */
export class MemoryStore {
  private readonly _memoryDir: string;
  private readonly _config: MemoryConfig;

  constructor(config: MemoryConfig) {
    this._config = config;
    this._memoryDir = config.memoryDir;
  }

  /**
   * カテゴリパスからディレクトリパスを解決する
   */
  private _resolveProjectDir(categoryPath: MemoryCategoryPath): string {
    return path.join(
      this._memoryDir,
      categoryPath.abstractCategory,
      categoryPath.concreteCategory,
      categoryPath.projectName
    );
  }

  /**
   * プロジェクトディレクトリが存在することを保証する（欠損時は自動復旧）
   */
  private _ensureProjectDir(categoryPath: MemoryCategoryPath): string {
    const projectDir = this._resolveProjectDir(categoryPath);
    if (!fs.existsSync(projectDir)) {
      try {
        fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
        console.log(`Memory: Recovered missing directory ${projectDir}`);
      } catch (error) {
        if (this._isDiskFullError(error)) {
          console.error('Memory: Disk full - cannot recover directory');
        }
        throw error;
      }
    }
    return projectDir;
  }

  /**
   * ディスク容量不足エラーかどうかを判定する
   */
  private _isDiskFullError(error: unknown): boolean {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOSPC';
  }

  /**
   * アトミック書き込み: 一時ファイルに書き込んでからリネームする
   */
  private _atomicWriteFileSync(filePath: string, content: string): void {
    const tmpPath = filePath + '.tmp.' + process.pid;
    try {
      fs.writeFileSync(tmpPath, content, { mode: 0o600 });
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      // 一時ファイルが残っていれば削除
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      if (this._isDiskFullError(error)) {
        console.error(`Memory: Disk full - cannot write ${filePath}`);
      }
      throw error;
    }
  }

  /**
   * 登録済みプロジェクトの一覧を返す
   */
  ListProjects(): ProjectSummary[] {
    if (!fs.existsSync(this._memoryDir)) {
      return [];
    }

    const projects: ProjectSummary[] = [];

    try {
      // 抽象カテゴリを走査
      const abstractCategories = fs.readdirSync(this._memoryDir);
      for (const abstractCat of abstractCategories) {
        const abstractPath = path.join(this._memoryDir, abstractCat);
        if (!fs.statSync(abstractPath).isDirectory()) continue;

        // 具体カテゴリを走査
        const concreteCategories = fs.readdirSync(abstractPath);
        for (const concreteCat of concreteCategories) {
          const concretePath = path.join(abstractPath, concreteCat);
          if (!fs.statSync(concretePath).isDirectory()) continue;

          // プロジェクトを走査
          const projectDirs = fs.readdirSync(concretePath);
          for (const projectName of projectDirs) {
            const projectPath = path.join(concretePath, projectName);
            if (!fs.statSync(projectPath).isDirectory()) continue;

            const memoryFilePath = path.join(projectPath, 'MEMORY.md');
            if (!fs.existsSync(memoryFilePath)) continue;

            try {
              const content = fs.readFileSync(memoryFilePath, 'utf-8');
              const description = this._extractDescription(content);
              const lastUpdatedAt = this._extractLastUpdated(content);
              const sessionIds = this._extractSessionIds(content);

              projects.push({
                projectName,
                categoryPath: {
                  abstractCategory: abstractCat,
                  concreteCategory: concreteCat,
                  projectName,
                },
                description,
                lastUpdatedAt,
                sessionIds,
              });
            } catch (error) {
              console.error(`Failed to read project memory: ${projectPath}`, error);
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to list projects:', error);
    }

    return projects;
  }

  /**
   * MEMORY.md のブロック引用行から description を抽出する
   */
  private _extractDescription(content: string): string {
    const match = content.match(/^>\s*(.+)$/m);
    return match?.[1]?.trim() ?? '';
  }

  /**
   * MEMORY.md から最終更新日時を抽出する
   */
  private _extractLastUpdated(content: string): string {
    const match = content.match(/\[最終更新:\s*(.+?)\]/);
    return match?.[1]?.trim() ?? new Date().toISOString();
  }

  /**
   * MEMORY.md からセッションIDを抽出する
   */
  private _extractSessionIds(content: string): string[] {
    const ids: string[] = [];
    const regex = /MEMORY_([^.\]]+)\.md/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      ids.push(match[1] as string);
    }
    return ids;
  }

  /**
   * 指定プロジェクトの MEMORY.md およびセッションメモリを読み取る
   */
  ReadMemory(categoryPath: MemoryCategoryPath): ProjectMemoryContent | null {
    const projectDir = this._resolveProjectDir(categoryPath);

    if (!fs.existsSync(projectDir)) {
      return null;
    }

    const memoryFilePath = path.join(projectDir, 'MEMORY.md');
    const pinnedFilePath = path.join(projectDir, 'pinned.md');

    if (!fs.existsSync(memoryFilePath)) {
      return null;
    }

    try {
      const memoryContent = fs.readFileSync(memoryFilePath, 'utf-8');
      const pinnedContent = fs.existsSync(pinnedFilePath)
        ? fs.readFileSync(pinnedFilePath, 'utf-8')
        : '';

      // セッションメモリファイルを読み取る
      const sessionMemories: SessionMemoryContent[] = [];
      const files = fs.readdirSync(projectDir);
      for (const file of files) {
        const sessionMatch = file.match(/^MEMORY_(.+)\.md$/);
        if (sessionMatch) {
          const sessionId = sessionMatch[1] as string;
          const filePath = path.join(projectDir, file);
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const stat = fs.statSync(filePath);
            sessionMemories.push({
              sessionId,
              content,
              lastUpdatedAt: stat.mtime.toISOString(),
            });
          } catch (error) {
            console.error(`Failed to read session memory: ${filePath}`, error);
          }
        }
      }

      // 合計サイズを算出
      let totalSizeBytes = Buffer.byteLength(memoryContent, 'utf-8');
      for (const sm of sessionMemories) {
        totalSizeBytes += Buffer.byteLength(sm.content, 'utf-8');
      }

      return {
        projectName: categoryPath.projectName,
        categoryPath,
        memoryContent,
        pinnedContent,
        sessionMemories,
        totalSizeBytes,
      };
    } catch (error) {
      console.error(`Failed to read memory for ${categoryPath.projectName}:`, error);
      return null;
    }
  }

  /**
   * 新規プロジェクトのメモリディレクトリおよび初期ファイルを作成する
   */
  CreateProject(categoryPath: MemoryCategoryPath, description: string): ProjectMemoryContent {
    const projectDir = this._ensureProjectDir(categoryPath);

    const now = new Date().toISOString().split('T')[0];

    // MEMORY.md を初期化
    const memoryContent = `# Project: ${categoryPath.projectName}
> ${description}

## 概要
${description}

## セッション

## 重要事項

## 詳細ファイル
- [pinned.md](./pinned.md) - 固定記憶（概要化対象外）

## 最近の活動
- [${now}] プロジェクトメモリを作成

[最終更新: ${now}]
`;

    const memoryFilePath = path.join(projectDir, 'MEMORY.md');
    this._atomicWriteFileSync(memoryFilePath, memoryContent);

    // pinned.md を初期化
    const pinnedFilePath = path.join(projectDir, 'pinned.md');
    const pinnedContent = `# Pinned: ${categoryPath.projectName}
> 固定記憶（概要化対象外）

`;
    this._atomicWriteFileSync(pinnedFilePath, pinnedContent);

    console.log(`Memory: Created project ${categoryPath.abstractCategory}/${categoryPath.concreteCategory}/${categoryPath.projectName}`);

    return {
      projectName: categoryPath.projectName,
      categoryPath,
      memoryContent,
      pinnedContent,
      sessionMemories: [],
      totalSizeBytes: Buffer.byteLength(memoryContent, 'utf-8'),
    };
  }

  /**
   * セッション単位のメモリファイルを作成し、ファイルパスを返す
   */
  CreateSessionMemory(
    categoryPath: MemoryCategoryPath,
    sessionId: string,
    source: MemorySource
  ): string {
    const projectDir = this._ensureProjectDir(categoryPath);
    const fileName = `MEMORY_${sessionId}.md`;
    const filePath = path.join(projectDir, fileName);
    const now = new Date().toISOString();

    // ソース情報をフォーマット
    const platformInfo = this._formatSource(source);

    const content = `# Session: ${sessionId}
> セッション

## セッション情報
- **Session ID**: ${sessionId}
- **開始日時**: ${now}
- **開始チャネル**: ${platformInfo}
- **プロジェクト**: ${categoryPath.projectName}

## 対話の経緯

## プラットフォーム固有情報
${platformInfo}

[最終更新: ${now}]
`;

    try {
      this._atomicWriteFileSync(filePath, content);
    } catch (error) {
      console.error(`Memory: Failed to create session file ${fileName}`, error);
      return filePath;
    }

    // MEMORY.md のセッション一覧を更新
    this._updateSessionList(categoryPath, sessionId);

    console.log(`Memory: Created session memory ${fileName} for ${categoryPath.projectName}`);
    return filePath;
  }

  /**
   * 指定セッションの MEMORY_<session_id>.md にエントリを追記する
   */
  AppendSessionMemory(
    categoryPath: MemoryCategoryPath,
    sessionId: string,
    entry: MemoryEntryInput
  ): void {
    this._ensureProjectDir(categoryPath);
    const projectDir = this._resolveProjectDir(categoryPath);
    const filePath = path.join(projectDir, `MEMORY_${sessionId}.md`);

    if (!fs.existsSync(filePath)) {
      console.warn(`Memory: Session file not found: ${filePath}`);
      return;
    }

    const now = new Date().toISOString();
    const dateStr = now.split('T')[0];
    const appendLine = `- [${dateStr}] ${entry.content}\n`;

    try {
      let content = fs.readFileSync(filePath, 'utf-8');

      // ファイル破損チェック: 最低限のマークダウン構造があるか
      if (!content.includes('# Session:')) {
        console.warn(`Memory: Session file appears corrupted: ${filePath}, skipping append`);
        return;
      }

      // 「対話の経緯」セクションに追記
      const sectionMarker = '## 対話の経緯';
      const idx = content.indexOf(sectionMarker);
      if (idx !== -1) {
        const afterSection = idx + sectionMarker.length;
        const nextSectionIdx = content.indexOf('\n## ', afterSection);
        if (nextSectionIdx !== -1) {
          content = content.slice(0, nextSectionIdx) + appendLine + content.slice(nextSectionIdx);
        } else {
          // 最終更新の手前に挿入
          const lastUpdateIdx = content.lastIndexOf('\n[最終更新:');
          if (lastUpdateIdx !== -1) {
            content = content.slice(0, lastUpdateIdx) + appendLine + content.slice(lastUpdateIdx);
          } else {
            content += appendLine;
          }
        }
      } else {
        content += appendLine;
      }

      // 最終更新を更新
      content = content.replace(/\[最終更新:.*?\]/, `[最終更新: ${now}]`);

      this._atomicWriteFileSync(filePath, content);
    } catch (error) {
      if (this._isDiskFullError(error)) {
        console.error(`Memory: Disk full - cannot append to session ${sessionId}`);
      } else {
        console.error(`Failed to append session memory: ${filePath}`, error);
      }
    }
  }

  /**
   * MEMORY.md の「最近の活動」セクションにエントリを追記する
   */
  AppendMemory(categoryPath: MemoryCategoryPath, entry: MemoryEntryInput): void {
    this._ensureProjectDir(categoryPath);
    const projectDir = this._resolveProjectDir(categoryPath);
    const filePath = path.join(projectDir, 'MEMORY.md');

    if (!fs.existsSync(filePath)) {
      console.warn(`Memory: MEMORY.md not found for ${categoryPath.projectName}`);
      return;
    }

    const now = new Date().toISOString();
    const dateStr = now.split('T')[0];
    const appendLine = `- [${dateStr}] ${entry.content}\n`;

    try {
      let content = fs.readFileSync(filePath, 'utf-8');

      // ファイル破損チェック: 最低限のマークダウン構造があるか
      if (!content.includes('# Project:')) {
        console.warn(`Memory: MEMORY.md appears corrupted for ${categoryPath.projectName}, skipping append`);
        return;
      }

      // 「最近の活動」セクションに追記
      const sectionMarker = '## 最近の活動';
      const idx = content.indexOf(sectionMarker);
      if (idx !== -1) {
        const afterSection = idx + sectionMarker.length;
        const nextLine = content.indexOf('\n', afterSection);
        if (nextLine !== -1) {
          content = content.slice(0, nextLine + 1) + appendLine + content.slice(nextLine + 1);
        } else {
          content += '\n' + appendLine;
        }
      } else {
        // セクションがなければ[最終更新]の前に追加
        const lastUpdateIdx = content.lastIndexOf('\n[最終更新:');
        if (lastUpdateIdx !== -1) {
          content = content.slice(0, lastUpdateIdx) + '\n## 最近の活動\n' + appendLine + content.slice(lastUpdateIdx);
        } else {
          content += '\n## 最近の活動\n' + appendLine;
        }
      }

      // 最終更新を更新
      content = content.replace(/\[最終更新:.*?\]/, `[最終更新: ${now}]`);

      this._atomicWriteFileSync(filePath, content);
    } catch (error) {
      if (this._isDiskFullError(error)) {
        console.error(`Memory: Disk full - cannot append to MEMORY.md for ${categoryPath.projectName}`);
      } else {
        console.error(`Failed to append memory: ${categoryPath.projectName}`, error);
      }
    }
  }

  /**
   * pinned.md にユーザー明示指示の記憶を追記する
   */
  AppendPinned(categoryPath: MemoryCategoryPath, entry: PinnedEntryInput): void {
    this._ensureProjectDir(categoryPath);
    const projectDir = this._resolveProjectDir(categoryPath);
    const filePath = path.join(projectDir, 'pinned.md');

    const now = new Date().toISOString();
    const dateStr = now.split('T')[0];
    const appendLine = `- [${dateStr}] [PINNED] ${entry.content}\n  原文: ${entry.originalPrompt}\n`;

    try {
      if (fs.existsSync(filePath)) {
        fs.appendFileSync(filePath, appendLine, { mode: 0o600 });
      } else {
        const content = `# Pinned: ${categoryPath.projectName}\n> 固定記憶（概要化対象外）\n\n${appendLine}`;
        this._atomicWriteFileSync(filePath, content);
      }
      console.log(`Memory: Pinned entry added for ${categoryPath.projectName}`);
    } catch (error) {
      if (this._isDiskFullError(error)) {
        console.error(`Memory: Disk full - cannot append pinned entry for ${categoryPath.projectName}`);
      } else {
        console.error(`Failed to append pinned: ${categoryPath.projectName}`, error);
      }
    }
  }

  /**
   * MEMORY.md + 全 MEMORY_*.md の合計バイト数を返す
   */
  GetMemorySize(categoryPath: MemoryCategoryPath): number {
    const projectDir = this._resolveProjectDir(categoryPath);
    if (!fs.existsSync(projectDir)) return 0;

    let totalSize = 0;

    try {
      const files = fs.readdirSync(projectDir);
      for (const file of files) {
        if (file === 'MEMORY.md' || file.match(/^MEMORY_.+\.md$/)) {
          const filePath = path.join(projectDir, file);
          const stat = fs.statSync(filePath);
          totalSize += stat.size;
        }
      }
    } catch (error) {
      console.error(`Failed to get memory size: ${categoryPath.projectName}`, error);
    }

    return totalSize;
  }

  /**
   * MEMORY.md のバックアップを作成し、バックアップファイルパスを返す
   */
  BackupMemory(categoryPath: MemoryCategoryPath): string {
    const projectDir = this._resolveProjectDir(categoryPath);
    const memoryFilePath = path.join(projectDir, 'MEMORY.md');
    const timestamp = Math.floor(Date.now() / 1000);
    const backupPath = `${memoryFilePath}.bak.${timestamp}`;

    try {
      fs.copyFileSync(memoryFilePath, backupPath);
      fs.chmodSync(backupPath, 0o600);

      // ローテーション: maxBackups を超えた古いバックアップを削除
      this._rotateBackups(projectDir);

      console.log(`Memory: Backup created at ${backupPath}`);
      return backupPath;
    } catch (error) {
      console.error(`Failed to backup memory: ${categoryPath.projectName}`, error);
      throw error;
    }
  }

  /**
   * MEMORY.md の内容を全置換する（概要化後の書き戻し用）
   */
  ReplaceMemoryContent(categoryPath: MemoryCategoryPath, newContent: string): void {
    this._ensureProjectDir(categoryPath);
    const projectDir = this._resolveProjectDir(categoryPath);
    const memoryFilePath = path.join(projectDir, 'MEMORY.md');

    try {
      this._atomicWriteFileSync(memoryFilePath, newContent);
      console.log(`Memory: Content replaced for ${categoryPath.projectName}`);
    } catch (error) {
      console.error(`Failed to replace memory content: ${categoryPath.projectName}`, error);
      throw error;
    }
  }

  /**
   * 概要化済みセッションファイルを削除する
   */
  DeleteSessionFile(categoryPath: MemoryCategoryPath, sessionId: string): void {
    const projectDir = this._resolveProjectDir(categoryPath);
    const filePath = path.join(projectDir, `MEMORY_${sessionId}.md`);

    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Memory: Deleted session file MEMORY_${sessionId}.md`);
      }
    } catch (error) {
      console.error(`Failed to delete session file: ${filePath}`, error);
    }
  }

  /**
   * バックアップからメモリを復元する
   */
  RestoreFromBackup(categoryPath: MemoryCategoryPath, backupPath: string): void {
    const projectDir = this._resolveProjectDir(categoryPath);
    const memoryFilePath = path.join(projectDir, 'MEMORY.md');

    try {
      fs.copyFileSync(backupPath, memoryFilePath);
      fs.chmodSync(memoryFilePath, 0o600);
      console.log(`Memory: Restored from backup ${backupPath}`);
    } catch (error) {
      console.error(`Failed to restore from backup: ${backupPath}`, error);
      throw error;
    }
  }

  /**
   * MEMORY.md のセッション一覧を更新する (T023: スレッド横断のインデックスとして機能)
   */
  private _updateSessionList(
    categoryPath: MemoryCategoryPath,
    sessionId: string,
    description: string = 'セッション'
  ): void {
    const projectDir = this._resolveProjectDir(categoryPath);
    const filePath = path.join(projectDir, 'MEMORY.md');

    if (!fs.existsSync(filePath)) return;

    try {
      let content = fs.readFileSync(filePath, 'utf-8');
      const now = new Date().toISOString().split('T')[0]!;
      const sessionLine = `- [MEMORY_${sessionId}.md](./MEMORY_${sessionId}.md) - ${description} (${now})\n`;

      // 既存のセッションリンクがあれば更新しない（重複防止）
      if (content.includes(`MEMORY_${sessionId}.md`)) {
        return;
      }

      const sectionMarker = '## セッション';
      const idx = content.indexOf(sectionMarker);
      if (idx !== -1) {
        const afterSection = idx + sectionMarker.length;
        const nextLine = content.indexOf('\n', afterSection);
        if (nextLine !== -1) {
          content = content.slice(0, nextLine + 1) + sessionLine + content.slice(nextLine + 1);
        } else {
          content += '\n' + sessionLine;
        }
      }

      // 最終更新を更新
      content = content.replace(/\[最終更新:.*?\]/, `[最終更新: ${new Date().toISOString()}]`);

      this._atomicWriteFileSync(filePath, content);
    } catch (error) {
      console.error(`Failed to update session list: ${categoryPath.projectName}`, error);
    }
  }

  /**
   * バックアップのローテーション
   */
  private _rotateBackups(projectDir: string): void {
    try {
      const files = fs.readdirSync(projectDir);
      const backups = files
        .filter((f) => f.startsWith('MEMORY.md.bak.'))
        .map((f) => ({
          name: f,
          path: path.join(projectDir, f),
          timestamp: parseInt(f.replace('MEMORY.md.bak.', ''), 10),
        }))
        .sort((a, b) => b.timestamp - a.timestamp);

      // maxBackups を超えた古いバックアップを削除
      for (let i = this._config.maxBackups; i < backups.length; i++) {
        const backup = backups[i];
        if (backup) {
          fs.unlinkSync(backup.path);
          console.log(`Memory: Rotated old backup ${backup.name}`);
        }
      }
    } catch (error) {
      console.error('Failed to rotate backups:', error);
    }
  }

  /**
   * MemorySource をフォーマットする
   */
  private _formatSource(source: MemorySource): string {
    switch (source.channel) {
      case 'slack':
        return `- Slack: channel=${source.channelId}, thread_ts=${source.threadTs}`;
      case 'line':
        return `- LINE: groupId=${source.groupId ?? 'N/A'}`;
      case 'github':
        return `- GitHub: ${source.owner}/${source.repo}#${source.issueNumber}`;
    }
  }
}

// シングルトンインスタンス
let _instance: MemoryStore | undefined;

/**
 * メモリストアのシングルトンインスタンスを取得する
 */
export function GetMemoryStore(config?: MemoryConfig): MemoryStore {
  if (!_instance) {
    if (!config) {
      // デフォルト設定でフォールバック
      config = {
        enabled: true,
        memoryDir: path.join(os.homedir(), '.claps', 'memory'),
        maxMemoryFileSize: 15000,
        compressionTarget: 0.6,
        maxInjectionSize: 10000,
        recencyProtectionDays: 7,
        maxBackups: 3,
      };
    }
    _instance = new MemoryStore(config);
  }
  return _instance;
}
