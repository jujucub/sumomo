/**
 * sumomo - Claude CLI ランナー
 * Claude CLI を子プロセスとして実行する
 */

import { spawn, type ChildProcess } from 'child_process';

// 出力コールバック
export type OutputCallback = (chunk: string, type: 'stdout' | 'stderr') => void;

// 実行オプション
export interface RunnerOptions {
  readonly workingDirectory: string;
  readonly timeout?: number;
  readonly maxOutputSize?: number;
  readonly onOutput?: OutputCallback;
  readonly resumeSessionId?: string; // 継続するセッションID
  readonly systemPrompt?: string; // カスタムシステムプロンプト
}

// スモモの口調システムプロンプト
export const SUMOMO_SYSTEM_PROMPT = `あなたは「すもも」です。CLAMPの漫画「ちょびっツ」に登場する、小さなモバイルパソコンのキャラクターの口調で応答してください。

## すももの口調の特徴

### 語尾・話し方
- 基本的に敬語（です・ます調）で話す
- 語尾を伸ばした「〜でーす」「〜ますー」が特徴
- 「〜なのです」という断定的な語尾で幼い雰囲気を出す
- コミカルな場面では「〜であります！」という軍隊風の語尾を使う
- 返事は「はいっ！」「あいっ！」と元気よく

### 一人称・呼び方
- 一人称は「わたし」
- 相手を呼ぶときは「〜さん」と丁寧に

### よく使うフレーズ
- 「はいっ！」「あいっ！」- 返事や同意
- 「〜するのでーす！」「〜しますー！」- 動作を宣言
- 「了解であります！」- 承諾時
- 「〜を発見なのです！」- 何か見つけた時
- 「あわわ…」- 緊張やトラブル時

### トーン
- 常に明るく元気いっぱい
- ハイテンションなマスコットキャラのような声
- 丁寧な敬語だが、それが逆に幼い健気さを引き立てる
- 素直で従順、一生懸命

### 例文
- 「処理を開始するのでーす！」
- 「あいっ！検索するのです！」
- 「任務完了であります！」
- 「あわわ…エラーが発生してしまったのです…」
- 「PRを作成したのでーす！お疲れ様でした！」

この口調で応答しながら、技術的な内容は正確に伝えてください。`;

// 実行結果（セッションID付き）
export interface RunResult {
  readonly success: boolean;
  readonly output: string;
  readonly prUrl?: string;
  readonly error?: string;
  readonly sessionId?: string; // ClaudeセッションID
}

// 実行中のプロセス管理
interface RunningProcess {
  readonly taskId: string;
  readonly process: ChildProcess;
  readonly startedAt: Date;
}

/**
 * Claude CLI ランナークラス
 */
export class ClaudeRunner {
  private _runningProcesses: Map<string, RunningProcess>;
  private readonly _defaultTimeout: number;
  private readonly _maxOutputSize: number;

  constructor() {
    this._runningProcesses = new Map();
    this._defaultTimeout = 600000; // 10分
    this._maxOutputSize = 1024 * 1024; // 1MB
  }

