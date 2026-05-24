#!/usr/bin/env node
/**
 * kurotan-permission-bridge.js
 * Claude Code PreToolUse hook 中継スクリプト。
 *
 * 動作概要:
 * 1. stdin から PreToolUse JSON を読む
 * 2. config.json から permissionMode を読む (§5.11.3.2)
 * 3. Auto モード: permission-resolver で設定を参照し、
 * allow/deny/ask/no-match の全決定を即時 outputDecision して exit
 * (kurotan UI フローには進まない、#432 修正後)
 * 4. Custom モード: Auto 解決後、Custom リストで allow を override
 * 5. runtime.json から port/pid を取得し POST /permission-request
 * 6. タイムアウト / エラー / kurotan 不在の場合は decision: "ask" を返す
 * 7. 常に exit 0 (Claude Code を絶対にブロックしない)
 *
 * フェイルセーフ:
 * kurotan が落ちている / runtime.json が無い / タイムアウトの場合、
 * "ask" を返してターミナル承認 (Claude Code デフォルト) に fall back する。
 */

'use strict';

const fs   = require('fs');
const http = require('http');
const path = require('path');
const os   = require('os');

// ─── タイムアウト保険（65 秒で強制終了） ──────────────────────
// settings.json の timeout: 65000 と同期（bridge 60s + 5s 余裕）
const HARD_TIMEOUT_MS = 65000;
const timer = setTimeout(() => {
  outputAsk();
  process.exit(0);
}, HARD_TIMEOUT_MS);
if (timer.unref) timer.unref();

// ─── デバッグログ ──────────────────────────────────────────────
const DEBUG = process.env.KUROTAN_DEBUG === '1';
function dbg(...args) {
  if (DEBUG) process.stderr.write('[kurotan-permission-bridge] ' + args.join(' ') + '\n');
}

// ─── フェイルセーフ出力 ────────────────────────────────────────
function outputDecision(decision) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

function outputAsk() {
  outputDecision('ask');
}

// ─── APPDATA パス ─────────────────────────────────────────────
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const KUROTAN_DIR = path.join(APPDATA, 'kurotan');

// ─── config.json 読み込み ─────────────────────────────────────
/**
 * %APPDATA%\kurotan\config.json の permissionMode を読む。
 * 不正値・キー欠落は "auto" にフォールバック (§5.11.3.2)。
 * @returns {"auto"|"custom"}
 */
function readPermissionMode() {
  try {
    const configPath = path.join(KUROTAN_DIR, 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg.permissionMode === 'auto' || cfg.permissionMode === 'custom') {
      return cfg.permissionMode;
    }
    return 'auto';
  } catch (_) {
    return 'auto';
  }
}

// ─── Custom 設定パス ─────────────────────────────────────────
const CUSTOM_CONFIG_PATH = path.join(KUROTAN_DIR, 'custom-confirm-config.json');

// ─── runtime.json の読み込み ──────────────────────────────────
function readRuntime() {
  try {
    const runtimePath = path.join(KUROTAN_DIR, 'runtime.json');
    const raw = fs.readFileSync(runtimePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    dbg('runtime.json read failed:', e.message);
    return null;
  }
}

// ─── PID 生存確認 ─────────────────────────────────────────────
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ─── /history-append ─────────────────────────────────────────
/**
 * kurotan main の /history-append に履歴を送信する Promise を返す。
 * stdout への permission decision 出力とは独立して呼び出せる。
 * タイムアウト (200ms) で諦め、失敗時も resolve する (Claude Code を阻害しない)。
 *
 * 旧 fire-and-forget (§5.11.6.4) の意図を保ちつつ、
 * B1 修正: stdout 出力後に await することで exit 前に HTTP flush が確実に完了する。
 *
 * payload v2 (§5.11.6.4): { toolName, matchKey, mode, decision, source, sessionId }
 * 旧 autoDecision フィールドは撤去 (spec §5.11.6.4 / 2026-05-02 改訂)。
 *
 * @param {number} port
 * @param {object} entry - { toolName, matchKey, mode, decision, source, matchedRule, sessionId }
 * @returns {Promise<void>}
 */
function historyAppend(port, entry, token) {
  return new Promise((resolve) => {
 const TIMEOUT_MS = 200; // 1000 → 200 に短縮 (agent_guide §5.1 の +50ms 基準整合)
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    const fallbackTimer = setTimeout(finish, TIMEOUT_MS);
    if (fallbackTimer.unref) fallbackTimer.unref();

    try {
      const body = JSON.stringify({
        toolName:    entry.toolName    || '',
        matchKey:    entry.matchKey    || '',
        mode:        entry.mode        || 'auto',
        decision:    entry.decision    || 'ask',
        source:      entry.source      || 'no-match',
        matchedRule: entry.matchedRule || null,
        sessionId:   entry.sessionId   || '',
        timestamp_ms: Date.now(),
      });
      const bodyBuf = Buffer.from(body, 'utf8');

 // HTTP API 認証トークン
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
        Connection: 'close',
      };
      if (token) headers['X-Kurotan-Token'] = token;

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/history-append',
        method: 'POST',
        headers,
      });
 // レスポンス受信 (or エラー) で resolve。内容は捨てる
      req.on('response', (res) => { res.resume(); res.on('end', () => { clearTimeout(fallbackTimer); finish(); }); });
      req.on('error', () => { clearTimeout(fallbackTimer); finish(); });
      req.end(bodyBuf);
    } catch (_) {
      clearTimeout(fallbackTimer);
      finish();
    }
  });
}

