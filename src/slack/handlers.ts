/**
 * sumomo - Slack イベントハンドラー
 * メンション、ボタンクリック、モーダル、メッセージの処理
 */

import type { App } from '@slack/bolt';
import type {
  ApprovalResult,
  SlackTaskMetadata,
  AllowedUsers,
} from '../types/index.js';

// ホワイトリスト（RegisterSlackHandlersで設定、UpdateAllowedUsersで更新可能）
let _allowedUsers: AllowedUsers | undefined;

/**
 * SlackユーザーIDがホワイトリストに含まれているかチェック
 */
function IsUserAllowed(userId: string): boolean {
  if (!_allowedUsers) return false;
  // ホワイトリストが空の場合は全員拒否
  if (_allowedUsers.slack.length === 0) return false;
  return _allowedUsers.slack.includes(userId);
}

/**
 * Slackホワイトリストを動的に更新する
 */
export function UpdateAllowedUsers(slackUsers: readonly string[]): void {
  if (!_allowedUsers) {
    _allowedUsers = { github: [], slack: slackUsers };
  } else {
    _allowedUsers = {
      ..._allowedUsers,
      slack: slackUsers,
    };
  }
  console.log(`Slack allowed users updated: ${slackUsers.length} users`);
}

// 承認待ちリクエストの管理
interface PendingApproval {
  readonly requestId: string;
  readonly taskId: string;
  readonly tool: string;
  readonly command: string;
  readonly channelId: string;
  readonly messageTs: string;
  resolve: (result: ApprovalResult) => void;
}

// 質問待ちリクエストの管理
interface PendingQuestion {
  readonly requestId: string;
  readonly taskId: string;
  resolve: (answer: string) => void;
}

const _pendingApprovals = new Map<string, PendingApproval>();
const _pendingQuestions = new Map<string, PendingQuestion>();

/**
 * Slack ハンドラーを登録する
 */
