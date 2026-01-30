#!/usr/bin/env python3
"""
sumomo - Slack 承認 Hook スクリプト
PreToolUse Hook として実行され、危険な操作に対して Slack 経由で承認を求める
承認後、tmux send-keys で Claude CLI に許可を送信する
"""

import json
import os
import sys
import subprocess
import urllib.request
import urllib.error
from pathlib import Path

# 承認サーバーのURL
APPROVAL_SERVER_URL = os.environ.get('APPROVAL_SERVER_URL', 'http://localhost:3001')

# tmuxセッション名（環境変数から取得）
TMUX_SESSION = os.environ.get('SUMOMO_TMUX_SESSION', '')

# 認証トークンファイルのパス
AUTH_TOKEN_FILE = Path.home() / '.sumomo' / 'auth-token'


def get_auth_token() -> str:
    """認証トークンをファイルから読み込む"""
    try:
        return AUTH_TOKEN_FILE.read_text().strip()
    except FileNotFoundError:
        return ''


def main():
    """メインエントリーポイント"""
    # SUMOMO_TMUX_SESSION が設定されていない場合は自動許可
    # （sumomo 以外の通常のClaudeセッションでは承認をスキップ）
    if not TMUX_SESSION:
        output_result("allow")
        return

    # 標準入力からHook入力を読み取る
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        # JSONパースエラーの場合は許可
        output_result("allow")
        return

    tool_name = input_data.get('tool_name', '')
    tool_input = input_data.get('tool_input', {})

    # 承認サーバーに問い合わせ
    try:
        result = request_approval(tool_name, tool_input)
        decision = result.get("permissionDecision", "allow")
        comment = result.get("message", "")

        # tmuxセッションがある場合は、send-keysで許可/拒否を送信
        if TMUX_SESSION:
            send_tmux_response(decision, comment)

        output_result(decision, comment)
    except Exception as e:
        # エラーの場合は拒否
        output_result("deny", f"Approval request failed: {str(e)}")


def request_approval(tool_name: str, tool_input: dict) -> dict:
    """承認サーバーに承認リクエストを送信する"""
    url = f"{APPROVAL_SERVER_URL}/approve"

    data = json.dumps({
        "tool_name": tool_name,
        "tool_input": tool_input
    }).encode('utf-8')

    # 認証トークンを取得
    auth_token = get_auth_token()
    if not auth_token:
        raise Exception("Auth token not found. Is sumomo running?")

    headers = {
        'Content-Type': 'application/json',
        'X-Auth-Token': auth_token
    }

    request = urllib.request.Request(url, data=data, headers=headers, method='POST')

    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            result = json.loads(response.read().decode('utf-8'))
            return result
    except urllib.error.HTTPError as e:
        raise Exception(f"HTTP error: {e.code}")
    except urllib.error.URLError as e:
        raise Exception(f"URL error: {e.reason}")


def send_tmux_response(decision: str, comment: str = ""):
    """tmux send-keys で Claude CLI に許可/拒否を送信する"""
    if not TMUX_SESSION:
        return

    try:
        if decision == "allow":
            if comment:
                # 許可 + コメント: Tab → コメント → Enter
                subprocess.run(['tmux', 'send-keys', '-t', TMUX_SESSION, 'Tab'], check=True)
                subprocess.run(['tmux', 'send-keys', '-t', TMUX_SESSION, comment], check=True)
                subprocess.run(['tmux', 'send-keys', '-t', TMUX_SESSION, 'Enter'], check=True)
            else:
                # 許可のみ: Enter（Yesがデフォルト選択）
                subprocess.run(['tmux', 'send-keys', '-t', TMUX_SESSION, 'Enter'], check=True)
        else:
            # 拒否: 下矢印2回でNOに移動
            subprocess.run(['tmux', 'send-keys', '-t', TMUX_SESSION, 'Down', 'Down'], check=True)
            if comment:
                # 拒否 + コメント: Tab → コメント → Enter
                subprocess.run(['tmux', 'send-keys', '-t', TMUX_SESSION, 'Tab'], check=True)
                subprocess.run(['tmux', 'send-keys', '-t', TMUX_SESSION, comment], check=True)
                subprocess.run(['tmux', 'send-keys', '-t', TMUX_SESSION, 'Enter'], check=True)
            else:
                # 拒否のみ: Enter
                subprocess.run(['tmux', 'send-keys', '-t', TMUX_SESSION, 'Enter'], check=True)

        print(f"[Hook] Sent {decision} to tmux session: {TMUX_SESSION}", file=sys.stderr)
    except subprocess.CalledProcessError as e:
        print(f"[Hook] Failed to send tmux keys: {e}", file=sys.stderr)


def output_result(decision: str, reason: str = ""):
    """Claude CLI が期待する形式で結果を出力する"""
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason
        }
    }))


if __name__ == '__main__':
    main()
