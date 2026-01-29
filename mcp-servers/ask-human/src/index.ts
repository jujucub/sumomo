#!/usr/bin/env node
/**
 * ask-human MCP Server
 * Claude が人間に質問を送信し、回答を受け取るための MCP サーバー
 *
 * 動作:
 * 1. Claude が ask_human ツールを呼び出す
 * 2. MCP サーバーが承認サーバーに質問を送信
 * 3. 承認サーバーが Slack に質問を送信
 * 4. ユーザーが Slack で回答
 * 5. 回答が Claude に返される
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// 承認サーバーのURL（環境変数またはデフォルト）
const APPROVAL_SERVER_URL =
  process.env['APPROVAL_SERVER_URL'] ?? 'http://127.0.0.1:3001';

// 認証トークンファイル
const AUTH_TOKEN_FILE = path.join(os.homedir(), '.sumomo', 'auth-token');

/**
 * 認証トークンをファイルから読み取る
 */
function ReadAuthToken(): string | undefined {
  try {
    if (fs.existsSync(AUTH_TOKEN_FILE)) {
      return fs.readFileSync(AUTH_TOKEN_FILE, 'utf-8').trim();
    }
  } catch (error) {
    console.error('Failed to read auth token:', error);
  }
  return undefined;
}

// ツール定義
const ASK_HUMAN_TOOL: Tool = {
  name: 'ask_human',
  description: `人間に質問を送信し、回答を待ちます。
判断が必要な場合や、確認が必要な場合に使用してください。
選択肢を提供することで、ユーザーが簡単に回答できるようになります。`,
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: '人間に尋ねる質問',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: '選択肢の配列（任意）。提供すると、ボタンとして表示されます。',
      },
      context: {
        type: 'string',
        description: '質問の背景や補足情報（任意）',
      },
    },
    required: ['question'],
  },
};

/**
 * MCP サーバーを作成する
 */
function CreateServer(): Server {
  const server = new Server(
    {
      name: 'ask-human',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ツール一覧を返す
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [ASK_HUMAN_TOOL],
    };
  });

  // ツール実行
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name !== 'ask_human') {
      return {
        content: [
          {
            type: 'text',
            text: `Unknown tool: ${name}`,
          },
        ],
        isError: true,
      };
    }

    const question = args?.['question'] as string | undefined;
    const options = args?.['options'] as string[] | undefined;
    const context = args?.['context'] as string | undefined;

    if (!question) {
      return {
        content: [
          {
            type: 'text',
            text: 'question is required',
          },
        ],
        isError: true,
      };
    }

    try {
      const answer = await AskHuman(question, options, context);
      return {
        content: [
          {
            type: 'text',
            text: answer,
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: `Failed to ask human: ${message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * 人間に質問を送信し、回答を待つ
 */
async function AskHuman(
  question: string,
  options?: string[],
  context?: string
): Promise<string> {
  // 認証トークンを読み取る
  const authToken = ReadAuthToken();
  if (!authToken) {
    throw new Error('Auth token not found - is sumomo running?');
  }

  const requestBody = {
    question,
    options: options ?? [],
    context: context ?? '',
  };

  const response = await fetch(`${APPROVAL_SERVER_URL}/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': authToken,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Unauthorized - invalid auth token');
    }
    throw new Error(`HTTP error: ${response.status}`);
  }

  const result = (await response.json()) as { answer: string };
  return result.answer;
}

/**
 * メインエントリーポイント
 */
async function Main(): Promise<void> {
  const server = CreateServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // シャットダウン処理
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });
}

Main().catch((error) => {
  console.error('MCP server error:', error);
  process.exit(1);
});