export function RegisterSlackHandlers(
  app: App,
  channelId: string,
  onMention: (metadata: SlackTaskMetadata, prompt: string) => Promise<void>,
  allowedUsers: AllowedUsers
): void {
  // ホワイトリストを保存
  _allowedUsers = allowedUsers;

  // @sumomo メンションの処理
  app.event('app_mention', async ({ event, say }) => {
    const text = event.text;
    const userId = event.user ?? 'unknown';
    const threadTs = event.thread_ts ?? event.ts;

    // ホワイトリストチェック
    if (!IsUserAllowed(userId)) {
      console.log(`Denied Slack request from ${userId} (not in whitelist)`);
      await say({
        text: 'このリクエストは処理できませんでした。',
        thread_ts: threadTs,
      });
      return;
    }

    // @sumomo を除いた指示テキスト
    const prompt = text.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!prompt) {
      await say({
        text: 'はいっ！何をお手伝いしましょうか〜？ご用件をお聞かせくださいなのです！',
        thread_ts: threadTs,
      });
      return;
    }

    // スレッドで処理開始を通知
    await say({
      text: '🍑 あいっ！処理を開始するのでーす！',
      thread_ts: threadTs,
    });

    const metadata: SlackTaskMetadata = {
      source: 'slack',
      channelId: event.channel,
      threadTs,
      userId,
      messageText: text,
    };

    await onMention(metadata, prompt);
  });

  // 承認ボタンのクリック処理（モーダルを開く）
  app.action('approval_allow', async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (!action || action.type !== 'button') return;

    const requestId = action.value;
    console.log(`[approval_allow] requestId: ${requestId}`);
    if (!requestId) return;

    const pending = _pendingApprovals.get(requestId);
    console.log(`[approval_allow] pending found: ${!!pending}, pendingApprovals size: ${_pendingApprovals.size}`);
    if (!pending) return;

    // モーダルを開く
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: `approval_modal_allow_${requestId}`,
        title: {
          type: 'plain_text',
          text: '実行を許可',
        },
        submit: {
          type: 'plain_text',
          text: '許可する',
        },
        close: {
          type: 'plain_text',
          text: 'キャンセル',
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*ツール:* ${pending.tool}\n*コマンド:*\n\`\`\`${pending.command.slice(0, 500)}\`\`\``,
            },
          },
          {
            type: 'input',
            block_id: 'comment_block',
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'comment_input',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'コメントがあれば入力してください（任意）',
              },
            },
            label: {
              type: 'plain_text',
              text: 'コメント',
            },
          },
        ],
      },
    });
  });

  app.action('approval_deny', async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (!action || action.type !== 'button') return;

    const requestId = action.value;
    if (!requestId) return;

    const pending = _pendingApprovals.get(requestId);
    if (!pending) return;

    // モーダルを開く
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: `approval_modal_deny_${requestId}`,
        title: {
          type: 'plain_text',
          text: '実行を拒否',
        },
        submit: {
          type: 'plain_text',
          text: '拒否する',
        },
        close: {
          type: 'plain_text',
          text: 'キャンセル',
        },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*ツール:* ${pending.tool}\n*コマンド:*\n\`\`\`${pending.command.slice(0, 500)}\`\`\``,
            },
          },
          {
            type: 'input',
            block_id: 'comment_block',
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'comment_input',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: '拒否理由や代替案があれば入力してください（任意）',
              },
            },
            label: {
              type: 'plain_text',
              text: 'コメント',
            },
          },
        ],
      },
    });
  });

  // モーダル送信処理（許可）
  app.view(/^approval_modal_allow_/, async ({ ack, view, body, client }) => {
    await ack();

    const callbackId = view.callback_id;
    const requestId = callbackId.replace('approval_modal_allow_', '');
    console.log(`[modal_allow] callbackId: ${callbackId}, requestId: ${requestId}`);

    const pending = _pendingApprovals.get(requestId);
    console.log(`[modal_allow] pending found: ${!!pending}, pendingApprovals size: ${_pendingApprovals.size}`);
    if (!pending) return;

    // コメントを取得
    const commentBlock = view.state.values['comment_block'];
    const comment = commentBlock?.['comment_input']?.value ?? '';

    // 承認を解決
    console.log(`[modal_allow] Resolving approval with decision: allow`);
    pending.resolve({
      decision: 'allow',
      comment: comment || undefined,
      respondedBy: body.user.id,
    });
    _pendingApprovals.delete(requestId);
    console.log(`[modal_allow] Deleted from pendingApprovals, size: ${_pendingApprovals.size}`);

    // 元のメッセージを更新
    let updateText = `✅ *許可されました* by <@${body.user.id}>`;
    if (comment) {
      updateText += `\n💬 コメント: ${comment}`;
    }

    await client.chat.update({
      channel: pending.channelId,
      ts: pending.messageTs,
      text: '✅ 許可されました',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: updateText,
          },
        },
      ],
    });
  });

  // モーダル送信処理（拒否）
  app.view(/^approval_modal_deny_/, async ({ ack, view, body, client }) => {
    await ack();

    const callbackId = view.callback_id;
    const requestId = callbackId.replace('approval_modal_deny_', '');

    const pending = _pendingApprovals.get(requestId);
    if (!pending) return;

    // コメントを取得
    const commentBlock = view.state.values['comment_block'];
    const comment = commentBlock?.['comment_input']?.value ?? '';

    // 拒否を解決
    pending.resolve({
      decision: 'deny',
      comment: comment || undefined,
      respondedBy: body.user.id,
    });
    _pendingApprovals.delete(requestId);

    // 元のメッセージを更新
    let updateText = `❌ *拒否されました* by <@${body.user.id}>`;
    if (comment) {
      updateText += `\n💬 コメント: ${comment}`;
    }

    await client.chat.update({
      channel: pending.channelId,
      ts: pending.messageTs,
      text: '❌ 拒否されました',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: updateText,
          },
        },
      ],
    });
  });

  // 質問への回答ボタン（動的アクションID対応）
  app.action(/^answer_/, async ({ ack, body, client }) => {
    await ack();

    if (body.type !== 'block_actions') return;

    const action = body.actions[0];
    if (!action || action.type !== 'button') return;

    // action_id から requestId と answer を抽出
    // フォーマット: answer_{requestId}_{answerIndex}
    const parts = action.action_id.split('_');
    if (parts.length < 3) return;

    const requestId = parts[1];
    const answer = action.value ?? '';

    if (!requestId) return;

    const pending = _pendingQuestions.get(requestId);
    if (pending) {
      pending.resolve(answer);
      _pendingQuestions.delete(requestId);

      // メッセージを更新
      await client.chat.update({
        channel: body.channel?.id ?? channelId,
        ts: body.message?.ts ?? '',
        text: `回答: ${answer}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `💬 *回答:* ${answer} by <@${body.user.id}>`,
            },
          },
        ],
      });
    }
  });
}

/**
 * 承認リクエストを Slack に送信し、回答を待つ（モーダル対応）
 */
export async function RequestApproval(
  app: App,
  channelId: string,
  requestId: string,
  taskId: string,
  tool: string,
  command: string,
  threadTs?: string
): Promise<ApprovalResult> {
  return new Promise((resolve) => {
    // 先に承認待ちとして登録（ボタンクリック時に参照できるように）
    _pendingApprovals.set(requestId, {
      requestId,
      taskId,
      tool,
      command,
      channelId,
      messageTs: '', // 後で更新
      resolve,
    });

    // Slack にメッセージを送信
    void app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `🍑 実行許可リクエストなのです: ${tool}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🍑 すももからの実行許可リクエストであります！',
            emoji: true,
          },
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*ツール:*\n${tool}`,
            },
            {
              type: 'mrkdwn',
              text: `*タスクID:*\n${taskId.slice(0, 8)}...`,
            },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*詳細:*\n\`\`\`${command.slice(0, 500)}${command.length > 500 ? '...' : ''}\`\`\``,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '✅ 許可',
                emoji: true,
              },
              style: 'primary',
              action_id: 'approval_allow',
              value: requestId,
            },
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: '❌ 拒否',
                emoji: true,
              },
              style: 'danger',
              action_id: 'approval_deny',
              value: requestId,
            },
          ],
        },
      ],
    }).then((result) => {
      // messageTsを更新
      const pending = _pendingApprovals.get(requestId);
      if (pending) {
        _pendingApprovals.set(requestId, {
          ...pending,
          messageTs: result.ts ?? '',
        });
      }
    });
  });
}

