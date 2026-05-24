'use strict';

/**
 * migration.js — §5.11.5.7 マイグレーション仕様 v1 → v2 (/ 2026-05-02)
 *
 * 公開 API:
 * needsMigration(filePath): boolean
 * migrateV1ToV2(v1Json): { v2, log }
 * runMigration(srcPath, dstPath, logPath): { success, count, errors }
 *
 * 冪等性:
 * - v2 ファイルが既に存在する場合は何もしない
 * - v1 ファイルが存在しない (新規インストール) 場合は何もしない
 * - 2 回実行しても壊れない
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DEBUG = process.env.KUROTAN_DEBUG === '1';
function dbg(...args) {
  if (DEBUG) process.stderr.write('[migration] ' + args.join(' ') + '\n');
}

// v2 toolTypes デフォルト (全 9 種別 "inherit" / + Q10=A)
const DEFAULT_TOOL_TYPES = {
  Bash:     'inherit',
  Read:     'inherit',
  Edit:     'inherit',
  Search:   'inherit',
  Web:      'inherit',
  Skill:    'inherit',
  Agent:    'inherit',
  'mcp__*': 'inherit',
  Other:    'inherit',
};

/**
 * ファイルが v1 形式 (マイグレーション必要) かどうかを判定する。
 *
 * 判定ルール (§5.11.5.7 検出ロジック):
 * - ファイル不存在 → false (新規インストール。何もしない)
 * - version === 2 → false (既に v2 / 何もしない)
 * - version === 1 → true (マイグレーション実行)
 * - version フィールド欠落 + patterns[] あり → true (v1 推定)
 * - JSON parse 失敗 → false (破損ファイル / 呼び出し元で別処理)
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function needsMigration(filePath) {
  if (!fs.existsSync(filePath)) {
    dbg('file not found, no migration needed:', filePath);
    return false;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    dbg('parse failed, skip migration check:', e.message);
    return false;
  }

  if (!raw || typeof raw !== 'object') return false;

 // version === 2 以上は移行不要 (version >= 3 は read-only として扱うが needsMigration は false)
  if (typeof raw.version === 'number' && raw.version >= 2) {
    dbg('version', raw.version, '- no migration needed');
    return false;
  }

 // version === 1
  if (raw.version === 1) {
    dbg('version 1 detected, migration needed');
    return true;
  }

 // version フィールド欠落 + patterns[] あり → v1 推定
  if (raw.version === undefined && Array.isArray(raw.patterns)) {
    dbg('no version field + patterns[] found, treating as v1');
    return true;
  }

  return false;
}

/**
 * v1 JSON データを v2 形式に変換する。
 * 不正 rule entry は skip して続行 (§5.11.5.7 マイグレーション失敗時の挙動)。
 *
 * @param {object} v1Json - v1 形式の JSON オブジェクト
 * @returns {{ v2: object, log: object }}
 */
function migrateV1ToV2(v1Json) {
  const now = new Date().toISOString();

  const v2 = {
    version: 2,
    toolTypes: Object.assign({}, DEFAULT_TOOL_TYPES),
    exceptions: [],
  };

  const log = {
    migratedAt: now,
    sourceVersion: v1Json.version !== undefined ? v1Json.version : 'unknown',
    results: [],
    skipped: [],
  };

  const patterns = Array.isArray(v1Json.patterns) ? v1Json.patterns : [];

  for (const p of patterns) {
 // rule フィールド検証
    if (!p || typeof p.rule !== 'string' || !p.rule) {
      dbg('skip: invalid rule entry:', JSON.stringify(p));
      log.skipped.push({ entry: p, reason: 'invalid or missing rule field' });
      continue;
    }

 // rule 構文の簡易チェック (parse failure → skip)
 // parseRule は循環参照を避けるため内部で再実装せずチェックのみ
    if (!isValidRuleSyntax(p.rule)) {
      dbg('skip: invalid rule syntax:', p.rule);
      log.skipped.push({ entry: p, reason: 'invalid rule syntax: ' + p.rule });
      continue;
    }

 // マッピング: enabled=true → "ask" / enabled=false → "inherit"
    const decision = p.enabled === true ? 'ask' : 'inherit';

    const exc = {
      rule:      p.rule,
      decision:  decision,
      source:    'migrated-from-v1',
      addedAt:   (typeof p.addedAt === 'string' && p.addedAt) ? p.addedAt : now,
    };

    v2.exceptions.push(exc);

    log.results.push({
      originalRule:    p.rule,
      originalEnabled: p.enabled === true,
      mappedDecision:  decision,
      addedAt:         exc.addedAt,
    });
  }

  return { v2, log };
}

/**
 * rule 構文の簡易バリデーション。
 * 括弧が開いたら対応する閉じ括弧があるかをチェックする。
 *
 * @param {string} rule
 * @returns {boolean}
 */
