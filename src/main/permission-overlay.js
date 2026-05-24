'use strict';

/**
 * permission-overlay.js (0.9.47)
 *
 * claude_overlay の手動ボタン機能を kurotan に移植したオーバーレイ。
 * - 常時前面の細長いウィンドウにボタン列を表示
 * - ボタンクリックで現在フォーカス中のウィンドウに任意文字列 + Enter を送信
 * - koffi で user32.SendInput を呼び、ネイティブモジュールビルドを回避
 *
 * 使用方式: BrowserWindow は focusable:false にしてフォーカスを奪わない
 * → 文字列送信時、Claude Code のターミナル等が引き続きキーボード入力を受ける
 */

const path = require('path');
const { BrowserWindow, ipcMain, screen } = require('electron');

// ─── win32 SendInput バインディング ──────────────────────────────────
let _sendInput = null;
let _INPUT = null;
let _inputSize = 0;

let _getForegroundWindow = null;
let _immGetContext = null;
let _immNotifyIME = null;
let _immReleaseContext = null;
let _immGetOpenStatus = null;
let _immSetOpenStatus = null;
let _getCursorPos = null;
let _setCursorPos = null;

function _ensureKoffi() {
  if (_sendInput) return true;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const imm32 = koffi.load('imm32.dll');

    const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
      dx: 'int32',
      dy: 'int32',
      mouseData: 'uint32',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t',
    });
    const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
      wVk: 'uint16',
      wScan: 'uint16',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t',
    });
    const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
      uMsg: 'uint32',
      wParamL: 'uint16',
      wParamH: 'uint16',
    });
    const INPUT_UNION = koffi.union('INPUT_UNION', {
      mi: MOUSEINPUT,
      ki: KEYBDINPUT,
      hi: HARDWAREINPUT,
    });
    _INPUT = koffi.struct('INPUT', {
      type: 'uint32',
      u: INPUT_UNION,
    });
    _inputSize = koffi.sizeof(_INPUT);
    _sendInput = user32.func('uint32 SendInput(uint32, INPUT*, int)');

 // IME 制御 (日本語入力中の Enter キーが composition 確定で消費される問題対策)
    _getForegroundWindow = user32.func('uintptr_t GetForegroundWindow()');
    _immGetContext = imm32.func('uintptr_t ImmGetContext(uintptr_t)');
    _immNotifyIME = imm32.func('int ImmNotifyIME(uintptr_t, uint32, uint32, uint32)');
    _immReleaseContext = imm32.func('int ImmReleaseContext(uintptr_t, uintptr_t)');
    _immGetOpenStatus = imm32.func('int ImmGetOpenStatus(uintptr_t)');
    _immSetOpenStatus = imm32.func('int ImmSetOpenStatus(uintptr_t, int)');
 // ターゲット選択用: カーソル位置取得 / 設定
    _getCursorPos = user32.func('int GetCursorPos(_Out_ void *)');
    _setCursorPos = user32.func('int SetCursorPos(int, int)');
    return true;
  } catch (e) {
    console.error('[permission-overlay] koffi load failed:', e.message);
    return false;
  }
}

const NI_COMPOSITIONSTR = 0x0015;
const CPS_COMPLETE = 0x0001;

/** フォアグラウンドウィンドウの IME composition があれば確定する。
 * composition が active な状態で VK_RETURN を送ると IME が確定で消費して
 * アプリ側に Enter が届かない問題への対策。 */
function _commitImeComposition() {
  if (!_getForegroundWindow || !_immGetContext) return;
  try {
    const hwnd = _getForegroundWindow();
    if (!hwnd) return;
    const himc = _immGetContext(hwnd);
    if (himc) {
      _immNotifyIME(himc, NI_COMPOSITIONSTR, CPS_COMPLETE, 0);
      _immReleaseContext(hwnd, himc);
    }
  } catch (e) {
 // best effort
  }
}

/** IME を一時 OFF にして処理実行 → 復帰。
 * IME が ON 状態のままだと VK_RETURN を消費するケースの対策。 */
