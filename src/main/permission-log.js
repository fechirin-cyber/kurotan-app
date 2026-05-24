'use strict';

/**
 * permission-log.js — §5.10.2.1 operation log (opt-in, 既定 OFF)
 *
 * 環境変数 KUROTAN_PERMISSION_LOG=1 のときのみ
 * %APPDATA%\kurotan\logs\permission_log.jsonl に追記する。
 *
 * 記録フィールド (3 つに限定):
 * ts - ISO 8601 タイムスタンプ
 * decision - "allow" | "deny" | "timeout"
 * durationMs - request 受信 → decision 確定までの経過 ms
 * source - "click" | "auto-dismiss" | "main-timeout" | "fallback" | "fallback-no-sessionid"
 *
 * BLOCK: toolName / toolInput / transcript_path / 引数文字列 は記録しない (プライバシー §2-1)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOG_DIR  = path.join(APPDATA, 'kurotan', 'logs');
const LOG_PATH = path.join(LOG_DIR, 'permission_log.jsonl');
const LOG_MAX_BYTES = 1 * 1024 * 1024; // 1 MB
const LOG_MAX_GENERATIONS = 3;

function _isEnabled() {
  return process.env.KUROTAN_PERMISSION_LOG === '1';
}

function _ensureDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * 1MB 超えたらローテートする (世代最大 3)。
 */
function _rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const stat = fs.statSync(LOG_PATH);
    if (stat.size <= LOG_MAX_BYTES) return;

 // 古い世代をシフト: .3 を削除, .2 → .3, .1 → .2, 現行 → .1
    for (let i = LOG_MAX_GENERATIONS; i >= 1; i--) {
      const older = LOG_PATH.replace('.jsonl', `.${i}.jsonl`);
      const newer = i === 1 ? LOG_PATH : LOG_PATH.replace('.jsonl', `.${i - 1}.jsonl`);
      if (fs.existsSync(newer)) {
        if (i === LOG_MAX_GENERATIONS) {
 fs.unlinkSync(newer); // 最古世代は削除
        } else {
          fs.renameSync(newer, older);
        }
      }
    }
 // 現行ファイルを .1 にリネーム
    const gen1 = LOG_PATH.replace('.jsonl', '.1.jsonl');
    fs.renameSync(LOG_PATH, gen1);
  } catch (e) {
 // ローテート失敗は無視 (ベストエフォート)
  }
}

/**
 * permission 操作を 1 record 追記する。
 * KUROTAN_PERMISSION_LOG=1 のときのみ動作する。
 *
 * @param {{ decision: string, durationMs: number, source: string }} record
 */
function append(record) {
  if (!_isEnabled()) return;
  try {
    _ensureDir();
    _rotateIfNeeded();
    const entry = {
      ts: new Date().toISOString(),
      decision: record.decision || 'unknown',
      durationMs: typeof record.durationMs === 'number' ? record.durationMs : -1,
      source: record.source || 'unknown',
    };
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
 // ログ書き込み失敗は無視 (Claude Code への影響ゼロ原則)
  }
}

module.exports = { append };