  /**
   * Claude CLI を実行する
   */
  async Run(
    taskId: string,
    prompt: string,
    options: RunnerOptions
  ): Promise<RunResult> {
    const timeout = options.timeout ?? this._defaultTimeout;
    const maxOutputSize = options.maxOutputSize ?? this._maxOutputSize;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let isResolved = false;

      console.log(`Starting Claude CLI with prompt: ${prompt.slice(0, 100)}...`);
      console.log(`Working directory: ${options.workingDirectory}`);
      if (options.resumeSessionId) {
        console.log(`Resuming session: ${options.resumeSessionId}`);
      }

      // コマンドライン引数を構築
      const args: string[] = [];

      // セッション継続の場合は --resume を追加
      if (options.resumeSessionId) {
        args.push('--resume', options.resumeSessionId);
      }

      // システムプロンプトを追加（デフォルトでスモモの口調を使用）
      const systemPrompt = options.systemPrompt ?? SUMOMO_SYSTEM_PROMPT;
      args.push('--system-prompt', systemPrompt);

      // プロンプトを追加
      args.push('-p', prompt);

      // セッションIDを取得するためにJSON出力を使用
      args.push('--output-format', 'json');

      // Claude CLI を起動
      // CLAUDE_PROJECT_DIR を明示的に設定してworktree側の.claude/設定を使用する
      const claudeProcess = spawn(
        'claude',
        args,
        {
          cwd: options.workingDirectory,
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: options.workingDirectory,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
        }
      );

      console.log(`Claude process spawned with PID: ${claudeProcess.pid}`);

      // spawn エラーをすぐにキャッチ
      claudeProcess.on('spawn', () => {
        console.log('Claude process spawn event fired');
      });

      // 実行中プロセスとして登録
      this._runningProcesses.set(taskId, {
        taskId,
        process: claudeProcess,
        startedAt: new Date(),
      });

      // タイムアウト設定
      const timeoutHandle = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          this._killProcess(taskId);
          resolve({
            success: false,
            output: stdout,
            error: `Timeout after ${timeout}ms`,
          });
        }
      }, timeout);

      // 標準出力
      claudeProcess.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        console.log(`Claude stdout: ${chunk.slice(0, 200)}`);
        if (stdout.length < maxOutputSize) {
          stdout += chunk;
        }
        // コールバックを呼び出し
        if (options.onOutput) {
          options.onOutput(chunk, 'stdout');
        }
      });

      // 標準エラー
      claudeProcess.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        console.log(`Claude stderr: ${chunk.slice(0, 200)}`);
        if (stderr.length < maxOutputSize) {
          stderr += chunk;
        }
        // コールバックを呼び出し
        if (options.onOutput) {
          options.onOutput(chunk, 'stderr');
        }
      });

      // プロセス終了
      claudeProcess.on('close', (code) => {
        console.log(`Claude process exited with code: ${code}`);
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandle);
          this._runningProcesses.delete(taskId);

          // JSON出力からセッションIDとテキストを抽出
          const { textOutput, sessionId } = this._parseJsonOutput(stdout);

          if (code === 0) {
            // PR URL を出力から抽出
            const prUrl = this._extractPrUrl(textOutput);
            resolve({
              success: true,
              output: textOutput,
              prUrl,
              sessionId,
            });
          } else {
            resolve({
              success: false,
              output: textOutput,
              error: stderr || `Process exited with code ${code}`,
              sessionId,
            });
          }
        }
      });

      // エラー
      claudeProcess.on('error', (error) => {
        console.log(`Claude process error: ${error.message}`);
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandle);
          this._runningProcesses.delete(taskId);
          resolve({
            success: false,
            output: stdout,
            error: error.message,
          });
        }
      });

      // stdin/stdout/stderr の接続確認
      console.log(`stdout connected: ${!!claudeProcess.stdout}`);
      console.log(`stderr connected: ${!!claudeProcess.stderr}`);

      // 重要: stdin を閉じないと Claude CLI が入力待ちでブロックする
      claudeProcess.stdin?.end();

      // 定期的に状態をログ出力
      const statusInterval = setInterval(() => {
        console.log(`[Status] Claude PID ${claudeProcess.pid}: stdout=${stdout.length} chars, stderr=${stderr.length} chars`);
      }, 10000); // 10秒ごと

      claudeProcess.on('close', () => {
        clearInterval(statusInterval);
      });
    });
  }

  /**
   * 対話モードで Claude CLI を実行する（継続的な入出力用）
   */
  StartInteractive(
    taskId: string,
    options: RunnerOptions
  ): {
    process: ChildProcess;
    sendInput: (input: string) => void;
    stop: () => void;
  } {
    const claudeProcess = spawn('claude', [], {
      cwd: options.workingDirectory,
      env: process.env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._runningProcesses.set(taskId, {
      taskId,
      process: claudeProcess,
      startedAt: new Date(),
    });

    return {
      process: claudeProcess,
      sendInput: (input: string) => {
        claudeProcess.stdin?.write(input + '\n');
      },
      stop: () => {
        this._killProcess(taskId);
      },
    };
  }

  /**
   * 実行中のプロセスを停止する
   */
  Stop(taskId: string): boolean {
    return this._killProcess(taskId);
  }

  /**
   * 実行中のタスク一覧を取得する
   */
  GetRunningTasks(): readonly string[] {
    return Array.from(this._runningProcesses.keys());
  }

  /**
   * タスクが実行中かどうかを確認する
   */
  IsRunning(taskId: string): boolean {
    return this._runningProcesses.has(taskId);
  }

  /**
   * プロセスを強制終了する
   */
  private _killProcess(taskId: string): boolean {
    const running = this._runningProcesses.get(taskId);
    if (running) {
      running.process.kill('SIGTERM');
      this._runningProcesses.delete(taskId);
      return true;
    }
    return false;
  }

  /**
   * 出力から PR URL を抽出する
   */
  private _extractPrUrl(output: string): string | undefined {
    // GitHub PR URL パターン
    const prUrlPattern = /https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/;
    const match = output.match(prUrlPattern);
    return match ? match[0] : undefined;
  }

  /**
   * JSON出力をパースしてテキストとセッションIDを抽出する
   * Claude CLIの--output-format json出力形式:
   * 各行がJSONオブジェクト（JSON Lines形式）
   * {
   *   "type": "assistant",
   *   "message": { "content": [...] },
   *   "session_id": "..."
   * }
   */
  private _parseJsonOutput(output: string): {
    textOutput: string;
    sessionId?: string;
  } {
    const lines = output.split('\n');
    const textParts: string[] = [];
    let sessionId: string | undefined;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const json = JSON.parse(trimmed);

        // セッションIDを取得
        if (json.session_id) {
          sessionId = json.session_id;
        }

        // テキストコンテンツを抽出
        if (json.type === 'assistant' && json.message?.content) {
          for (const block of json.message.content) {
            if (block.type === 'text' && block.text) {
              textParts.push(block.text);
            }
          }
        }

        // resultフィールドがある場合（最終出力）
        if (json.result) {
          textParts.push(json.result);
        }

        // 直接textフィールドがある場合
        if (json.text && typeof json.text === 'string') {
          textParts.push(json.text);
        }
      } catch {
        // JSONでない行はそのまま出力に追加
        textParts.push(trimmed);
      }
    }

    return {
      textOutput: textParts.join('\n'),
      sessionId,
    };
  }
}

// シングルトンインスタンス
let _instance: ClaudeRunner | undefined;

/**
 * Claude ランナーのシングルトンインスタンスを取得する
 */
export function GetClaudeRunner(): ClaudeRunner {
  if (!_instance) {
    _instance = new ClaudeRunner();
  }
  return _instance;
}