function _withImeOff(fn) {
  let hwnd = 0, himc = 0, wasOpen = 0, opened = false;
  try {
    if (_getForegroundWindow) hwnd = _getForegroundWindow();
    if (hwnd && _immGetContext) himc = _immGetContext(hwnd);
    if (himc && _immGetOpenStatus) {
      wasOpen = _immGetOpenStatus(himc);
      if (wasOpen) {
        _immSetOpenStatus(himc, 0);
        opened = true;
      }
    }
  } catch (_) {}
  try {
    fn();
  } finally {
    try {
      if (himc) {
        if (opened && _immSetOpenStatus) _immSetOpenStatus(himc, 1);
        if (_immReleaseContext) _immReleaseContext(hwnd, himc);
      }
    } catch (_) {}
  }
}

/** VK_RETURN を scancode 経由で送出。IME を素通りしやすい低レベル入力。 */
function _sendEnterScancode() {
  const down = _makeKeyInput(VK_RETURN, ENTER_SCANCODE, KEYEVENTF_SCANCODE);
  const up = _makeKeyInput(VK_RETURN, ENTER_SCANCODE, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP);
  _sendInput(2, [down, up], _inputSize);
}

const INPUT_KEYBOARD = 1;
const INPUT_MOUSE = 0;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_SCANCODE = 0x0008;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const VK_RETURN = 0x0D;
const ENTER_SCANCODE = 0x1C;

function _makeKeyInput(vk, scan, flags) {
  return {
    type: INPUT_KEYBOARD,
    u: {
      ki: {
        wVk: vk,
        wScan: scan,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  };
}

function _sendUnicodeChar(charCode) {
  const down = _makeKeyInput(0, charCode, KEYEVENTF_UNICODE);
  const up = _makeKeyInput(0, charCode, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
  _sendInput(2, [down, up], _inputSize);
}

function _sendVk(vk) {
  const down = _makeKeyInput(vk, 0, 0);
  const up = _makeKeyInput(vk, 0, KEYEVENTF_KEYUP);
  _sendInput(2, [down, up], _inputSize);
}

/**
 * 任意文字列 + Enter をフォーカス中のウィンドウへ送信する。
 * @param {string} text - 送信文字列 (Enter は含めない)
 * @param {boolean} appendEnter - true なら末尾に VK_RETURN を 1 回送る
 */
// 並行送信防止フラグ。clipboard 経路の遅延 Enter + クリップボード復元中の
// 別 send が走るとクリップボードや IME 状態が衝突するため直列化する。
let _sendInProgress = false;

function sendText(text, appendEnter = true) {
  if (!_ensureKoffi()) return false;
  if (typeof text !== 'string') return false;
  if (_sendInProgress) {
 // 直前の送信完了前は受け付けない (ユーザー連打対策)
    return false;
  }
  _sendInProgress = true;
  const target = _configStore && _configStore.getOverlayTarget();
  if (target) {
    const ok = _focusTarget(target);
    if (!ok) {
 // フォーカス失敗時はテキスト送信を中止 (現在のフォアグラウンド誤送信を防ぐ)
      console.warn('[permission-overlay] focusTarget failed, aborting send');
      _sendInProgress = false;
      return false;
    }
    setTimeout(() => {
      try { _doSendText(text, appendEnter); }
      finally { _scheduleSendInProgressRelease(text, appendEnter); }
    }, 80);
  } else {
    _doSendText(text, appendEnter);
    _scheduleSendInProgressRelease(text, appendEnter);
  }
  return true;
}

/** 送信完了タイミングに合わせて _sendInProgress を解除する。
 * clipboard 経路は遅延 Enter (250ms) + クリップボード復元 (700ms) があるため最長 700ms 後。 */
function _scheduleSendInProgressRelease(text, appendEnter) {
  const hasNonAscii = /[^\x00-\x7F]/.test(text);
  const delay = hasNonAscii ? 750 : 0;
  if (delay === 0) {
    _sendInProgress = false;
  } else {
    setTimeout(() => { _sendInProgress = false; }, delay);
  }
}

function _doSendText(text, appendEnter) {
  const hasNonAscii = /[^\x00-\x7F]/.test(text);
  if (hasNonAscii) {
    _sendViaClipboard(text, appendEnter);
    return;
  }
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 0x0A) {
      _sendVk(VK_RETURN);
    } else {
      _sendUnicodeChar(code);
    }
  }
  if (appendEnter) {
    _sendVk(VK_RETURN);
    _sendNumpadEnter();
  }
}

/** クリップボード経由で Ctrl+V 貼付 → 遅延 Enter → クリップボード復元。 */
function _sendViaClipboard(text, appendEnter) {
  try {
    const { clipboard } = require('electron');
    const original = clipboard.readText();
    clipboard.writeText(text);
    const VK_CONTROL = 0x11;
    const VK_V = 0x56;
    const inputs = [
      _makeKeyInput(VK_CONTROL, 0, 0),
      _makeKeyInput(VK_V, 0, 0),
      _makeKeyInput(VK_V, 0, KEYEVENTF_KEYUP),
      _makeKeyInput(VK_CONTROL, 0, KEYEVENTF_KEYUP),
    ];
    _sendInput(inputs.length, inputs, _inputSize);
 // 遅延 Enter (IME composition が落ち着くのを待つ)
    if (appendEnter) {
      setTimeout(() => {
        try {
          _sendVk(VK_RETURN);
          _sendNumpadEnter();
        } catch (_) {}
      }, 250);
    }
 // クリップボード復帰 (Enter 送信完了後の余裕を見て 700ms)
    setTimeout(() => {
      try { clipboard.writeText(original); } catch (_) {}
    }, 700);
  } catch (e) {
    console.error('[permission-overlay] clipboard send failed:', e.message);
  }
}

/** 現在のカーソル位置を {x, y} で返す。失敗時 null。 */
function _captureCursorPos() {
  if (!_ensureKoffi() || !_getCursorPos) return null;
  try {
    const buf = Buffer.alloc(8);
    const ok = _getCursorPos(buf);
 if (!ok) return null; // GetCursorPos 戻り値チェック
    return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
  } catch (e) {
    return null;
  }
}

/** ターゲット座標へカーソルを移動して左クリック (ウィンドウフォーカス用)。
 * 成功 (SetCursorPos & SendInput 両方 OK) で true。 */
function _focusTarget(target) {
  if (!_ensureKoffi()) return false;
  if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) return false;
  try {
    const cursorOk = _setCursorPos(target.x, target.y);
    if (!cursorOk) return false;
    const down = {
      type: INPUT_MOUSE,
      u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTDOWN, time: 0, dwExtraInfo: 0 } },
    };
    const up = {
      type: INPUT_MOUSE,
      u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_LEFTUP, time: 0, dwExtraInfo: 0 } },
    };
    const sent = _sendInput(2, [down, up], _inputSize);
 return sent === 2; // 2 イベント全送信成功時のみ true
  } catch (e) {
    console.error('[permission-overlay] focusTarget failed:', e.message);
    return false;
  }
}

