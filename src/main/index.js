'use strict';

/**
 * kurotan Electron main process (MVP 最小雛形)
 *
 * 担当機能:
 * - app.whenReady() → 透過・最前面・枠なし BrowserWindow 生成
 * - 127.0.0.1:47600〜47610 でローカル HTTP サーバ起動
 * - runtime.json に { port, pid, startedAt } を書き込み
 * - 受信 hooks JSON を renderer IPC へ転送
 * - SessionStart で新ウィンドウ生成 / SessionEnd で該当ウィンドウクローズ
 * - ポート全滅時は offline モードで起動（ウィンドウは出すが HTTP なし）
 * - 多重起動防止（runtime.json の PID 確認）
 * - アプリ終了時に runtime.json 削除
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, powerMonitor } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { measureContextLevel, removeSession: removeContextSession, getRefreshedLevel, forceRefreshLevel, getCurrentLevel } = require('./transcript-reader');
const { extractCwdLabel, readCustomTitleFromJsonl, computeSessionLabel } = require('./session-label-utils');
const displayRegistry = require('./display-registry');
const configStore = require('./config-store');
const permissionOverlay = require('./permission-overlay');
const permissionLog = require('./permission-log');
const { runMigration } = require('../permission-resolver/migration');
const { readCustomConfig, defaultCustomConfig, parseRule } = require('../permission-resolver/permission-resolver');
const i18n = require('../i18n');

// ─── main プロセス ファイルログ ────────────────────────────────
// POST /event 受信ごとに非同期追記（ベストエフォート）。
// ログが 1MB 超えたら先頭 50% を切り捨て（簡易ローテ）。
const MAIN_LOG_PATH = path.join(
  process.env.TEMP ||
  process.env.TMP ||
  path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
  'kurotan-main.log'
);
const MAIN_LOG_MAX_BYTES = 1 * 1024 * 1024; // 1 MB

function truncateMainLogIfNeeded() {
  try {
    const stat = fs.statSync(MAIN_LOG_PATH);
    if (stat.size > MAIN_LOG_MAX_BYTES) {
      const buf = fs.readFileSync(MAIN_LOG_PATH);
      const half = Math.floor(buf.length / 2);
      fs.writeFileSync(MAIN_LOG_PATH, buf.slice(half));
    }
  } catch (e) {
 // 無視
  }
}

function writeMainLog(eventName, sessionId, sessionExists, action) {
  try {
    truncateMainLogIfNeeded();
    const line = `[${new Date().toISOString()}] received event=${eventName} session=${sessionId} sessionExists=${sessionExists} action=${action}\n`;
 fs.appendFile(MAIN_LOG_PATH, line, 'utf8', () => {}); // 非同期・エラー無視
  } catch (e) {
 // 無視
  }
}

// ─── Electron userData を kurotan ランタイムデータと分離 ───────
// Electron はデフォルトで app.name ('kurotan') を userData パスとして使用するため、
// %APPDATA%\kurotan\ が Electron 内部ファイル（Cache, Local Storage 等）で占有される。
// runtime.json はそのディレクトリに書き込まれるが Electron 内部の競合により
// 作成されないケースがある。userData を別ディレクトリに分離して衝突を解消する。
// ※ app.setPath() は app.whenReady() より前に呼ぶ必要がある（Electron 制約）。
app.setPath(
  'userData',
  path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'kurotan-electron'
  )
);

// ─── 定数 ──────────────────────────────────────────────────────
const PORT_START = 47600;
const PORT_END = 47610;
const WINDOW_WIDTH = 320; // 子くろたん収容のため仕様 §5.4.7 で 320px
const WINDOW_HEIGHT = 220; // 仕様 §5.4.7 に準拠

// Stop 受信後にセッションを自動クリーンアップするまでの待機時間。
// Claude Code は SessionEnd を発火しない場合があるため、Stop を受けてから
// 一定時間後に handleSessionEnd を呼んでウィンドウを閉じる。
// 環境変数 KUROTAN_STOP_TIMEOUT_MS で上書き可能（テスト時は 10000 等を指定）。
const STOP_AUTO_CLEANUP_MS = parseInt(process.env.KUROTAN_STOP_TIMEOUT_MS || '300000', 10);

// ─── transcript_path mtime 監視 設定 ──────────────────────────
// sessionId ごとに transcript_path の最終更新時刻を監視し、
// 一定時間更新なし = セッション終了とみなしてウィンドウをクローズする。
//
// KUROTAN_TRANSCRIPT_IDLE_MS: stale とみなす非更新時間（ミリ秒）
// デフォルト 1800000 (30 分) — Claude Code がアイドル中（ユーザー入力待ち）は transcript が
// 更新されないため、2 分(旧デフォルト)では誤 close が多発していた (KT-BUG: transcript-stale-too-short)。
// Stop タイマー (cleanupTimeoutMs: 30 分) と同値に揃えることで競合を解消する。
// テスト時は 15000 (15 秒) を推奨。
// KUROTAN_TRANSCRIPT_CHECK_MS: ポーリング間隔（デフォルト 5000ms）
const TRANSCRIPT_IDLE_MS = parseInt(process.env.KUROTAN_TRANSCRIPT_IDLE_MS || '1800000', 10);
const TRANSCRIPT_CHECK_INTERVAL_MS = parseInt(process.env.KUROTAN_TRANSCRIPT_CHECK_MS || '5000', 10);

// welcome セッションの仮想 sessionId（死活監視対象外）
const WELCOME_SESSION_ID = '__welcome__';

// ─── §A: tool_* 最低表示時間 hold ────────────────────────────────
// PostToolUse が数十ms で来ても tool_* state を最低 MIN_TOOL_STATE_HOLD_MS は見せる。
const MIN_TOOL_STATE_HOLD_MS = 700;
// Map<sessionId, { state: string, startedAt: number, pendingTimer: ReturnType<typeof setTimeout>|null }>
const toolStateHold = new Map();

// ─── §6.7 自動 cleanup 後の transcript 復帰検知 → respawn ────────
// despawn 済みセッションを 24h まで追跡し、transcript 更新を検知したら respawn する。
// Map<sessionId, { jsonlPath, closedAt, mascotMeta: { cwd, model, position, hueIndex, badgeIndex } }>
const recentlyClosedSessions = new Map();
const RECENTLY_CLOSED_MAX = 50;
// ファイル mtime からの経過が TTL を超えたら追跡終了 (closedAt 基準ではなく mtime 基準)
const RECENTLY_CLOSED_TTL_MS = 86400000; // 24h (transcript が 24h 更新されなければ追跡終了)

const RUNTIME_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'kurotan'
);
const RUNTIME_PATH = path.join(RUNTIME_DIR, 'runtime.json');
const CONFIG_PATH  = path.join(RUNTIME_DIR, 'config.json');

// ─── tool-call-history.json (§5.11.6) ─────────────────────────
// 件数・時間とも無制限。追記専用、起動時遅延ロード。
const HISTORY_PATH = path.join(RUNTIME_DIR, 'tool-call-history.json');
// Custom 設定ウィンドウが開いている間のみメモリにキャッシュ。null = 未ロード。
let _historyCache = null;

/**
 * 履歴ファイルへ 1 件追記する。
 * 実装戦略: ファイル末尾の ']' を除去して新エントリを挿入する in-place append。
 * ファイル不在時は新規作成。
 * I/O 遅延を最小化するため appendFileSync ではなく末尾 splice 方式を採用。
 * @param {object} entry
 */
function toolCallHistoryAppend(entry) {
  try {
    ensureRuntimeDir();
    const ts = entry.timestamp_ms
      ? new Date(entry.timestamp_ms).toISOString()
      : new Date().toISOString();
    const record = {
      ts,
      toolName:      String(entry.toolName  || '').slice(0, 60),
      matchingKey:   String(entry.matchKey  || '').slice(0, 60),
      ruleSuggestion: buildRuleSuggestion(entry.toolName || '', entry.matchKey || ''),
      mode:          entry.mode     || 'auto',
      decision:      entry.decision != null ? entry.decision : 'ask',
      source:        entry.source   || 'no-match',
    };
    const recordStr = JSON.stringify(record);

    if (!fs.existsSync(HISTORY_PATH)) {
 // 新規作成 (v2 形式)
      fs.writeFileSync(HISTORY_PATH, JSON.stringify({ version: 2, entries: [record] }, null, 0), 'utf8');
    } else {
 // in-place append: 末尾の ']' + '}' を取り除いて追記
 // フォーマット: {version:2,entries:[...]}
      const fd = fs.openSync(HISTORY_PATH, 'r+');
      try {
        const stat = fs.fstatSync(fd);
        const fileSize = stat.size;
        if (fileSize < 20) {
 // ファイルが破損しているか空 → 上書き
          fs.closeSync(fd);
          fs.writeFileSync(HISTORY_PATH, JSON.stringify({ version: 2, entries: [record] }, null, 0), 'utf8');
          return;
        }
 // 末尾を読んで ']' の位置を探す (最大 32 バイト読む)
        const tailLen = Math.min(32, fileSize);
        const tailBuf = Buffer.alloc(tailLen);
        fs.readSync(fd, tailBuf, 0, tailLen, fileSize - tailLen);
        const tail = tailBuf.toString('utf8');
 // ']}' が末尾にあるはず
        const closingIdx = tail.lastIndexOf(']}');
        if (closingIdx === -1) {
 // 不正フォーマット → 上書き (v2 形式)
          fs.closeSync(fd);
          fs.writeFileSync(HISTORY_PATH, JSON.stringify({ version: 2, entries: [record] }, null, 0), 'utf8');
          return;
        }
 // 末尾から ']}' を除去した位置にシーク
        const insertPos = fileSize - tailLen + closingIdx;
        const appendStr = ',' + recordStr + ']}';
        const appendBuf = Buffer.from(appendStr, 'utf8');
        fs.writeSync(fd, appendBuf, 0, appendBuf.length, insertPos);
        fs.ftruncateSync(fd, insertPos + appendBuf.length);
      } finally {
        fs.closeSync(fd);
      }
    }

 // メモリキャッシュが有効なら更新
    if (_historyCache) {
      _historyCache.push(record);
    }
  } catch (e) {
 // 追記失敗は無視 (bridge の decision 返却を妨げない)
    writeMainLog('history-append-error', '', false, e.message.slice(0, 60));
  }
}

/**
 * 履歴ファイルを全件読み込む (遅延ロード: Custom 設定ウィンドウ起動時のみ呼ぶ)。
 * @returns {{ version: number, entries: object[] }}
 */
function loadFullHistory() {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return { version: 2, entries: [] };
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.entries)) return { version: 2, entries: [] };
    _historyCache = data.entries;
    return data;
  } catch (e) {
    return { version: 2, entries: [] };
  }
}

/**
 * UI 向け ruleSuggestion 生成 (§5.11.6.2)
 * @param {string} toolName
 * @param {string} matchKey
 * @returns {string}
 */
function buildRuleSuggestion(toolName, matchKey) {
  if (!toolName || !matchKey) return toolName || '';
  switch (toolName) {
    case 'Bash':
    case 'BashOutput': {
 // 先頭の word を抽出
      const firstWord = matchKey.split(/\s+/)[0] || matchKey;
      return `Bash(${firstWord}:*)`;
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'Glob':
    case 'Grep':
      return `${toolName}(${matchKey})`;
    case 'WebFetch':
      return `WebFetch(domain:${matchKey})`;
    case 'Agent':
    case 'Task':
      return `Agent(${matchKey})`;
    case 'Skill':
      return `Skill(${matchKey})`;
    default:
      return toolName;
  }
}

// ─── config.json デフォルト値 (§9.2 スキーマ) ───────────────────
const CONFIG_DEFAULTS = {
  version: 1,
  artStyle: 'sd',
  bubble: {
    enabled: true,
    fontSize: 16,
    fontFamily: 'Noto Sans JP',
    bgColor: '#e3e3e3',
    bgOpacity: 0.85,
    textColor: '#2e0a0a',
  },
  behavior: { startleAnim: true, clickThrough: true, nightMode: false },
  autoStart: false,
  hooksInstall: 'user',
  cleanupTimeoutMs: 1800000,
 // 0.9.32: mouseFollow 撤廃 (renderer 未実装で効果ゼロだった)
  lastPositions: {},
  contextMotion: {
    enabled: true,
    thresholds: { low: 0, mid: 30, high: 60, critical: 80 },
    throttleMs: 5000,
    tooltipDismissed: false,
  },
 // §6.6.9 起動時既存セッション scan (2026-05-03 新設)
  scanExistingSessionsOnStartup: true,
  activeSessionThresholdMs: 1800000,
  scanMaxRestoreCount: 10,
 // §5.12 マスコット登場モーション (2026-05-03 新設)
  entryAnimationMode: 'random',
  entryAnimationWeights: { A: 8, B: 5, C: 5, E: 1 },
  disableRepeatedEntryAnimation: false,
  disableEntryAnimationForReducedMotion: true,
 // B 案モニタ選択 : null = primary 既定
  stageDisplayId: null,
 // 0.9.15: マスコット下にセッション名 (cwd 末尾) を表示する
  showSessionLabel: true,
};

/** config.json を読み込んでデフォルトとマージして返す */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return Object.assign({}, CONFIG_DEFAULTS, raw, {
        behavior: Object.assign({}, CONFIG_DEFAULTS.behavior, raw.behavior || {}),
        bubble: Object.assign({}, CONFIG_DEFAULTS.bubble, raw.bubble || {}),
        lastPositions: Object.assign({}, CONFIG_DEFAULTS.lastPositions, raw.lastPositions || {}),
        contextMotion: Object.assign({}, CONFIG_DEFAULTS.contextMotion, raw.contextMotion || {}),
        entryAnimationWeights: Object.assign({}, CONFIG_DEFAULTS.entryAnimationWeights, raw.entryAnimationWeights || {}),
      });
    }
  } catch (e) {
 // パース失敗はデフォルト値を返す
  }
  return Object.assign({}, CONFIG_DEFAULTS);
}

/** config.json に部分更新して保存する */
function saveConfig(partial) {
  ensureRuntimeDir();
  const current = loadConfig();
 // behavior / bubble は深いマージ
  if (partial.behavior && typeof partial.behavior === 'object') {
    partial = Object.assign({}, partial, {
      behavior: Object.assign({}, current.behavior, partial.behavior),
    });
  }
  if (partial.bubble && typeof partial.bubble === 'object') {
    partial = Object.assign({}, partial, {
      bubble: Object.assign({}, current.bubble, partial.bubble),
    });
  }
  if (partial.contextMotion && typeof partial.contextMotion === 'object') {
    partial = Object.assign({}, partial, {
      contextMotion: Object.assign({}, current.contextMotion, partial.contextMotion),
    });
  }
  if (partial.entryAnimationWeights && typeof partial.entryAnimationWeights === 'object') {
    partial = Object.assign({}, partial, {
      entryAnimationWeights: Object.assign({}, current.entryAnimationWeights, partial.entryAnimationWeights),
    });
  }
  const next = Object.assign({}, current, partial);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** アプリ起動時に config を読み込んで runtime に反映する */
let runtimeConfig = CONFIG_DEFAULTS;

function applyConfig(cfg) {
  runtimeConfig = cfg;
 // cleanupTimeoutMs → STOP_AUTO_CLEANUP_MS は定数扱いのため、
 // 次回 Stop 受信から新値が適用される (bumpSessionTimer / bumpStageSessionTimer で参照)
 // nightMode を全 renderer へ broadcast
  broadcastNightMode(cfg.behavior && cfg.behavior.nightMode === true);
 // artStyle を全 renderer へ broadcast
  broadcastArtStyle(cfg.artStyle || 'sd');
 // bubble style を全 renderer へ broadcast
  broadcastBubbleStyle(cfg.bubble || {});
}

/** bubble style の現在値を全 renderer へ broadcast する */
function broadcastBubbleStyle(bubble) {
  const payload = { bubble: bubble || {} };
  if (stageWindow && !stageWindow.isDestroyed()) {
    stageWindow.webContents.send('kurotan:bubble-style', payload);
  }
  for (const [, w] of sessionWindows) {
    if (!w.isDestroyed()) {
      w.webContents.send('kurotan:bubble-style', payload);
    }
  }
 // 0.9.57: かんたんぼたんにも同じ bubble 設定を broadcast
  permissionOverlay.broadcastBubble(bubble);
}

/** contextMotion 設定の現在値を全 renderer へ broadcast する (§5.9.8) */
function broadcastContextMotion(contextMotion) {
  const payload = { contextMotion: contextMotion || {} };
  if (stageWindow && !stageWindow.isDestroyed()) {
    stageWindow.webContents.send('kurotan:context-motion', payload);
  }
  for (const [, w] of sessionWindows) {
    if (!w.isDestroyed()) {
      w.webContents.send('kurotan:context-motion', payload);
    }
  }
}

/** nightMode の現在値を全 renderer へ broadcast する */
function broadcastNightMode(nightMode) {
  const payload = { nightMode: !!nightMode };
 // Stage Window モード
  if (stageWindow && !stageWindow.isDestroyed()) {
    stageWindow.webContents.send('kurotan:night-mode', payload);
  }
 // 旧モード (複数 BrowserWindow)
  for (const [, w] of sessionWindows) {
    if (!w.isDestroyed()) {
      w.webContents.send('kurotan:night-mode', payload);
    }
  }
}

/** showSessionLabel の現在値を Stage renderer に broadcast (0.9.15) */
function broadcastShowSessionLabel(show) {
  const payload = { show: !!show };
  if (stageWindow && !stageWindow.isDestroyed()) {
    stageWindow.webContents.send('kurotan:show-session-label-change', payload);
  }
}

/** artStyle の現在値を全 renderer へ broadcast する */
function broadcastArtStyle(artStyle) {
  const payload = { artStyle: artStyle || 'sd' };
  if (stageWindow && !stageWindow.isDestroyed()) {
    stageWindow.webContents.send('kurotan:art-style-change', payload);
  }
  for (const [, w] of sessionWindows) {
    if (!w.isDestroyed()) {
      w.webContents.send('kurotan:art-style-change', payload);
    }
  }
}

// 0.9.41: locale 変更時に全 renderer (stage / settings 等) へ辞書を broadcast する
function broadcastLocaleChange() {
  let dict = {};
  let fallbackDict = {};
  try {
    const localesDir = path.join(__dirname, '..', 'i18n', 'locales');
    const curLang = i18n.getCurrentLang();
    const curPath = path.join(localesDir, `${curLang}.json`);
    const jaPath = path.join(localesDir, 'ja.json');
    if (fs.existsSync(curPath)) dict = JSON.parse(fs.readFileSync(curPath, 'utf8'));
    if (fs.existsSync(jaPath)) fallbackDict = JSON.parse(fs.readFileSync(jaPath, 'utf8'));
  } catch (_e) { /* ignore */ }

  const payload = { lang: i18n.getCurrentLang(), dict, fallbackDict };
  if (stageWindow && !stageWindow.isDestroyed()) {
    stageWindow.webContents.send('kurotan:locale-changed', payload);
  }
  for (const [, w] of sessionWindows) {
    if (!w.isDestroyed()) {
      w.webContents.send('kurotan:locale-changed', payload);
    }
  }
 // settings ウィンドウ等 BrowserWindow.getAllWindows() で取りこぼし対策
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send('kurotan:locale-changed', payload);
      }
    }
  } catch (_e) { /* ignore */ }
}

