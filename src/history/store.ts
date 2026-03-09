/**
 * claps - 作業履歴ストア
 * JSONL形式で作業履歴を永続化する
 */

import fs from 'fs';
import path from 'path';
import type { WorkHistoryRecord } from '../types/index.js';
import { GetClapsDir } from '../git/repo.js';

// 履歴保存ディレクトリを取得する（遅延評価）
function GetHistoryBaseDir(): string {
  return path.join(GetClapsDir(), 'history');
}

/**
 * 日付文字列（YYYY-MM-DD）を取得する
 */
function FormatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * ユーザーの履歴ディレクトリパスを取得する
 */
function GetUserDir(userId: string): string {
  // ユーザーIDをサニタイズ（ディレクトリトラバーサル防止）
  const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(GetHistoryBaseDir(), safeUserId);
}

/**
 * 作業履歴ストアクラス
 */
export class HistoryStore {
  /**
   * 作業履歴レコードを追記する
   */
  Append(record: WorkHistoryRecord): void {
    const userDir = GetUserDir(record.userId);
    const dateStr = FormatDate(new Date(record.timestamp));
    const filePath = path.join(userDir, `${dateStr}.jsonl`);

    try {
      // ディレクトリがなければ作成
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
      }

      // JSONL形式で追記
      const line = JSON.stringify(record) + '\n';
      fs.appendFileSync(filePath, line, { mode: 0o600 });

      console.log(`History recorded: ${record.id} for user ${record.userId}`);
    } catch (error) {
      console.error('Failed to append history record:', error);
    }
  }

  /**
   * ユーザーの履歴レコードを取得する
   */
  GetRecords(userId: string, days: number, maxRecords: number = 50): readonly WorkHistoryRecord[] {
    const userDir = GetUserDir(userId);

    if (!fs.existsSync(userDir)) {
      return [];
    }

    const records: WorkHistoryRecord[] = [];
    const now = new Date();

    // 指定日数分のファイルを読み込む
    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = FormatDate(date);
      const filePath = path.join(userDir, `${dateStr}.jsonl`);

      if (!fs.existsSync(filePath)) {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter((line) => line.trim() !== '');

        for (const line of lines) {
          try {
            const record = JSON.parse(line) as WorkHistoryRecord;
            records.push(record);
          } catch {
            // 不正なJSONL行はスキップ
            console.warn(`Skipping invalid JSONL line in ${filePath}`);
          }
        }
      } catch (error) {
        console.error(`Failed to read history file ${filePath}:`, error);
      }
    }

    // タイムスタンプの降順でソートし、上限を適用
    const sorted = records.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return sorted.slice(0, maxRecords);
  }

  /**
   * 指定ISO日時以降のレコードを返す
   * sinceIsoの日付から今日までのJSONLファイルを読み、タイムスタンプでフィルタする
   */
  GetRecordsSince(userId: string, sinceIso: string): readonly WorkHistoryRecord[] {
    const userDir = GetUserDir(userId);

    if (!fs.existsSync(userDir)) {
      return [];
    }

    const sinceTime = new Date(sinceIso).getTime();
    const sinceDate = new Date(sinceIso);
    const now = new Date();
    const records: WorkHistoryRecord[] = [];

    // sinceの日付から今日までのファイルを走査
    const current = new Date(sinceDate);
    current.setHours(0, 0, 0, 0);

    while (current <= now) {
      const dateStr = FormatDate(current);
      const filePath = path.join(userDir, `${dateStr}.jsonl`);

      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const lines = content.split('\n').filter((line) => line.trim() !== '');

          for (const line of lines) {
            try {
              const record = JSON.parse(line) as WorkHistoryRecord;
              if (new Date(record.timestamp).getTime() > sinceTime) {
                records.push(record);
              }
            } catch {
              // 不正なJSONL行はスキップ
            }
          }
        } catch (error) {
          console.error(`Failed to read history file ${filePath}:`, error);
        }
      }

      current.setDate(current.getDate() + 1);
    }

    return records;
  }

  /**
   * 指定日付にレコードが存在するかチェックする
   */
  HasRecordsForDate(date: Date): boolean {
    if (!fs.existsSync(GetHistoryBaseDir())) {
      return false;
    }

    const dateStr = FormatDate(date);

    try {
      const userDirs = fs.readdirSync(GetHistoryBaseDir());

      for (const userDir of userDirs) {
        const userPath = path.join(GetHistoryBaseDir(), userDir);

        if (!fs.statSync(userPath).isDirectory()) {
          continue;
        }

        const filePath = path.join(userPath, `${dateStr}.jsonl`);
        if (fs.existsSync(filePath)) {
          // ファイルが存在し、中身があるかチェック
          const stat = fs.statSync(filePath);
          if (stat.size > 0) {
            return true;
          }
        }
      }
    } catch (error) {
      console.error('Failed to check records for date:', error);
    }

    return false;
  }

  /**
   * 指定日数内にアクティブだったユーザーIDの一覧を取得する
   */
  GetActiveUsers(days: number): readonly string[] {
    if (!fs.existsSync(GetHistoryBaseDir())) {
      return [];
    }

    const activeUsers: Set<string> = new Set();
    const now = new Date();

    // 対象日付のセットを作成
    const targetDates: Set<string> = new Set();
    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      targetDates.add(FormatDate(date));
    }

    try {
      const userDirs = fs.readdirSync(GetHistoryBaseDir());

      for (const userDir of userDirs) {
        const userPath = path.join(GetHistoryBaseDir(), userDir);

        // ディレクトリでなければスキップ
        if (!fs.statSync(userPath).isDirectory()) {
          continue;
        }

        // 対象日付のファイルが存在するかチェック
        try {
          const files = fs.readdirSync(userPath);
          for (const file of files) {
            const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
            if (dateMatch && targetDates.has(dateMatch[1] as string)) {
              activeUsers.add(userDir);
              break;
            }
          }
        } catch {
          // ディレクトリの読み込みに失敗した場合はスキップ
        }
      }
    } catch (error) {
      console.error('Failed to list active users:', error);
    }

    return Array.from(activeUsers);
  }
}

// シングルトンインスタンス
let _instance: HistoryStore | undefined;

/**
 * 作業履歴ストアのシングルトンインスタンスを取得する
 */
export function GetHistoryStore(): HistoryStore {
  if (!_instance) {
    _instance = new HistoryStore();
  }
  return _instance;
}
