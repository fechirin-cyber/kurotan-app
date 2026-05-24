'use strict';

/**
 * permission-dialog-preload.js
 * permission-dialog.html 専用の contextBridge preload。
 * main プロセスから requestId / toolName / toolInput を受け取り、
 * ユーザーの決定を main プロセスへ返す。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kurotanPermissionBridge', {
 /**
 * 初期化データを受信するリスナーを登録する。
 * main が 'permission-dialog:init' で { requestId, toolName, toolInput } を送る。
 * @param {function} callback - (data: {requestId, toolName, toolInput}) => void
 */
  onInit(callback) {
    ipcRenderer.removeAllListeners('permission-dialog:init');
    ipcRenderer.on('permission-dialog:init', (_event, data) => callback(data));
  },

 /**
 * 許可/拒否の決定を main に送信する。
 * @param {'allow'|'deny'} decision
 */
  sendDecision(decision) {
    ipcRenderer.send('permission-dialog:decision', { decision });
  },
});
