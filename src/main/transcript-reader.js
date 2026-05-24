'use strict';

/**
 * transcript-reader.js
 *
 * transcript_path (.jsonl) の末尾 1 行を読み、usage を集計して
 * contextLevel を算出・IPC 送信する (§5.9.2 / §5.9.6)。
 *
 * プライバシー制約 (§12 項目 6 / agent_guide §5.7 項目 2):
 * - 本文・transcript_path・トークン数を renderer に送信しない
 * - IPC ペイロードは { sessionId, level } のみ
 * - usage フィールドは 5 種のみ取得し main process 内メモリで完結
 * - 永続化しない
 */

const fs = require('fs');
const { getContextWindow } = require('./context-window-table');

// ─── 定数 ──────────────────────────────────────────────────────────

/** 5 段階 contextLevel 帯の既定境界値 (%) */
const DEFAULT_THRESHOLDS = {
 low: 0, // 0-30%
 mid: 30, // 30-60%
 high: 60, // 60-80%
 critical: 80, // 80-95%
 // 95-100% は critical (sleep-pose 寄り) — CSS で data-context-level="critical" + usage % で制御
};

/** ヒステリシス幅 (%) §5.9.3 */
const HYSTERESIS_PCT = 2;

/**
 * 末尾 1 行取得用: バッファサイズ (4KB 以内想定、§5.9.6)
 * .jsonl は各行が独立 JSON なので、末尾から最大 4096 バイトを読んで
 * 最後の改行区切りを取得する。
 */
const TAIL_READ_BYTES = 4096;

// ─── セッション別状態 ───────────────────────────────────────────────

/**
 * sessionId → SessionContextState のマップ。main process 内のみ保持。
 * @type {Map<string, SessionContextState>}
 *
 * SessionContextState: {
 * lastMeasureMs: number, // 前回計測時刻 (throttle 用)
 * lastLevel: string, // 'low' | 'mid' | 'high' | 'critical'
 * lastUsagePct: number, // 0-100 (前回の使用率)
 * throttleMs: number, // throttle 間隔 (ms)
 * }
 */
const sessionStates = new Map();

// ─── ユーティリティ ─────────────────────────────────────────────────

/**
 * ファイル末尾から最大 TAIL_READ_BYTES バイトを読み、最後の完全行を返す。
 * I/O ≦ 5ms 目標 (§5.9.6)。
 * 失敗時は null を返す (サイレントフェイル)。
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function readLastLine(filePath) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return null;

    fd = fs.openSync(filePath, 'r');
    const readBytes = Math.min(TAIL_READ_BYTES, stat.size);
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
    fs.closeSync(fd);
    fd = undefined;

    const text = buf.toString('utf8');
 // 末尾の改行を除去して最後の行を取得
    const lines = text.split('\n');
 // 末尾が空行のことがある
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.length > 0) return line;
    }
    return null;
  } catch (e) {
 // サイレントフェイル: transcript_path 不存在 / 権限エラー等
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    return null;
  }
}

/**
 * 末尾 1 行の JSON を parse して usage 5 フィールドを返す。
 * 失敗時は null を返す (サイレントフェイル)。
 *
 * 取得するフィールド (§5.9.2 / agent_guide §5.7 項目 1):
 * input_tokens / output_tokens / cache_creation_input_tokens
 * / cache_read_input_tokens / total (合算済)
 *
 * @param {string} line
 * @returns {{ input_tokens: number, output_tokens: number, cache_creation: number, cache_read: number, model: string }|null}
 */
function parseUsageLine(line) {
  try {
    const obj = JSON.parse(line);
    if (!obj || typeof obj !== 'object') return null;

 // usage フィールドの存在確認
    const usage = obj.message && obj.message.usage;
    if (!usage) return null;

    const input   = Number(usage.input_tokens)              || 0;
    const output  = Number(usage.output_tokens)             || 0;
    const create  = Number(usage.cache_creation_input_tokens) || 0;
    const read    = Number(usage.cache_read_input_tokens)   || 0;

    const model = (obj.message && typeof obj.message.model === 'string')
      ? obj.message.model
      : '';

    return { input_tokens: input, output_tokens: output, cache_creation: create, cache_read: read, model };
  } catch (e) {
    return null;
  }
}

/**
 * usage から使用率 (0-100) を算出する。
 * 使用率 = (input + cache_creation + cache_read) / context_window * 100
 * ※ output_tokens は次の input に積まれるため input 系合計を採用 (§5.9.2)
 *
 * @param {{ input_tokens: number, cache_creation: number, cache_read: number, model: string }} usage
 * @returns {number} 0-100
 */
function calcUsagePct(usage) {
  const total = usage.input_tokens + usage.cache_creation + usage.cache_read;
  const window = getContextWindow(usage.model);
  if (window <= 0) return 0;
  return Math.min(100, (total / window) * 100);
}

/**
 * 使用率とヒステリシスを考慮して contextLevel を決定する。
 *
 * ヒステリシス (§5.9.3): 低い帯へ復帰するには (threshold - 2%) を下回る必要がある。
 *
 * @param {number} pct - 0-100
 * @param {string} prevLevel - 直前の level
 * @param {{ low:number, mid:number, high:number, critical:number }} thresholds
 * @returns {'low'|'mid'|'high'|'critical'}
 */