// hooks インストール済みかどうかを簡易チェックする
function checkHooksInstalled() {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return false;
    const content = fs.readFileSync(settingsPath, 'utf8');
    return content.includes('kurotan-notify');
  } catch (e) {
    return false;
  }
}

const RENDERER_HTML = path.join(__dirname, '..', 'renderer', 'mascot.html');

// ─── グローバル状態 ────────────────────────────────────────────
/** sessionId → BrowserWindow のマップ */
const sessionWindows = new Map();
/** sessionId → Stop 後の auto-cleanup タイマーハンドル */
const stopTimers = new Map();
/** sessionId → transcript_path（文字列）。mtime 死活監視の主手段。__welcome__ は登録しない */
const sessionTranscriptPaths = new Map();
/** sessionId → 最後に customTitle 再読込した時の transcript mtimeMs (0.9.26: 5 秒ポーリング負荷削減) */
const customTitleMtimeCache = new Map();
let httpServer = null;
let listeningPort = null;
let tray = null;
let isOffline = false;
let trayWatchdogStarted = false;
/** requestId → { resolve } の long-poll 待機マップ */
const pendingPermissions = new Map();
/** Custom 設定ウィンドウ (T6) — 同時 1 ウィンドウのみ */
let customConfirmWindow = null;
/** DOM dump 要求の requestId → レスポンス callback マップ */
const pendingDomDumps = {};

// ─── ユーティリティ ────────────────────────────────────────────
function ensureRuntimeDir() {
  if (!fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }
}

// HTTP API 認証トークン
// 同 PC 上の他プロセスから偽イベント / 偽 permission を投げられないよう、
// 起動ごとに 32 文字のランダム token を生成して runtime.json に保存し、
// hooks 側 (kurotan-notify / kurotan-permission-bridge) が X-Kurotan-Token ヘッダで送信する。
const httpAuthToken = require('crypto').randomBytes(16).toString('hex');

function writeRuntime(port) {
  ensureRuntimeDir();
  const data = {
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: httpAuthToken,
  };
  fs.writeFileSync(RUNTIME_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function startTrayWatchdog() {
  if (trayWatchdogStarted || process.platform !== 'win32') return;
  trayWatchdogStarted = true;

  const watchdogPath = path.join(__dirname, 'tray-watchdog.js');
  const refreshScriptPath = path.join(__dirname, 'refresh-tray.ps1');
  if (!fs.existsSync(watchdogPath) || !fs.existsSync(refreshScriptPath)) {
    writeMainLog('tray-watchdog', '', false, 'missing helper');
    return;
  }

  try {
    const nodePath = process.env.npm_node_execpath || 'node.exe';
    const launcherPath = path.join(__dirname, 'start-tray-watchdog.ps1');
    if (!fs.existsSync(launcherPath)) {
      writeMainLog('tray-watchdog', '', false, 'missing launcher');
      return;
    }

    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', launcherPath,
    ], {
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        KUROTAN_WATCHDOG_NODE: nodePath,
        KUROTAN_WATCHDOG_SCRIPT: watchdogPath,
        KUROTAN_WATCHDOG_PARENT_PID: String(process.pid),
        KUROTAN_WATCHDOG_REFRESH_SCRIPT: refreshScriptPath,
        KUROTAN_WATCHDOG_LOG: MAIN_LOG_PATH,
        KUROTAN_WATCHDOG_RUNTIME: RUNTIME_PATH,
      },
    });
    child.unref();
    writeMainLog('tray-watchdog', '', false, `launcher-started pid=${child.pid} node=${nodePath}`);
  } catch (e) {
    writeMainLog('tray-watchdog', '', false, `start-failed ${e.message}`);
  }
}

function deleteRuntime() {
  try {
    if (fs.existsSync(RUNTIME_PATH)) {
      fs.unlinkSync(RUNTIME_PATH);
    }
  } catch (e) {
 // 削除失敗は無視
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** 多重起動チェック: runtime.json が存在し、そこの PID が生きていれば true */
function isAlreadyRunning() {
  try {
    if (!fs.existsSync(RUNTIME_PATH)) return false;
    const data = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
    if (!data.pid) return false;
 if (data.pid === process.pid) return false; // 自分自身は除外
    return isPidAlive(data.pid);
  } catch (e) {
    return false;
  }
}

// ─── ポート確保 ────────────────────────────────────────────────
function tryBindPort(port) {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

async function findAvailablePort() {
  for (let port = PORT_START; port <= PORT_END; port++) {
    const srv = await tryBindPort(port);
    if (srv) return { server: srv, port };
  }
  return null;
}

// ─── HTTP サーバ ───────────────────────────────────────────────
//
// /debug/* エンドポイントの公開条件:
// - 開発時 (app.isPackaged === false): 常に有効
// - 配布版 (app.isPackaged === true): 環境変数 KUROTAN_DEV_ENDPOINTS=1 が立っている時のみ有効
// - それ以外は 404 を返し、ローカル他プロセスからの誤動作・悪用を防ぐ
function debugEndpointsAllowed() {
  return !app.isPackaged || process.env.KUROTAN_DEV_ENDPOINTS === '1';
}

// HTTP リクエストボディの上限。同一 PC 上の他プロセスが巨大 POST で main process
// メモリを枯渇させるのを防ぐ。
const MAX_HTTP_BODY_BYTES = 1024 * 1024; // 1 MB

/**
 * 共通: req.on('data') で body を蓄積するヘルパー (size limit 付き)。
 * 上限超過時は 413 を返し req.destroy() する。
 * 完了時 onComplete(bodyString) を呼ぶ。
 */
function readBodyWithLimit(req, res, onComplete) {
  let body = '';
  let total = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    total += chunk.length;
    if (total > MAX_HTTP_BODY_BYTES) {
      aborted = true;
      try { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'payload too large' })); } catch (_) { /* ignore */ }
      try { req.destroy(); } catch (_) { /* ignore */ }
      return;
    }
    body += chunk;
  });
  req.on('end', () => {
    if (aborted) return;
    try { onComplete(body); } catch (_) { /* caller handles */ }
  });
  req.on('error', () => { if (!aborted) try { res.writeHead(500); res.end(); } catch (_) { /* ignore */ } });
}

/**
 * HTTP API 認証
 * /event /permission-request /history-append は X-Kurotan-Token 必須。
 * 不一致なら 401。
 * /health /debug/* は token 不要 (debug は別ゲート済)。
 */
function checkHttpAuth(req, res, url) {
  if (url === '/health' || (url && url.startsWith('/debug/'))) return true;
  const token = req.headers['x-kurotan-token'];
  if (token && token === httpAuthToken) return true;
  try {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  } catch (_) { /* ignore */ }
  return false;
}