/**
 * 質問を Slack に送信し、回答を待つ
 */
export async function AskQuestion(
  app: App,
  channelId: string,
  requestId: string,
  taskId: string,
  question: string,
  options: readonly string[],
  threadTs?: string
): Promise<string> {
  return new Promise((resolve) => {
    // 質問待ちとして登録
    _pendingQuestions.set(requestId, {
      requestId,
      taskId,
      resolve,
    });

    // 選択肢ボタンを生成
    const buttons = options.map((option, index) => ({
      type: 'button' as const,
      text: {
        type: 'plain_text' as const,
        text: option,
        emoji: true,
      },
      action_id: `answer_${requestId}_${index}`,
      value: option,
    }));

    // Slack にメッセージを送信
    void app.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `🍑 お聞きしたいことがあるのです: ${question}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '🍑 すももからの質問なのでーす！',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: question,
          },
        },
        {
          type: 'actions',
          elements: buttons,
        },
      ],
    });
  });
}

/**
 * GitHub Issue 用のスレッドを作成する
 */
export async function CreateIssueThread(
  app: App,
  channelId: string,
  owner: string,
  repo: string,
  issueNumber: number,
  issueTitle: string,
  issueUrl: string
): Promise<string> {
  const result = await app.client.chat.postMessage({
    channel: channelId,
    text: `🍑 あいっ！GitHub Issue の処理を開始するのでーす！`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: '🍑 GitHub Issue 処理開始であります！',
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*<${issueUrl}|#${issueNumber}: ${issueTitle}>*\n\`${owner}/${repo}\``,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '処理の進捗はこのスレッドに投稿するのです！お楽しみに〜♪',
          },
        ],
      },
    ],
  });

  return result.ts ?? '';
}

/**
 * 処理開始を通知する
 */
export async function NotifyTaskStarted(
  app: App,
  channelId: string,
  _taskId: string,
  description: string,
  threadTs?: string
): Promise<string> {
  const result = await app.client.chat.postMessage({
    channel: channelId,
    text: `🍑 了解であります！処理を開始するのでーす: ${description}`,
    thread_ts: threadTs,
  });
  return result.ts ?? '';
}

/**
 * 処理完了を通知する
 */
export async function NotifyTaskCompleted(
  app: App,
  channelId: string,
  _taskId: string,
  message: string,
  prUrl?: string,
  threadTs?: string
): Promise<void> {
  let text = `🍑 任務完了であります！${message}`;
  if (prUrl) {
    text += `\nPRを作成したのでーす: ${prUrl}`;
  }

  await app.client.chat.postMessage({
    channel: channelId,
    text,
    thread_ts: threadTs,
  });
}

/**
 * エラーを通知する
 */
export async function NotifyError(
  app: App,
  channelId: string,
  _taskId: string,
  error: string,
  threadTs?: string
): Promise<void> {
  await app.client.chat.postMessage({
    channel: channelId,
    text: `🍑 あわわ…エラーが発生してしまったのです…: ${error}`,
    thread_ts: threadTs,
  });
}

/**
 * 進捗を通知する
 */
export async function NotifyProgress(
  app: App,
  channelId: string,
  message: string,
  threadTs?: string
): Promise<void> {
  await app.client.chat.postMessage({
    channel: channelId,
    text: `🍑 ${message}`,
    thread_ts: threadTs,
  });
}
