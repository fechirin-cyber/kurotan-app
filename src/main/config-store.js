'use strict';

/**
 * config-store.js — §5.10.8.2 feature flag 永続化
 *
 * ~/.kurotan/config.json の `permissionUi.legacyDialog` を読み書きする。
 * 優先順位: 環境変数 KUROTAN_LEGACY_PERMISSION_DIALOG > config.json > 既定値 false
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ~/.kurotan/config.json のパス (Windows: %USERPROFILE%\.kurotan\config.json)
const KUROTAN_HOME = path.join(os.homedir(), '.kurotan');
const HOME_CONFIG_PATH = path.join(KUROTAN_HOME, 'config.json');

// ─── 内部キャッシュ ─────────────────────────────────────────────
let _cached = null; // null = 未読み込み

function _ensureDir() {
  if (!fs.existsSync(KUROTAN_HOME)) {
    fs.mkdirSync(KUROTAN_HOME, { recursive: true });
  }
}

function _read() {
  if (_cached !== null) return _cached;
  try {
    if (fs.existsSync(HOME_CONFIG_PATH)) {
      _cached = JSON.parse(fs.readFileSync(HOME_CONFIG_PATH, 'utf8'));
    } else {
      _cached = {};
    }
  } catch (e) {
    _cached = {};
  }
  return _cached;
}

function _write(obj) {
  _ensureDir();
  fs.writeFileSync(HOME_CONFIG_PATH, JSON.stringify(obj, null, 2), 'utf8');
  _cached = obj;
}

// ─── feature flag: permissionUi.legacyDialog ──────────────────

/**
 * 環境変数 > config.json > 既定値 false の優先順位で
 * `KUROTAN_LEGACY_PERMISSION_DIALOG` flag を返す。
 * @returns {boolean}
 */
function getLegacyPermissionDialog() {
 // 優先 1: 環境変数
  const envVal = process.env.KUROTAN_LEGACY_PERMISSION_DIALOG;
  if (envVal !== undefined) {
    return envVal === '1' || envVal === 'true';
  }
 // 優先 2: config.json
  const cfg = _read();
  if (cfg && cfg.permissionUi && typeof cfg.permissionUi.legacyDialog === 'boolean') {
    return cfg.permissionUi.legacyDialog;
  }
 // 既定値: false (新経路)
  return false;
}

/**
 * config.json の `permissionUi.legacyDialog` を更新する。
 * 環境変数が設定されている場合は config.json への書き込みのみ行い、
 * 実効値（getLegacyPermissionDialog）には反映されない（環境変数優先）。
 * @param {boolean} value
 */
function setLegacyPermissionDialog(value) {
  const cfg = _read();
  if (!cfg.permissionUi) cfg.permissionUi = {};
  cfg.permissionUi.legacyDialog = !!value;
  _write(cfg);
}

/**
 * グローバル変数 `__kurotanLegacyPermissionDialog` に展開する。
 * index.js の app.whenReady() 冒頭で呼ぶ。
 */
function init() {
  global.__kurotanLegacyPermissionDialog = getLegacyPermissionDialog();
}

// ─── permission overlay (0.9.47) ─────────────────────────────

function getOverlayButtons() {
  const cfg = _read();
  if (cfg && cfg.permissionOverlay && Array.isArray(cfg.permissionOverlay.buttons)) {
    return cfg.permissionOverlay.buttons;
  }
  return null;
}

function setOverlayButtons(buttons) {
  const cfg = _read();
  if (!cfg.permissionOverlay) cfg.permissionOverlay = {};
  cfg.permissionOverlay.buttons = buttons;
  _write(cfg);
}

function getOverlayEnabled() {
  const cfg = _read();
  return !!(cfg && cfg.permissionOverlay && cfg.permissionOverlay.enabled);
}

function setOverlayEnabled(enabled) {
  const cfg = _read();
  if (!cfg.permissionOverlay) cfg.permissionOverlay = {};
  cfg.permissionOverlay.enabled = !!enabled;
  _write(cfg);
}

function getOverlayPosition() {
  const cfg = _read();
  if (cfg && cfg.permissionOverlay && cfg.permissionOverlay.position) {
    return cfg.permissionOverlay.position;
  }
  return null;
}

function setOverlayPosition(pos) {
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
  const cfg = _read();
  if (!cfg.permissionOverlay) cfg.permissionOverlay = {};
  cfg.permissionOverlay.position = { x: pos.x, y: pos.y };
  _write(cfg);
}

function getOverlayTarget() {
  const cfg = _read();
  if (cfg && cfg.permissionOverlay && cfg.permissionOverlay.target) {
    return cfg.permissionOverlay.target;
  }
  return null;
}

function setOverlayTarget(target) {
  const cfg = _read();
  if (!cfg.permissionOverlay) cfg.permissionOverlay = {};
  if (target === null || target === undefined) {
    delete cfg.permissionOverlay.target;
  } else if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
    cfg.permissionOverlay.target = { x: target.x, y: target.y };
  }
  _write(cfg);
}

function getOverlaySize() {
  const cfg = _read();
  if (cfg && cfg.permissionOverlay && cfg.permissionOverlay.size) {
    return cfg.permissionOverlay.size;
  }
  return null;
}

function setOverlaySize(size) {
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
  const cfg = _read();
  if (!cfg.permissionOverlay) cfg.permissionOverlay = {};
  cfg.permissionOverlay.size = { width: size.width, height: size.height };
  _write(cfg);
}

module.exports = {
  init,
  getLegacyPermissionDialog,
  setLegacyPermissionDialog,
  getOverlayButtons,
  setOverlayButtons,
  getOverlayEnabled,
  setOverlayEnabled,
  getOverlayPosition,
  setOverlayPosition,
  getOverlaySize,
  setOverlaySize,
  getOverlayTarget,
  setOverlayTarget,
};
