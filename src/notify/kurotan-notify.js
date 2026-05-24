#!/usr/bin/env node
/**
 * kurotan-notify
 * Claude Code hooks の中継 CLI。
 * stdin から hooks JSON を受け取り、kurotan デーモンの /event エンドポイントへ HTTP POST する。
 *
 * 設計方針:
 * - Node.js 標準 http モジュールのみ使用（依存ゼロ）
 * - socket.write flush 完了で即 process.exit(0)
 * - タイムアウト 500ms で必ず終了（Claude Code をブロックしない）
 * - 失敗は常に silently exit 0
 * - KUROTAN_DEBUG=1 で stderr にデバッグログを出力
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

// ─── デバッグログ ──────────────────────────────────────────────
const DEBUG = process.env.KUROTAN_DEBUG === '1';
function dbg(...args) {
  if (DEBUG) process.stderr.write('[kurotan-notify] ' + args.join(' ') + '\n');
}

// ─── ファイルログ ──────────────────────────────────────────────
// KUROTAN_NO_LOG=1 で無効化。書込失敗は常に無視（silent exit 0 原則維持）。
const LOG_ENABLED = process.env.KUROTAN_NO_LOG !== '1';
const LOG_PATH = path.join(
  process.env.TEMP ||
  process.env.TMP ||
  path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
  'kurotan-notify.log'
);
const LOG_MAX_BYTES = 1 * 1024 * 1024; // 1 MB

function truncateLogIfNeeded(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > LOG_MAX_BYTES) {
 // 後半 50% を残す（前半を切り捨て）
      const buf = fs.readFileSync(filePath);
      const half = Math.floor(buf.length / 2);
      fs.writeFileSync(filePath, buf.slice(half));
    }
  } catch (e) {
 // 無視
  }
}

function writeNotifyLog(event, sessionId, port, result) {
  if (!LOG_ENABLED) return;
  try {
    truncateLogIfNeeded(LOG_PATH);
    const portStr = port != null ? String(port) : 'NA';
    const line = `[${new Date().toISOString()}] event=${event} session=${sessionId} port=${portStr} result=${result}\n`;
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch (e) {
 // 無視
  }
}

// ─── タイムアウト保険（500ms で強制終了） ─────────────────────
const TIMEOUT_MS = 500;
const timer = setTimeout(() => {
  dbg('timeout, exit 0');
  process.exit(0);
}, TIMEOUT_MS);
// タイマーが Node プロセスの終了を妨げないようにする
if (timer.unref) timer.unref();

// ─── runtime.json の読み込み ──────────────────────────────────
function getRuntimePath() {
 // %APPDATA%\kurotan\runtime.json
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appdata, 'kurotan', 'runtime.json');
}

function readRuntime() {
  try {
    const runtimePath = getRuntimePath();
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
 // ESRCH = No such process, EPERM = permission denied (still alive)
    return e.code === 'EPERM';
  }
}

// ─── tool_input_digest 生成 ────────────────────────────────────
// 仕様書 §2.3 / agent_guide §3.2.1 に従い、表示に必要な最小情報のみ抽出する
// 機密情報・長大データはマスコット側に送らない
function buildDigest(toolName, toolInput) {
  if (!toolInput) return {};
  const CMD_MAX = 60;

  switch (toolName) {
    case 'Read':
    case 'Glob':
    case 'Grep': {
      const digest = {};
      if (toolInput.file_path) digest.file_path = toolInput.file_path;
      if (toolInput.pattern) digest.pattern = String(toolInput.pattern).slice(0, CMD_MAX);
      if (toolInput.path) digest.path = toolInput.path;
      return digest;
    }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const digest = {};
      if (toolInput.file_path) digest.file_path = toolInput.file_path;
 // content / old_string / new_string は含めない（プライバシー保護）
      return digest;
    }
    case 'Bash':
    case 'BashOutput':
    case 'KillShell': {
      const digest = {};
      if (toolInput.command) digest.command = String(toolInput.command).slice(0, CMD_MAX);
 // stdout / stderr は含めない
      return digest;
    }
    case 'WebFetch': {
      const digest = {};
      if (toolInput.url) digest.url = String(toolInput.url).slice(0, CMD_MAX);
      return digest;
    }
    case 'WebSearch': {
      const digest = {};
      if (toolInput.query) digest.query = String(toolInput.query).slice(0, CMD_MAX);
      return digest;
    }
    case 'Skill': {
 // skill のみ。引数 content は送らない（プライバシー保護）
 // T0 実機確認: tool_input.skill が正しいキー（skill_name は誤り）
      const digest = {};
      if (toolInput.skill) digest.skill = toolInput.skill;
      return digest;
    }
    case 'Agent':
    case 'Task': {
 // subagent_type と tool_use_id のみ。prompt / description / context は送らない
      const digest = {};
      if (toolInput.subagent_type) digest.subagent_type = toolInput.subagent_type;
      if (toolInput.tool_use_id) digest.tool_use_id = toolInput.tool_use_id;
      return digest;
    }
 // SubagentStart / SubagentStop は tool_input ではなくトップレベルフィールドを使う
 // (buildDigest は tool_name ベースの分岐のため、これらには通常ここには来ないが念のため)
    case 'SubagentStart':
    case 'SubagentStop': {
 // §5.6.1: agent_id / agent_type のみ。本文・transcript は送らない
      const digest = {};
      if (toolInput.agent_id) digest.agent_id = toolInput.agent_id;
      if (toolInput.agent_type) digest.agent_type = toolInput.agent_type;
      return digest;
    }
    default: {
 // その他: tool_name のみ（他フィールドはすべて除外）
      return {};
    }
  }
}

// ─── ペイロード構築 ────────────────────────────────────────────
function buildPayload(hooksJson) {
  const event = hooksJson.hook_event_name || hooksJson.event || '';
  const sessionId = hooksJson.session_id || '';
  const cwd = hooksJson.cwd || '';
  const model = hooksJson.model || '';
  const toolName = hooksJson.tool_name || '';
  const toolInput = hooksJson.tool_input || null;
 // transcript_path は UI に表示しない（パス露出防止）が、
 // main 側の mtime 死活監視のためにアンダースコアフィールドとして転送する。
 // spec §2.3 / agent_guide §3 §8.4 の「UI 表示しない」要件は main 側で担保。
  const transcriptPath = hooksJson.transcript_path || '';

  const payload = {
    event,
    session_id: sessionId,
    cwd,
    model,
    timestamp_ms: Date.now(),
    pid: process.pid,
 // transcript_path を mtime 監視用に転送（UI には出さない）
    _kurotanTranscriptPath: transcriptPath,
  };

  if (toolName) {
    payload.tool_name = toolName;
    payload.tool_input_digest = buildDigest(toolName, toolInput);
  }

 // tool_use_id を外部フィールドにも含める（子くろたんペアリング用）
  if (hooksJson.tool_use_id) {
    payload.tool_use_id = hooksJson.tool_use_id;
  }

 // SubagentStart / SubagentStop: §5.6.1 に従い agent_id / agent_type のみ転送
 // 本文・transcript は除外済み（上記 transcriptPath は mtime 監視専用 _kurotanTranscriptPath にのみ入る）
  if (event === 'SubagentStart' || event === 'SubagentStop') {
 // agent_id / agent_type はトップレベルフィールドとして公式 hooks が提供する
    if (hooksJson.agent_id) payload.agent_id = hooksJson.agent_id;
    if (hooksJson.agent_type) payload.agent_type = hooksJson.agent_type;
 // tool_input が存在する場合も同様に digest 化（tool_input 経由で来るケースの保険）
    if (toolInput) {
      if (toolInput.agent_id && !payload.agent_id) payload.agent_id = toolInput.agent_id;
      if (toolInput.agent_type && !payload.agent_type) payload.agent_type = toolInput.agent_type;
    }
  }

 // 0.9.26: イースターエッグ keyword 検出 (raw prompt 送信回避でプライバシー保持)
 // スキャン対象を hooksJson.prompt のみに限定 (UserPromptSubmit hook)。
 // tool_input 全体や message body は誤検出 + プライバシー上のスキャン範囲拡大になるため除外。
  const promptStr = typeof hooksJson.prompt === 'string' ? hooksJson.prompt : '';
  if (promptStr) {
    if (/ultrathink/i.test(promptStr)) {
      payload._kurotanEasterEgg = (payload._kurotanEasterEgg || []).concat(['ultrathink']);
    }
    if (/korone|korosan|ころね|ころさん/i.test(promptStr)) {
      payload._kurotanEasterEgg = (payload._kurotanEasterEgg || []).concat(['korone']);
    }
  }

  return payload;
}

// ─── HTTP POST（生 socket.write 方式） ────────────────────────
// agent_guide §3.2.2 の実装ノート準拠:
// socket.write の flush 完了後に即 process.exit(0)
// レスポンス受信は待たない
function postEvent(port, payloadJson, token, onDone) {
  const host = '127.0.0.1';
  const bodyBuf = Buffer.from(payloadJson, 'utf8');

 // onDone は1度だけ呼ぶ（drain / response / error の競合防止）
  let doneCalled = false;
  const done = () => {
    if (doneCalled) return;
    doneCalled = true;
    onDone();
  };

 // HTTP API 認証トークン
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': bodyBuf.length,
    Connection: 'close',
  };
  if (token) headers['X-Kurotan-Token'] = token;

  const req = http.request(
    {
      hostname: host,
      port,
      path: '/event',
      method: 'POST',
      headers,
    },
    (res) => {
 // レスポンス受信 = サーバーがボディを読み終えた証拠 → ここで exit
      dbg('response status:', res.statusCode);
      res.resume();
      res.once('end', () => {
        dbg('response end, exit 0');
        done();
      });
 // レスポンスが流れない場合の保険
      res.once('close', done);
    }
  );

  req.on('error', (e) => {
    dbg('request error:', e.message);
    done();
  });

  req.end(bodyBuf);

 // 呼び出し元で .on('error') を追加登録できるよう req を返す
  return req;
}

// ─── ヘルスチェック（stale 判定保険） ────────────────────────
// agent_guide §3.3.1 に従い、PID 確認と併せて GET /health を 200ms で叩く
function healthCheck(port, onResult) {
  const HEALTH_TIMEOUT = 200;
  let done = false;

  const finish = (ok) => {
    if (done) return;
    done = true;
    clearTimeout(t);
    onResult(ok);
  };

  const t = setTimeout(() => finish(false), HEALTH_TIMEOUT);

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/health',
      method: 'GET',
    },
    (res) => {
      finish(res.statusCode === 200);
      res.resume();
    }
  );

  req.on('error', () => finish(false));
  req.end();
}

// ─── メイン処理 ───────────────────────────────────────────────
function main(rawInput) {
 // 1. JSON パース
  let hooksJson;
  try {
    hooksJson = JSON.parse(rawInput);
  } catch (e) {
    dbg('JSON parse error:', e.message);
    writeNotifyLog('(parse_error)', '', null, 'error:json_parse');
    process.exit(0);
  }

  const eventName = hooksJson.hook_event_name || hooksJson.event || '';
  const sessionId = hooksJson.session_id || '';
  dbg('event:', eventName, 'session:', sessionId);

 // 2. runtime.json 読み込み
  const runtime = readRuntime();
  if (!runtime || !runtime.port || !runtime.pid) {
    dbg('runtime.json missing or incomplete, skip');
    writeNotifyLog(eventName, sessionId, null, 'skip:no_runtime');
    process.exit(0);
  }

  const { port, pid } = runtime;

 // 3. PID 生存確認（stale 対策）
  if (!isPidAlive(pid)) {
    dbg('pid', pid, 'is dead (stale runtime.json), skip');
    writeNotifyLog(eventName, sessionId, port, 'skip:stale_pid');
    process.exit(0);
  }

 // 4. ヘルスチェック（PID 番号リサイクル対策）
  healthCheck(port, (healthy) => {
    if (!healthy) {
      dbg('health check failed on port', port, ', skip');
      writeNotifyLog(eventName, sessionId, port, 'skip:health_fail');
      process.exit(0);
    }

 // 5. ペイロード構築
    const payload = buildPayload(hooksJson);
    const payloadJson = JSON.stringify(payload);
    dbg('payload:', payloadJson);

 // 6. HTTP POST（flush 後に即 exit）
    const reqObj = postEvent(port, payloadJson, runtime.token, () => {
      writeNotifyLog(eventName, sessionId, port, 'sent');
      process.exit(0);
    });

 // POST エラー時もログを残す
    reqObj.on('error', (e) => {
      writeNotifyLog(eventName, sessionId, port, 'error:' + e.message.replace(/\s+/g, '_').slice(0, 40));
    });
  });
}

// ─── stdin 読み込み ───────────────────────────────────────────
let inputChunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => inputChunks.push(chunk));
process.stdin.on('end', () => {
  const raw = inputChunks.join('').trim();
  if (!raw) {
    dbg('empty stdin, exit 0');
    process.exit(0);
  }
  main(raw);
});
process.stdin.on('error', () => process.exit(0));