// ─── POST /permission-request ─────────────────────────────────
/**
 * kurotan main に許可リクエストを送り、decision を返す Promise。
 * 60 秒以内に応答がなければ 'ask' を resolve する。
 *
 * @param {number} port
 * @param {object} body - { sessionId, toolName, toolInput }
 * @returns {Promise<string>} - 'allow' | 'deny' | 'ask'
 */
function postPermissionRequest(port, body, token) {
  const LONG_POLL_TIMEOUT_MS = 60000;

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (decision) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(pollTimer);
      resolve(decision);
    };

    const pollTimer = setTimeout(() => {
      dbg('long-poll timeout, returning ask');
      finish('ask');
    }, LONG_POLL_TIMEOUT_MS);

    const bodyJson = JSON.stringify(body);
    const bodyBuf  = Buffer.from(bodyJson, 'utf8');

 // HTTP API 認証トークン
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': bodyBuf.length,
      Connection: 'close',
    };
    if (token) headers['X-Kurotan-Token'] = token;

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/permission-request',
        method: 'POST',
        headers,
        timeout: LONG_POLL_TIMEOUT_MS + 1000,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            const dec = parsed.decision;
            if (dec === 'allow' || dec === 'deny' || dec === 'ask') {
              dbg('received decision:', dec);
              finish(dec);
            } else {
              dbg('unexpected decision value:', dec, '- returning ask');
              finish('ask');
            }
          } catch (e) {
            dbg('response parse error:', e.message, '- returning ask');
            finish('ask');
          }
        });
        res.on('error', () => finish('ask'));
      }
    );

    req.on('error', (e) => {
      dbg('request error:', e.message, '- returning ask');
      finish('ask');
    });

    req.on('timeout', () => {
      dbg('socket timeout - aborting request');
      req.destroy();
      finish('ask');
    });

    req.end(bodyBuf);
  });
}

