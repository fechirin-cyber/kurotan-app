'use strict';

/**
 * context-window-table.js
 *
 * モデル別 context window 上限値テーブル (§5.9.2 / C-4)。
 *
 * - 仕様書本体への列挙は行わず、このファイルの差分 commit のみで新モデル追加を完結させる。
 * - 未知モデル受信時は 1,000,000 (1M) を仮置きしてサイレントフェイルする。
 * contextLevel 計測自体は継続する (即座に low 寄りに偏る副作用は許容)。
 */

/**
 * モデル文字列 → context window トークン数 のマップ。
 * キーは model フィールドの先頭一致で検索するため、バージョンサフィックスを持つ
 * 派生モデルも同一エントリで処理できる (例: claude-sonnet-4-5-xxx も "claude-sonnet-4-5" に一致)。
 *
 * @type {Array<{ prefix: string, tokens: number }>}
 */
const CONTEXT_WINDOW_TABLE = [
 // Claude Sonnet 4 系 (claude-sonnet-4-x) — 200K
  { prefix: 'claude-sonnet-4-5', tokens: 200000 },
  { prefix: 'claude-sonnet-4',   tokens: 200000 },

 // Claude Haiku 4 系 — 200K
  { prefix: 'claude-haiku-4-5',  tokens: 200000 },
  { prefix: 'claude-haiku-4',    tokens: 200000 },

 // Claude Opus 4 系 — 1M
  { prefix: 'claude-opus-4-7',   tokens: 1000000 },
  { prefix: 'claude-opus-4-5',   tokens: 1000000 },
  { prefix: 'claude-opus-4',     tokens: 1000000 },

 // Claude 3 系 (旧世代参考値)
  { prefix: 'claude-3-5-sonnet', tokens: 200000 },
  { prefix: 'claude-3-5-haiku',  tokens: 200000 },
  { prefix: 'claude-3-opus',     tokens: 200000 },
  { prefix: 'claude-3-sonnet',   tokens: 200000 },
  { prefix: 'claude-3-haiku',    tokens: 200000 },

 // Sonnet 4-6 (本プロジェクト開発機モデル) — 1M
  { prefix: 'claude-sonnet-4-6', tokens: 1000000 },
];

/**
 * モデル名から context window 上限を返す。
 * テーブル未掲載の場合は 1,000,000 (1M) を返してサイレントフェイルする (§5.9.2)。
 *
 * @param {string} modelName - hooks payload の message.model フィールド
 * @returns {number} context window トークン数
 */
function getContextWindow(modelName) {
  if (typeof modelName !== 'string' || !modelName) {
 return 1000000; // 未知モデル → 1M 仮置き
  }
  const lower = modelName.toLowerCase();
  for (const entry of CONTEXT_WINDOW_TABLE) {
    if (lower.startsWith(entry.prefix.toLowerCase())) {
      return entry.tokens;
    }
  }
 // テーブル未掲載 → 1M 仮置き (サイレントフェイル)
  return 1000000;
}

module.exports = { getContextWindow, CONTEXT_WINDOW_TABLE };
