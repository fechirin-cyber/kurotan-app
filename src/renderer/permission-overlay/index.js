'use strict';

/* global overlayBridge */

const buttonsEl = document.getElementById('buttons');
const addBtn = document.getElementById('add-btn');
const targetBtn = document.getElementById('target-btn');
const closeBtn = document.getElementById('close-btn');
const toastEl = document.getElementById('toast');
const countdownEl = document.getElementById('countdown');

const dialogMask = document.getElementById('dialog-mask');
const dlgLabel = document.getElementById('dlg-label');
const dlgText = document.getElementById('dlg-text');
const dlgOk = document.getElementById('dlg-ok');
const dlgCancel = document.getElementById('dlg-cancel');
const dlgDelete = document.getElementById('dlg-delete');
const dialogTitle = document.getElementById('dialog-title');

let _buttons = [];
let _editingId = null; // null = 新規追加

function renderButtons() {
  buttonsEl.innerHTML = '';
 // #buttons は CSS の display: contents で子を #bar の flex 子要素に flatten する
 // ここでスタイル上書きすると wrap が壊れるので何も設定しない
  for (const b of _buttons) {
    const el = document.createElement('button');
    el.className = 'btn';
    el.textContent = b.label;
    el.dataset.id = b.id;
    el.title = `送信: ${b.text || '(空)'} + Enter\n右クリックで編集`;
    el.addEventListener('click', () => {
      overlayBridge.sendText(b.text, true);
      showToast(`送信: ${b.label}`);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openEditDialog(b);
    });
    buttonsEl.appendChild(el);
  }
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.remove('show'), 900);
}

const DIALOG_WIDTH = 320;
const DIALOG_HEIGHT = 260;

// ユーザー操作で変形した直前のサイズを保持。ダイアログ開→閉で復元する。
let _savedSize = null;

function _expandForDialog() {
  document.body.classList.add('dialog-open');
  _savedSize = { w: window.innerWidth, h: window.innerHeight };
 overlayBridge.setFocusable(true); // 先に dialog-active フラグを立ててから resize
  overlayBridge.resize(DIALOG_WIDTH, DIALOG_HEIGHT, 'bottom');
}

function _shrinkAfterDialog() {
  document.body.classList.remove('dialog-open');
  if (_savedSize) {
    overlayBridge.resize(_savedSize.w, _savedSize.h, 'bottom');
    _savedSize = null;
  }
  overlayBridge.setFocusable(false);
}

function openAddDialog() {
  _editingId = null;
  dialogTitle.textContent = 'ボタン追加';
  dlgLabel.value = '';
  dlgText.value = '';
  dlgDelete.style.display = 'none';
  _expandForDialog();
  dialogMask.classList.add('show');
  setTimeout(() => dlgLabel.focus(), 0);
}

function openEditDialog(button) {
  _editingId = button.id;
  dialogTitle.textContent = 'ボタン編集';
  dlgLabel.value = button.label;
  dlgText.value = button.text;
  dlgDelete.style.display = '';
  _expandForDialog();
  dialogMask.classList.add('show');
  setTimeout(() => dlgLabel.focus(), 0);
}

function closeDialog() {
  dialogMask.classList.remove('show');
  _editingId = null;
  _shrinkAfterDialog();
}

async function saveDialog() {
  const label = dlgLabel.value.trim();
  const text = dlgText.value;
  if (!label) {
    showToast('ラベル必須');
    return;
  }
  let next;
  if (_editingId === null) {
    next = [..._buttons, { id: `btn-${Date.now()}`, label, text }];
  } else {
    next = _buttons.map((b) => (b.id === _editingId ? { ...b, label, text } : b));
  }
  _buttons = await overlayBridge.setButtons(next);
  renderButtons();
  closeDialog();
}

async function deleteCurrent() {
  if (_editingId === null) return;
  const next = _buttons.filter((b) => b.id !== _editingId);
  _buttons = await overlayBridge.setButtons(next);
  renderButtons();
  closeDialog();
}

addBtn.addEventListener('click', openAddDialog);
closeBtn.addEventListener('click', () => overlayBridge.close());

// ターゲット設定: クリック → 3 秒カウントダウン → カーソル位置記録
// 右クリック → ターゲット解除
let _capturing = false;
async function startTargetCapture() {
 if (_capturing) return; // 多重起動防止
  _capturing = true;
  try {
    for (let i = 3; i >= 1; i--) {
      countdownEl.textContent = String(i);
      countdownEl.classList.add('show');
      await new Promise((r) => setTimeout(r, 1000));
    }
    countdownEl.classList.remove('show');
    const pos = await overlayBridge.captureTarget();
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      await overlayBridge.setTarget(pos);
      targetBtn.classList.add('has-target');
      targetBtn.title = `フォーカス先: (${pos.x}, ${pos.y}) — 右クリックで解除`;
      showToast(`ターゲット: (${pos.x}, ${pos.y})`);
    } else {
      showToast('ターゲット取得失敗');
    }
  } catch (err) {
    countdownEl.classList.remove('show');
    showToast('ターゲット設定エラー');
    console.error('[overlay] captureTarget error', err);
  } finally {
    _capturing = false;
  }
}
targetBtn.addEventListener('click', () => {
  startTargetCapture();
});
targetBtn.addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  await overlayBridge.clearTarget();
  targetBtn.classList.remove('has-target');
  targetBtn.title = '送信前にフォーカスする座標を設定 (3秒カウント後にカーソル位置を記録)';
  showToast('ターゲット解除');
});
dlgOk.addEventListener('click', saveDialog);
dlgCancel.addEventListener('click', closeDialog);
dlgDelete.addEventListener('click', deleteCurrent);

