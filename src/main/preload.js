'use strict';

/**
 * preload.js
 * contextIsolation: true / nodeIntegration: false 環境で
 * renderer に安全な IPC ブリッジを公開する。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kurotanBridge', {
 /**
 * main から送信される hooks イベントを受信するリスナーを登録する。
 * 累積防止のため登録前に既存リスナーを除去する。
 * @param {function} callback - (payload: object) => void
 */
  onEvent(callback) {
    ipcRenderer.removeAllListeners('kurotan:event');
    ipcRenderer.on('kurotan:event', (_event, payload) => callback(payload));
  },

 // 0.9.32: onCursor / kurotan:cursor 撤廃 (mouseFollow 機能を削除)

 /**
 * online 復旧通知を受信するリスナーを登録する。
 * 累積防止のため登録前に既存リスナーを除去する。
 * @param {function} callback - ({port}: {port: number}) => void
 */
  onOnline(callback) {
    ipcRenderer.removeAllListeners('kurotan:online');
    ipcRenderer.on('kurotan:online', (_event, data) => callback(data));
  },

 /**
 * main プロセスにウィンドウクローズを要求する（farewell アニメ完了後）。
 */
  closeWindow() {
    ipcRenderer.send('kurotan:window-close');
  },

 /**
 * main プロセスに再接続を要求する（offline 状態からの復旧）。
 */
  requestReconnect() {
    ipcRenderer.send('kurotan:reconnect');
  },

 // 0.9.32: notifyStateChange / kurotan:state-change 撤廃 (mouseFollow 機能削除に伴い main 側の購読者なし)

 /**
 * welcome 吹き出しを受信するリスナーを登録する。
 * 累積防止のため登録前に既存リスナーを除去する。
 * @param {function} callback - ({text, durationMs}: {text: string, durationMs: number}) => void
 */
  onWelcome(callback) {
    ipcRenderer.removeAllListeners('kurotan:welcome');
    ipcRenderer.on('kurotan:welcome', (_event, data) => callback(data));
  },

 /**
 * welcome マスコットの fade-out 要求を受信するリスナーを登録する。
 * 累積防止のため登録前に既存リスナーを除去する。
 * @param {function} callback - () => void
 */
  onWelcomeClose(callback) {
    ipcRenderer.removeAllListeners('kurotan:welcome-close');
    ipcRenderer.on('kurotan:welcome-close', (_event) => callback());
  },

 /**
 * Stage Window の click-through 状態を main に依頼する（）。
 * @param {boolean} ignore - true: click-through ON / false: click-through OFF
 */
  setIgnoreMouseEvents(ignore) {
    ipcRenderer.send('kurotan:set-ignore-mouse', { ignore });
  },

 // ─── : Stage Window IPC ────────────────────────────────

 /**
 * マスコット追加通知を受信するリスナーを登録する（）。
 * @param {function} callback - (data: { sessionId, cwd, model, position, hueIndex, badgeIndex }) => void
 */
  onMascotAdd(callback) {
    ipcRenderer.removeAllListeners('kurotan:mascot-add');
    ipcRenderer.on('kurotan:mascot-add', (_event, data) => callback(data));
  },

 /**
 * マスコット状態更新通知を受信するリスナーを登録する（）。
 * @param {function} callback - (data: { sessionId, state, toolName?, skillName?, bubbleText?, children? }) => void
 */
  onMascotUpdate(callback) {
    ipcRenderer.removeAllListeners('kurotan:mascot-update');
    ipcRenderer.on('kurotan:mascot-update', (_event, data) => callback(data));
  },

 /**
 * マスコット削除通知を受信するリスナーを登録する（）。
 * @param {function} callback - (data: { sessionId, withFarewell }) => void
 */
  onMascotRemove(callback) {
    ipcRenderer.removeAllListeners('kurotan:mascot-remove');
    ipcRenderer.on('kurotan:mascot-remove', (_event, data) => callback(data));
  },

 /**
 * ドラッグ完了時の位置を main に保存する（）。
 * @param {string} sessionId
 * @param {number} x
 * @param {number} y
 */
  savePosition(sessionId, x, y) {
    ipcRenderer.send('kurotan:position-update', { sessionId, x, y });
  },

 /**
 * 右クリックメニューを main に要求する（）。
 * @param {string} sessionId
 * @param {number} x
 * @param {number} y
 */
  showContextMenu(sessionId, x, y) {
    ipcRenderer.send('kurotan:show-context-menu', { sessionId, x, y });
  },

 /**
 * renderer クラッシュ後の復旧用: セッション一覧を main に要求する（）。
 * @param {function} callback - (sessions: Array<{sessionId, cwd, position, hueIndex, badgeIndex, state}>) => void
 */
  onSessionRestore(callback) {
    ipcRenderer.removeAllListeners('kurotan:session-restore');
    ipcRenderer.on('kurotan:session-restore', (_event, data) => callback(data));
  },

 /**
 * ULTRATHINK イースターエッグ発火通知を受信するリスナーを登録する（§5.7.1）。
 * main が payload 検査で ultrathink を検出したら sessionId を通知する。
 * @param {function} callback - (sessionId: string) => void
 */
  onUltrathinkTrigger(callback) {
    ipcRenderer.removeAllListeners('kurotan:ultrathink-trigger');
    ipcRenderer.on('kurotan:ultrathink-trigger', (_event, data) => callback(data.sessionId));
  },

 /**
 * KORONE イースターエッグ発火通知を受信するリスナーを登録する（§5.7.2）。
 * main が UserPromptSubmit で "korone" / "ころね" を検出したら全 Stage に通知する。
 * in-memory state のみ (config.json 永続化なし)。再起動でリセット。
 * @param {function} callback - ({ sessionId: string }) => void
 */
  onEasterEggKorone(callback) {
    ipcRenderer.removeAllListeners('kurotan:easter-egg-korone');
    ipcRenderer.on('kurotan:easter-egg-korone', (_event, data) => callback(data));
  },

 /**
 * 深夜モード変更通知を受信するリスナーを登録する（§5.5 / §8.1）。
 * main が applyConfig / saveConfig 時に broadcast する。
 * @param {function} callback - (nightMode: boolean) => void
 */
  onNightModeChange(callback) {
    ipcRenderer.removeAllListeners('kurotan:night-mode');
    ipcRenderer.on('kurotan:night-mode', (_event, data) => callback(data.nightMode));
  },

 /**
 * アートスタイル変更通知を受信するリスナーを登録する。
 * main が applyConfig / saveConfig 時に broadcast する。
 * @param {function} callback - (artStyle: string) => void
 */
  onArtStyleChange(callback) {
    ipcRenderer.removeAllListeners('kurotan:art-style-change');
    ipcRenderer.on('kurotan:art-style-change', (_event, data) => callback(data.artStyle));
  },

 /**
 * 0.9.41: i18n locale 変更通知を受信するリスナーを登録する。
 * @param {function} callback - (data: { lang, dict, fallbackDict }) => void
 */
  onLocaleChanged(callback) {
    ipcRenderer.removeAllListeners('kurotan:locale-changed');
    ipcRenderer.on('kurotan:locale-changed', (_event, data) => callback(data));
  },

 /**
 * 0.9.15: セッション名ラベル ON/OFF 通知を受信するリスナーを登録する。
 * @param {function} callback - (show: boolean) => void
 */
  onShowSessionLabelChange(callback) {
    ipcRenderer.removeAllListeners('kurotan:show-session-label-change');
    ipcRenderer.on('kurotan:show-session-label-change', (_event, data) => callback(!!data.show));
  },

 /**
 * 吹き出しスタイル変更通知を受信するリスナーを登録する。
 * @param {function} callback - (bubble: object) => void
 */
  onBubbleStyleChange(callback) {
    ipcRenderer.removeAllListeners('kurotan:bubble-style');
    ipcRenderer.on('kurotan:bubble-style', (_event, data) => callback(data.bubble));
  },

 /**
 * PostToolUse の "task done" ポップ演出通知を受信するリスナーを登録する。
 * @param {function} callback - (data: { sessionId, toolName }) => void
 */
  onMascotTaskDone(callback) {
    ipcRenderer.removeAllListeners('kurotan:mascot-task-done');
    ipcRenderer.on('kurotan:mascot-task-done', (_event, data) => callback(data));
  },

 /**
 * §5.6.7 SubagentStop ✨ sparkle 演出通知を受信するリスナーを登録する。
 * main process は SubagentStop (主) または PostToolUse(Agent) (副) 受信時に送信する。
 * payload: { sessionId: string, success: boolean }
 * @param {function} callback - ({ sessionId: string, success: boolean }) => void
 */
  onSubagentSparkle(callback) {
    ipcRenderer.removeAllListeners('kurotan:subagent-sparkle');
    ipcRenderer.on('kurotan:subagent-sparkle', (_event, data) => callback(data));
  },

 // ─── : contextLevel / compact refresh ───────────────

 /**
 * contextLevel 変更通知を受信するリスナーを登録する (§5.9.2 / §5.9.6)。
 * payload: { sessionId, level } level: 'low'|'mid'|'high'|'critical'
 * 本文・transcript_path・トークン数は含まない (プライバシー §12 項目 6)。
 * @param {function} callback - ({ sessionId: string, level: string }) => void
 */
  onContextLevel(callback) {
    ipcRenderer.removeAllListeners('kurotan:context-level');
    ipcRenderer.on('kurotan:context-level', (_event, data) => callback(data));
  },

 /**
 * compact refresh 演出通知を受信するリスナーを登録する (§5.9.5)。
 * SessionStart / PreCompact / PostCompact 受信時に発火する。
 * @param {function} callback - ({ sessionId: string }) => void
 */
  onCompactRefresh(callback) {
    ipcRenderer.removeAllListeners('kurotan:compact-refresh');
    ipcRenderer.on('kurotan:compact-refresh', (_event, data) => callback(data));
  },

 /**
 * contextMotion 設定変更通知を受信するリスナーを登録する。
 * settings から enabled 変更時に broadcast される。
 * @param {function} callback - ({ contextMotion: object }) => void
 */
  onContextMotion(callback) {
    ipcRenderer.removeAllListeners('kurotan:context-motion');
    ipcRenderer.on('kurotan:context-motion', (_event, data) => callback(data.contextMotion));
  },

 // ─── Permission Bridge (spike) ───────────────────────

 /**
 * main から送信される許可リクエストを受信するリスナーを登録する。
 * @param {function} callback - (data: { sessionId, requestId, toolName, toolInput }) => void
 */
  onPermissionRequest(callback) {
    ipcRenderer.removeAllListeners('kurotan:permission-request');
    ipcRenderer.on('kurotan:permission-request', (_event, data) => callback(data));
  },

 /**
 * 許可/拒否の決定を main に送信する。
 *
 * 新シグネチャ (§5.10.3): オブジェクト形式で呼ぶ
 * sendPermissionDecision({ requestId, decision, durationMs, source })
 *
 * 旧シグネチャ (legacy 互換): 位置引数形式でも動作する
 * sendPermissionDecision(requestId, decision)
 *
 * @param {string|object} requestIdOrObj
 * @param {'allow'|'deny'} [decision]
 */
  sendPermissionDecision(requestIdOrObj, decision) {
    let payload;
    if (requestIdOrObj && typeof requestIdOrObj === 'object') {
 // 新シグネチャ: { requestId, decision, durationMs, source }
      payload = requestIdOrObj;
    } else {
 // 旧シグネチャ互換: (requestId, decision)
      payload = { requestId: requestIdOrObj, decision };
    }
    ipcRenderer.send('kurotan:permission-decision', payload);
  },

 // ─── ローカル検証用 debug IPC (/3) ───────────────

 /**
 * debug-context-level 受信: 全マスコットの contextLevel を value (0.0〜1.0) で上書きする。
 * 0.75 → sleepy / 0.85 → drowsy / 0.95 → yawn / 0.99 → stretch (仕様 §5.9)
 * @param {function} callback - ({ value: number }) => void
 */
  onDebugContextLevel(callback) {
    ipcRenderer.removeAllListeners('kurotan:debug-context-level');
    ipcRenderer.on('kurotan:debug-context-level', (_event, data) => callback(data));
  },

 /**
 * debug-reset-onboarding 受信: localStorage の onboarding flag を全削除する。
 * 設定画面の onboarding tooltip 初回のみ表示を検証するために使う。
 * @param {function} callback - () => void
 */
  onDebugResetOnboarding(callback) {
    ipcRenderer.removeAllListeners('kurotan:debug-reset-onboarding');
    ipcRenderer.on('kurotan:debug-reset-onboarding', (_event) => callback());
  },

 /**
 * debug-dom-dump 受信: 全マスコットの DOM 状態を収集して返す。
 * @param {function} callback - ({ requestId }) => void
 */
  onDebugDomDump(callback) {
    ipcRenderer.removeAllListeners('kurotan:debug-dom-dump');
    ipcRenderer.on('kurotan:debug-dom-dump', (_event, data) => callback(data));
  },

 /**
 * DOM dump 結果を main process へ送信する。
 * @param {object} data - { requestId, mascots }
 */
  sendDomDumpResponse(data) {
    ipcRenderer.send('kurotan:debug-dom-dump-response', data);
  },

 // ─── 設定画面 API (§8 / §9.2) ────────────────────────────────

 /**
 * 設定画面用 API。contextIsolation 経由で kurotanBridge.settings として公開。
 */
  settings: {
 /**
 * 現在の config.json を返す。
 * @returns {Promise<object>}
 */
    getConfig() {
      return ipcRenderer.invoke('kurotan:settings:get');
    },

 /**
 * config.json を部分更新して保存する。
 * @param {object} partial - 更新するキーのみ渡す
 * @returns {Promise<void>}
 */
    saveConfig(partial) {
      return ipcRenderer.invoke('kurotan:settings:save', partial);
    },

 /**
 * hooks インストーラを呼ぶ。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
    installHooks() {
      return ipcRenderer.invoke('kurotan:settings:install-hooks');
    },

 /**
 * hooks アンインストーラを呼ぶ。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
    uninstallHooks() {
      return ipcRenderer.invoke('kurotan:settings:uninstall-hooks');
    },
  },
});