/** Numpad Enter (拡張 scancode 0xE01C) を送る。
 * 通常 Enter (VK_RETURN) が IME に消費されたケースの保険。 */
function _sendNumpadEnter() {
  const flags = KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY;
  const down = _makeKeyInput(VK_RETURN, ENTER_SCANCODE, flags);
  const up = _makeKeyInput(VK_RETURN, ENTER_SCANCODE, flags | KEYEVENTF_KEYUP);
  _sendInput(2, [down, up], _inputSize);
}

// ─── BrowserWindow 管理 ─────────────────────────────────────────
let _win = null;
let _configStore = null;
let _dialogActive = false; // ダイアログ表示中の一時 resize はサイズ永続化対象外

const DEFAULT_BUTTONS = [
  { id: 'btn-1', label: '1', text: '1' },
  { id: 'btn-2', label: '2', text: '2' },
  { id: 'btn-3', label: '3', text: '3' },
  { id: 'btn-yes', label: 'YES', text: 'yes' },
  { id: 'btn-no', label: 'NO', text: 'no' },
];

function getButtons() {
  if (!_configStore) return DEFAULT_BUTTONS.slice();
  const stored = _configStore.getOverlayButtons();
  if (Array.isArray(stored) && stored.length > 0) return stored;
  return DEFAULT_BUTTONS.slice();
}

function setButtons(buttons) {
  if (!_configStore) return;
  if (!Array.isArray(buttons)) return;
  const sanitized = buttons
    .filter((b) => b && typeof b.label === 'string' && typeof b.text === 'string')
    .map((b, i) => ({
      id: typeof b.id === 'string' ? b.id : `btn-${Date.now()}-${i}`,
      label: b.label.slice(0, 16),
      text: b.text.slice(0, 512),
    }));
  _configStore.setOverlayButtons(sanitized);
 // 開いているオーバーレイに即時反映
  if (_win && !_win.isDestroyed()) {
    _win.webContents.send('overlay:buttons-updated', sanitized);
  }
}