document.addEventListener('keydown', (e) => {
  if (!dialogMask.classList.contains('show')) return;
  if (e.key === 'Escape') closeDialog();
  if (e.key === 'Enter' && document.activeElement !== dlgText) {
    e.preventDefault();
    saveDialog();
  }
});

overlayBridge.onButtonsUpdated((next) => {
  if (Array.isArray(next)) {
    _buttons = next;
    renderButtons();
  }
});

// ─── カスタムリサイズ + ドラッグ (click-through は撤廃: resize 競合のため) ───
let _resizing = false;
let _dragging = false;
let _pendingMove = null;
let _rafScheduled = false;

function _scheduleMove() {
  if (_rafScheduled) return;
  _rafScheduled = true;
  requestAnimationFrame(() => {
    _rafScheduled = false;
    if (!_pendingMove) return;
    const { kind, x, y } = _pendingMove;
    _pendingMove = null;
    if (kind === 'resize' && _resizing) overlayBridge.resizeMove(x, y);
    else if (kind === 'drag' && _dragging) overlayBridge.dragMove(x, y);
  });
}

document.addEventListener('mousedown', (e) => {
  const edgeEl = e.target.closest && e.target.closest('.resize-edge');
  if (edgeEl) {
    const parts = edgeEl.dataset.edge.split(',');
    _resizing = true;
    overlayBridge.startResize({
      top: parts.includes('top'),
      bottom: parts.includes('bottom'),
      left: parts.includes('left'),
      right: parts.includes('right'),
    });
    e.preventDefault();
    return;
  }
  const barEl = e.target.closest && e.target.closest('#bar');
  const btnEl = e.target.closest && e.target.closest('.btn');
  if (barEl && !btnEl) {
    _dragging = true;
    overlayBridge.startDrag();
    e.preventDefault();
  }
});

document.addEventListener('mousemove', (e) => {
  if (_resizing) {
    _pendingMove = { kind: 'resize', x: e.screenX, y: e.screenY };
    _scheduleMove();
  } else if (_dragging) {
    _pendingMove = { kind: 'drag', x: e.screenX, y: e.screenY };
    _scheduleMove();
  }
});

document.addEventListener('mouseup', () => {
  if (_resizing) {
    _resizing = false;
    overlayBridge.endResize();
  }
  if (_dragging) {
    _dragging = false;
    overlayBridge.endDrag();
  }
});

// 吹き出し設定を CSS 変数に反映
function _hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const m = hex.replace('#', '').match(/^([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}
function applyBubble(bubble) {
  const root = document.documentElement;
  if (!bubble) return;
  let rgb = null;
  let opacity = 0.85;
  if (bubble.bgColor) {
    rgb = _hexToRgb(bubble.bgColor);
  }
  if (bubble.bgOpacity != null) {
    opacity = bubble.bgOpacity;
  }
  if (rgb) {
    root.style.setProperty('--bubble-bg', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`);
 // 下地は明度を 30% 落とす + 少し不透明寄り
    const darken = (c) => Math.max(0, Math.round(c * 0.7));
    root.style.setProperty(
      '--bar-bg',
      `rgba(${darken(rgb.r)}, ${darken(rgb.g)}, ${darken(rgb.b)}, ${Math.min(1, opacity + 0.07)})`
    );
  }
  if (bubble.textColor) {
    root.style.setProperty('--bubble-text-color', bubble.textColor);
  }
  if (bubble.fontFamily) {
    root.style.setProperty(
      '--bubble-font-family',
      `${bubble.fontFamily}, 'Noto Sans JP', 'Meiryo', sans-serif`
    );
  }
  if (bubble.fontSize) {
    root.style.setProperty('--bubble-font-size', `${bubble.fontSize}px`);
  }
}

overlayBridge.onBubbleStyle((bubble) => applyBubble(bubble));

(async () => {
  _buttons = await overlayBridge.getButtons();
  renderButtons();
  try {
    const bubble = await overlayBridge.getBubble();
    applyBubble(bubble);
  } catch (e) {
 // 初期化エラーは fallback CSS 変数を維持
  }
  try {
    const target = await overlayBridge.getTarget();
    if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) {
      targetBtn.classList.add('has-target');
      targetBtn.title = `フォーカス先: (${target.x}, ${target.y}) — 右クリックで解除`;
    }
  } catch (_) {}
})();
