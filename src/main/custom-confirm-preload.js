'use strict';

/**
 * custom-confirm-preload.js — Custom 設定ウィンドウ用 preload (§5.11.5.4 v2)
 *
 * contextBridge で window.kurotanCustomConfirm.* API を expose する。
 * IPC チャンネルは §5.11.5.4 (v2 / 2026-05-02 改訂) に定義。
 *
 * v2 変更点:
 * - 旧 listPatterns / setPattern は撤去 (spec plan-A)
 * - 新規: getToolTypes / setToolType / listExceptions / setException / removeException
 * - 既存維持: listHistory / getMode / onModeChanged / closeWindow
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kurotanCustomConfirm', {
 // ─── 既存維持 ──────────────────────────────────────────────────

 /**
 * 履歴エントリを取得する。
 * @param {{ since?: string, limit?: number }} opts
 */
  listHistory: (opts) => ipcRenderer.invoke('kurotan:custom-confirm:list-history', opts || {}),

 /** 現在の permissionMode を取得する */
  getMode: () => ipcRenderer.invoke('kurotan:custom-confirm:get-mode'),

 /**
 * kurotan:permission-mode-changed イベントを購読する。
 * @param {function} callback - ({ mode }) を受け取る
 * @returns {function} 購読解除関数
 */
  onModeChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('kurotan:permission-mode-changed', handler);
    return () => ipcRenderer.removeListener('kurotan:permission-mode-changed', handler);
  },

 /** このウィンドウを閉じる (Esc キーショートカット用) */
  closeWindow: () => ipcRenderer.invoke('kurotan:custom-confirm:close-window'),

 // ─── v2 新規 (§5.11.5.4) ───────────────────────────────────────

 /**
 * 全ツール種別の 4 状態を取得する。
 * @returns {Promise<{ toolTypes: { Bash: string, ..., Other: string } }>}
 */
  getToolTypes: () => ipcRenderer.invoke('kurotan:custom-confirm:get-tool-types'),

 /**
 * 1 種別の状態を変更する。
 * @param {{ toolType: string, decision: "allow"|"ask"|"deny"|"inherit" }} data
 * @returns {Promise<{ ok: true }|{ error: string }>}
 */
  setToolType: (data) => ipcRenderer.invoke('kurotan:custom-confirm:set-tool-type', data),

 /**
 * 個別パターン例外の全件を取得する。
 * @returns {Promise<{ exceptions: Array }>}
 */
  listExceptions: () => ipcRenderer.invoke('kurotan:custom-confirm:list-exceptions'),

 /**
 * 例外を追加または上書きする (rule が既存なら decision を更新)。
 * @param {{ rule: string, decision: string, source?: string }} data
 * @returns {Promise<{ ok: true, exception: object }|{ error: string }>}
 */
  setException: (data) => ipcRenderer.invoke('kurotan:custom-confirm:set-exception', data),

 /**
 * 例外を削除する。
 * @param {{ rule: string }} data
 * @returns {Promise<{ ok: true, removed: number }|{ error: string }>}
 */
  removeException: (data) => ipcRenderer.invoke('kurotan:custom-confirm:remove-exception', data),
});
