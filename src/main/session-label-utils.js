'use strict';

/**
 * session-label-utils.js
 *
 * sessionLabel 計算と JSONL custom-title 抽出ロジック (0.9.26 で main/index.js から分離)。
 * テストから直接 import できるよう、Electron / DOM 依存なしの純関数のみ含める。
 *
 * - extractCwdLabel: cwd 末尾セグメント (Windows / POSIX 両対応)
 * - readCustomTitleFromJsonl: JSONL から /rename customTitle を抽出 (head 128KB + tail 256KB)
 * - computeSessionLabel: 優先順位 customTitle > cwd > sessionId
 */

const fs = require('fs');

/**
 * cwd 末尾セグメントを抽出する。
 * @param {string} cwd
 * @returns {string} 末尾セグメント、cwd が空なら ''
 */
function extractCwdLabel(cwd) {
  const segments = (cwd || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (segments.length === 0) return '';
  const last = segments[segments.length - 1];
  return last === '' ? '~' : last;
}

/**
 * JSONL から /rename で設定された customTitle (type: 'custom-title') を抽出する。
 * 大きい transcript で /rename が後ろに付け足されるケースに備え、先頭 128KB と
 * 末尾 256KB の両方をスキャンして時系列上もっとも新しい custom-title を返す。
 *
 * @param {string} filePath
 * @returns {string} customTitle or '' (見つからない場合 / 読み取り失敗時)
 */
function readCustomTitleFromJsonl(filePath) {
  const HEAD_SIZE = 128 * 1024;
  const TAIL_SIZE = 256 * 1024;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const fileSize = stat.size;

      const scanRange = (offset, size) => {
        const buf = Buffer.alloc(size);
        const bytesRead = fs.readSync(fd, buf, 0, size, offset);
        const content = buf.slice(0, bytesRead).toString('utf8');
        const lines = content.split('\n');
        let last = '';
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj && obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle) {
              last = obj.customTitle;
            }
 } catch (_) {} // partial line / invalid JSON は無視
        }
        return last;
      };

      const headTitle = scanRange(0, Math.min(HEAD_SIZE, fileSize));
      let tailTitle = '';
      if (fileSize > HEAD_SIZE) {
        const tailOffset = Math.max(HEAD_SIZE, fileSize - TAIL_SIZE);
        tailTitle = scanRange(tailOffset, fileSize - tailOffset);
      }
      return tailTitle || headTitle;
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return '';
  }
}

/**
 * sessionLabel を一元的に計算する。
 * 優先順位: customTitle (/rename) > cwd 末尾 > sessionId 先頭 8 文字
 * @param {string} sessionId
 * @param {string} cwd
 * @param {string} transcriptPath - JSONL path (optional, customTitle 検出用)
 * @returns {string}
 */
function computeSessionLabel(sessionId, cwd, transcriptPath) {
  let customTitle = '';
  if (transcriptPath) {
    try { customTitle = readCustomTitleFromJsonl(transcriptPath); } catch (_) {}
  }
  return customTitle || extractCwdLabel(cwd) || (sessionId || '').slice(0, 8);
}

module.exports = {
  extractCwdLabel,
  readCustomTitleFromJsonl,
  computeSessionLabel,
};