function calcLevel(pct, prevLevel, thresholds) {
  const t = thresholds || DEFAULT_THRESHOLDS;
  const h = HYSTERESIS_PCT;

 // 上昇方向 (ヒステリシスなし)
  if (pct >= 95) return 'critical';
  if (pct >= (t.critical || 80)) return 'critical';
  if (pct >= (t.high    || 60)) return 'high';
  if (pct >= (t.mid     || 30)) return 'mid';

 // 下降方向 (ヒステリシス適用: 境界 - 2% を下回らないと復帰しない)
 // 現在 critical なら high に落ちるのは (80 - 2) = 78% 未満
 // 現在 high なら mid に落ちるのは (60 - 2) = 58% 未満
 // 現在 mid なら low に落ちるのは (30 - 2) = 28% 未満
  const critThresh = (t.critical || 80) - h;
  const highThresh = (t.high     || 60) - h;
  const midThresh  = (t.mid      || 30) - h;

  if (prevLevel === 'critical' && pct >= critThresh) return 'critical';
  if (prevLevel === 'high'     && pct >= highThresh) return 'high';
  if (prevLevel === 'mid'      && pct >= midThresh)  return 'mid';

 // それ以外は通常ルール
  if (pct >= (t.critical || 80)) return 'critical';
  if (pct >= (t.high     || 60)) return 'high';
  if (pct >= (t.mid      || 30)) return 'mid';
  return 'low';
}

// ─── 主要 API ─────────────────────────────────────────────────────

/**
 * transcript_path を読んで contextLevel を計測し、必要なら IPC でレベルを送信する。
 * throttle / サイレントフェイル / 前回値継続 を実装済み。
 *
 * @param {{
 * sessionId: string,
 * transcriptPath: string,
 * sendToRenderer: function({ sessionId: string, level: string }): void,
 * thresholds?: object,
 * throttleMs?: number,
 * enabled?: boolean,
 * }} opts
 * @returns {{ level: string, usagePct: number }|null} 計測結果、スキップ時は null
 */
function measureContextLevel(opts) {
  const {
    sessionId,
    transcriptPath,
    sendToRenderer,
    thresholds,
    throttleMs = 5000,
    enabled = true,
  } = opts;

 // 機能無効時は常に low を維持 (前回 level が high 等でも初期化)
  if (!enabled) {
    const s = sessionStates.get(sessionId);
    if (s && s.lastLevel !== 'low') {
      s.lastLevel = 'low';
      s.lastUsagePct = 0;
      sendToRenderer({ sessionId, level: 'low' });
    }
    return null;
  }

 // sessionId or transcriptPath 未提供はサイレントフェイル
  if (!sessionId || !transcriptPath) return null;

  const now = Date.now();

 // セッション状態を初期化 (初回)
  if (!sessionStates.has(sessionId)) {
    sessionStates.set(sessionId, {
      lastMeasureMs: 0,
      lastLevel: 'low',
      lastUsagePct: 0,
      throttleMs,
    });
  }

  const state = sessionStates.get(sessionId);

 // 5 秒 throttle: 直前計測から throttleMs 未満ならスキップ (前回値継続)
  if (now - state.lastMeasureMs < (throttleMs || 5000)) {
    return null;
  }

  state.lastMeasureMs = now;

 // ファイル末尾 1 行を読む
  const line = readLastLine(transcriptPath);
 if (!line) return null; // サイレントフェイル → 前回値継続

 // usage を parse
  const usage = parseUsageLine(line);
 if (!usage) return null; // サイレントフェイル → 前回値継続

 // 使用率算出
  const pct = calcUsagePct(usage);

 // ─── コンパクション検知 (差分検知方式 §5.9.5) ────────────────
 // 直前使用率から 30% 以上の急落 → compact 検知
  const prevPct = state.lastUsagePct;
  const isCompacted = (prevPct > 0) && (prevPct - pct >= 30);

 // level 算出 (ヒステリシス適用)
  const prevLevel = state.lastLevel;
  const newLevel = calcLevel(pct, prevLevel, thresholds || DEFAULT_THRESHOLDS);

 // 状態更新
  state.lastUsagePct = pct;
  state.lastLevel = newLevel;

 // level 変化時 or compact 検知時は IPC 送信
 // IPC ペイロードは { sessionId, level } のみ (プライバシー §12 項目 6)
  if (newLevel !== prevLevel || isCompacted) {
    sendToRenderer({ sessionId, level: newLevel });
  }

  return { level: newLevel, usagePct: pct, isCompacted };
}

/**
 * セッション終了時に状態を削除する。
 * @param {string} sessionId
 */
function removeSession(sessionId) {
  sessionStates.delete(sessionId);
}

/**
 * セッションの現在 contextLevel を返す (IPC 送信なし)。
 * セッション未登録の場合は 'low' を返す。
 *
 * @param {string} sessionId
 * @returns {'low'|'mid'|'high'|'critical'}
 */
function getCurrentLevel(sessionId) {
  const s = sessionStates.get(sessionId);
  return s ? s.lastLevel : 'low';
}

/**
 * Stop 受信時のリフレッシュ: 1 段下げた level を返す (§5.9.4)。
 * main process が success モーション完了後にこの値で IPC を送る。
 *
 * @param {string} sessionId
 * @returns {'low'|'mid'|'high'|'critical'} 1 段下げた level
 */
function getRefreshedLevel(sessionId) {
  const current = getCurrentLevel(sessionId);
  const DOWN = { critical: 'high', high: 'mid', mid: 'low', low: 'low' };
  return DOWN[current] || 'low';
}

/**
 * コンパクション後のリフレッシュ: level を low にリセットする (§5.9.5)。
 * 1.5 秒後に再計測値に戻すのは呼び出し側の責任。
 *
 * @param {string} sessionId
 */
function forceRefreshLevel(sessionId) {
  const s = sessionStates.get(sessionId);
  if (s) {
    s.lastLevel = 'low';
    s.lastUsagePct = 0;
  }
}

module.exports = {
  measureContextLevel,
  removeSession,
  getCurrentLevel,
  getRefreshedLevel,
  forceRefreshLevel,
  DEFAULT_THRESHOLDS,
};