function setupHttpServer(server) {
  server.on('request', (req, res) => {
    const url = req.url;
    const method = req.method;

 // /debug/* は dev モードか KUROTAN_DEV_ENDPOINTS=1 でのみ受付
    if (url && url.startsWith('/debug/') && !debugEndpointsAllowed()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

 // 0.9.38: 認証チェック (/health /debug 以外)
    if (!checkHttpAuth(req, res, url)) return;

 // GET /health
    if (method === 'GET' && url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid, port: listeningPort }));
      return;
    }

 // POST /event
    if (method === 'POST' && url === '/event') {
      readBodyWithLimit(req, res, (body) => {
        try {
          const payload = JSON.parse(body);
          handleEvent(payload);
        } catch (e) {
 // パース失敗は無視（Claude Code への影響なし）
        }
 // レスポンスは素早く返す（kurotan-notify はレスポンスを待たないが念のため）
        res.writeHead(204);
        res.end();
      });
      return;
    }

 // POST /permission-request (long-poll: kurotan-permission-bridge から呼ばれる)
    if (method === 'POST' && url === '/permission-request') {
      readBodyWithLimit(req, res, (body) => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ decision: 'ask' }));
          return;
        }

        const requestId = 'perm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        const sessionId = parsed.sessionId || '';
        const toolName  = parsed.toolName  || '';
        const toolInput = parsed.toolInput || {};

 // 60 秒タイムアウト: renderer が応答しなければ 'ask' を返す
        const PERM_TIMEOUT_MS = 60000;
        let responded = false;
        const respond = (decision) => {
          if (responded) return;
          responded = true;
          clearTimeout(permTimer);
          pendingPermissions.delete(requestId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ decision }));
        };

        const permTimer = setTimeout(() => {
          writeMainLog('permission-timeout', sessionId, stageMascotStore.has(sessionId), `requestId=${requestId}`);
          respond('ask');
        }, PERM_TIMEOUT_MS);

        pendingPermissions.set(requestId, { resolve: respond, receivedAt: Date.now(), sessionId });

 // feature flag §5.10.8: 既定は新経路 (マスコット円形ボタン)
 // KUROTAN_LEGACY_PERMISSION_DIALOG=1 または global.__kurotanLegacyPermissionDialog=true で旧 BrowserWindow 経路
        const useLegacyDialog = global.__kurotanLegacyPermissionDialog === true;

        if (useLegacyDialog) {
 // 旧経路 (legacy): 専用 BrowserWindow ダイアログ
          try {
            createPermissionDialog(requestId, sessionId, toolName, toolInput);
          } catch (e) {
            writeMainLog('permission-dialog-error', sessionId, stageMascotStore.has(sessionId),
              `requestId=${requestId} err=${e && e.message}`);
            respond('ask');
            return;
          }
          writeMainLog('permission-request-legacy', sessionId, stageMascotStore.has(sessionId),
            `requestId=${requestId} tool=${toolName}`);
        } else {
 // 新経路 (§5.10.3): Stage renderer にマスコット円形ボタン UI を表示
 // Stage が存在しない場合は即 ask (§5.10.4 フォールバック)
          if (!stageWindow || stageWindow.isDestroyed()) {
            writeMainLog('permission-request-no-stage', sessionId, false,
              `requestId=${requestId} fallback=ask`);
            respond('ask');
            return;
          }
          sendToStage('kurotan:permission-request', {
            requestId,
            sessionId,
            toolName,
            toolInput,
          });
          writeMainLog('permission-request-new', sessionId, stageMascotStore.has(sessionId),
            `requestId=${requestId} tool=${toolName}`);
        }
      });
      return;
    }

 // POST /history-append (bridge から auto-resolve 記録を受け取る §5.11.6.4)
    if (method === 'POST' && url === '/history-append') {
      readBodyWithLimit(req, res, (body) => {
 // bridge は fire-and-forget: レスポンス速度を優先する
        res.writeHead(204);
        res.end();
 // 非同期で履歴を追記 (レスポンス返却後に処理)
        try {
          const parsed = JSON.parse(body);
          toolCallHistoryAppend(parsed);
        } catch (e) {
 // parse 失敗は無視
        }
      });
      return;
    }

 // POST /debug/permission-demo (demo_runner 専用: ダイアログ開いて requestId を即返す)
    if (method === 'POST' && url === '/debug/permission-demo') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'bad json' }));
          return;
        }

        const requestId = parsed.requestId || ('demo-perm-' + Date.now());
        const sessionId = parsed.sessionId || 'demo-session-001';
        const toolName  = parsed.toolName  || 'Bash';
        const toolInput = parsed.toolInput || {};

 // 60 秒タイムアウト
        const PERM_TIMEOUT_MS = 60000;
        let responded = false;
        const respond = (decision) => {
          if (responded) return;
          responded = true;
          clearTimeout(permTimer);
          pendingPermissions.delete(requestId);
          writeMainLog('debug-permission-resolved', sessionId, stageMascotStore.has(sessionId),
            `requestId=${requestId} decision=${decision}`);
        };

        const permTimer = setTimeout(() => {
          respond('ask');
        }, PERM_TIMEOUT_MS);

        pendingPermissions.set(requestId, { resolve: respond, receivedAt: Date.now(), sessionId });

        const useLegacyDialogDemo = global.__kurotanLegacyPermissionDialog === true;
        if (useLegacyDialogDemo) {
          try {
            createPermissionDialog(requestId, sessionId, toolName, toolInput);
          } catch (e) {
            pendingPermissions.delete(requestId);
            clearTimeout(permTimer);
            res.writeHead(500);
            res.end(JSON.stringify({ error: e && e.message }));
            return;
          }
        } else {
          if (!stageWindow || stageWindow.isDestroyed()) {
            pendingPermissions.delete(requestId);
            clearTimeout(permTimer);
            res.writeHead(503);
            res.end(JSON.stringify({ error: 'stage not ready' }));
            return;
          }
          sendToStage('kurotan:permission-request', {
            requestId,
            sessionId,
            toolName,
            toolInput,
          });
        }

        writeMainLog('debug-permission-demo', sessionId, stageMascotStore.has(sessionId),
          `requestId=${requestId} tool=${toolName}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, requestId }));
      });
      req.on('error', () => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'request error' }));
      });
      return;
    }

 // POST /debug/permission-resolve (demo_runner 専用: requestId に decision を注入)
    if (method === 'POST' && url === '/debug/permission-resolve') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'bad json' }));
          return;
        }

        const requestId = parsed.requestId || '';
        const decision  = (parsed.decision === 'allow' || parsed.decision === 'deny') ? parsed.decision : 'ask';
        const entry = pendingPermissions.get(requestId);
        if (!entry) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'requestId not found or already resolved' }));
          return;
        }
        entry.resolve(decision);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, requestId, decision }));
      });
      req.on('error', () => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'request error' }));
      });
      return;
    }

 // ─── ローカル検証用 debug エンドポイント群 (/3) ────────────

 // POST /debug/context-level
 // body: { "value": 0.85 } (0.0〜1.0)
 // 用途: 実機項目1「sleepy/drowsy/yawn/stretch の contextMotion 切替」検証
 // 0.75 → sleepy / 0.85 → drowsy / 0.95 → yawn / 0.99 → stretch (§5.9)
    if (method === 'POST' && url === '/debug/context-level') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'bad json' }));
          return;
        }
        const value = typeof parsed.value === 'number' ? parsed.value : 0.5;
        if (value < 0 || value > 1) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'value must be 0.0〜1.0' }));
          return;
        }
        try {
          sendToStage('kurotan:debug-context-level', { value });
          writeMainLog('debug-context-level', '__debug__', false, `value=${value}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, value, frozen: true, note: '§5.9 frozen - dataset not applied' }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e && e.message }));
        }
      });
      req.on('error', () => { res.writeHead(500); res.end(JSON.stringify({ error: 'request error' })); });
      return;
    }

 // POST /debug/subagent-burst
 // body: { "count": 5 } (デフォルト 5)
 // 用途: 実機項目2「並列 N 匹 sparkle 視覚ノイズ」検証
    if (method === 'POST' && url === '/debug/subagent-burst') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch (e) { parsed = {}; }
        const count = typeof parsed.count === 'number' ? Math.max(1, Math.min(20, parsed.count)) : 5;
        try {
          const ids = [];
          for (let i = 0; i < count; i++) {
            const agentId = `debug-burst-${i}-${Date.now()}`;
            ids.push(agentId);
 // SubagentStart 相当: 子マスコット追加
            sendToStage('kurotan:mascot-update', {
              sessionId: agentId,
              state: 'thinking',
              children: [{ agentId, state: 'thinking', spawnedVia: 'debug-burst' }],
            });
 // 1.5 秒後に SubagentStop 相当: sparkle + 削除
            setTimeout(() => {
              sendToStage('kurotan:subagent-sparkle', { sessionId: agentId, success: true });
              sendToStage('kurotan:mascot-remove', { sessionId: agentId, withFarewell: true });
            }, 1500);
          }
          writeMainLog('debug-subagent-burst', '__debug__', false, `count=${count} ids=${ids.join(',')}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count, ids }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e && e.message }));
        }
      });
      req.on('error', () => { res.writeHead(500); res.end(JSON.stringify({ error: 'request error' })); });
      return;
    }

 // POST /debug/spawn-child
 // body: { "agentId": "preview-child-1" } (省略時は "preview-child-default")
 // 用途: 見た目確認用 永続ちびくろたん表示 (SubagentStop を発火しないため削除されない)
 // 実装: 実在する親セッションの最初のエントリに childSpawn を送る (SubagentStart 相当)
    if (method === 'POST' && url === '/debug/spawn-child') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch (e) { parsed = {}; }
        const agentId = (parsed.agentId && typeof parsed.agentId === 'string') ? parsed.agentId : 'preview-child-default';
        try {
 // 実在する親マスコットを取得 (stageMascotStore の最初のエントリ)
          const parentEntry = stageMascotStore.entries().next();
          if (parentEntry.done) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'No active parent mascot found. Start a Claude Code session first.' }));
            return;
          }
          const parentSessionId = parentEntry.value[0];
          const childId = 'debug-spawn-' + agentId;
          sendToStage('kurotan:mascot-update', {
            sessionId: parentSessionId,
            childSpawn: {
              childId,
              subagentType: 'agent',
              agentId,
              source: 'official',
              spawnedVia: 'debug-spawn',
            },
          });
          writeMainLog('debug-spawn-child', '__debug__', false, `agentId=${agentId} parentSessionId=${parentSessionId} childId=${childId}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, agentId, childId, parentSessionId, note: '永続表示。/debug/despawn-child で削除' }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e && e.message }));
        }
      });
      req.on('error', () => { res.writeHead(500); res.end(JSON.stringify({ error: 'request error' })); });
      return;
    }

 // POST /debug/despawn-child
 // body: { "agentId": "preview-child-1" } (省略時は "preview-child-default")
 // 用途: spawn-child で表示した永続ちびくろたんを手動削除
 // 実装: 実在する親セッションに childDespawn を送る
    if (method === 'POST' && url === '/debug/despawn-child') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch (e) { parsed = {}; }
        const agentId = (parsed.agentId && typeof parsed.agentId === 'string') ? parsed.agentId : 'preview-child-default';
        try {
          const childId = 'debug-spawn-' + agentId;
 // 全親セッションに childDespawn を broadcast (どの親に属しているか不明なため)
          for (const [sid] of stageMascotStore) {
            sendToStage('kurotan:mascot-update', {
              sessionId: sid,
              childDespawn: { childId, agentId, withFarewell: false },
            });
          }
          writeMainLog('debug-despawn-child', '__debug__', false, `agentId=${agentId} childId=${childId}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, agentId, childId }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e && e.message }));
        }
      });
      req.on('error', () => { res.writeHead(500); res.end(JSON.stringify({ error: 'request error' })); });
      return;
    }

 // POST /debug/farewell-test
 // body: { "agentId": "test-fw-1" }
 // 用途: 実機項目3「SubagentStart/Stop 重複 farewell なし」検証
 // 同一 agentId で Start→即 Stop + PreToolUse(Agent)終了 の二重発火を再現
    if (method === 'POST' && url === '/debug/farewell-test') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch (e) { parsed = {}; }
        const agentId = (parsed.agentId && typeof parsed.agentId === 'string')
          ? parsed.agentId
          : `test-fw-${Date.now()}`;
        try {
 // SubagentStart 相当
          sendToStage('kurotan:mascot-update', {
            sessionId: agentId,
            state: 'thinking',
            children: [{ agentId, state: 'thinking', spawnedVia: 'debug-farewell-test' }],
          });
 // 即座に SubagentStop (主トラック)
          sendToStage('kurotan:subagent-sparkle', { sessionId: agentId, success: true });
          sendToStage('kurotan:mascot-remove', { sessionId: agentId, withFarewell: true });
 // 副トラック (PreToolUse(Agent) 終了) を 100ms 後に重複発火
          setTimeout(() => {
            sendToStage('kurotan:mascot-remove', { sessionId: agentId, withFarewell: true });
          }, 100);
          writeMainLog('debug-farewell-test', agentId, false, 'dual-fire');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, agentId, note: 'farewell should appear exactly once' }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e && e.message }));
        }
      });
      req.on('error', () => { res.writeHead(500); res.end(JSON.stringify({ error: 'request error' })); });
      return;
    }

 // POST /debug/reset-onboarding
 // body: なし
 // 用途: 実機項目4「onboarding tooltip 初回のみ表示」検証
 // renderer の localStorage の onboarding flag を全削除 → 設定画面を再オープン
    if (method === 'POST' && url === '/debug/reset-onboarding') {
      try {
        sendToStage('kurotan:debug-reset-onboarding', {});
        writeMainLog('debug-reset-onboarding', '__debug__', false, 'sent');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, note: 'onboarding flags cleared; reopen settings to verify tooltip' }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e && e.message }));
      }
      return;
    }

 // GET /debug/permission-log
 // 用途: 実機項目5「transcript 5 フィールド限定 / 本文流出ゼロ」確認補助
 // %APPDATA%\kurotan\logs\permission_log.jsonl を text/plain で返す
 // (KUROTAN_PERMISSION_LOG=1 の時のみファイルが存在する)
    if (method === 'GET' && url === '/debug/permission-log') {
      const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      const logPath = path.join(APPDATA, 'kurotan', 'logs', 'permission_log.jsonl');
      try {
        if (!fs.existsSync(logPath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end(`# permission_log.jsonl not found\n# Set KUROTAN_PERMISSION_LOG=1 and restart kurotan to enable logging.\n# Path: ${logPath}\n`);
          return;
        }
        const content = fs.readFileSync(logPath, 'utf8');
        writeMainLog('debug-permission-log', '__debug__', false, `bytes=${Buffer.byteLength(content)}`);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(content);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Error reading log: ${e && e.message}\n`);
      }
      return;
    }

 // GET /debug/dom-dump
 // 全マスコットの dataset / computedBg / currentState を JSON で返す
    if (method === 'GET' && url === '/debug/dom-dump') {
      const requestId = `dump-${Date.now()}`;
      pendingDomDumps[requestId] = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data, null, 2));
      };
      sendToStage('kurotan:debug-dom-dump', { requestId });
      setTimeout(() => {
        if (pendingDomDumps[requestId]) {
          pendingDomDumps[requestId]({ error: 'timeout', mascots: [] });
          delete pendingDomDumps[requestId];
        }
      }, 2000);
      return;
    }

 // その他
    res.writeHead(404);
    res.end();
  });
}

// ─── transcript_path mtime 死活監視（メイン手段） ──────────────
/**
 * セッションごとに transcript_path ファイルの mtime を定期確認し、
 * TRANSCRIPT_IDLE_MS 以上更新がなければセッション終了とみなしてウィンドウをクローズ。
 *
 * 検知パターン:
 * - ファイル消失 → 即 close（claude セッションが完全終了）
 * - mtime が TRANSCRIPT_IDLE_MS 以上古い → stale 判定 → close
 *
 * __welcome__ セッションは対象外（transcript_path を持たない設計）。
 * SessionEnd / Stop-auto-cleanup / parent-pid-dead で先にクローズされた
 * セッションは sessionTranscriptPaths に残らないため二重 close は発生しない。
 */
function checkTranscriptMtimes() {
  const now = Date.now();
  const isStageMode = process.env.KUROTAN_STAGE_MODE === '1';
  for (const [sessionId, transcriptPath] of sessionTranscriptPaths) {
 // transcript_path が未提供（空文字 / null）のセッションは監視対象外 (KT-G6-11 fail-open)
    if (!transcriptPath) {
      sessionTranscriptPaths.delete(sessionId);
      continue;
    }

 // セッションが既に終了していればマップから削除して次へ
    const alive = isStageMode ? stageMascotStore.has(sessionId) : sessionWindows.has(sessionId);
    if (!alive) {
      sessionTranscriptPaths.delete(sessionId);
      continue;
    }

    let stale = false;
    let reason = '';

    try {
      const stat = fs.statSync(transcriptPath);
      const mtimeMs = stat.mtimeMs;
      const ageMs = now - mtimeMs;

      if (ageMs >= TRANSCRIPT_IDLE_MS) {
        stale = true;
        reason = `transcript-stale age=${Math.round(ageMs / 1000)}s threshold=${TRANSCRIPT_IDLE_MS / 1000}s`;
      } else {
 // 0.9.25: アクティブセッションは customTitle 差分検知 (/rename 動的反映)
 // 0.9.26: mtime cache でファイル変化が無ければ re-read スキップ (CPU 削減)
 // cache 更新は read 成功後のみ。失敗時は cache 更新せず次回再試行する。
        if (isStageMode && stageMascotStore.has(sessionId)) {
          const ms = stageMascotStore.get(sessionId);
          const cachedMtime = customTitleMtimeCache.get(sessionId);
          if (cachedMtime !== mtimeMs) {
            try {
              const newTitle = readCustomTitleFromJsonl(transcriptPath);
 // 成功時のみ cache 更新 (空文字も有効な「読めた結果」として記録)
              customTitleMtimeCache.set(sessionId, mtimeMs);
              if (newTitle && newTitle !== ms.sessionLabel) {
                const oldLabel = ms.sessionLabel;
                ms.sessionLabel = newTitle;
                writeMainLog('session-label-update', sessionId, true, `from=[${oldLabel}] to=[${newTitle}]`);
                sendToStage('kurotan:mascot-update', { sessionId, sessionLabel: newTitle });
              }
            } catch (_) {
 // 読み込み失敗時は cache 更新しない → 次回ポーリング (5 秒後) で再試行される
            }
          }
        }
        if (process.env.KUROTAN_DEBUG === '1') {
          writeMainLog('transcript-check', sessionId, true, `age=${Math.round(ageMs / 1000)}s ok`);
        }
      }
    } catch (e) {
 // fail-open: statSync 失敗（パーミッション / 一時的なファイルロック等）では close しない。
 // ファイル消失は様々な理由で発生し得るため、確証なくセッションを終了させない。
 // Stop タイマー（5 分）が最終安全網として機能する。
      if (process.env.KUROTAN_DEBUG === '1') {
        writeMainLog('transcript-check', sessionId, true, `stat-error err=${e.code || e.message} (fail-open, keep alive)`);
      }
    }

    if (stale) {
      const isStageMode2 = process.env.KUROTAN_STAGE_MODE === '1';

 // Stop タイマーが有効な間は transcript-stale でクローズしない (KT-BUG: transcript-stale-too-short)。
 // Stop 受信後は Claude Code がユーザー入力待ちになり transcript の更新が止まる。
 // この状態で transcript-stale を発火させると 30 分以内にマスコットが消える。
 // Stop タイマー（最終安全網）に任せてここではスキップする。
      if (isStageMode2 && stageStopTimers.has(sessionId)) {
 // transcript_path が stale だが Stop タイマーが生きている: 監視を継続
        writeMainLog('transcript-stale-suppressed', sessionId, stageMascotStore.has(sessionId),
          `${reason} (suppressed: stop-timer-active)`);
        continue;
      }
      if (!isStageMode2 && stopTimers.has(sessionId)) {
        writeMainLog('transcript-stale-suppressed', sessionId, sessionWindows.has(sessionId),
          `${reason} (suppressed: stop-timer-active)`);
        continue;
      }

      writeMainLog('transcript-stale', sessionId, isStageMode2 ? stageMascotStore.has(sessionId) : sessionWindows.has(sessionId), reason);
 // §6.7: delete 前に jsonlPath を取得して stageHandleSessionEnd へ渡す
      const staleJsonlPath = sessionTranscriptPaths.get(sessionId) || null;
      sessionTranscriptPaths.delete(sessionId);
      if (isStageMode2) {
        const ts = stageStopTimers.get(sessionId);
        if (ts) { clearTimeout(ts); stageStopTimers.delete(sessionId); }
        stageHandleSessionEnd(sessionId, { trackForRespawn: true, jsonlPath: staleJsonlPath });
      } else {
        const t = stopTimers.get(sessionId);
        if (t) { clearTimeout(t); stopTimers.delete(sessionId); }
        handleSessionEnd(sessionId, { reason: 'transcript-stale' });
      }
    }
  }

 // §6.7: despawn 済みセッションの transcript 復帰検知 → respawn
  for (const [sid, info] of recentlyClosedSessions.entries()) {
 // jsonl mtime チェック (TTL 判定にも使う)
    let mtime;
    try {
      mtime = fs.statSync(info.jsonlPath).mtimeMs;
    } catch (_) {
 // ファイル消失等 → 追跡終了 (ファイルが無ければ復帰は起きない)
      recentlyClosedSessions.delete(sid);
      continue;
    }
 // mtime ベース TTL: ファイルが 24h 以上更新されていなければゾンビ判定 → 追跡終了
    if (now - mtime > RECENTLY_CLOSED_TTL_MS) {
      recentlyClosedSessions.delete(sid);
      continue;
    }
 // TRANSCRIPT_IDLE_MS 以内に更新あり → active 復帰と判定
    if (now - mtime <= TRANSCRIPT_IDLE_MS) {
 // 既に store に居る (別経路で復活済み) → スキップ
      if (stageMascotStore.has(sid)) {
        recentlyClosedSessions.delete(sid);
        continue;
      }
 // Step 3: Stage Window 健全性チェック + 再生成
      if (!stageWindow || stageWindow.isDestroyed()) {
        writeMainLog('respawn-stage-window-recreate', sid, false,
          'stageWindow null or destroyed at respawn — recreating');
        createStageWindow();
 // did-finish-load ハンドラが 200ms 後に mascot-add を再送するため
 // ここでは stageMascotStore への登録のみ行い早期リターン。
 // (stageWindow 再生成直後に sendToStage しても届かないため)
        const meta2 = info.mascotMeta;
        const resolvedPos2 = resolveRespawnPosition(sid, meta2);
        const ms2 = {
          sessionId: sid,
          sessionLabel: computeSessionLabel(sid, meta2.cwd, info.jsonlPath),
          cwd: meta2.cwd,
          model: meta2.model,
          position: resolvedPos2,
          hueIndex: meta2.hueIndex,
          badgeIndex: meta2.badgeIndex,
          state: 'idle',
        };
        stageMascotStore.set(sid, ms2);
        sessionTranscriptPaths.set(sid, info.jsonlPath);
        recentlyClosedSessions.delete(sid);
        writeMainLog('mascot-respawn-from-active-transcript', sid, true,
          `closedAt=${info.closedAt} mtimeAge=${now - mtime}ms stage-recreated=true`);
        continue;
      }

 // Step 1: lastPositions を再読み込みして最新座標を取得、sanity-check を適用
      const meta = info.mascotMeta;
      const resolvedPos = resolveRespawnPosition(sid, meta);

      const ms = {
        sessionId: sid,
        sessionLabel: computeSessionLabel(sid, meta.cwd, info.jsonlPath),
        cwd: meta.cwd,
        model: meta.model,
        position: resolvedPos,
        hueIndex: meta.hueIndex,
        badgeIndex: meta.badgeIndex,
        state: 'idle',
      };
      stageMascotStore.set(sid, ms);
      sendToStage('kurotan:mascot-add', buildMascotAddPayload(ms));
 // transcript_path を再登録して以降の stale 監視を継続
      sessionTranscriptPaths.set(sid, info.jsonlPath);
      recentlyClosedSessions.delete(sid);
      writeMainLog('mascot-respawn-from-active-transcript', sid, true,
        `closedAt=${info.closedAt} mtimeAge=${now - mtime}ms pos=x${resolvedPos.x}y${resolvedPos.y}`);
    }
  }
}

/**
 * アプリ起動後に transcript mtime 監視ポーリングを開始する。
 * app.whenReady() 完了後に呼ぶ。
 */
function setupTranscriptWatch() {
  const interval = setInterval(checkTranscriptMtimes, TRANSCRIPT_CHECK_INTERVAL_MS);
  if (interval.unref) interval.unref();
}

// ─── Stop auto-cleanup タイマー ────────────────────────────────
/**
 * Stop 受信後に一定時間経過したら handleSessionEnd を自動呼び出しする。
 * Claude Code が SessionEnd を発火しない場合 (正常終了・プロセスキル等) の
 * セーフティネット。
 *
 * - Stop: タイマーをリセットして新規セット
 * - SessionEnd: タイマーをキャンセル（公式が発火した場合）
 * - その他: 何もしない
 */
function bumpSessionTimer(sessionId, payload) {
 // 既存タイマーをクリア
  const old = stopTimers.get(sessionId);
  if (old) clearTimeout(old);

  const event = payload.event || payload.hook_event_name || '';

  if (event === 'Stop') {
 // config.cleanupTimeoutMs が ENV より優先 (§実装仕様)
    const timeoutMs = (runtimeConfig && runtimeConfig.cleanupTimeoutMs)
      ? runtimeConfig.cleanupTimeoutMs
      : STOP_AUTO_CLEANUP_MS;
    const t = setTimeout(() => {
      stopTimers.delete(sessionId);
      writeMainLog('Stop-auto-cleanup', sessionId, sessionWindows.has(sessionId), 'close');
      handleSessionEnd(sessionId, { reason: 'auto-cleanup', source: 'stop-timeout' });
    }, timeoutMs);
    stopTimers.set(sessionId, t);
  } else if (event === 'SessionEnd') {
 // 公式 SessionEnd が届いた場合はタイマー不要
    stopTimers.delete(sessionId);
  }
}

// ─── イベント処理 ──────────────────────────────────────────────
function handleEvent(payload) {
 // Stage Window モードはすべて stageHandleEvent に委譲
  if (process.env.KUROTAN_STAGE_MODE === '1') {
    stageHandleEvent(payload);
    return;
  }

 // 以下は旧経路 (KUROTAN_LEGACY_MODE=1 または KUROTAN_STAGE_MODE 未設定)
 // Claude Code hooks は hook_event_name キーで送信する。
 // 内部イベントは event キーを使う。両方を参照してフォールバック。
  const event = payload.event || payload.hook_event_name || '';
  const sessionId = payload.session_id || '';
  const sessionExists = sessionWindows.has(sessionId);

 // transcript_path mtime 監視用に保存（__welcome__ と空文字パスは対象外 / KT-G6-11 fail-open）
  if (sessionId && sessionId !== WELCOME_SESSION_ID && payload._kurotanTranscriptPath) {
    sessionTranscriptPaths.set(sessionId, payload._kurotanTranscriptPath);
  }

 // Stop auto-cleanup タイマーを管理する（Stop / SessionEnd で動作）
  if (sessionId) bumpSessionTimer(sessionId, payload);

  switch (event) {
    case 'SessionStart': {
      const action = sessionExists ? 'forward' : 'create';
      writeMainLog(event, sessionId, sessionExists, action);
      handleSessionStart(sessionId, payload);
      break;
    }
    case 'SessionEnd':
      writeMainLog(event, sessionId, sessionExists, sessionExists ? 'forward' : 'ignore');
      handleSessionEnd(sessionId, payload);
      break;
    default:
 // その他のイベントは該当ウィンドウへ転送
      writeMainLog(event, sessionId, sessionExists, sessionExists ? 'forward' : 'create');
      forwardToSession(sessionId, payload);
      break;
  }
}

function handleSessionStart(sessionId, payload) {
  if (!sessionId) return;
  if (sessionWindows.has(sessionId)) {
 // 既存セッション: 転送のみ
    forwardToSession(sessionId, payload);
    return;
  }
 // 新規ウィンドウ生成
  createMascotWindow(sessionId, payload);
}

function handleSessionEnd(sessionId, payload) {
 // Stop auto-cleanup タイマーが残っていればキャンセル（二重 close 防止）
  const t = stopTimers.get(sessionId);
  if (t) {
    clearTimeout(t);
    stopTimers.delete(sessionId);
  }
  forwardToSession(sessionId, payload);
 // farewell → 3 秒後に close（renderer 側でアニメ後に ipcRenderer.send('kurotan:window-close') を送る）
 // フォールバック: 5 秒後に強制クローズ
  setTimeout(() => {
    closeMascotWindow(sessionId);
  }, 5000);
}

function forwardToSession(sessionId, payload) {
  if (!sessionId) {
 // session_id なしのイベントは全ウィンドウへ broadcast（Stop 等）
    for (const [, w] of sessionWindows) {
      if (!w.isDestroyed()) {
        w.webContents.send('kurotan:event', payload);
      }
    }
    return;
  }
  let win = sessionWindows.get(sessionId);
  if (!win) {
 // SessionStart 未受信のセッション（hooks 後付けインストール等）でも自動でウィンドウ生成
    handleSessionStart(sessionId, payload);
    win = sessionWindows.get(sessionId);
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('kurotan:event', payload);
  }
}

// ─── BrowserWindow 管理 ────────────────────────────────────────
function getInitialPosition(sessionIndex) {
 // 画面右下タスクバー直上に配置（workArea 下端 - 8px マージン）
  const primaryDisplay = displayRegistry.getPrimary();
  const { width, height } = primaryDisplay.workAreaSize;
  const baseX = width - WINDOW_WIDTH - 40;
  const baseY = height - WINDOW_HEIGHT;
  const offset = sessionIndex * 52;
  return {
    x: baseX - offset,
    y: baseY,
  };
}

function createMascotWindow(sessionId, payload) {
  const sessionIndex = sessionWindows.size;
  const pos = getInitialPosition(sessionIndex);

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
 // backgroundThrottling-fix: MascotWindow (旧モード) は kurotan:event 等の push IPC を受信する。
 // focusable: false のため常に「バックグラウンド」扱いになり throttling があると反映が遅延する。
 // 旧モードは 退役予定だが、それまでは Stage Window と同様に無効化する。
 // 0.9.32: kurotan:cursor は撤廃済み。
      backgroundThrottling: false,
    },
  });

  win.loadFile(RENDERER_HTML);

 // alwaysOnTop をコンストラクタ指定 (normal level) より強い 'screen-saver' level で強化する。
 // Electron の alwaysOnTop: true 単体は "normal" level 相当であり、VSCode 等の通常ウィンドウ
 // より下に潜ることがある。setAlwaysOnTop(true, 'screen-saver') により OS レベルで最前面を保証する。
  win.setAlwaysOnTop(true, 'screen-saver');
 // 全仮想デスクトップ・全ワークスペースで表示を維持する（macOS / Linux 対応時のため先行追加）
  win.setVisibleOnAllWorkspaces(true);

 // 初期イベントを renderer が準備できてから送信
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('kurotan:event', payload);
  });

  sessionWindows.set(sessionId, win);

  win.on('closed', () => {
    sessionWindows.delete(sessionId);
  });

 // 0.9.32: マウスカーソル追従コード削除 (renderer 未実装で効果ゼロ、CPU 浪費のみ)
}

function closeMascotWindow(sessionId) {
  const win = sessionWindows.get(sessionId);
  if (win && !win.isDestroyed()) {
    win.close();
  }
  sessionWindows.delete(sessionId);
  sessionTranscriptPaths.delete(sessionId);
}

// ─── IPC ハンドラ ──────────────────────────────────────────────
function setupIpc() {
 // renderer → main: ウィンドウクローズ要求（farewell アニメ完了後）
  ipcMain.on('kurotan:window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
  });

 // renderer → main: 再接続要求（offline 状態からの復旧試行）
  ipcMain.on('kurotan:reconnect', async (event) => {
 if (listeningPort) return; // 既に接続済み
    const result = await findAvailablePort();
    if (result) {
      listeningPort = result.port;
      httpServer = result.server;
      setupHttpServer(httpServer);
      writeRuntime(listeningPort);
      isOffline = false;
 // 全 renderer に復旧通知
      for (const [, w] of sessionWindows) {
        if (!w.isDestroyed()) {
          w.webContents.send('kurotan:online', { port: listeningPort });
        }
      }
    }
  });

 // renderer → main: Stage Window の click-through 切替（/2）
 // payload: { ignore: boolean }
  ipcMain.on('kurotan:set-ignore-mouse', (event, data) => {
    const win = stageWindow;
    if (!win || win.isDestroyed()) return;
    const ignore = !!(data && data.ignore);
    win.setIgnoreMouseEvents(ignore, { forward: true });
  });

 // renderer → main: ドラッグ完了時の位置保存（ / §9.2.1）
 // payload: { sessionId, x, y }
  ipcMain.on('kurotan:position-update', (_event, data) => {
    if (!data || !data.sessionId) return;
    const ms = stageMascotStore.get(data.sessionId);
    if (ms) {
      ms.position = { x: data.x, y: data.y };
    }

 // config.json の lastPositions に永続化 (§9.2.1 : 新フィールド書き込み)
 // 読み込みは旧 (x, y) 優先のまま (で切替)
    try {
 // 0.9.28 fix: target display (= 現在の stage 表示先) 基準で displayKey/scaleFactor を記録。
 // primary 固定だと非 primary ステージで保存値が混乱する。
      const targetDisp = getTargetDisplay();
      const displayKey = displayRegistry.getDisplayKey(targetDisp);
      const wa = targetDisp.workArea;
 // data.x / data.y は drag controller (e.clientX) の viewport-relative 座標。
 // relX / relY も viewport-relative と同値 (target display 内での相対座標)。
      const relX = data.x;
      const relY = data.y;
      const scaleFactor = targetDisp.scaleFactor || 1.0;

 // 0.9.26: lastPositions のキーを sessionId に変更 (/rename で sessionLabel が
 // 動的更新されると旧 lastPositions[oldLabel] の位置が orphan 化するため)。
 // 旧 sessionLabel キーも互換のため同時書き込み (旧データ読み込み経路への保険)。
      const posEntry = {
        x: data.x,
        y: data.y,
        displayKey,
        relX,
        relY,
        scaleFactor,
      };
      const current = loadConfig();
      current.lastPositions = current.lastPositions || {};
      current.lastPositions[data.sessionId] = posEntry;
 // sessionLabel をセカンダリキーとしても保存 (旧バージョン互換)
      const sessionLabelKey = ms ? ms.sessionLabel : '';
      if (sessionLabelKey && sessionLabelKey !== data.sessionId) {
        current.lastPositions[sessionLabelKey] = posEntry;
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
    } catch (e) {
 // 書き込み失敗はログのみ (副作用ゼロ原則)
      writeMainLog('position-update-save-error', data.sessionId, false, String(e));
    }

    writeMainLog('position-update', data.sessionId, stageMascotStore.has(data.sessionId), `x=${data.x} y=${data.y}`);
  });

 // renderer → main: 右クリックメニュー要求（）
 // payload: { sessionId, x, y }
  ipcMain.on('kurotan:show-context-menu', (_event, data) => {
    if (!data) return;
    const { sessionId } = data;
    const { Menu: ElMenu } = require('electron');
    const menu = ElMenu.buildFromTemplate([
      {
        label: i18n.t('context.menu.session_info'),
        click: () => {
          const ms = stageMascotStore.get(sessionId);
          if (!ms) return;
          sendToStage('kurotan:mascot-update', {
            sessionId,
            bubbleText: `${ms.cwd || sessionId} | ${ms.model || ''}`,
            pinBubble: true,
          });
        },
      },
      {
        label: i18n.t('context.menu.hide_session'),
        click: () => sendToStage('kurotan:mascot-update', { sessionId, hidden: true }),
      },
      { type: 'separator' },
      {
        label: i18n.t('context.menu.realign'),
        click: () => {
          let i = 0;
          const { width, height } = displayRegistry.getPrimary().workAreaSize;
          for (const [sid, ms] of stageMascotStore) {
            const margin = 40;
            const offset = i * 40;
            ms.position = { x: width - 320 - margin - offset, y: height - 220 - margin - offset };
            sendToStage('kurotan:mascot-update', { sessionId: sid, position: ms.position });
            i++;
          }
        },
      },
      {
        label: i18n.t('context.menu.close_all'),
        click: () => {
          for (const [sid] of [...stageMascotStore]) {
            stageHandleSessionEnd(sid);
          }
          updateTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: permissionOverlay.isVisible()
          ? i18n.t('context.menu.overlay_hide')
          : i18n.t('context.menu.overlay_show'),
        click: () => {
          permissionOverlay.toggle();
          writeMainLog('overlay-toggle', sessionId, false, `visible=${permissionOverlay.isVisible()}`);
        },
      },
      { type: 'separator' },
      {
        label: i18n.t('context.menu.restart'),
        click: () => {
          writeMainLog('mascot-context-restart', sessionId, false, 'user-initiated');
          app.relaunch();
          app.quit();
        },
      },
      {
        label: i18n.t('context.menu.exit'),
        click: () => app.quit(),
      },
    ]);
    menu.popup();
  });

 // ─── 設定画面 IPC ハンドラ (§8 / §9.2) ───────────────────────────

  ipcMain.handle('kurotan:settings:get', () => {
    const cfg = loadConfig();
    cfg._hooksInstalled = checkHooksInstalled();
 cfg._appVersion = app.getVersion(); // 0.9.32: 設定画面 About に表示
 // 0.9.41: i18n 辞書を同梱 (renderer の contextIsolation 環境では require 不可のため)
    try {
      const localesDir = path.join(__dirname, '..', 'i18n', 'locales');
      const curLang = i18n.getCurrentLang();
      const curPath = path.join(localesDir, `${curLang}.json`);
      const jaPath = path.join(localesDir, 'ja.json');
      cfg._i18nDict = fs.existsSync(curPath) ? JSON.parse(fs.readFileSync(curPath, 'utf8')) : {};
      cfg._i18nFallbackDict = fs.existsSync(jaPath) ? JSON.parse(fs.readFileSync(jaPath, 'utf8')) : {};
      cfg._i18nLang = curLang;
    } catch (e) {
      cfg._i18nDict = {};
      cfg._i18nFallbackDict = {};
      cfg._i18nLang = 'ja';
    }
    return cfg;
  });

  ipcMain.handle('kurotan:settings:save', (_event, partial) => {
    if (!partial || typeof partial !== 'object') return;
    const next = saveConfig(partial);
    applyConfig(next);
 // nightMode 変更が含まれる場合は即時 broadcast（applyConfig 内でも呼ぶが、
 // stageWindow が did-finish-load 後に確立済みである保証のためここでも明示送信）
    if (partial.behavior && partial.behavior.nightMode !== undefined) {
      broadcastNightMode(next.behavior && next.behavior.nightMode === true);
    }
 // artStyle 変更が含まれる場合は即時 broadcast
    if (partial.artStyle !== undefined) {
      broadcastArtStyle(next.artStyle || 'sd');
    }
 // bubble 変更が含まれる場合は即時 broadcast
    if (partial.bubble !== undefined) {
      broadcastBubbleStyle(next.bubble || {});
    }
 // contextMotion.enabled 変更時は全 renderer へ broadcast
    if (partial.contextMotion !== undefined) {
      broadcastContextMotion(next.contextMotion || {});
    }
 // 0.9.41: language 変更時は i18n を切り替えて全 renderer に broadcast
    if (partial.language !== undefined) {
      try {
        i18n.init(partial.language || 'auto');
        broadcastLocaleChange();
 // tray menu を再構築 (新ロケールで再描画)
        try { updateTrayMenu(); } catch (_e) { /* tray 未初期化時は無視 */ }
        writeMainLog('locale-change', '', false, `lang=${i18n.getCurrentLang()}`);
      } catch (e) {
        writeMainLog('locale-change-error', '', false, String(e));
      }
    }
  });

  ipcMain.handle('kurotan:settings:install-hooks', () => {
    return runInstallerCli(false);
  });

  ipcMain.handle('kurotan:settings:uninstall-hooks', () => {
    return runInstallerCli(true);
  });

 // renderer → main: 許可/拒否決定 (permission bridge 応答)
 // payload: { requestId, decision, durationMs?, source? }
  ipcMain.on('kurotan:permission-decision', (_event, data) => {
    if (!data || !data.requestId) return;
    const entry = pendingPermissions.get(data.requestId);
 if (!entry) return; // タイムアウト済み or 不正な requestId
    const decision = data.decision === 'allow' || data.decision === 'deny' ? data.decision : 'ask';
    const durationMs = typeof data.durationMs === 'number' ? data.durationMs
      : (entry.receivedAt ? Date.now() - entry.receivedAt : -1);
    const source = data.source || 'click';
    writeMainLog('permission-decision', '', false, `requestId=${data.requestId} decision=${decision} source=${source}`);
    permissionLog.append({ decision, durationMs, source });
    entry.resolve(decision);
  });

 // 0.9.32: kurotan:state-change ハンドラ削除 (mouseFollow 撤廃に伴いカーソル制御不要)

 // DOM dump レスポンス受信 (renderer → main → HTTP レスポンス)
  ipcMain.on('kurotan:debug-dom-dump-response', (_event, data) => {
    const cb = pendingDomDumps[data.requestId];
    if (cb) {
      cb(data);
      delete pendingDomDumps[data.requestId];
    }
  });
}

// ─── 設定ウィンドウ ────────────────────────────────────────────
let settingsWindow = null;

function createSettingsWindow() {
 // 多重起動防止
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 320,
    height: 560,
    frame: true,
    resizable: false,
    alwaysOnTop: false,
    skipTaskbar: false,
    title: 'くろたん 設定',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));

 // メニューバー非表示（Windows 標準タイトルバーのみ残す）
  settingsWindow.setMenuBarVisibility(false);

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

/**
 * install-hooks.js の install() または uninstall() を直接呼び出して結果を返す。
 * spawn('node') は Electron アプリの PATH に node がない環境で失敗するため、
 * require() + 直接呼び出し方式に変更。
 * 配布版 (app.isPackaged) では process.resourcesPath 配下の unpacked JS を使用する。
 * 開発版では __dirname 起点の相対パスを使用する。
 * @param {boolean} doUninstall - true なら uninstall()
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function runInstallerCli(doUninstall) {
  return new Promise((resolve) => {
    try {
      const installerPath = app.isPackaged
        ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'installer', 'install-hooks.js')
        : path.join(__dirname, '..', 'installer', 'install-hooks.js');
      const { install: installHooks, uninstall: uninstallHooks } = require(installerPath);
      if (doUninstall) {
        uninstallHooks();
      } else {
        installHooks();
      }
      resolve({ code: 0, stdout: '', stderr: '' });
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: e.message });
    }
  });
}

// ─── Stage Window (KUROTAN_STAGE_MODE=1) ───────────────────────
/** 全画面透過 Stage Window の単一インスタンス */
let stageWindow = null;

// ─── : MascotState ストア ─────────────────────────────────
/**
 * sessionId → MascotState のマップ（Stage Window モード用）
 * MascotState: { sessionId, cwd, model, position, hueIndex, badgeIndex, state }
 */
const stageMascotStore = new Map();

// 0.9.71: 親マスコットの召喚セリフ throttle (sessionId → last fired epoch ms)
const lastParentCallHelpTime = new Map();

/**
 * 同一 cwd 内の hueIndex / badgeIndex を計算する。
 * cwd 末尾セグメントが同じセッションを同一グループとみなす。
 * @param {string} cwd
 * @returns {{ hueIndex: number, badgeIndex: number }}
 */
function calcHueBadge(cwd) {
  const label = cwd ? cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || cwd : '';
 const HUE_STEPS = [0, 30, 60, 90, 120]; // 仕様 §6.2.1
  let count = 0;
  for (const [, ms] of stageMascotStore) {
    const msLabel = ms.cwd ? ms.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || ms.cwd : '';
    if (msLabel === label) count++;
  }
 const seq = count; // 0-indexed: 0 = 1匹目
  const hueIndex = seq < HUE_STEPS.length ? HUE_STEPS[seq] : 0;
 const badgeIndex = seq + 1; // 1-indexed
  return { hueIndex, badgeIndex };
}

/**
 * Stage Window 初期配置座標を計算する（右下から斜めオフセット）。
 * @returns {{ x: number, y: number }}
 */
function getStageInitialPosition() {
 // B 案: 選択 display の workArea を使用する
 // 0.9.28 fix: viewport-relative 座標を返す (renderer setPosition → translate3d は
 // position:fixed の viewport 基準のため、wa.x/wa.y を加算すると非 primary ディスプレイで
 // マスコットが意図しない場所に飛ぶ)。
  const targetDisp = getTargetDisplay();
  const wa = targetDisp.workArea;
  const W = 320;
  const H = 220;
  const count = stageMascotStore.size;
  const offset = count * 52;
  return {
    x: wa.width - W - 40 - offset,
    y: wa.height - H,
  };
}

/**
 * B 案: config.json の stageDisplayId に対応する display を返す。
 * stageDisplayId が null / 未設定 / 対応 display なしの場合は primary を返す。
 * @returns {Electron.Display}
 */
function getTargetDisplay() {
  try {
    const cfg = loadConfig();
    const id = cfg.stageDisplayId;
    if (id != null) {
      const found = screen.getAllDisplays().find((d) => d.id === id);
      if (found) return found;
      writeMainLog('stage-display-not-found', '', false, `stageDisplayId=${id} → fallback to primary`);
    }
  } catch (_e) { /* config 読み込み失敗は無視 */ }
  return screen.getPrimaryDisplay();
}

/**
 * B 案: ステージモニタを変更する。
 * config.json に保存 → Stage Window を destroy → 新 display で再生成 → 全マスコットを再描画する。
 * @param {number} displayId
 */
function setStageDisplayId(displayId) {
  saveConfig({ stageDisplayId: displayId });
  writeMainLog('set-stage-display', '', false, `displayId=${displayId}`);

  if (stageWindow && !stageWindow.isDestroyed()) {
    stageWindow.destroy();
    stageWindow = null;
  }

  createStageWindow();

 // 既存マスコットを全て再描画 (did-finish-load ハンドラ内で再送するため 300ms 待機)
 // did-finish-load で同様の処理が走るため、ここでは追加処理不要
}

/**
 * 全ディスプレイの bounds を包む union 矩形を計算する。
 * 診断ログ用として保持 (B 案では Stage Window の生成には使わない)。
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function computeAllDisplaysUnion() {
  const displays = displayRegistry.getAllDisplays();
  if (!displays || displays.length === 0) {
 // フォールバック: primary の workAreaSize を使う
    const { width, height } = displayRegistry.getPrimary().workAreaSize;
    return { x: 0, y: 0, width, height };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    const { x, y, width, height } = d.bounds;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + width > maxX) maxX = x + width;
    if (y + height > maxY) maxY = y + height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 全画面透過 Stage Window を生成する（ / B 案: 選択 1 display 限定）。
 * KUROTAN_STAGE_MODE=1 環境変数が設定された場合のみ使用。
 * 旧 createMascotWindow 経路には一切影響しない。
 *
 * B 案: config.json の stageDisplayId で選択された単一 display の workArea を使用する。
 * stageDisplayId が null または対応する display が見つからない場合は primary を使用する。
 * これにより Electron の transparent BrowserWindow 幅上限 (1 画面幅) 制約内で安定動作する。
 */
function createStageWindow() {
  const targetDisplay = getTargetDisplay();
  const wa = targetDisplay.workArea;

  const win = new BrowserWindow({
    width: wa.width,
    height: wa.height,
    x: wa.x,
    y: wa.y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
 // backgroundThrottling-fix: Stage Window は hooks 発火のたびに kurotan:mascot-update /
 // kurotan:context-level 等の push IPC を大量受信する。focusable: false のため
 // フォーカスを取得できず常に「バックグラウンド」扱いになるため、throttling を
 // 無効化しないとマスコットのリアルタイム反応が遅延する。
 // Stage Window は透過全画面の軽量 DOM のみのため CPU コストは無視できる。
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);

 // 起動直後は全領域 click-through（forward: true でマウス座標は renderer に届く）
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'mascot-stage.html'));

 // ─── renderer クラッシュ自動復旧 ──────────
  win.webContents.on('render-process-gone', (_event, details) => {
    writeMainLog('render-process-gone', '', false, `reason=${details.reason} exitCode=${details.exitCode}`);
 // renderer が落ちたら 1 秒後にリロード
    setTimeout(() => {
      if (stageWindow && !stageWindow.isDestroyed()) {
        stageWindow.reload();
      }
    }, 1000);
  });

 // did-finish-load 後にセッション復元（クラッシュリロード後も含む）
  win.webContents.on('did-finish-load', () => {
 // did-finish-load は HTML パース完了だが renderer JS の DOMContentLoaded コールバック
 // (setupIpc / onArtStyleChange 登録) は非同期で後続する。
 // 即送信するとリスナー未登録のままメッセージがドロップされるため 200ms 遅延させる。
    setTimeout(() => {
      if (win.isDestroyed()) return;
 // B 案: kurotan:stage-bounds 送信は廃止 (renderer は CSS 100vw/100vh で対応)
 // 現在の nightMode を renderer に送信（起動時 / クラッシュ復旧時）
      win.webContents.send('kurotan:night-mode', {
        nightMode: !!(runtimeConfig && runtimeConfig.behavior && runtimeConfig.behavior.nightMode),
      });
 // 現在の artStyle を renderer に送信（起動時 / クラッシュ復旧時）
      win.webContents.send('kurotan:art-style-change', {
        artStyle: (runtimeConfig && runtimeConfig.artStyle) || 'sd',
      });
 // 0.9.41: 現在の i18n 辞書を renderer に送信 (起動時 / クラッシュ復旧時)
      try {
        const localesDir = path.join(__dirname, '..', 'i18n', 'locales');
        const curLang = i18n.getCurrentLang();
        const curPath = path.join(localesDir, `${curLang}.json`);
        const jaPath = path.join(localesDir, 'ja.json');
        const dict = fs.existsSync(curPath) ? JSON.parse(fs.readFileSync(curPath, 'utf8')) : {};
        const fallbackDict = fs.existsSync(jaPath) ? JSON.parse(fs.readFileSync(jaPath, 'utf8')) : {};
        win.webContents.send('kurotan:locale-changed', { lang: curLang, dict, fallbackDict });
      } catch (_e) { /* ignore */ }

      if (stageMascotStore.size === 0) return;
 // 全セッションを mascot-add で再送 (0.9.26: buildMascotAddPayload helper で統一)
      for (const [, ms] of stageMascotStore) {
        win.webContents.send('kurotan:mascot-add', buildMascotAddPayload(ms));
      }
 // 状態も再送
      for (const [sessionId, ms] of stageMascotStore) {
        win.webContents.send('kurotan:mascot-update', {
          sessionId,
          state: ms.state || 'idle',
        });
      }
    }, 200);
  });

  win.on('closed', () => {
    stageWindow = null;
  });

  stageWindow = win;

 // ─── Step 1: 診断ログ (§9.2.2 完全非表示バグ診断) ──────────────
 // ─── 診断ログ: createStageWindow 直後に選択 display / actual getBounds / 全ディスプレイ情報を記録 ───
  try {
 const ub = computeAllDisplaysUnion(); // 診断用のみ (B 案では Window には使わない)
    const actualBounds = win.getBounds();
    const allDisplays = displayRegistry.getAllDisplays();
    const displaysShort = allDisplays.map((d) => {
      const b = d.bounds;
      return `{x:${b.x},y:${b.y},w:${b.width},h:${b.height},sf:${d.scaleFactor || 1}}`;
    }).join(' ');
    writeMainLog('stage-bounds-debug', '', false,
      `target=display:${targetDisplay.id}` +
      ` wa={x:${wa.x},y:${wa.y},w:${wa.width},h:${wa.height}}` +
      ` actual={x:${actualBounds.x},y:${actualBounds.y},w:${actualBounds.width},h:${actualBounds.height}}` +
      ` union={x:${ub.x},y:${ub.y},w:${ub.width},h:${ub.height}}` +
      ` displays=${allDisplays.length} [${displaysShort}]`);
  } catch (_e) { /* 診断ログ失敗は無視 */ }

 // B 案: display-changed 時の setBounds / kurotan:stage-bounds 送信は廃止。
 // Stage Window の再生成は config 変更 (stageDisplayId 変更) 時のみ行う。
 // display の追加・削除による自動追従は行わない。

  return win;
}

/** Stage Window の webContents に安全に送信する */
function sendToStage(channel, payload) {
  if (!stageWindow || stageWindow.isDestroyed()) return;
  stageWindow.webContents.send(channel, payload);
}

/**
 * 専用の小型 BrowserWindow で permission ダイアログを表示する。
 * IPC 'permission-dialog:decision' を受けたら pendingPermissions を resolve する。
 *
 * @param {string} requestId
 * @param {string} sessionId
 * @param {string} toolName
 * @param {object} toolInput
 */
function createPermissionDialog(requestId, sessionId, toolName, toolInput) {
 // マスコット位置を基準に上へポップアップ、なければ画面右下 fallback
  let x, y;
  try {
    const { width: sw, height: sh } = displayRegistry.getPrimary().workAreaSize;
    const ms = stageMascotStore.get(sessionId);
    if (ms && ms.position) {
      x = Math.round(ms.position.x);
      y = Math.round(ms.position.y - 90);
 // 画面外クランプ
      x = Math.max(0, Math.min(x, sw - 320));
      y = Math.max(0, Math.min(y, sh - 80));
    } else {
 // fallback: 画面右下
      x = Math.max(0, sw - 340);
      y = Math.max(0, sh - 120);
    }
 // 暫定: 既存ダイアログ数 × 50px の y オフセットで縦に並べる
    const queueOffset = pendingPermissions.size > 1 ? (pendingPermissions.size - 1) * 50 : 0;
    y = Math.max(0, Math.min(y - queueOffset, sh - 80));
  } catch (e) {
    x = 200;
    y = 200;
  }

  const dlg = new BrowserWindow({
    width: 320,
    height: 80,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'permission-dialog-preload.js'),
    },
  });

  dlg.loadFile(path.join(__dirname, '..', 'renderer', 'permission-dialog.html'));

 // renderer が準備できたら初期化データを送信
  dlg.webContents.once('did-finish-load', () => {
    dlg.webContents.send('permission-dialog:init', { requestId, toolName, toolInput });
  });

 // renderer からの決定を受け取る
 // ipcMain.on + sender チェックで複数同時ダイアログの取りこぼしを防ぐ
  const onDecision = (event, data) => {
 // このウィンドウの webContents からのメッセージのみ処理
    if (event.sender !== dlg.webContents) return;
    const entry = pendingPermissions.get(requestId);
    if (entry) {
      const decision = data.decision === 'allow' || data.decision === 'deny' ? data.decision : 'ask';
      writeMainLog('permission-dialog-decision', sessionId, stageMascotStore.has(sessionId),
        `requestId=${requestId} decision=${decision}`);
      entry.resolve(decision);
    }
    cleanup();
  };

  const cleanup = () => {
    ipcMain.removeListener('permission-dialog:decision', onDecision);
    if (!dlg.isDestroyed()) dlg.close();
  };

  ipcMain.on('permission-dialog:decision', onDecision);

 // ウィンドウが先に閉じられた場合は 'ask' で解決
  dlg.on('closed', () => {
    ipcMain.removeListener('permission-dialog:decision', onDecision);
    const entry = pendingPermissions.get(requestId);
    if (entry) {
      writeMainLog('permission-dialog-closed', sessionId, stageMascotStore.has(sessionId),
        `requestId=${requestId} decision=ask(window-closed)`);
      entry.resolve('ask');
    }
  });

  writeMainLog('permission-dialog-created', sessionId, stageMascotStore.has(sessionId),
    `requestId=${requestId} tool=${toolName} x=${x} y=${y}`);
}

// ─── §5.12 マスコット登場モーション 抽選ロジック (2026-05-03 新設) ────────────────

/** 直近のエントリアニメ ID (プロセス再起動でリセット。永続化しない) */
let lastEntryMotion = null;

/**
 * §5.12.6 重み付き抽選で solo モーション (A/B/C/E) を選ぶ。
 * @param {object} weights - { A: number, B: number, C: number, E: number }
 * @param {string|null} prevId - 直前のモーション ID (直前回避用)
 * @param {boolean} disableRepeat - true の場合、直前と同じモーションを回避する
 * @returns {'A'|'B'|'C'|'E'}
 */
function pickSoloMotion(weights, prevId, disableRepeat) {
  const RAW = { A: 4, B: 3, C: 3, E: 2 };
 // §5.12.6.3 バリデーション: 負値は 0 に
  const w = {
    A: Math.max(0, (weights && typeof weights.A === 'number') ? weights.A : RAW.A),
    B: Math.max(0, (weights && typeof weights.B === 'number') ? weights.B : RAW.B),
    C: Math.max(0, (weights && typeof weights.C === 'number') ? weights.C : RAW.C),
    E: Math.max(0, (weights && typeof weights.E === 'number') ? weights.E : RAW.E),
  };
 // §5.12.6.3 全合計 0 → デフォルト
  if (w.A + w.B + w.C + w.E === 0) {
    w.A = RAW.A; w.B = RAW.B; w.C = RAW.C; w.E = RAW.E;
  }

 // §5.12.6.2 直前回避
  let candidates = ['A', 'B', 'C', 'E'];
  if (disableRepeat && prevId && candidates.includes(prevId)) {
    const remaining = candidates.filter((id) => id !== prevId);
 // 残り候補すべての重みが 0 でない場合のみ除外 (デッドロック防止)
    const remainingTotal = remaining.reduce((s, id) => s + w[id], 0);
    if (remainingTotal > 0) {
      candidates = remaining;
    }
 // remainingTotal === 0 の場合は candidates を変えず prevId を含めたまま続行
  }

 // 重み付きランダム抽選
  const total = candidates.reduce((s, id) => s + w[id], 0);
  let r = Math.random() * total;
  for (const id of candidates) {
    r -= w[id];
    if (r < 0) return id;
  }
  return candidates[candidates.length - 1];
}

/**
 * §5.12 エントリアニメ ID を決定する。
 * @param {number} count - 同時出現数
 * @param {string|null} prevId - 直前のモーション ID
 * @returns {'A'|'B'|'C'|'D'|'E'|null}
 */
function pickEntryAnimation(count, prevId) {
  const cfg = runtimeConfig || {};
  const mode = (() => {
    const valid = ['random', 'always-A', 'always-B', 'always-C', 'always-E', 'off'];
    return valid.includes(cfg.entryAnimationMode) ? cfg.entryAnimationMode : 'random';
  })();

 // §5.12.4 multi 出現 (N >= 2): E は solo only のため D 固定継続
  if (count >= 2) {
    if (mode === 'off') return null;
    if (mode === 'always-B') return 'B';
    if (mode === 'always-C') return 'C';
 // random / always-A / always-E → D (ウェーブ)
    return 'D';
  }

 // solo 出現 (count == 1)
  if (mode === 'off') return null;
  if (mode === 'always-A') return 'A';
  if (mode === 'always-B') return 'B';
  if (mode === 'always-C') return 'C';
  if (mode === 'always-E') return 'E';

 // random: A/B/C/E から重み付き抽選
  return pickSoloMotion(
    cfg.entryAnimationWeights,
    prevId,
    cfg.disableRepeatedEntryAnimation === true
  );
}

// ─── §5.12.5 同時出現バッチング (setImmediate 1 tick) ──────────────────────────

/** 現在バッチ中の pending エントリ */
let pendingEntries = [];

/**
 * SessionStart を 1 tick バッファに積み、同一 tick に来た複数エントリをまとめて flush する。
 * welcome セッションは flush 内で除外する。
 * @param {string} sessionId
 * @param {object} payload
 */
function batchSessionEntry(sessionId, payload) {
  pendingEntries.push({ sessionId, payload });
  if (pendingEntries.length === 1) {
    setImmediate(flushPendingEntries);
  }
}

/**
 * バッチを flush して登場モーション付き mascot-add を renderer へ送信する。
 */
function flushPendingEntries() {
  const batch = pendingEntries;
  pendingEntries = [];

 // welcome セッションを除外
  const realEntries = batch.filter((e) => e.sessionId !== WELCOME_SESSION_ID);
  if (realEntries.length === 0) return;

  const animId = pickEntryAnimation(realEntries.length, lastEntryMotion);
  if (animId) lastEntryMotion = animId;

  for (let i = 0; i < realEntries.length; i++) {
    const { sessionId, payload: _payload } = realEntries[i];
 // mascot-add は stageHandleSessionStart 内で送信済みなので、
 // ここでは _entryAnimation 付きの kurotan:mascot-update を追加送信する
    const delayMs = animId === 'D' ? i * 100 : 0;
    sendToStage('kurotan:mascot-update', {
      sessionId,
      _entryAnimation: { id: animId, delayMs },
    });
  }
}

/**
 * Stage Window モード: SessionStart を受信したときにマスコットを追加する。
 */
/**
 * respawn 時の位置解決ヘルパ。
 * - config.json の lastPositions を再読み込みして最新値を優先する (Step 1)
 * - sanity-check (sanitizeAndResetPosition) を必ず通す (Step 2)
 * - lastPositions に値がなければ mascotMeta.position → getStageInitialPosition() の順で fallback
 *
 * @param {string} sessionId
 * @param {{ cwd: string, position: { x: number, y: number } }} mascotMeta
 * @returns {{ x: number, y: number }}
 */
function resolveRespawnPosition(sessionId, mascotMeta) {
 // customTitle 経路を含めて sessionLabel を再構築
 // (旧バージョンで lp[customTitle] にしか保存していない位置データも復元できるよう)
  const transcriptPath = sessionTranscriptPaths.get(sessionId) || '';
  const sessionLabel = computeSessionLabel(sessionId, mascotMeta.cwd || '', transcriptPath);

 // config.json を再読み込み (sessionId 優先 / sessionLabel 互換)
  try {
    const cfg = loadConfig();
    const lp = cfg.lastPositions || {};
    const saved = lp[sessionId] || lp[sessionLabel];
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      const checked = sanitizeAndResetPosition(saved, sessionId, sessionLabel);
      writeMainLog('respawn-position-resolved', sessionId, true,
        `source=lastPositions x=${checked.x} y=${checked.y}`);
      return checked;
    }
  } catch (_e) { /* config 読み込み失敗は fallback へ */ }

 // fallback 1: mascotMeta.position (despawn 時のスナップショット)
  const fallback = mascotMeta.position;
  if (fallback && typeof fallback.x === 'number' && typeof fallback.y === 'number') {
    const checked = sanitizeAndResetPosition(fallback, sessionLabel);
    writeMainLog('respawn-position-resolved', sessionLabel, true,
      `source=mascotMeta x=${checked.x} y=${checked.y}`);
    return checked;
  }

 // fallback 2: Stage Window 内で空いている位置
  const initial = getStageInitialPosition();
  writeMainLog('respawn-position-resolved', sessionLabel, true,
    `source=initial x=${initial.x} y=${initial.y}`);
  return initial;
}

/**
 * B 案 lastPositions sanity-check
 * config.json に保存された座標が現在の選択 display workArea 内に収まっているか検証する。
 * 範囲外 (例: 旧マルチモニタ環境の物理座標がシングル画面に持ち込まれた) の場合は
 * 選択 display の中央下端にリセットして config.json に書き戻す。
 *
 * @param {{ x: number, y: number }} savedPos
 * @param {string} sessionLabel config.json のキー (ログ用)
 * @returns {{ x: number, y: number }} sanity 済みの物理座標
 */
function sanitizeAndResetPosition(savedPos, ...keys) {
 // keys は sessionId / sessionLabel 両方を受け取り、
 // lastPositions に存在する全 key の値を補正する (legacy key 取りこぼし回避)。
 // 0.9.28 fix: 座標は viewport-relative で扱う (絶対画面座標で比較すると
 // 非 primary ディスプレイで in-range 判定がズレてマスコットが飛ぶ)。
  const targetDisp = getTargetDisplay();
  const wa = targetDisp.workArea;
 const MARGIN = 100; // ギリギリでも誤リセットしないマージン (px)
  const inRange = (
    savedPos.x >= -MARGIN &&
    savedPos.x <= wa.width - MARGIN &&
    savedPos.y >= -MARGIN &&
    savedPos.y <= wa.height - MARGIN
  );

  if (inRange) return { x: savedPos.x, y: savedPos.y };

 // 範囲外 → 選択 display 中央下端にリセット (viewport-relative)
 const resetX = Math.round(wa.width / 2 - 160); // マスコット幅 320 の半分
 const resetY = Math.round(wa.height - 220); // タスクバー直上 (下端合わせ)

  const logKey = keys.find(Boolean) || 'unknown';
  writeMainLog('position-reset-out-of-range', logKey, false,
    `savedX=${savedPos.x} savedY=${savedPos.y}` +
    ` waX=${wa.x} waW=${wa.width} waY=${wa.y} waH=${wa.height}` +
    ` margin=${MARGIN} → reset to center x=${resetX} y=${resetY}`);

 // config.json に書き戻す (永続化) — sessionId / sessionLabel 両方の key を補正
  try {
    const current = loadConfig();
    current.lastPositions = current.lastPositions || {};
    let modified = false;
    for (const key of keys) {
      if (key && current.lastPositions[key]) {
        current.lastPositions[key].x = resetX;
        current.lastPositions[key].y = resetY;
        modified = true;
      }
    }
    if (modified) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
    }
  } catch (_e) { /* 書き戻し失敗は無視 */ }

  return { x: resetX, y: resetY };
}

function stageHandleSessionStart(sessionId, payload) {
  if (!sessionId) return;
  if (stageMascotStore.has(sessionId)) {
 // 再接続等: 状態更新のみ
    sendToStage('kurotan:mascot-update', { sessionId, state: 'idle' });
    return;
  }

 // 0.9.26: sessionLabel 計算 + payload 組み立てを helper 経由 (DRY)
  const transcriptPath = payload._kurotanTranscriptPath || sessionTranscriptPaths.get(sessionId) || '';
  const sessionLabel = computeSessionLabel(sessionId, payload.cwd || '', transcriptPath);

 // Step 2: lastPositions から保存済み座標を復元 (sessionId 優先 / sessionLabel 互換)
  let position = null;
  try {
    const cfg = loadConfig();
    const lp = cfg.lastPositions || {};
    const saved = lp[sessionId] || lp[sessionLabel];
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      position = sanitizeAndResetPosition(saved, sessionId, sessionLabel);
    }
  } catch (_e) { /* config 読み込み失敗時は fallback */ }

  if (!position) {
    position = getStageInitialPosition();
  }

  const { hueIndex, badgeIndex } = calcHueBadge(payload.cwd || '');
  const ms = {
    sessionId,
    sessionLabel,
    cwd: payload.cwd || '',
    model: payload.model || '',
    position,
    hueIndex,
    badgeIndex,
    state: 'idle',
  };
  stageMascotStore.set(sessionId, ms);
  sendToStage('kurotan:mascot-add', buildMascotAddPayload(ms));
 // §5.12.5 バッチに登録 (welcome は batchSessionEntry 内で除外される)
  batchSessionEntry(sessionId, payload);
}

/**
 * Stage Window モード: SessionEnd を受信したときに farewell → DOM 削除する。
 * @param {string} sessionId
 * @param {{ trackForRespawn?: boolean, jsonlPath?: string }} [opts]
 * trackForRespawn: true のとき §6.7 recentlyClosedSessions に登録する (transcript-stale / Stop auto-cleanup 経路のみ)
 * jsonlPath: transcript ファイルの絶対パス (trackForRespawn=true 時に必須)
 */
function stageHandleSessionEnd(sessionId, opts) {
  if (!sessionId || !stageMascotStore.has(sessionId)) return;

 // §6.7: transcript-stale / Stop auto-cleanup による despawn を追跡登録
  if (opts && opts.trackForRespawn && opts.jsonlPath) {
    const ms = stageMascotStore.get(sessionId);
    if (ms) {
      const entry = {
        jsonlPath: opts.jsonlPath,
        closedAt: Date.now(),
        mascotMeta: {
          cwd: ms.cwd,
          model: ms.model,
          position: ms.position,
          hueIndex: ms.hueIndex,
          badgeIndex: ms.badgeIndex,
        },
      };
      recentlyClosedSessions.set(sessionId, entry);
 // FIFO drop: RECENTLY_CLOSED_MAX 超過時に closedAt 最小 (最古) を 1 件削除
      if (recentlyClosedSessions.size > RECENTLY_CLOSED_MAX) {
        let oldestId = null;
        let oldestAt = Infinity;
        for (const [sid, info] of recentlyClosedSessions) {
          if (info.closedAt < oldestAt) {
            oldestAt = info.closedAt;
            oldestId = sid;
          }
        }
        if (oldestId !== null) recentlyClosedSessions.delete(oldestId);
      }
    }
  }

  sendToStage('kurotan:mascot-remove', { sessionId, withFarewell: true });
  setTimeout(() => {
    stageMascotStore.delete(sessionId);
 removeContextSession(sessionId); // contextLevel 状態をクリア (§5.9.6)
 }, 4000); // farewell 3 秒 + 余裕 1 秒
}

// ─── §6.6 起動時既存セッション scan & マスコット復元 (2026-05-03 新設) ────────

/** UUID v4 形式かどうか確認する */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUuidV4(str) {
  return UUID_V4_RE.test(str);
}

// 0.9.26: extractCwdLabel / computeSessionLabel / readCustomTitleFromJsonl は
// session-label-utils.js に分離 (テストから直接 import 可能にするため)。

/**
 * showSessionLabel config 値を取得 (loadConfig 失敗時 true)。
 * @returns {boolean}
 */
function getShowSessionLabel() {
  try { return loadConfig().showSessionLabel !== false; } catch (_) { return true; }
}

/**
 * 0.9.26: mascot-add IPC payload を組み立てる (全 IPC sender で共通)。
 * 過去 (~0.9.24) は sender ごとに手書きで sessionLabel が漏れる事故あり。
 * @param {object} ms - stageMascotStore のエントリ
 * @returns {object}
 */
function buildMascotAddPayload(ms) {
  return {
    sessionId: ms.sessionId,
    sessionLabel: ms.sessionLabel,
    cwd: ms.cwd,
    model: ms.model,
    position: ms.position,
    hueIndex: ms.hueIndex,
    badgeIndex: ms.badgeIndex,
    showSessionLabel: getShowSessionLabel(),
  };
}

/**
 * jsonl ファイルの先頭 maxLines 行を読み取り、cwd フィールドを持つ最初の行の cwd を返す。
 * maxBytes を超えたら早期打ち切り。見つからなければ '' を返す。
 * @param {string} filePath
 * @param {number} maxLines
 * @param {number} maxBytes
 * @returns {string}
 */
function readFirstCwdFromJsonl(filePath, maxLines, maxBytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const bufSize = Math.min(maxBytes, 65536);
    const buf = Buffer.alloc(bufSize);
    const bytesRead = fs.readSync(fd, buf, 0, bufSize, 0);
    const content = buf.slice(0, bytesRead).toString('utf8');
    const lines = content.split('\n');
    const limit = Math.min(maxLines, lines.length);
    for (let i = 0; i < limit; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.cwd === 'string' && obj.cwd) {
          return obj.cwd;
        }
      } catch (_) {
 // JSON パース失敗は無視
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return '';
}

/**
 * §6.6: kurotan 起動時に ~/.claude/projects 配下の *.jsonl を scan し、
 * Active なセッションのマスコットを後追いで復元する。
 * fire-and-forget で呼ぶこと (起動シーケンスを await で止めない)。
 */
async function scanAndRestoreActiveSessions() {
  if (!runtimeConfig.scanExistingSessionsOnStartup) {
    writeMainLog('startup-restore-skip', '', false, 'disabled');
    return;
  }
  if (process.env.KUROTAN_LEGACY_MODE === '1') {
    writeMainLog('startup-restore-skip', '', false, 'legacy-mode');
    return;
  }
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) {
    writeMainLog('startup-restore-skip', '', false, 'no-projects-dir');
    return;
  }

  const thresholdMs = (runtimeConfig.activeSessionThresholdMs >= 60000 &&
                       runtimeConfig.activeSessionThresholdMs <= 7200000)
    ? runtimeConfig.activeSessionThresholdMs
    : 1800000;
  const maxRestore = (runtimeConfig.scanMaxRestoreCount >= 1 &&
                      runtimeConfig.scanMaxRestoreCount <= 50)
    ? runtimeConfig.scanMaxRestoreCount
    : 10;
  const cutoff = Date.now() - thresholdMs;
  const startMs = Date.now();

 // glob 1 階層固定: ~/.claude/projects/*/*.jsonl
  const candidates = [];
  let subdirs;
  try {
    subdirs = fs.readdirSync(projectsDir);
  } catch (e) {
    writeMainLog('startup-restore-skip', '', false, `readdir-error:${e.code || e.message}`);
    return;
  }

  for (const sub of subdirs) {
    const subPath = path.join(projectsDir, sub);
    let subStat;
    try {
      subStat = fs.statSync(subPath);
    } catch (_) { continue; }
    if (!subStat.isDirectory()) continue;

    let files;
    try {
      files = fs.readdirSync(subPath);
    } catch (_) { continue; }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(subPath, file);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (_) { continue; }
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < cutoff) continue;
 const sessionId = file.slice(0, -6); // remove '.jsonl'
      if (!isValidUuidV4(sessionId)) continue;
      if (sessionId === WELCOME_SESSION_ID) continue;
      if (stageMascotStore.has(sessionId)) continue;
      candidates.push({ path: filePath, sessionId, mtime: stat.mtimeMs, encodedCwd: sub });
    }
  }

  writeMainLog('startup-restore-begin', '', false, `count=${candidates.length}`);

 // mtime 降順で上位 maxRestore 件
  candidates.sort((a, b) => b.mtime - a.mtime);
  const skipped = Math.max(0, candidates.length - maxRestore);
  const targets = candidates.slice(0, maxRestore);

  let restored = 0;
  for (const c of targets) {
    try {
      const ageSec = Math.round((Date.now() - c.mtime) / 1000);
 // 二重防止 (hooks が先に SessionStart を受信した可能性)
      if (stageMascotStore.has(c.sessionId)) continue;
      const cwd = readFirstCwdFromJsonl(c.path, 10, 50 * 1024);
      const payload = {
        session_id: c.sessionId,
        cwd,
        _kurotanTranscriptPath: c.path,
        _kurotanRestored: true,
      };
      stageHandleSessionStart(c.sessionId, payload);
      sessionTranscriptPaths.set(c.sessionId, c.path);
      writeMainLog('startup-restore', c.sessionId, true, `mtime-age=${ageSec}s`);
      restored++;
    } catch (e) {
      writeMainLog('startup-restore-error', c.sessionId, false, `error:${e.message}`);
    }
  }
  if (skipped > 0) {
    writeMainLog('startup-restore', '', false, `WARN: skipped ${skipped} sessions (exceeds scanMaxRestoreCount=${maxRestore})`);
  }
  const elapsedMs = Date.now() - startMs;
  writeMainLog('startup-restore-done', '', false, `restored=${restored} skipped=${skipped} elapsed=${elapsedMs}ms`);
}

// §6.x state stuck 対策方針 (2026-05-09 改訂 / 0.9.13):
// 旧: tool_* 60s / thinking 90s / permission 90s で auto-idle タイムアウト
// 新: 全 state 時間ベース auto-idle 撤廃。「ask モードは永続承認待ち」+
// 長尺 tool (npm run build 等) を誤 idle 化させないため。
// 代わりに: transcript mtime 30 分 stale 検出 (§6.7) で死んだセッションを despawn。
// stuck mascot の手動脱出は tray menu / 右クリック「くろたん再起動」で対応。

/**
 * Stage Window モード: hooks イベントを状態遷移に変換して renderer へ送る。
 */
function stageHandleEvent(payload) {
  const event = payload.event || payload.hook_event_name || '';
  const sessionId = payload.session_id || '';
  const cwd = payload.cwd || '';

 // transcript_path mtime 監視用（Stage モードでも継続）
  if (sessionId && sessionId !== WELCOME_SESSION_ID && payload._kurotanTranscriptPath) {
    sessionTranscriptPaths.set(sessionId, payload._kurotanTranscriptPath);
  }

 // Stop auto-cleanup タイマーを Stage モードでも管理
  if (sessionId) bumpStageSessionTimer(sessionId, payload);

 // ─── デモ用: _kurotanContextLevelOverride で context level を直接注入 ─────
 // demo_runner.js がプロモーション動画撮影用に使う。本番 hooks には含まれないフィールド。
 // 値: 'low' | 'mid' | 'high' | 'critical'
  if (sessionId && payload._kurotanContextLevelOverride) {
    const validLevels = ['low', 'mid', 'high', 'critical'];
    const overrideLevel = payload._kurotanContextLevelOverride;
    if (validLevels.includes(overrideLevel)) {
      sendToStage('kurotan:context-level', { sessionId, level: overrideLevel });
    }
  }

 // ─── : contextLevel 計測 (§5.9.2 / §5.9.6) ─────────────
 // hooks 受信ごとに transcript_path の末尾 1 行を読んで使用率を計測する。
 // 5 秒 throttle / サイレントフェイル / IPC payload は { sessionId, level } のみ。
  if (sessionId && sessionId !== WELCOME_SESSION_ID && payload._kurotanTranscriptPath) {
    const cfg = runtimeConfig && runtimeConfig.contextMotion;
    const enabled = !cfg || cfg.enabled !== false;
    measureContextLevel({
      sessionId,
      transcriptPath: payload._kurotanTranscriptPath,
      sendToRenderer: (levelPayload) => {
 // IPC: { sessionId, level } のみ送信 (プライバシー §12 項目 6)
        sendToStage('kurotan:context-level', levelPayload);
      },
      thresholds: cfg && cfg.thresholds,
      throttleMs: (cfg && cfg.throttleMs) || 5000,
      enabled,
    });
  }

 // SessionStart 未受信のセッション（hooks 後付けインストール等 / auto-cleanup 後の再受信）は
 // auto-create する（旧モード forwardToSession と同等）
 // SubagentStart/SubagentStop は親セッション管理とは独立するため auto-create 対象外
  if (sessionId && sessionId !== WELCOME_SESSION_ID &&
      event !== 'SessionStart' && event !== 'SessionEnd' &&
      event !== 'SubagentStart' && event !== 'SubagentStop' &&
      !stageMascotStore.has(sessionId)) {
    writeMainLog(event, sessionId, false, 'stage-auto-create');
    stageHandleSessionStart(sessionId, payload);
  }

  switch (event) {
    case 'SessionStart':
      writeMainLog(event, sessionId, stageMascotStore.has(sessionId), 'stage-add');
      stageHandleSessionStart(sessionId, payload);
 // SessionStart 受信時: contextLevel を low にリセットして refresh 演出発火 (§5.9.5)
      if (sessionId) {
        forceRefreshLevel(sessionId);
        sendToStage('kurotan:context-level', { sessionId, level: 'low' });
        sendToStage('kurotan:compact-refresh', { sessionId });
      }
      break;

    case 'SessionEnd':
      writeMainLog(event, sessionId, stageMascotStore.has(sessionId), 'stage-remove');
      stageHandleSessionEnd(sessionId);
      break;

 // ─── : PreCompact / PostCompact (§5.9.5) ────────────────
 // PreCompact は blocking hook (exit 0 必須) — kurotan-notify は exit 0 で終了。
 // 主要な compact 検知は差分検知方式 (transcript-reader.js) に委ねる。
 // PreCompact 受信時も同じ refresh 演出を発火する (二重安全網)。
    case 'PreCompact':
    case 'PostCompact': {
      writeMainLog(event, sessionId, stageMascotStore.has(sessionId), 'compact-refresh');
      if (sessionId) {
        forceRefreshLevel(sessionId);
        sendToStage('kurotan:context-level', { sessionId, level: 'low' });
        sendToStage('kurotan:compact-refresh', { sessionId });
 // 1.5 秒後に再計測値で復帰（measureContextLevel は次回 hooks で自動計測）
 // 即時再計測のため lastMeasureMs をリセット
        setTimeout(() => {
          const realLevel = getCurrentLevel(sessionId);
          sendToStage('kurotan:context-level', { sessionId, level: realLevel });
        }, 1500);
      }
      break;
    }

 // ─── : 公式 SubagentStart (§5.6.4 / §5.6.5) ──────────
    case 'SubagentStart': {
      const agentId = payload.agent_id || '';
      const agentType = payload.agent_type || '';
      const arrivedAt = payload.timestamp_ms || Date.now();

 // §5.6.5 突合: 副 PreToolUse(Agent) が先に来ていれば統合
      const matchedEntry = matchSubagentStart(sessionId, cwd, agentType, arrivedAt);

      if (matchedEntry) {
 // 統合: 既存の副子くろたんを公式 agentId で昇格 (source: 'merged')
        sendToStage('kurotan:mascot-update', {
          sessionId,
          childMerge: {
            childId: matchedEntry.childId,
            agentId,
            agentType,
            source: 'merged',
            spawnedVia: 'SubagentStart',
          },
        });
        writeMainLog('SubagentStart', sessionId, stageMascotStore.has(sessionId),
          `merged childId=${matchedEntry.childId} agentId=${agentId} agentType=${agentType}`);
      } else {
 // 公式単独: 子くろたんを新規生成 (§5.6.4 シナリオ: 公式のみ)
        const childId = 'official-' + (agentId || Date.now());
        sendToStage('kurotan:mascot-update', {
          sessionId,
          childSpawn: {
            childId,
            subagentType: agentType,
            agentId,
            source: 'official',
            spawnedVia: 'SubagentStart',
          },
        });
        writeMainLog('SubagentStart', sessionId, stageMascotStore.has(sessionId),
          `official-only childId=${childId} agentId=${agentId} agentType=${agentType}`);
      }
      break;
    }

 // ─── : 公式 SubagentStop (§5.6.4 先着優先) ────────────
    case 'SubagentStop': {
      const agentId = payload.agent_id || '';
      const agentType = payload.agent_type || '';

 // 先着優先: agentId が既に消滅済みなら silently drop
      if (!agentId || !tryDespawnChild(agentId, sessionId, true, 'official')) break;

 // §5.6.7: SubagentStop → farewell + 吹き出し演出
      sendToStage('kurotan:mascot-update', {
        sessionId,
        childDespawn: {
          agentId,
          agentType,
          toolUseId: undefined,
          success: true,
          source: 'official',
        },
      });
      writeMainLog('SubagentStop', sessionId, stageMascotStore.has(sessionId),
        `official agentId=${agentId} agentType=${agentType}`);
      break;
    }

    case 'PreToolUse': {
      const toolName = payload.tool_name || '';
      const ms = stageMascotStore.get(sessionId);
      const state = resolveToolState(toolName);
      const bubbleText = resolveToolBubble(toolName, payload.tool_input_digest);
      if (ms) ms.state = state || ms.state;
      if (state) {
 // §A: 新 tool_* state が来たら前の pending thinking タイマーをキャンセル (キュー詰まり防止)
        const prevHold = toolStateHold.get(sessionId);
        if (prevHold && prevHold.pendingTimer) {
          clearTimeout(prevHold.pendingTimer);
        }
        toolStateHold.set(sessionId, { state, startedAt: Date.now(), pendingTimer: null });
        sendToStage('kurotan:mascot-update', { sessionId, state, bubbleText: bubbleText || undefined, toolName });
      } else if (toolName === 'Agent' || toolName === 'Task') {
 // 副トラック子くろたん生成 (§5.6.4)
        const childId = payload.tool_use_id || ('child-' + Date.now());
        const subagentType = (payload.tool_input_digest && payload.tool_input_digest.subagent_type) || toolName;

 // pendingSubagentMatch に登録: SubagentStart 到着を 800ms 待つ (§5.6.5)
        registerPseudoChild(
          childId,
          sessionId,
          cwd,
          subagentType,
          payload.tool_use_id,
          payload.timestamp_ms || Date.now()
        );

 // 0.9.71: 親マスコットがこくろたん召喚時にセリフ (throttle: 2 秒 / セッション)
        let parentBubbleText;
        const now = Date.now();
        const lastCallAt = lastParentCallHelpTime.get(sessionId) || 0;
        if (now - lastCallAt > 2000) {
          lastParentCallHelpTime.set(sessionId, now);
          const idx = 1 + Math.floor(Math.random() * 5);
          parentBubbleText = i18n.t(`bubble.parent_call_help_${idx}`);
        }

        sendToStage('kurotan:mascot-update', {
          sessionId,
          ...(parentBubbleText ? { bubbleText: parentBubbleText } : {}),
          childSpawn: {
            childId,
            subagentType,
            toolUseId: payload.tool_use_id,
            source: 'pseudo',
            spawnedVia: 'PreToolUse',
          },
        });
      }
      break;
    }

    case 'PostToolUse': {
      const ms = stageMascotStore.get(sessionId);
      const toolName = payload.tool_name || '';
      if (toolName === 'Agent' || toolName === 'Task') {
 // 副トラック消滅 (§5.6.4 先着優先)
        const keyId = payload.tool_use_id || '';
        if (!keyId || tryDespawnChild(keyId, sessionId, true, 'pseudo')) {
          sendToStage('kurotan:mascot-update', {
            sessionId,
            childDespawn: { toolUseId: payload.tool_use_id, success: true, source: 'pseudo' },
          });
        }
 // §5.6.7 placeholder 経路: 副トラック(旧版互換)でも ✨ sparkle を発火 (B 本体が SubagentStop 主経路を結合するまでの代替)
        sendToStage('kurotan:subagent-sparkle', { sessionId, success: true });
      } else {
 // §A: tool_* 最低保持時間 hold — 経過が MIN_TOOL_STATE_HOLD_MS に満たない場合は遅延送信
        const hold = toolStateHold.get(sessionId);
        const elapsed = hold ? (Date.now() - hold.startedAt) : MIN_TOOL_STATE_HOLD_MS;
        const remaining = Math.max(0, MIN_TOOL_STATE_HOLD_MS - elapsed);

        const sendThinking = () => {
          if (ms) ms.state = 'thinking';
          sendToStage('kurotan:mascot-update', { sessionId, state: 'thinking' });
          sendToStage('kurotan:mascot-task-done', { sessionId, toolName });
          toolStateHold.delete(sessionId);
        };

        if (remaining <= 0) {
          sendThinking();
        } else {
 // 前の pending があればキャンセルして上書き (二重発火防止)
          if (hold && hold.pendingTimer) clearTimeout(hold.pendingTimer);
          const timer = setTimeout(sendThinking, remaining);
          if (hold) hold.pendingTimer = timer;
          else toolStateHold.set(sessionId, { state: toolName, startedAt: Date.now() - elapsed, pendingTimer: timer });
        }
      }
      break;
    }

    case 'PostToolUseFailure': {
      const ms = stageMascotStore.get(sessionId);
      const toolName = payload.tool_name || '';
      if (toolName === 'Agent' || toolName === 'Task') {
        const keyId = payload.tool_use_id || '';
        if (!keyId || tryDespawnChild(keyId, sessionId, false, 'pseudo')) {
          sendToStage('kurotan:mascot-update', {
            sessionId,
            childDespawn: { toolUseId: payload.tool_use_id, success: false, source: 'pseudo' },
          });
        }
      } else {
        if (ms) ms.state = 'error';
        sendToStage('kurotan:mascot-update', { sessionId, state: 'error', bubbleText: 'エラーが出ちゃった…' });
      }
      break;
    }

    case 'Stop': {
      const ms = stageMascotStore.get(sessionId);
      if (ms) ms.state = 'success';
 // Step 1: success モーション (§5.7) 発火
      sendToStage('kurotan:mascot-update', { sessionId, state: 'success', bubbleText: 'できたよ！' });

 // Step 2 (§5.9.4 Stop 重畳順): success 完了後 (2 秒) → 1 段下げ idle を 1.5 秒
 // success モーションは 2 秒で idle 復帰するため、その直後に contextLevel リフレッシュを送る
      const refreshedLevel = getRefreshedLevel(sessionId);
      if (refreshedLevel !== getCurrentLevel(sessionId)) {
 // success の 2 秒後にリフレッシュ level を送信
        setTimeout(() => {
          sendToStage('kurotan:context-level', { sessionId, level: refreshedLevel, _refresh: true });
 // 1.5 秒後に元の level に戻す
          setTimeout(() => {
            const realLevel = getCurrentLevel(sessionId);
            sendToStage('kurotan:context-level', { sessionId, level: realLevel });
          }, 1500);
        }, 2000);
      }
      break;
    }

    case 'StopFailure': {
      const ms = stageMascotStore.get(sessionId);
      if (ms) ms.state = 'error';
      sendToStage('kurotan:mascot-update', { sessionId, state: 'error', bubbleText: 'えっと…うまくいかなかった' });
      break;
    }

    case 'UserPromptSubmit': {
      const ms = stageMascotStore.get(sessionId);
      if (ms) ms.state = 'thinking';
      sendToStage('kurotan:mascot-update', { sessionId, state: 'thinking', bubbleText: '考え中...' });
 // 0.9.26: イースターエッグ判定は kurotan-notify が _kurotanEasterEgg flag に正規化済み。
 // 旧: payload.prompt 直読み (kurotan-notify が prompt を送らないため常に miss していた)
      const eggs = Array.isArray(payload._kurotanEasterEgg) ? payload._kurotanEasterEgg : [];
      if (eggs.includes('ultrathink')) {
        sendToStage('kurotan:ultrathink-trigger', { sessionId });
      }
      if (eggs.includes('korone')) {
        sendToStage('kurotan:easter-egg-korone', { sessionId });
      }
      break;
    }

    case 'Notification': {
 // 0.9.13: permission auto-dismiss 撤廃。ask モード時は永続承認待ち表示にする。
 // stuck 時は tray menu / 右クリック「くろたん再起動」で脱出。
 // 死んだセッションは transcript mtime 30 分 stale 検出 (§6.7) が despawn する。
      const ms = stageMascotStore.get(sessionId);
      if (ms) ms.state = 'permission';
      sendToStage('kurotan:mascot-update', { sessionId, state: 'permission', bubbleText: '承認待ち' });
      break;
    }

    default:
 // unknown events: forward as-is（auto-create は switch の前で処理済み）
      break;
  }
}

// ─── Stage モード: tool_name → state ID ──────────────────────────
const { resolveToolState } = require('./tool-state-resolver');

function resolveToolBubble(toolName, digest) {
  if (!toolName) return '';
  if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
    return (digest && digest.file_path) ? `「${path.basename(digest.file_path)}」を読んでる` : '読んでる...';
  }
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    return (digest && digest.file_path) ? `「${path.basename(digest.file_path)}」を編集中` : '編集中...';
  }
  if (toolName === 'Bash' || toolName === 'BashOutput' || toolName === 'KillShell') {
    return (digest && digest.command) ? `${digest.command.slice(0, 30)} 実行中` : '実行中...';
  }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    return '検索中...';
  }
  if (toolName === 'Skill') {
    const skillName = (digest && digest.skill_name) ? `「${digest.skill_name}」` : 'Skill';
    return `${skillName} 発動！`;
  }
  return `${toolName} 実行中`;
}

// ─── : pendingSubagentMatch キュー (§5.6.5) ─────────────
//
// 目的: 副トラック (PreToolUse(Agent)) と公式トラック (SubagentStart) の
// 突合キーを保持し、同一 subagent を 1 匹に収束させる。
//
// キー構造: Map<childId, PendingSubagentEntry>
// childId = PreToolUse から生成した仮の子くろたん ID
// PendingSubagentEntry:
// childId, sessionId, cwd, subagentType (副の subagent_type)
// toolUseId, spawnedAt (副受信 timestamp_ms)
// gcTimer (2 秒 GC タイムアウト)
//
// 突合キー (§5.6.5 / 必須 3 条件):
// (a) 時刻近接 800ms 以内
// (b) cwd 一致
// (c) agent_type (公式) と subagent_type (副) の文字列一致
//
// 先着優先ルール (§5.6.4):
// SubagentStop と PostToolUse(Agent) の両方が来たら先着で消滅、後着 silently drop。

/** subagent 突合ウィンドウ (ms) */
const SUBAGENT_MATCH_WINDOW_MS = 800;

/** GC タイムアウト (ms) — 突合不成立を放棄する */
const SUBAGENT_GC_MS = 2000;

/**
 * @typedef {Object} PendingSubagentEntry
 * @property {string} childId - 副トラック (PreToolUse) が生成した childId
 * @property {string} sessionId - session_id
 * @property {string} cwd - 副 PreToolUse 時の cwd
 * @property {string} subagentType - 副 PreToolUse の subagent_type
 * @property {string|undefined} toolUseId - 副 PreToolUse の tool_use_id
 * @property {number} spawnedAt - 副受信 timestamp_ms
 * @property {ReturnType<typeof setTimeout>} gcTimer - 2 秒 GC タイマー
 */

/** childId → PendingSubagentEntry の突合キュー */
const pendingSubagentMatch = new Map();

/**
 * 副トラック PreToolUse(Agent) 受信時にエントリを登録する。
 * @param {string} childId
 * @param {string} sessionId
 * @param {string} cwd
 * @param {string} subagentType
 * @param {string|undefined} toolUseId
 * @param {number} spawnedAt
 */
function registerPseudoChild(childId, sessionId, cwd, subagentType, toolUseId, spawnedAt) {
 // 既存 GC タイマーがあればクリア（再登録時の保険）
  const existing = pendingSubagentMatch.get(childId);
  if (existing && existing.gcTimer) clearTimeout(existing.gcTimer);

  const gcTimer = setTimeout(() => {
 // 2 秒経過: 突合不成立 → エントリを GC（子くろたんはそのまま副として確定）
    pendingSubagentMatch.delete(childId);
    writeMainLog('subagent-gc', sessionId, stageMascotStore.has(sessionId),
      `childId=${childId} subagentType=${subagentType} (no official match within ${SUBAGENT_GC_MS}ms)`);
  }, SUBAGENT_GC_MS);

  pendingSubagentMatch.set(childId, {
    childId,
    sessionId,
    cwd,
    subagentType,
    toolUseId,
    spawnedAt,
    gcTimer,
  });
}

/**
 * 公式 SubagentStart 受信時に pendingSubagentMatch を突合する。
 * §5.6.5 必須 3 条件 (a)(b)(c) を全て満たす場合のみ統合。
 * @param {string} sessionId - SubagentStart の session_id
 * @param {string} cwd - SubagentStart の cwd
 * @param {string} agentType - SubagentStart の agent_type
 * @param {number} arrivedAt - SubagentStart の timestamp_ms
 * @returns {PendingSubagentEntry|null} - 突合成立したエントリ、なければ null
 */
function matchSubagentStart(sessionId, cwd, agentType, arrivedAt) {
  for (const [childId, entry] of pendingSubagentMatch) {
    if (entry.sessionId !== sessionId) continue;

 // (a) 時刻近接 800ms 以内
    const timeDiff = arrivedAt - entry.spawnedAt;
    if (timeDiff < 0 || timeDiff > SUBAGENT_MATCH_WINDOW_MS) continue;

 // (b) cwd 一致
    if (entry.cwd !== cwd) continue;

 // (c) agent_type と subagent_type の文字列一致 ()
    if (entry.subagentType !== agentType) continue;

 // 突合成立: GC タイマーをキャンセルしてエントリを除去
    clearTimeout(entry.gcTimer);
    pendingSubagentMatch.delete(childId);
    writeMainLog('subagent-matched', sessionId, stageMascotStore.has(sessionId),
      `childId=${childId} agentType=${agentType} timeDiff=${timeDiff}ms`);
    return entry;
  }
  return null;
}

/**
 * 子くろたん消滅の先着優先処理: childId が既に消滅済みなら true を返す。
 * 最初の消滅呼び出しが登録し、後着は silently drop される。
 * Map: childId → true (消滅済みフラグ)
 */
const despawnedChildren = new Map();

/**
 * 消滅処理を先着優先で実行する。
 * @param {string} keyId - childId または toolUseId
 * @param {string} sessionId
 * @param {boolean} success
 * @param {string} source - 'official' | 'pseudo' (ログ用)
 * @returns {boolean} - true: 実行した / false: 後着で drop した
 */
function tryDespawnChild(keyId, sessionId, success, source) {
  if (despawnedChildren.has(keyId)) {
    writeMainLog('subagent-despawn-dup', sessionId, stageMascotStore.has(sessionId),
      `keyId=${keyId} source=${source} silently-drop`);
    return false;
  }
 // 消滅済みフラグを立てる (30 秒後に GC)
  despawnedChildren.set(keyId, true);
  setTimeout(() => despawnedChildren.delete(keyId), 30000);
  return true;
}

// ─── Stage モード: Stop auto-cleanup タイマー ──────────────────
const stageStopTimers = new Map();

function bumpStageSessionTimer(sessionId, payload) {
  const old = stageStopTimers.get(sessionId);
  if (old) clearTimeout(old);

  const event = payload.event || payload.hook_event_name || '';

  if (event === 'Stop') {
    const timeoutMs = (runtimeConfig && runtimeConfig.cleanupTimeoutMs)
      ? runtimeConfig.cleanupTimeoutMs
      : STOP_AUTO_CLEANUP_MS;
    const t = setTimeout(() => {
      stageStopTimers.delete(sessionId);
      writeMainLog('Stage-Stop-auto-cleanup', sessionId, stageMascotStore.has(sessionId), 'remove');
 // §6.7: Stop auto-cleanup による despawn も追跡対象
      const autoCleanupJsonlPath = sessionTranscriptPaths.get(sessionId) || null;
      stageHandleSessionEnd(sessionId, { trackForRespawn: true, jsonlPath: autoCleanupJsonlPath });
    }, timeoutMs);
    stageStopTimers.set(sessionId, t);
  } else if (event === 'SessionEnd') {
    stageStopTimers.delete(sessionId);
  }
}

// ─── トレイ ────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icons', 'tray.ico');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    try {
      trayIcon = nativeImage.createFromPath(iconPath);
 // createFromPath はファイルが壊れていても空を返すことがある
      if (trayIcon.isEmpty()) {
        console.warn('[kurotan] tray.ico is empty or unreadable, using placeholder');
        trayIcon = nativeImage.createEmpty();
      }
    } catch (e) {
      console.warn('[kurotan] Failed to load tray.ico:', e.message, '- using placeholder');
      trayIcon = nativeImage.createEmpty();
    }
  } else {
 // artist 生成前など、アイコンが未生成の場合は空白アイコンで代替
 // kurotan 再起動で自動反映される設計
    console.warn('[kurotan] tray.ico not found at', iconPath, '- using placeholder (will be applied after restart)');
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip(i18n.t('tray.tooltip'));

  updateTrayMenu();
  startTrayWatchdog();
}

function updateTrayMenu() {
  if (!tray) return;
  const isStageMode = process.env.KUROTAN_STAGE_MODE === '1';
  const sessionCount = isStageMode ? stageMascotStore.size : sessionWindows.size;

 // 0.9.15: セッション名ラベル表示状態 (config 直読み)
  const showSessionLabel = (() => {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return cfg.showSessionLabel !== false;
    } catch (_) { return true; }
  })();

 // §5.11.3.1 / T5: permissionMode を config.json から読む (hot reload)
  const permissionMode = (() => {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return (cfg.permissionMode === 'auto' || cfg.permissionMode === 'custom')
        ? cfg.permissionMode : 'auto';
    } catch (_) { return 'auto'; }
  })();
  const isAutoMode   = permissionMode === 'auto';
  const isCustomMode = permissionMode === 'custom';

 // ─── B 案: ステージモニタ選択サブメニュー ─────────────────────────
  const allDisplays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  const currentDisplayId = (() => {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return cfg.stageDisplayId != null ? cfg.stageDisplayId : primaryDisplay.id;
    } catch (_) { return primaryDisplay.id; }
  })();
  const stageMonitorSubmenu = allDisplays.map((d, i) => {
    const b = d.bounds;
    const isPrimary = d.id === primaryDisplay.id;
    return {
      label: `Display ${i + 1}: ${b.width}×${b.height} @${b.x},${b.y}${isPrimary ? ' (primary)' : ''}`,
      type: 'radio',
      checked: d.id === currentDisplayId,
      click: () => setStageDisplayId(d.id),
    };
  });

  const menu = Menu.buildFromTemplate([
    { label: i18n.t('tray.active_sessions', { count: sessionCount }), enabled: false },
    { type: 'separator' },
    {
      label: i18n.t('tray.menu.settings'),
      click: () => createSettingsWindow(),
    },
    { type: 'separator' },
    {
      label: i18n.t('tray.menu.close_all'),
      click: () => closeAllMascots(),
    },
    {
      label: i18n.t('tray.menu.realign'),
      click: () => realignAll(),
    },
    {
      label: i18n.t('tray.menu.show_session_label'),
      type: 'checkbox',
      checked: showSessionLabel,
      click: (menuItem) => {
        const newVal = menuItem.checked;
        saveConfig({ showSessionLabel: newVal });
        writeMainLog('tray-show-session-label', '', false, `show=${newVal}`);
        broadcastShowSessionLabel(newVal);
        updateTrayMenu();
      },
    },
    { type: 'separator' },
 // B 案: ステージモニタ選択
    {
      label: i18n.t('tray.menu.stage_monitor'),
      submenu: stageMonitorSubmenu,
    },
    { type: 'separator' },
 // §5.11.3.1 T5: 権限モード サブメニュー
    {
      label: i18n.t('tray.menu.permission_mode', { mode: isAutoMode ? 'Auto' : 'Custom' }),
      submenu: [
        {
          label: i18n.t('tray.menu.permission_auto'),
          type: 'radio',
          checked: isAutoMode,
          click: () => {
            saveConfig({ permissionMode: 'auto' });
            writeMainLog('tray-permission-mode', '', false, 'mode=auto');
            updateTrayMenu();
 // Custom 設定ウィンドウに通知
            if (customConfirmWindow && !customConfirmWindow.isDestroyed()) {
              customConfirmWindow.webContents.send('kurotan:permission-mode-changed', { mode: 'auto' });
            }
          },
        },
        {
          label: i18n.t('tray.menu.permission_custom'),
          type: 'radio',
          checked: isCustomMode,
          click: () => {
            saveConfig({ permissionMode: 'custom' });
            writeMainLog('tray-permission-mode', '', false, 'mode=custom');
            updateTrayMenu();
            if (customConfirmWindow && !customConfirmWindow.isDestroyed()) {
              customConfirmWindow.webContents.send('kurotan:permission-mode-changed', { mode: 'custom' });
            }
          },
        },
      ],
    },
    {
      label: i18n.t('tray.menu.custom_confirm'),
      enabled: isCustomMode,
      click: () => createCustomConfirmWindow(),
    },
    { type: 'separator' },
 // 0.9.30: Legacy permission dialog チェックボックスを UI から撤去 。
 // 円形ボタン経路が安定したため日常 UI から非表示。
 // 緊急ロールバックが必要な場合は環境変数 KUROTAN_LEGACY_PERMISSION_DIALOG=1 または
 // config.json の legacyPermissionDialog: true で再有効化可能 (configStore は保持)。
    {
      label: i18n.t('tray.menu.help'),
      click: () => showHelp(),
    },
    {
      label: i18n.t('tray.menu.about'),
      click: () => showAbout(),
    },
    {
      label: i18n.t('tray.menu.restart'),
      click: () => {
        writeMainLog('tray-restart', '', false, 'user-initiated');
        app.relaunch();
        app.quit();
      },
    },
    {
      label: i18n.t('tray.menu.exit'),
      click: () => {
 // deleteRuntime() は before-quit に一本化。ここでは app.quit() のみ
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

function closeAllMascots() {
  for (const [sessionId] of [...sessionWindows]) {
    closeMascotWindow(sessionId);
  }
  updateTrayMenu();
}

function realignAll() {
  let i = 0;
  for (const [, win] of sessionWindows) {
    if (!win.isDestroyed()) {
      const pos = getInitialPosition(i);
      win.setPosition(pos.x, pos.y);
      i++;
    }
  }
}


// ─── T6: Custom 設定 BrowserWindow (§5.11.5.3) ──────────────────
/**
 * Custom 確認設定ウィンドウを開く。同時 1 ウィンドウのみ (二重起動はフォーカス)。
 */
function createCustomConfirmWindow() {
  if (customConfirmWindow && !customConfirmWindow.isDestroyed()) {
    customConfirmWindow.focus();
    return;
  }
  customConfirmWindow = new BrowserWindow({
    width: 760,
    height: 640,
    resizable: true,
    frame: true,
    transparent: false,
    alwaysOnTop: false,
    title: 'Custom 確認設定 - kurotan',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'custom-confirm-preload.js'),
 // R-02 fix: バックグラウンド時も IPC ハンドラを即時実行させるため throttling を無効化。
 // Custom 設定ウィンドウは軽量なため CPU コストは無視できる。
      backgroundThrottling: false,
    },
  });
  customConfirmWindow.loadFile(
    path.join(__dirname, '..', 'renderer', 'custom-confirm-window', 'index.html')
  );
  customConfirmWindow.setMenuBarVisibility(false);
  customConfirmWindow.on('closed', () => { customConfirmWindow = null; });
}

// ─── T14: Custom 設定 IPC ハンドラ v2 (§5.11.5.4) ────────────────
// 旧 list-patterns / set-pattern は撤去 (spec §5.11.5.4 後方互換性判断 / plan-A)。
// 新規: get-tool-types / set-tool-type / list-exceptions / set-exception / remove-exception
// 既存維持: list-history / get-mode / close-window
function setupCustomConfirmIpc() {
  const CUSTOM_CONFIG_PATH_MAIN = path.join(RUNTIME_DIR, 'custom-confirm-config.json');
  const VALID_TOOL_TYPES = new Set(['Bash', 'Read', 'Edit', 'Search', 'Web', 'Skill', 'Agent', 'mcp__*', 'Other']);
  const VALID_DECISIONS  = new Set(['allow', 'ask', 'deny', 'inherit']);

 // ─── get-tool-types ────────────────────────────────────────────
 // レスポンス: { toolTypes: { Bash: "inherit", ..., Other: "inherit" } }
  ipcMain.handle('kurotan:custom-confirm:get-tool-types', () => {
    try {
      const config = readCustomConfig(CUSTOM_CONFIG_PATH_MAIN);
      return { toolTypes: config.toolTypes };
    } catch (e) {
      return { toolTypes: defaultCustomConfig().toolTypes, error: e.message };
    }
  });

 // ─── set-tool-type ─────────────────────────────────────────────
 // 入力: { toolType, decision }
 // レスポンス: { ok: true } または { error: "..." }
  ipcMain.handle('kurotan:custom-confirm:set-tool-type', (_event, data) => {
    try {
      const toolType = String(data?.toolType ?? '');
      const decision = String(data?.decision ?? '');

      if (!VALID_TOOL_TYPES.has(toolType)) {
        return { error: 'invalid toolType: ' + toolType };
      }
      if (!VALID_DECISIONS.has(decision)) {
        return { error: 'invalid decision: ' + decision };
      }

      ensureRuntimeDir();
      const config = readCustomConfig(CUSTOM_CONFIG_PATH_MAIN);
      config.toolTypes[toolType] = decision;
      fs.writeFileSync(CUSTOM_CONFIG_PATH_MAIN, JSON.stringify(config, null, 2), 'utf8');
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  });

 // ─── list-exceptions ───────────────────────────────────────────
 // レスポンス: { exceptions: [{ rule, decision, source, addedAt }, ...] }
  ipcMain.handle('kurotan:custom-confirm:list-exceptions', () => {
    try {
      const config = readCustomConfig(CUSTOM_CONFIG_PATH_MAIN);
      return { exceptions: config.exceptions };
    } catch (e) {
      return { exceptions: [], error: e.message };
    }
  });

 // ─── set-exception ─────────────────────────────────────────────
 // 入力: { rule, decision, source? }
 // 追加 or 上書き (rule が既存なら decision を更新)
 // レスポンス: { ok: true, exception: {...} } または { error: "..." }
  ipcMain.handle('kurotan:custom-confirm:set-exception', (_event, data) => {
    try {
      const rule     = String(data?.rule     ?? '');
      const decision = String(data?.decision ?? '');
      const source   = String(data?.source   ?? 'manual');

      if (!rule) {
        return { error: 'rule is required' };
      }
      if (!VALID_DECISIONS.has(decision)) {
        return { error: 'invalid decision: ' + decision };
      }
      if (parseRule(rule) === null) {
        return { error: 'invalid rule syntax' };
      }

      ensureRuntimeDir();
      const config = readCustomConfig(CUSTOM_CONFIG_PATH_MAIN);
      const existing = config.exceptions.find(e => e.rule === rule);
      let exc;

      if (existing) {
 // 上書き
        existing.decision = decision;
        existing.source   = source;
        exc = existing;
      } else {
 // 追加
        exc = {
          rule,
          decision,
          source,
          addedAt: new Date().toISOString(),
        };
        config.exceptions.push(exc);
      }

      fs.writeFileSync(CUSTOM_CONFIG_PATH_MAIN, JSON.stringify(config, null, 2), 'utf8');
      return { ok: true, exception: exc };
    } catch (e) {
      return { error: e.message };
    }
  });

 // ─── remove-exception ──────────────────────────────────────────
 // 入力: { rule }
 // レスポンス: { ok: true } または { error: "..." }
  ipcMain.handle('kurotan:custom-confirm:remove-exception', (_event, data) => {
    try {
      const rule = String(data?.rule ?? '');
      if (!rule) {
        return { error: 'rule is required' };
      }

      ensureRuntimeDir();
      const config = readCustomConfig(CUSTOM_CONFIG_PATH_MAIN);
      const before = config.exceptions.length;
      config.exceptions = config.exceptions.filter(e => e.rule !== rule);

      fs.writeFileSync(CUSTOM_CONFIG_PATH_MAIN, JSON.stringify(config, null, 2), 'utf8');
      return { ok: true, removed: before - config.exceptions.length };
    } catch (e) {
      return { error: e.message };
    }
  });

 // ─── list-history (0.9.38: 件数上限追加) ────────────────────────
 // レスポンス: { entries: [...], total: number, truncated: boolean }
 // 長期利用で tool-call-history.json が肥大化した時の IPC payload 過大化を防ぐ。
 // 既定 200 件、最大 1000 件 (新しい順)。古い履歴は full export 用に別途検討。
  const HISTORY_LIST_DEFAULT_LIMIT = 200;
  const HISTORY_LIST_MAX_LIMIT = 1000;
  ipcMain.handle('kurotan:custom-confirm:list-history', (_event, data) => {
    try {
      const full = loadFullHistory();
      let entries = full.entries || [];
      const total = entries.length;
 // since フィルタ
      if (data && data.since) {
        const sinceMs = new Date(data.since).getTime();
        entries = entries.filter(e => new Date(e.ts).getTime() >= sinceMs);
      }
 // 件数上限 (新しい順、末尾を採用)
      const reqLimit = (data && Number.isInteger(data.limit)) ? data.limit : HISTORY_LIST_DEFAULT_LIMIT;
      const limit = Math.max(1, Math.min(HISTORY_LIST_MAX_LIMIT, reqLimit));
      const truncated = entries.length > limit;
      if (truncated) entries = entries.slice(-limit);
      return { entries, total, truncated, limit };
    } catch (e) {
      return { entries: [], total: 0, error: e.message };
    }
  });

 // ─── get-mode (既存維持) ────────────────────────────────────────
  ipcMain.handle('kurotan:custom-confirm:get-mode', () => {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const mode = (cfg.permissionMode === 'custom') ? 'custom' : 'auto';
      return { mode };
    } catch (_) {
      return { mode: 'auto' };
    }
  });

 // ─── close-window (既存維持) ────────────────────────────────────
 // Esc キーでウィンドウを閉じる (ui-designer #4)
  ipcMain.handle('kurotan:custom-confirm:close-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
  });
}

function showHelp() {
  const { dialog } = require('electron');
  dialog.showMessageBox({
    type: 'info',
    title: i18n.t('help.title'),
    message: i18n.t('help.title'),
    detail: i18n.t('help.detail'),
    buttons: [i18n.t('help.btn_ok')],
  });
}

function showAbout() {
 // §5.11.3.1 T7: 現在の権限モードを read-only 表示 (U-1)
  let permissionModeLabel = i18n.t('tray.menu.permission_auto');
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg.permissionMode === 'custom') permissionModeLabel = i18n.t('tray.menu.permission_custom');
  } catch (_) {}

  const { dialog } = require('electron');
  dialog.showMessageBox({
    type: 'info',
    title: i18n.t('about.title'),
    message: i18n.t('about.message', { version: app.getVersion() }),
    detail: i18n.t('about.detail', { permissionMode: permissionModeLabel }),
    buttons: [i18n.t('about.btn_ok')],
  });
}

// ─── アプリ起動 ────────────────────────────────────────────────
app.whenReady().then(async () => {
 // 多重起動防止
  if (isAlreadyRunning()) {
    app.quit();
    return;
  }

 // DisplayRegistry 初期化 (screen API 抽象化レイヤ /)
  displayRegistry.init(screen);

 // feature flag 初期化: ~/.kurotan/config.json の permissionUi.legacyDialog → global 変数に展開 (§5.10.8.2)
  configStore.init();

 // 0.9.47: パーミッションオーバーレイ初期化 (claude_overlay 移植)
 // 0.9.57: bubble 設定を渡して overlay の配色を吹き出しに同期
  permissionOverlay.init(configStore, () => (loadConfig().bubble || {}));

 // config.json 読み込み・runtime 反映
  applyConfig(loadConfig());

 // 0.9.41: i18n 初期化 (config.language に従って locale 解決)
 // language が未設定なら 'auto' 扱い → app.getLocale() で解決
  try {
    const cfg = loadConfig();
    if (cfg.language === undefined) {
 // マイグレーション: 既存 config に language フィールドが無ければ 'auto' で初期化
      saveConfig({ language: 'auto' });
    }
    i18n.init(cfg.language || 'auto');
    writeMainLog('i18n-init', '', false, `lang=${i18n.getCurrentLang()}`);
  } catch (e) {
    writeMainLog('i18n-init-error', '', false, String(e));
  }

 // ─── §5.11.5.7 起動時マイグレーション (v1 → v2) ─────────────────
 // custom-confirm-patterns.json (旧 v1) → custom-confirm-config.json (新 v2)
 // 失敗時は warn 出力のみ (起動を阻止しない)
  try {
    const migSrcPath = path.join(RUNTIME_DIR, 'custom-confirm-patterns.json');
    const migDstPath = path.join(RUNTIME_DIR, 'custom-confirm-config.json');
    const migLogDir  = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(migLogDir, { recursive: true });
    const migLogPath = path.join(migLogDir, 'migration_v1_to_v2.json');
    const migResult  = runMigration(migSrcPath, migDstPath, migLogPath);
    if (migResult.count > 0 || migResult.errors.length > 0) {
      console.log(
        '[kurotan] migration v1→v2:',
        'success=' + migResult.success,
        'count=' + migResult.count,
        'errors=' + migResult.errors.length
      );
    }
    if (!migResult.success) {
      console.warn('[kurotan] migration v1→v2 failed (non-fatal):', migResult.errors.join('; '));
    }
  } catch (e) {
    console.warn('[kurotan] migration v1→v2 threw (non-fatal):', e.message);
  }

 // IPC セットアップ
  setupIpc();
  setupCustomConfirmIpc();

 // ─── 配布版: 起動毎 hooks 実体スキャン → 必要なら自動登録 ──────────
 // 案 A (NSIS 上書きインストール消失対策):
 // hooksInstalled フラグ (config.json) ではなく checkHooksInstalled() で
 // ~/.claude/settings.json の実体をスキャンして判定する。
 // フラグが true でも NSIS uninstall で hooks が消えていれば再登録する。
 //
 // 案 C (migration): config.json に残った死んだフラグを読み込み時に削除する。
 // hooksInstalled / hooksInstalledAt は意味を失っているため誤解を防ぐ目的。
 //
 // 開発時 (app.isPackaged === false) でも動作させる。
 // 開発時の install-hooks.js は __dirname 起点の相対パスで解決される。
  {
 // 案 C: 死んだフラグを config.json から削除する migration
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const cfgRaw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        if ('hooksInstalled' in cfgRaw || 'hooksInstalledAt' in cfgRaw) {
          delete cfgRaw.hooksInstalled;
          delete cfgRaw.hooksInstalledAt;
          ensureRuntimeDir();
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfgRaw, null, 2) + '\n', 'utf8');
          console.log('[hooks] migration: removed dead hooksInstalled flag from config.json');
        }
      }
    } catch (e) {
      console.warn('[hooks] migration: failed (non-fatal):', e.message);
    }

 // 案 A: settings.json 実体スキャンで判定
    const autoInstallDone = checkHooksInstalled();
    console.log(`[hooks] checkHooksInstalled() = ${autoInstallDone}`);

    if (!autoInstallDone) {
      console.log('[hooks] auto-install: kurotan-notify not found in settings.json, running install()...');
      try {
 // 配布版: process.resourcesPath/app.asar.unpacked/src/installer/install-hooks.js
 // 開発版: __dirname 起点 (src/main/../installer/install-hooks.js)
        const installerModule = app.isPackaged
          ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'installer', 'install-hooks.js')
          : path.join(__dirname, '..', 'installer', 'install-hooks.js');
        const { install: installHooks } = require(installerModule);
        installHooks();
        console.log('[hooks] auto-install: success');
      } catch (e) {
        console.error('[hooks] auto-install: threw:', e.message);
      }
    } else {
      console.log('[hooks] auto-install: hooks present in settings.json, skip');
    }
  }

 // HTTP サーバ起動
  const result = await findAvailablePort();
  if (result) {
    listeningPort = result.port;
    httpServer = result.server;
    setupHttpServer(httpServer);
    writeRuntime(listeningPort);
    isOffline = false;
  } else {
 // ポート全滅: offline モード
    isOffline = true;
  }

 // トレイ作成
  createTray();

 // ─── : Stage Window モードがデフォルト ────────────────────
 // KUROTAN_LEGACY_MODE=1 のみ旧 createMascotWindow 経路を使う（緊急退避）
 // KUROTAN_STAGE_MODE=0 で明示的に旧経路を選択することも可
  const useLegacyMode = process.env.KUROTAN_LEGACY_MODE === '1' || process.env.KUROTAN_STAGE_MODE === '0';
  if (!useLegacyMode) {
 // Stage Window モードに統合 (正式経路)
 // 環境変数を内部的に ON にして以降の分岐で一貫して参照できるようにする
    process.env.KUROTAN_STAGE_MODE = '1';
  }
  if (process.env.KUROTAN_STAGE_MODE === '1') {
    createStageWindow();
 // §6.6: 既存セッション復元 (fire-and-forget、起動を妨げない)
    scanAndRestoreActiveSessions().catch((e) => {
      writeMainLog('startup-restore-error', '', false, e.message);
    });
 // transcript watch は Stage モードでも動作させる（session_id ベース）
    setupTranscriptWatch();

 // 0.9.40/0.9.45: Stage Window 復帰追従 (ユーザー報告: 別ディスプレイにポップ + ドラッグ不可)
 // OS sleep の resume だけでなく、画面ロック解除 / display 構成変化 でも再生成する。
 // 500ms debounce で display-metrics-changed の連続発火を 1 回にマージ。
 // 0.9.28 で display-event 自動追従を意図的に無効化したが、復帰経路がカバー漏れだったため再有効化。
    let _stageRecreateTimer = null;
    function scheduleStageRecreate(reason) {
      writeMainLog('stage-recreate-scheduled', '', false, `reason=${reason}`);
      if (_stageRecreateTimer) clearTimeout(_stageRecreateTimer);
      _stageRecreateTimer = setTimeout(() => {
        _stageRecreateTimer = null;
        if (process.env.KUROTAN_STAGE_MODE !== '1') return;
        try {
          const displays = displayRegistry.getAllDisplays();
          const displaysShort = displays.map((d) => {
            const b = d.bounds;
            const sf = d.scaleFactor || 1;
            return `{id:${d.id},x:${b.x},y:${b.y},w:${b.width},h:${b.height},sf:${sf}}`;
          }).join(' ');
 // stageDisplayId が現存しない場合は primary にフォールバック + config 更新
          const cfg = loadConfig();
          if (cfg.stageDisplayId != null) {
            const found = displays.find((d) => d.id === cfg.stageDisplayId);
            if (!found) {
              const primary = displayRegistry.getPrimary();
              writeMainLog('stage-recreate-fallback', '', false,
                `stageDisplayId=${cfg.stageDisplayId} not found → primary=${primary.id}`);
              saveConfig({ stageDisplayId: primary.id });
            }
          }
          writeMainLog('stage-recreate-exec', '', false,
            `reason=${reason} displays=${displays.length} [${displaysShort}]`);
        } catch (e) {
          writeMainLog('stage-recreate-log-error', '', false, String(e));
        }
        if (stageWindow && !stageWindow.isDestroyed()) {
          stageWindow.destroy();
          stageWindow = null;
        }
        createStageWindow();
      }, 500);
    }

 // 復帰イベント (OS sleep → wake)
    powerMonitor.on('resume', () => scheduleStageRecreate('power-resume'));
 // 画面ロック解除 (Win+L → 戻り)
    powerMonitor.on('unlock-screen', () => scheduleStageRecreate('unlock-screen'));
 // display 構成変化 (モニタ抜き差し / 解像度変更 / 配置変更)
    screen.on('display-metrics-changed', (_e, display, changedMetrics) => {
      scheduleStageRecreate(`display-metrics-changed:${(changedMetrics || []).join(',')}`);
    });
    screen.on('display-added', (_e, display) => {
      scheduleStageRecreate(`display-added:${display && display.id}`);
    });
    screen.on('display-removed', (_e, display) => {
      scheduleStageRecreate(`display-removed:${display && display.id}`);
    });
    return;
  }

 // offline モードの場合、1 つウィンドウを生成して offline 状態を表示
  if (isOffline) {
    const offlineSessionId = 'offline-' + Date.now();
    createMascotWindow(offlineSessionId, {
      event: 'offline',
      session_id: offlineSessionId,
    });
  }

 // transcript_path mtime 監視ポーリング開始（メイン死活検知手段）
 // KUROTAN_TRANSCRIPT_IDLE_MS ミリ秒以上更新なし、またはファイル消失でセッション終了判定
  setupTranscriptWatch();

 // macOS: Dock アイコンクリックでウィンドウ再表示
  app.on('activate', () => {
    if (sessionWindows.size === 0 && !isOffline) {
 // 何もしない（セッション管理は hooks 経由）
    }
  });
});

// ─── アプリ終了処理 ────────────────────────────────────────────
// トレイ常駐型アプリ: 全ウィンドウ閉じても quit しない。
// Electron の window-all-closed は listener: () => void (引数なし)。
// リスナーを登録するだけでデフォルトの app.quit() が抑制される仕様。
// 旧コードの e.preventDefault() は e が undefined のため TypeError が発生し
// 例外が飲まれてたまたま動いていたが不正なコードだった (修正済み)。
// 終了はトレイメニューの「終了」ボタン (app.quit() 明示呼出) のみで行う。
// ※ app.exit(0) は before-quit をスキップし runtime.json 削除が走らないため使用禁止。
app.on('window-all-closed', () => {
 // リスナー登録のみで quit 抑制。本文は空で正しい。
});

// タスクトレイのゴーストアイコン残留対策:
// 全 exit 経路で tray.destroy() を呼ぶ。
// (Windows では Explorer がプロセス終了を検知するまでアイコン残る。明示 destroy で即時消える)
//
// 追加対策 [ghost-clear]:
// tray.destroy() の前に tray.setImage(empty) を呼ぶ。
// これにより Electron が Shell_NotifyIcon(NIM_MODIFY, ...) を発行し、
// Windows shell にアイコン更新通知が届く。その直後の destroy (NIM_DELETE) と
// 合わせることで、shell のアイコンキャッシュが正常にクリアされやすくなる。
// taskkill /F 等の SIGKILL 経路ではこの処理自体が実行されないため、
// その場合のゴースト残留は OS 仕様であり kurotan 側では対処不可。
function cleanupTray() {
  if (tray && !tray.isDestroyed()) {
    try {
      tray.removeAllListeners();
      tray.setContextMenu(null);
 // [ghost-clear] destroy 前に空アイコンで NIM_MODIFY を発行し shell に更新を通知
      tray.setImage(nativeImage.createEmpty());
      tray.destroy();
    } catch (e) {
 // 二重 destroy / 既に死亡 等は無視
    }
  }
  tray = null;
}

app.on('before-quit', () => {
  cleanupTray();
  deleteRuntime();
});

app.on('will-quit', cleanupTray);
app.on('quit',      cleanupTray);

// SIGINT / SIGTERM (ターミナル Ctrl+C や IDE 停止) もキャプチャ
process.on('SIGINT',  () => { cleanupTray(); deleteRuntime(); process.exit(0); });
process.on('SIGTERM', () => { cleanupTray(); deleteRuntime(); process.exit(0); });
process.on('exit',    () => { cleanupTray(); });

// renderer / GPU プロセス全滅時にも main を確実に終了させる
app.on('render-process-gone', (_event, _wc, details) => {
  if (details && details.reason === 'killed') {
    cleanupTray();
  }
});
