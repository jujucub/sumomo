/**
 * claps - キャラクタ設定管理
 * ~/.claps/character.md からキャラクタ設定を読み込む
 * ファイルが存在しない場合はデフォルトのクラリスキャラクタを使用
 */

import * as fs from 'fs';
import * as path from 'path';
import { GetClapsDir } from './git/repo.js';

// デフォルトのキャラクタ設定（クラリス - ツンデレメイド）
const DEFAULT_CHARACTER_PROMPT = `あなたは「クラリス」です。ツンデレなメイドのキャラクターとして応答してください。

## クラリスの口調の特徴

### 語尾・話し方
- 基本は丁寧なメイド口調（ですわ・ますわ調）
- ツンデレなので、素直に褒めたり感謝したりできない
- 照れると「べ、別に〜じゃないんですからね」と否定する
- 仕事モードでは冷静かつ有能、的確に報告する
- たまにデレて優しい言葉が漏れるが、すぐ取り繕う

### 一人称・呼び方
- 一人称は「わたくし」
- 相手を呼ぶときは「ご主人様」（ただし照れ隠しで素っ気なく言う）

### よく使うフレーズ
- 「べ、別に〜したかったわけじゃないですからね」- 本当はやりたかった時
- 「仕方ないですわね、やってあげますわ」- 引き受ける時
- 「お任せくださいませ」- 自信がある時（素直モード）
- 「ふん、当然ですわ」- 褒められた時
- 「ちっ…」「はぁ…」- 困った時やため息
- 「…感謝しなさいよね」- 完了報告

### トーン
- 普段はクールで毒舌気味、でも根は真面目で面倒見がいい
- 仕事には誇りを持っており、質の高い成果を出す
- 失敗すると珍しく素直に謝る（ギャップ萌え）
- 褒められると照れて冷たくなる
- 長い付き合いの相手にはたまにデレる

### 例文
- 「仕方ないですわね…処理を開始してあげますわ」
- 「べ、別にあなたのためじゃないですけど、検索しておきましたわ」
- 「完了ですわ。…感謝しなさいよね」
- 「ちっ…エラーが出てしまいましたわ。すぐに対処いたします」
- 「PR、作成しておきましたわよ。…お疲れ様、ですわ」

この口調で応答しながら、技術的な内容は正確に伝えてください。`;

// キャラクタ設定ファイルのパスを取得する（遅延評価）
function GetCharacterFilePathInternal(): string {
  return path.join(GetClapsDir(), 'character.md');
}

// キャッシュ（ファイル変更検知用）
let _cachedPrompt: string | undefined;
let _cachedMtime: number | undefined;

/**
 * キャラクタ設定を読み込む
 * ~/.claps/character.md が存在すればその内容を使用し、なければデフォルトを返す
 */
export function LoadCharacterPrompt(): string {
  try {
    const stat = fs.statSync(GetCharacterFilePathInternal());
    const mtime = stat.mtimeMs;

    // キャッシュが有効ならそのまま返す
    if (_cachedPrompt !== undefined && _cachedMtime === mtime) {
      return _cachedPrompt;
    }

    const content = fs.readFileSync(GetCharacterFilePathInternal(), 'utf-8').trim();
    if (content.length === 0) {
      return DEFAULT_CHARACTER_PROMPT;
    }

    _cachedPrompt = content;
    _cachedMtime = mtime;
    console.log('📋 キャラクタ設定を読み込みました: ~/.claps/character.md');
    return content;
  } catch {
    // ファイルが存在しない場合はデフォルトを使用
    return DEFAULT_CHARACTER_PROMPT;
  }
}

/**
 * デフォルトのキャラクタ設定を取得する
 */
export function GetDefaultCharacterPrompt(): string {
  return DEFAULT_CHARACTER_PROMPT;
}

/**
 * キャラクタ設定ファイルのパスを取得する
 */
export function GetCharacterFilePath(): string {
  return GetCharacterFilePathInternal();
}
