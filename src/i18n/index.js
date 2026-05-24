'use strict';

/**
 * src/i18n/index.js — kurotan i18n singleton
 *
 * main / renderer 両方から require できる pure JS モジュール。
 * Electron セキュリティ境界を越えないため、Node.js API のみ使用。
 *
 * 対応言語: ja / en / zh-CN / zh-TW / ko
 * フォールバック: 現在 locale に key なし → ja → key 文字列そのもの
 */

const path = require('path');
const fs   = require('fs');
const EventEmitter = require('events');

// ─── ロケールファイルパス ───────────────────────────────────────
const LOCALES_DIR = path.join(__dirname, 'locales');

const SUPPORTED_LANGS = ['ja', 'en', 'zh-CN', 'zh-TW', 'ko'];
const DEFAULT_LANG = 'ja';

// ─── 内部状態 ──────────────────────────────────────────────────
let _currentLang = DEFAULT_LANG;
/** @type {{ [key: string]: string }} */
let _dict = {};
/** @type {{ [key: string]: string }} */
let _fallbackDict = {}; // ja

const _emitter = new EventEmitter();

// ─── ロケールファイル読み込み ──────────────────────────────────

/**
 * ロケールファイルを読み込んで辞書オブジェクトを返す。
 * 失敗時は空オブジェクトを返す (起動を阻害しない)。
 * @param {string} lang
 * @returns {{ [key: string]: string }}
 */
function _loadLocale(lang) {
  try {
    const filePath = path.join(LOCALES_DIR, `${lang}.json`);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
 // ロード失敗は黙認 (フォールバックに委ねる)
  }
  return {};
}

// ─── 言語解決 ─────────────────────────────────────────────────

/**
 * システムロケール文字列を SUPPORTED_LANGS の 1 つに解決する。
 * @param {string} locale - e.g. 'ja-JP', 'zh-CN', 'ko-KR', 'en-US'
 * @returns {string}
 */
function _resolveLocale(locale) {
  if (!locale) return DEFAULT_LANG;
  const l = String(locale).toLowerCase();

 // ja* → ja
  if (l.startsWith('ja')) return 'ja';
 // zh-cn / zh-hans → zh-CN
  if (l === 'zh-cn' || l === 'zh-hans' || l === 'zh_cn' || l === 'zh_hans') return 'zh-CN';
 // zh-tw / zh-hk / zh-hant → zh-TW
  if (l.startsWith('zh-tw') || l.startsWith('zh-hk') || l.startsWith('zh-hant') ||
      l.startsWith('zh_tw') || l.startsWith('zh_hk') || l.startsWith('zh_hant')) return 'zh-TW';
 // ko* → ko
  if (l.startsWith('ko')) return 'ko';
 // zh* (残り: zh-SG 等) → zh-CN にフォールバック
  if (l.startsWith('zh')) return 'zh-CN';
 // それ以外 → en
  return 'en';
}

// ─── パブリック API ────────────────────────────────────────────

const i18n = {
 /**
 * 起動時初期化。
 * lang='auto' のとき app.getLocale() (main) または navigator.language (renderer) で解決する。
 * @param {string} [lang='auto'] - 'ja'|'en'|'zh-CN'|'zh-TW'|'ko'|'auto'
 */
  init(lang) {
 // ja フォールバック辞書を常時ロード
    _fallbackDict = _loadLocale('ja');

    let resolved = lang || 'auto';

    if (resolved === 'auto') {
 // main プロセス: app.getLocale()
 // renderer プロセス: navigator.language
 // どちらも使えない場合は ja
      try {
 // Electron main
        if (typeof require !== 'undefined') {
          try {
            const { app } = require('electron');
            if (app && typeof app.getLocale === 'function') {
              resolved = _resolveLocale(app.getLocale());
            } else {
              throw new Error('no-app');
            }
          } catch (_) {
 // renderer or non-electron: navigator.language
            if (typeof navigator !== 'undefined' && navigator.language) {
              resolved = _resolveLocale(navigator.language);
            } else {
              resolved = DEFAULT_LANG;
            }
          }
        }
      } catch (_) {
        resolved = DEFAULT_LANG;
      }
    } else if (!SUPPORTED_LANGS.includes(resolved)) {
      resolved = _resolveLocale(resolved);
    }

    _currentLang = resolved;
    _dict = _loadLocale(_currentLang);
  },

 /**
 * 翻訳文字列を取得する。
 * params に { name: 'foo' } を渡すと {name} プレースホルダを展開する。
 * @param {string} key
 * @param {{ [k: string]: string|number }} [params]
 * @returns {string}
 */
  t(key, params) {
    let str = _dict[key];

 // フォールバック 1: ja 辞書
    if (str === undefined || str === null) {
      str = _fallbackDict[key];
    }

 // フォールバック 2: キー文字列そのもの
    if (str === undefined || str === null) {
      str = key;
    }

 // プレースホルダ展開
    if (params && typeof params === 'object') {
      str = str.replace(/\{(\w+)\}/g, (_, k) => {
        const v = params[k];
        return (v !== undefined && v !== null) ? String(v) : `{${k}}`;
      });
    }

    return str;
  },

 /**
 * 現在の言語コードを返す。
 * @returns {'ja'|'en'|'zh-CN'|'zh-TW'|'ko'}
 */
  getCurrentLang() {
    return _currentLang;
  },

 /**
 * 言語を切り替えて 'change' イベントを発火する。
 * @param {string} lang
 */
  setLang(lang) {
    const resolved = SUPPORTED_LANGS.includes(lang) ? lang : _resolveLocale(lang);
    if (resolved === _currentLang) return;
    _currentLang = resolved;
    _dict = _loadLocale(_currentLang);
    _emitter.emit('change', _currentLang);
  },

 /**
 * 言語変更リスナを登録する (renderer 用)。
 * @param {'change'} event
 * @param {function} cb
 */
  on(event, cb) {
    _emitter.on(event, cb);
  },

 /**
 * 言語変更リスナを解除する。
 * @param {'change'} event
 * @param {function} cb
 */
  off(event, cb) {
    _emitter.off(event, cb);
  },

 /**
 * サポートされている言語コード一覧。
 */
  SUPPORTED_LANGS,
};

module.exports = i18n;
