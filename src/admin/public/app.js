/**
 * sumomo 管理画面 - フロントエンドロジック
 */

// 状態
let authToken = localStorage.getItem('sumomo-auth-token') || '';
let config = {
  allowedGithubUsers: [],
  allowedSlackUsers: [],
  githubRepos: [],
};

// 初期化
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();

  // トークンが保存されていれば自動認証
  if (authToken) {
    loadConfig();
  }
});

/**
 * タブ切り替えの設定
 */
function setupTabs() {
  const tabs = document.querySelectorAll('.tab');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetId = tab.dataset.tab;

      // アクティブタブを切り替え
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      // コンテンツを切り替え
      document.querySelectorAll('.tab-content').forEach((content) => {
        content.classList.remove('active');
      });
      document.getElementById(targetId).classList.add('active');
    });
  });
}

/**
 * 認証を実行
 */
async function authenticate() {
  const input = document.getElementById('token-input');
  const token = input.value.trim();

  if (!token) {
    alert('トークンを入力してください');
    return;
  }

  authToken = token;

  try {
    await loadConfig();
    // 成功したらトークンを保存
    localStorage.setItem('sumomo-auth-token', token);
  } catch (error) {
    authToken = '';
    localStorage.removeItem('sumomo-auth-token');
    alert('認証に失敗しました: ' + error.message);
  }
}

/**
 * 設定を取得
 */
async function loadConfig() {
  const response = await fetch('/api/config', {
    headers: {
      'x-auth-token': authToken,
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('認証トークンが無効です');
    }
    throw new Error('設定の取得に失敗しました');
  }

  config = await response.json();
  showMainContent();
  renderAll();
}

/**
 * 設定を保存
 */
async function saveConfig() {
  const response = await fetch('/api/config', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-auth-token': authToken,
    },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    if (response.status === 401) {
      // トークンが無効になった場合
      authToken = '';
      localStorage.removeItem('sumomo-auth-token');
      hideMainContent();
      alert('セッションが無効になりました。再度認証してください。');
      return;
    }
    throw new Error('設定の保存に失敗しました');
  }

  const result = await response.json();
  config = result.config;
  renderAll();
}

/**
 * メインコンテンツを表示
 */
function showMainContent() {
  document.getElementById('auth-form').style.display = 'none';
  document.getElementById('main-content').style.display = 'block';
  document.getElementById('auth-status').textContent = '認証済み';
}

/**
 * メインコンテンツを非表示
 */
function hideMainContent() {
  document.getElementById('auth-form').style.display = 'block';
  document.getElementById('main-content').style.display = 'none';
  document.getElementById('auth-status').textContent = '';
}

/**
 * すべてのリストを再描画
 */
function renderAll() {
  renderList('github-users-list', config.allowedGithubUsers, removeGithubUser);
  renderList('slack-users-list', config.allowedSlackUsers, removeSlackUser);
  renderList('github-repos-list', config.githubRepos, removeGithubRepo);
}

/**
 * リストを描画（DOM APIを使用してXSS対策）
 */
function renderList(elementId, items, removeCallback) {
  const list = document.getElementById(elementId);
  list.innerHTML = '';

  if (items.length === 0) {
    const emptyLi = document.createElement('li');
    emptyLi.className = 'empty-message';
    emptyLi.textContent = '登録されていません';
    list.appendChild(emptyLi);
    return;
  }

  items.forEach((item, index) => {
    const li = document.createElement('li');

    const span = document.createElement('span');
    span.className = 'item-name';
    span.textContent = item;

    const button = document.createElement('button');
    button.className = 'danger';
    button.textContent = '削除';
    button.addEventListener('click', () => removeCallback(index));

    li.appendChild(span);
    li.appendChild(button);
    list.appendChild(li);
  });
}

// === GitHub ユーザー ===

/**
 * GitHubユーザーを追加
 */