// ─── メイン処理 ───────────────────────────────────────────────
async function main(rawInput) {
 // 1. JSON パース
  let hooksJson;
  try {
    hooksJson = JSON.parse(rawInput);
  } catch (e) {
    dbg('JSON parse error:', e.message);
    outputAsk();
    process.exit(0);
  }

  const sessionId = hooksJson.session_id || '';
  const toolName  = hooksJson.tool_name  || '';
  const toolInput = hooksJson.tool_input || {};
  const cwd       = hooksJson.cwd        || process.cwd();

  dbg('PreToolUse session:', sessionId, 'tool:', toolName);

 // 2. permissionMode 読み込み (毎回 stateless に読む / §5.11.3.3)
  const permissionMode = readPermissionMode();
  dbg('permissionMode:', permissionMode);

 // 3. permission-resolver で Auto / Custom 解決
 // mode と customConfigPath を明示的に渡す (§5.11.5.4 / T13)
  let autoResult = { decision: 'ask', source: 'no-match', matchedRule: null };
  try {
    const resolver = require('../permission-resolver/permission-resolver');
    autoResult = resolver.resolve({
      tool_name:        toolName,
      tool_input:       toolInput,
      cwd,
      sessionId,
      mode:             permissionMode,
      customConfigPath: CUSTOM_CONFIG_PATH,
    });
    dbg('resolver result:', JSON.stringify(autoResult));
  } catch (e) {
    dbg('resolver error:', e.message, '- fallback to ask');
 // resolver 自体の例外 → フォールバック (§5.11.4.4)
  }

 // 4. runtime.json 読み込み (history-append + permission-request に使う)
  const runtime = readRuntime();
  const port = runtime && runtime.port;
  const pid  = runtime && runtime.pid;

 // ─── Auto モード (§5.11.4.3) ────────────────────────────────
 // #432 BUG FIX :
 // 旧実装: ask / no-match を kurotan UI フローに fall through → long-poll (最大 60 秒)
 // 問題: bridge が Claude Code に stdout を返す前に Claude Code が settings.json の
 // allow ルールで独立してツール実行を進めるため、
 // 「ターミナルに trust prompt なし / kurotan UI にダイアログあり」という不一致が発生。
 // 修正: Auto モードでは allow / deny / ask / no-match の全決定を即時 outputDecision して
 // exit する。kurotan UI フロー (long-poll) は Custom モード専用とする。
 // history-append は observability のため引き続き送信する。
  if (permissionMode === 'auto') {
    dbg('auto mode: decision =', autoResult.decision, 'source =', autoResult.source);

 // 全決定を即時出力 (allow / deny / ask / no-match すべて)
    outputDecision(autoResult.decision);

    if (port && pid && isPidAlive(pid)) {
      const matchKey = buildMatchKey(toolName, toolInput);
      await historyAppend(port, {
        toolName, matchKey, sessionId,
        mode:        'auto',
        decision:    autoResult.decision,
        source:      autoResult.source,
        matchedRule: autoResult.matchedRule,
      }, runtime.token);
    }

    clearTimeout(timer);
    process.exit(0);
  }

 // ─── Custom モード (§5.11.5.6 v2) ──────────────────────────
 // resolver.resolve() が mode: 'custom' で既に実行済み。
 // allow / deny で確定した場合は即時出力して終了。
 // ask / no-match の場合は kurotan UI フロー (§5.10) に継続。
  if (permissionMode === 'custom') {
    if (autoResult.decision === 'allow' || autoResult.decision === 'deny') {
      dbg('custom mode: immediate', autoResult.decision, 'source:', autoResult.source);

 // B1 修正: stdout 先出力 → await historyAppend
      outputDecision(autoResult.decision);

      if (port && pid && isPidAlive(pid)) {
        const matchKey = buildMatchKey(toolName, toolInput);
        await historyAppend(port, {
          toolName, matchKey, sessionId,
          mode:        'custom',
          decision:    autoResult.decision,
          source:      autoResult.source,
          matchedRule: autoResult.matchedRule,
        }, runtime.token);
      }
      clearTimeout(timer);
      process.exit(0);
    }
 // ask / no-match → UI フロー継続
    dbg('custom mode: source =', autoResult.source, '→ fall through to UI');
  }

 // ─── kurotan UI フロー (§5.10) ──────────────────────────────
 // history-append: source を記録 (decision は UI 完了後に main が更新)
 // UI フローでは long-poll で待機するため exit race は発生しない。
 // void: long-poll 中なので await 不要。Promise を意図的に破棄している。
  if (port && pid && isPidAlive(pid)) {
    const matchKey = buildMatchKey(toolName, toolInput);
    void historyAppend(port, {
      toolName, matchKey, sessionId,
      mode:        permissionMode,
 decision: 'ask', // UI フロー中は ask → main が後で更新
      source:      autoResult.source,
      matchedRule: autoResult.matchedRule,
    }, runtime.token);
  }

 // kurotan が落ちている場合は ask でフォールバック
  if (!runtime || !port || !pid) {
    dbg('runtime.json missing or incomplete, returning ask');
    outputAsk();
    process.exit(0);
  }

  if (!isPidAlive(pid)) {
    dbg('pid', pid, 'is dead, returning ask');
    outputAsk();
    process.exit(0);
  }

 // 5. 表示用 toolInput digest（機密を含まない最小情報）
  const inputSummary = buildInputSummary(toolName, toolInput);

 // 6. POST /permission-request (long-poll, 最大 60 秒)
  let decision;
  try {
    decision = await postPermissionRequest(port, {
      sessionId,
      toolName,
      toolInput: inputSummary,
    }, runtime.token);
  } catch (e) {
    dbg('postPermissionRequest threw:', e.message, '- returning ask');
    decision = 'ask';
  }

 // 7. 結果を stdout に出力して終了
  outputDecision(decision);
  clearTimeout(timer);
  process.exit(0);
}

// ─── ツール入力 照合キー抽出 (§5.11.4.2) ──────────────────────
/**
 * tool_name + tool_input から照合キーを取得する (resolver と同一ロジック)。
 * resolver の require に失敗した場合は null を返す。
 * @returns {string|null}
 */
function buildMatchKey(toolName, toolInput) {
  try {
    const resolver = require('../permission-resolver/permission-resolver');
    return resolver.buildMatchKey(toolName, toolInput);
  } catch (_) {
    return null;
  }
}

// ─── ツール入力 digest（表示用・機密除外） ───────────────────
function buildInputSummary(toolName, toolInput) {
  const MAX = 30;
  switch (toolName) {
    case 'Bash':
    case 'BashOutput':
      return { command: toolInput.command ? String(toolInput.command).slice(0, MAX) : '' };
    case 'Read':
    case 'Glob':
    case 'Grep':
      return { file_path: toolInput.file_path || toolInput.path || '' };
    case 'Edit':
    case 'Write':
      return { file_path: toolInput.file_path || '' };
    case 'WebFetch':
    case 'WebSearch':
      return { url: toolInput.url ? String(toolInput.url).slice(0, MAX) : '' };
    case 'Agent':
    case 'Task':
      return { subagent_type: toolInput.subagent_type || toolInput.agent_type || '' };
    case 'Skill':
      return { skill: toolInput.skill || '' };
    default:
      return {};
  }
}

// ─── stdin 読み込み ───────────────────────────────────────────
let inputChunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => inputChunks.push(chunk));
process.stdin.on('end', () => {
  const raw = inputChunks.join('').trim();
  if (!raw) {
    dbg('empty stdin, returning ask');
    outputAsk();
    process.exit(0);
  }
  main(raw).catch(() => {
    outputAsk();
    process.exit(0);
  });
});
process.stdin.on('error', () => {
  outputAsk();
  process.exit(0);
});
