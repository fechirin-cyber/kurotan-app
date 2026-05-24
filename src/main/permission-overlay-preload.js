'use strict';

/**
 * permission-overlay-preload.js (0.9.47)
 * パーミッションオーバーレイ renderer 用 IPC ブリッジ。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayBridge', {
  getButtons() {
    return ipcRenderer.invoke('overlay:get-buttons');
  },
  setButtons(buttons) {
    return ipcRenderer.invoke('overlay:set-buttons', buttons);
  },
  sendText(text, appendEnter = true) {
    ipcRenderer.send('overlay:send', { text, appendEnter });
  },
  close() {
    ipcRenderer.send('overlay:close');
  },
  resize(width, height, anchor) {
    ipcRenderer.send('overlay:resize', { width, height, anchor });
  },
  setFocusable(focusable) {
    ipcRenderer.send('overlay:set-focusable', { focusable });
  },
  setIgnoreMouseEvents(ignore) {
    ipcRenderer.send('overlay:set-ignore-mouse', { ignore });
  },
  startResize(edge) {
    ipcRenderer.send('overlay:start-resize', edge);
  },
  resizeMove(x, y) {
    ipcRenderer.send('overlay:resize-move', { x, y });
  },
  endResize() {
    ipcRenderer.send('overlay:end-resize');
  },
  startDrag() {
    ipcRenderer.send('overlay:start-drag');
  },
  dragMove(x, y) {
    ipcRenderer.send('overlay:drag-move', { x, y });
  },
  endDrag() {
    ipcRenderer.send('overlay:end-drag');
  },
  onButtonsUpdated(callback) {
    ipcRenderer.removeAllListeners('overlay:buttons-updated');
    ipcRenderer.on('overlay:buttons-updated', (_e, data) => callback(data));
  },
  getBubble() {
    return ipcRenderer.invoke('overlay:get-bubble');
  },
  onBubbleStyle(callback) {
    ipcRenderer.removeAllListeners('overlay:bubble-style');
    ipcRenderer.on('overlay:bubble-style', (_e, bubble) => callback(bubble));
  },
  captureTarget() {
    return ipcRenderer.invoke('overlay:capture-target');
  },
  getTarget() {
    return ipcRenderer.invoke('overlay:get-target');
  },
  setTarget(target) {
    return ipcRenderer.invoke('overlay:set-target', target);
  },
  clearTarget() {
    return ipcRenderer.invoke('overlay:clear-target');
  },
});