async function addGithubUser() {
  const input = document.getElementById('github-user-input');
  const username = input.value.trim();

  if (!username) {
    alert('ユーザー名を入力してください');
    return;
  }

  // GitHubユーザー名の検証（1-39文字、英数字とハイフン、先頭/末尾にハイフン不可）
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(username)) {
    alert('無効なGitHubユーザー名です');
    return;
  }

  if (config.allowedGithubUsers.includes(username)) {
    alert('このユーザーは既に登録されています');
    return;
  }

  config.allowedGithubUsers = [...config.allowedGithubUsers, username];
  input.value = '';

  try {
    await saveConfig();
  } catch (error) {
    alert(error.message);
    // 失敗したら元に戻す（不変性パターン）
    config.allowedGithubUsers = config.allowedGithubUsers.filter(
      (u) => u !== username
    );
    renderAll();
  }
}

/**
 * GitHubユーザーを削除
 */
async function removeGithubUser(index) {
  const removed = config.allowedGithubUsers[index];
  config.allowedGithubUsers = config.allowedGithubUsers.filter(
    (_, i) => i !== index
  );

  try {
    await saveConfig();
  } catch (error) {
    alert(error.message);
    // 失敗したら元に戻す（不変性パターン）
    config.allowedGithubUsers = [
      ...config.allowedGithubUsers.slice(0, index),
      removed,
      ...config.allowedGithubUsers.slice(index),
    ];
    renderAll();
  }
}

// === Slack ユーザー ===

/**
 * Slackユーザーを追加
 */
async function addSlackUser() {
  const input = document.getElementById('slack-user-input');
  const userId = input.value.trim();

  if (!userId) {
    alert('ユーザーIDを入力してください');
    return;
  }

  // SlackユーザーIDの検証（U + 大文字英数字8-11文字）
  if (!/^U[A-Z0-9]{8,11}$/.test(userId)) {
    alert('無効なSlackユーザーIDです。形式: U12345678');
    return;
  }

  if (config.allowedSlackUsers.includes(userId)) {
    alert('このユーザーは既に登録されています');
    return;
  }

  config.allowedSlackUsers = [...config.allowedSlackUsers, userId];
  input.value = '';

  try {
    await saveConfig();
  } catch (error) {
    alert(error.message);
    // 失敗したら元に戻す（不変性パターン）
    config.allowedSlackUsers = config.allowedSlackUsers.filter(
      (u) => u !== userId
    );
    renderAll();
  }
}

/**
 * Slackユーザーを削除
 */
async function removeSlackUser(index) {
  const removed = config.allowedSlackUsers[index];
  config.allowedSlackUsers = config.allowedSlackUsers.filter(
    (_, i) => i !== index
  );

  try {
    await saveConfig();
  } catch (error) {
    alert(error.message);
    // 失敗したら元に戻す（不変性パターン）
    config.allowedSlackUsers = [
      ...config.allowedSlackUsers.slice(0, index),
      removed,
      ...config.allowedSlackUsers.slice(index),
    ];
    renderAll();
  }
}

// === GitHub リポジトリ ===

/**
 * GitHubリポジトリを追加
 */
async function addGithubRepo() {
  const input = document.getElementById('github-repo-input');
  const repo = input.value.trim();

  if (!repo) {
    alert('リポジトリ名を入力してください');
    return;
  }

  // owner/repo 形式のバリデーション
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
    alert('リポジトリ名は owner/repo 形式で入力してください');
    return;
  }

  if (config.githubRepos.includes(repo)) {
    alert('このリポジトリは既に登録されています');
    return;
  }

  config.githubRepos = [...config.githubRepos, repo];
  input.value = '';

  try {
    await saveConfig();
  } catch (error) {
    alert(error.message);
    // 失敗したら元に戻す（不変性パターン）
    config.githubRepos = config.githubRepos.filter((r) => r !== repo);
    renderAll();
  }
}

/**
 * GitHubリポジトリを削除
 */
async function removeGithubRepo(index) {
  const removed = config.githubRepos[index];
  config.githubRepos = config.githubRepos.filter((_, i) => i !== index);

  try {
    await saveConfig();
  } catch (error) {
    alert(error.message);
    // 失敗したら元に戻す（不変性パターン）
    config.githubRepos = [
      ...config.githubRepos.slice(0, index),
      removed,
      ...config.githubRepos.slice(index),
    ];
    renderAll();
  }
}