function isVisible() {
  return !!(_win && !_win.isDestroyed() && _win.isVisible());
}

function _getInitialBounds() {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const sizeStored = _configStore && _configStore.getOverlaySize();
  const width = (sizeStored && Number.isFinite(sizeStored.width)) ? sizeStored.width : 360;
  const height = (sizeStored && Number.isFinite(sizeStored.height)) ? sizeStored.height : 44;
  const stored = _configStore && _configStore.getOverlayPosition();
  if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
    return { x: stored.x, y: stored.y, width, height };
  }
  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + 40,
    width,
    height,
  };
}

function show() {
  if (_win && !_win.isDestroyed()) {
    _win.show();
    return;
  }
  const bounds = _getInitialBounds();
  _win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
 resizable: true, // ネイティブは透過ウィンドウだと効かないのでカスタム実装で代用
    minWidth: 80,
    minHeight: 36,
    movable: true,
    minimizable: false,
    maximizable: false,
    focusable: false,
    title: 'kurotan overlay',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'permission-overlay-preload.js'),
    },
  });
  _win.setAlwaysOnTop(true, 'screen-saver');
  _win.loadFile(path.join(__dirname, '..', 'renderer', 'permission-overlay', 'index.html'));
  _win.on('move', () => {
    if (!_configStore || !_win || _win.isDestroyed()) return;
    const [x, y] = _win.getPosition();
    _configStore.setOverlayPosition({ x, y });
  });
 // ユーザーがドラッグ完了した時のみ保存 (programmatic setBounds では発火しない)
  _win.on('resized', () => {
    if (!_configStore || !_win || _win.isDestroyed()) return;
    if (_dialogActive) return;
    const [x, y] = _win.getPosition();
    const [w, h] = _win.getSize();
    _configStore.setOverlayPosition({ x, y });
    _configStore.setOverlaySize({ width: w, height: h });
  });
  _win.on('closed', () => {
    _win = null;
  });
}

function hide() {
  if (_win && !_win.isDestroyed()) {
    _win.close();
  }
  _win = null;
}

function toggle() {
  if (isVisible()) {
    hide();
  } else {
    show();
  }
  if (_configStore) _configStore.setOverlayEnabled(isVisible());
}

let _getBubble = null;

function broadcastBubble(bubble) {
  if (_win && !_win.isDestroyed()) {
    _win.webContents.send('overlay:bubble-style', bubble || {});
  }
}

