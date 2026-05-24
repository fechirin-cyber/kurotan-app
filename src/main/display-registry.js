'use strict';

/**
 * DisplayRegistry — Electron screen API への直接依存を集約するモジュール
 *
 * 役割:
 * - getAllDisplays / getPrimary / getDisplayKey / findByKey / resolveOrFallback の API 提供
 * - display-added / display-removed / display-metrics-changed イベントを購読して内部状態を更新
 * - 100ms キャッシュ (display-metrics-changed で invalidate)
 * - キャッシュ invalidate 中の並行コール対策 (≦10ms バイパスフラグ)
 * - 配置変更は行わない (副作用ゼロ)
 */

const { EventEmitter } = require('events');

const CACHE_TTL_MS = 100; // キャッシュ有効期間 (ms)
const BYPASS_TTL_MS = 10; // invalidate 直後のバイパス猶予 (ms)

class DisplayRegistry extends EventEmitter {
  constructor() {
    super();
 /** @type {Electron.Display[] | null} */
    this._cache = null;
 /** @type {number} キャッシュ取得時刻 (Date.now()) */
    this._cacheAt = 0;
 /** @type {boolean} invalidate 中フラグ (BYPASS_TTL_MS 以内) */
    this._bypassing = false;
 /** @type {ReturnType<typeof setTimeout> | null} */
    this._bypassTimer = null;
 /** @type {Electron.Screen | null} */
    this._screen = null;
    this._initialized = false;
  }

 /**
 * main process 起動時に 1 度だけ呼ぶ。
 * @param {Electron.Screen} screenModule - Electron の screen モジュール
 */
  init(screenModule) {
    if (this._initialized) return;
    this._screen = screenModule;
    this._initialized = true;

 // 初期キャッシュ取得
    this._refreshCache();

 // display イベント購読
    screenModule.on('display-added', (event, display) => {
      console.log(`[DisplayRegistry] display-added id=${display.id} ${this.getDisplayKey(display)}`);
      this._invalidate();
      this.emit('changed', { type: 'added', display });
    });

    screenModule.on('display-removed', (event, display) => {
      console.log(`[DisplayRegistry] display-removed id=${display.id} ${this.getDisplayKey(display)}`);
      this._invalidate();
      this.emit('changed', { type: 'removed', display });
    });

    screenModule.on('display-metrics-changed', (event, display, changedMetrics) => {
      console.log(`[DisplayRegistry] display-metrics-changed id=${display.id} metrics=${changedMetrics.join(',')}`);
      this._invalidate();
      this.emit('changed', { type: 'metrics-changed', display, changedMetrics });
    });
  }

 /** キャッシュを強制更新する */
  _refreshCache() {
    if (!this._screen) return;
    const t0 = process.hrtime.bigint();
    this._cache = this._screen.getAllDisplays();
    const t1 = process.hrtime.bigint();
    this._cacheAt = Date.now();
    const ms = Number(t1 - t0) / 1e6;
    if (ms > 10) {
      console.log(`[DisplayRegistry] getAllDisplays() took ${ms.toFixed(2)}ms`);
    }
  }

 /**
 * キャッシュを invalidate する。
 * BYPASS_TTL_MS 以内の並行コールは直接 screen API を呼ぶ。
 */
  _invalidate() {
    this._cache = null;
    this._cacheAt = 0;
    this._bypassing = true;

    if (this._bypassTimer) {
      clearTimeout(this._bypassTimer);
    }
    this._bypassTimer = setTimeout(() => {
      this._bypassing = false;
      this._bypassTimer = null;
 // バイパス期間終了後にキャッシュを再取得
      this._refreshCache();
    }, BYPASS_TTL_MS);
  }

 /**
 * 全ディスプレイ一覧を返す。100ms キャッシュ付き。
 * @returns {Electron.Display[]}
 */
  getAllDisplays() {
    if (!this._screen) return [];

 // バイパス中または TTL 切れの場合は直接 API 呼び出し
    const now = Date.now();
    if (this._bypassing || !this._cache || (now - this._cacheAt) > CACHE_TTL_MS) {
      this._refreshCache();
    }
    return this._cache || [];
  }

 /**
 * プライマリディスプレイを返す。
 * @returns {Electron.Display}
 */
  getPrimary() {
    if (!this._screen) {
      throw new Error('[DisplayRegistry] Not initialized');
    }
    return this._screen.getPrimaryDisplay();
  }

 /**
 * display 識別子文字列を生成する。
 * フォーマット: "<width>x<height>@<bx>,<by>"
 * 同型ディスプレイ衝突時のみ "#<id>" サフィックスを付与。
 *
 * @param {Electron.Display} display
 * @param {Electron.Display[]} [allDisplays] - 衝突チェック用。省略時は内部キャッシュを使用。
 * @returns {string}
 */
  getDisplayKey(display, allDisplays) {
    const { width, height, x: bx, y: by } = display.bounds;
    const base = `${width}x${height}@${bx},${by}`;

    const all = allDisplays || this.getAllDisplays();
 // 同一 base キーを持つ display が 2 つ以上あるか確認
    const sameBase = all.filter(d => {
      const { width: w, height: h, x: dx, y: dy } = d.bounds;
      return `${w}x${h}@${dx},${dy}` === base;
    });

    if (sameBase.length <= 1) {
      return base;
    }

 // 衝突: 初出 (最小 id) はサフィックスなし、以降は "#<id>"
    const ids = sameBase.map(d => d.id).sort((a, b) => a - b);
    if (display.id === ids[0]) {
      return base;
    }
    return `${base}#${display.id}`;
  }

 /**
 * displayKey から現存する display を逆引きする。
 * @param {string} displayKey
 * @returns {Electron.Display | null}
 */
  findByKey(displayKey) {
    const all = this.getAllDisplays();
    for (const d of all) {
      if (this.getDisplayKey(d, all) === displayKey) {
        return d;
      }
    }
    return null;
  }

 /**
 * displayKey + 相対座標から絶対座標を算出する。
 * display が現存すれば絶対座標を返し、なければ primary display へフォールバック。
 * このメソッドは配置への適用は行わず、計算ロジックのみ提供する。
 *
 * @param {string} displayKey
 * @param {number} relX - display workArea 左上を原点とした x
 * @param {number} relY - display workArea 左上を原点とした y
 * @returns {{ x: number, y: number, display: Electron.Display, fallback: boolean }}
 */
  resolveOrFallback(displayKey, relX, relY) {
    const found = this.findByKey(displayKey);
    if (found) {
      return {
        x: found.workArea.x + relX,
        y: found.workArea.y + relY,
        display: found,
        fallback: false,
      };
    }
 // フォールバック: primary display 右下デフォルト位置
    const primary = this.getPrimary();
    const { width, height } = primary.workAreaSize;
    return {
      x: width - 320 - 40,
      y: height - 220,
      display: primary,
      fallback: true,
    };
  }

 /**
 * 現在の display の scaleFactor に対応する cssScale を計算する。
 * 計算ロジックのみ提供する。
 *
 * @param {Electron.Display} display
 * @param {number} [baseScaleFactor=1.0]
 * @returns {number}
 */
  getCssScale(display, baseScaleFactor = 1.0) {
    const sf = display.scaleFactor || 1.0;
    return baseScaleFactor / sf;
  }
}

// シングルトン
const registry = new DisplayRegistry();

module.exports = registry;