function isValidRuleSyntax(rule) {
  if (typeof rule !== 'string' || !rule.trim()) return false;

  const parenIdx = rule.indexOf('(');
 if (parenIdx === -1) return true; // 括弧なし = OK

 // 対応する ')' の存在確認 (quote-aware)
  let depth = 0;
  let inQuote = null;
  let closingFound = false;

  for (let i = parenIdx; i < rule.length; i++) {
    const ch = rule[i];

    if (inQuote) {
      if (ch === '\\' && i + 1 < rule.length) { i++; continue; }
      if (ch === inQuote) { inQuote = null; }
      continue;
    }

    if (ch === '"' || ch === "'") { inQuote = ch; continue; }

    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
 // closing)' が見つかった
        if (i === rule.length - 1) {
          closingFound = true;
        }
        break;
      }
    }
  }

  return closingFound;
}

/**
 * マイグレーションを実行する。
 *
 * 手順:
 * 1. srcPath を読む → needsMigration 判定
 * 2. migrateV1ToV2 実行
 * 3. dstPath に v2 ファイルを書き出し
 * 4. srcPath を .v1.bak にリネーム
 * 5. logPath にログを追記書き込み
 *
 * 冪等:
 * - srcPath が存在しない → no-op (success: true, count: 0)
 * - dstPath が v2 形式で存在 → no-op (success: true, count: 0)
 * - v1 が存在しない / needsMigration が false → no-op
 *
 * @param {string} srcPath - v1 ファイルパス
 * @param {string} dstPath - v2 ファイル書き出し先
 * @param {string} logPath - ログファイルパス
 * @returns {{ success: boolean, count: number, errors: string[] }}
 */
function runMigration(srcPath, dstPath, logPath) {
  const errors = [];

  try {
 // 冪等チェック 1: srcPath が存在しない → no-op
    if (!fs.existsSync(srcPath)) {
      dbg('srcPath not found, no migration:', srcPath);
      return { success: true, count: 0, errors: [] };
    }

 // 冪等チェック 2: dstPath が既に v2 なら no-op
    if (fs.existsSync(dstPath) && !needsMigration(dstPath)) {
      dbg('dstPath is already v2, skipping migration');
      return { success: true, count: 0, errors: [] };
    }

 // needsMigration チェック
    if (!needsMigration(srcPath)) {
      dbg('srcPath does not need migration:', srcPath);
      return { success: true, count: 0, errors: [] };
    }

 // v1 読み込み
    let v1Json;
    try {
      v1Json = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
    } catch (e) {
      const msg = 'failed to read/parse srcPath: ' + e.message;
      dbg(msg);
      errors.push(msg);
      return { success: false, count: 0, errors };
    }

 // v1 → v2 変換
    const { v2, log } = migrateV1ToV2(v1Json);

 // dstPath の親ディレクトリ作成
    const dstDir = path.dirname(dstPath);
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true });
    }

 // v2 ファイル書き出し
    try {
      fs.writeFileSync(dstPath, JSON.stringify(v2, null, 2), 'utf8');
      dbg('v2 written to:', dstPath);
    } catch (e) {
      const msg = 'failed to write v2 file: ' + e.message;
      dbg(msg);
      errors.push(msg);
      return { success: false, count: 0, errors };
    }

 // srcPath を .v1.bak にリネーム
    const bakPath = srcPath + '.v1.bak';
    try {
 // 既に .v1.bak が存在する場合は上書き
      if (fs.existsSync(bakPath)) {
        fs.unlinkSync(bakPath);
      }
      fs.renameSync(srcPath, bakPath);
      dbg('v1 renamed to:', bakPath);
    } catch (e) {
      const msg = 'failed to rename v1 to .v1.bak: ' + e.message;
      dbg(msg);
 // リネーム失敗はログに記録するが success 扱い (v2 は書き出し済み)
      errors.push(msg);
    }

 // ログ追記
    if (logPath) {
      try {
        const logDir = path.dirname(logPath);
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }

 // 既存ログを読み込んで配列に追記
        let existingLogs = [];
        if (fs.existsSync(logPath)) {
          try {
            existingLogs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
            if (!Array.isArray(existingLogs)) existingLogs = [];
          } catch (_) {
            existingLogs = [];
          }
        }

        existingLogs.push({
          runAt:    new Date().toISOString(),
          srcPath,
          dstPath,
          results:  log.results,
          skipped:  log.skipped,
          migratedCount: log.results.length,
          skippedCount:  log.skipped.length,
        });

        fs.writeFileSync(logPath, JSON.stringify(existingLogs, null, 2), 'utf8');
        dbg('migration log written to:', logPath);
      } catch (e) {
        const msg = 'failed to write migration log: ' + e.message;
        dbg(msg);
        errors.push(msg);
 // ログ書き込み失敗は success に影響しない
      }
    }

    return { success: true, count: log.results.length, errors };

  } catch (e) {
    const msg = 'unexpected error in runMigration: ' + e.message;
    dbg(msg);
    errors.push(msg);
    return { success: false, count: 0, errors };
  }
}

module.exports = { needsMigration, migrateV1ToV2, runMigration, isValidRuleSyntax };