function init(configStore, getBubble) {
  _configStore = configStore;
  _getBubble = typeof getBubble === 'function' ? getBubble : () => ({});

  ipcMain.handle('overlay:get-buttons', () => getButtons());
  ipcMain.handle('overlay:get-bubble', () => _getBubble());
  ipcMain.handle('overlay:set-buttons', (_e, buttons) => {
    setButtons(buttons);
    return getButtons();
  });
  ipcMain.on('overlay:send', (_e, payload) => {
    if (!payload || typeof payload.text !== 'string') return;
    sendText(payload.text, payload.appendEnter !== false);
  });
  ipcMain.on('overlay:close', () => hide());
 // ターゲット選択 / 取得 / クリア
  ipcMain.handle('overlay:capture-target', () => _captureCursorPos());
  ipcMain.handle('overlay:get-target', () => (_configStore ? _configStore.getOverlayTarget() : null));
  ipcMain.handle('overlay:set-target', (_e, target) => {
    if (_configStore) _configStore.setOverlayTarget(target);
    return target;
  });
  ipcMain.handle('overlay:clear-target', () => {
    if (_configStore) _configStore.setOverlayTarget(null);
    return null;
  });
  ipcMain.on('overlay:resize', (_e, payload) => {
    if (!_win || _win.isDestroyed()) return;
    const w = Math.max(120, Math.min(800, (payload && payload.width) || 360));
    const h = Math.max(40, Math.min(600, (payload && payload.height) || 44));
 const anchor = (payload && payload.anchor) || 'top'; // 'top' | 'bottom'
    const [curX, curY] = _win.getPosition();
    const [, curH] = _win.getSize();
    let nextY = curY;
    if (anchor === 'bottom') {
 // 下端を固定 → 上方向に伸びる
      nextY = curY + curH - h;
    }
    _win.setBounds({ x: curX, y: nextY, width: w, height: h });
  });
  ipcMain.on('overlay:set-focusable', (_e, payload) => {
    if (!_win || _win.isDestroyed()) return;
    const f = !!(payload && payload.focusable);
 _dialogActive = f; // ダイアログ表示中はサイズ永続化を停止
    _win.setFocusable(f);
    if (f) _win.focus();
  });
  ipcMain.on('overlay:set-ignore-mouse', (_e, payload) => {
    if (!_win || _win.isDestroyed()) return;
    const ignore = !!(payload && payload.ignore);
    _win.setIgnoreMouseEvents(ignore, { forward: true });
  });

 // ─── カスタムリサイズ (透過ウィンドウのため native edge-resize が使えない) ──
  let _resize = null;
  ipcMain.on('overlay:start-resize', (_e, edge) => {
    if (!_win || _win.isDestroyed()) return;
    const [x, y] = _win.getPosition();
    const [w, h] = _win.getSize();
    _resize = {
      edge: edge || {},
      startX: x, startY: y, startW: w, startH: h,
      cursorX0: null, cursorY0: null,
    };
 _dialogActive = true; // resize 中はサイズ永続化を 'resized' イベントで一括処理
  });
  ipcMain.on('overlay:resize-move', (_e, payload) => {
    if (!_resize || !_win || _win.isDestroyed()) return;
    if (_resize.cursorX0 === null) {
      _resize.cursorX0 = payload.x;
      _resize.cursorY0 = payload.y;
      return;
    }
    const dx = payload.x - _resize.cursorX0;
    const dy = payload.y - _resize.cursorY0;
    const { startX, startY, startW, startH, edge } = _resize;
    let newX = startX, newY = startY, newW = startW, newH = startH;
    if (edge.right) newW = Math.max(80, startW + dx);
    if (edge.bottom) newH = Math.max(36, startH + dy);
    if (edge.left) {
      newW = Math.max(80, startW - dx);
      newX = startX + (startW - newW);
    }
    if (edge.top) {
      newH = Math.max(36, startH - dy);
      newY = startY + (startH - newH);
    }
    _win.setBounds({ x: newX, y: newY, width: newW, height: newH });
  });
  ipcMain.on('overlay:end-resize', () => {
    if (!_win || _win.isDestroyed()) {
      _resize = null;
      _dialogActive = false;
      return;
    }
    if (_resize && _configStore) {
      const [x, y] = _win.getPosition();
      const [w, h] = _win.getSize();
      _configStore.setOverlayPosition({ x, y });
      _configStore.setOverlaySize({ width: w, height: h });
    }
    _resize = null;
    _dialogActive = false;
  });

 // ─── カスタムドラッグ (focusable:false で -webkit-app-region:drag が効かないため) ──
  let _drag = null;
  ipcMain.on('overlay:start-drag', () => {
    if (!_win || _win.isDestroyed()) return;
    const [x, y] = _win.getPosition();
    _drag = { startX: x, startY: y, cursorX0: null, cursorY0: null };
    _dialogActive = true;
  });
  ipcMain.on('overlay:drag-move', (_e, payload) => {
    if (!_drag || !_win || _win.isDestroyed()) return;
    if (_drag.cursorX0 === null) {
      _drag.cursorX0 = payload.x;
      _drag.cursorY0 = payload.y;
      return;
    }
    const dx = payload.x - _drag.cursorX0;
    const dy = payload.y - _drag.cursorY0;
    _win.setPosition(_drag.startX + dx, _drag.startY + dy);
  });
  ipcMain.on('overlay:end-drag', () => {
    if (_drag && _win && !_win.isDestroyed() && _configStore) {
      const [x, y] = _win.getPosition();
      _configStore.setOverlayPosition({ x, y });
    }
    _drag = null;
    _dialogActive = false;
  });

 // 前回起動時に開いていたら自動で開く
  if (_configStore && _configStore.getOverlayEnabled()) {
 // app.whenReady の後で呼ばれるため遅延不要
    show();
  }
}

module.exports = {
  init,
  show,
  hide,
  toggle,
  isVisible,
  sendText,
  getButtons,
  setButtons,
  broadcastBubble,
};
