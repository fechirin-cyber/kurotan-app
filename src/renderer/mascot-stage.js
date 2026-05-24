'use strict';

/**
 * mascot-stage.js - Stage Window renderer (/3)
 *
 * 担当:
 * - MascotRegistry: セッション → MascotElement の管理
 * - MascotElement: 1 匹分の DOM 生成・状態遷移・吹き出し・子くろたん
 * - DragController: ドラッグ移動・位置保存
 * - click-through 制御 (hover 検知 + IPC)
 * - ULTRATHINK イースターエッグ (§5.6)
 */

// ─── 0.9.41: i18n インライン helper (contextIsolation 環境のため require 不可) ──
// ※ ローカル変数 `t` (DOM 要素) との衝突回避のため `i18nT` 名で公開
var _i18nDict = {};
var _i18nFallbackDict = {};
function i18nT(key, params) {
  var s = _i18nDict[key];
  if (s === undefined || s === null) s = _i18nFallbackDict[key];
  if (s === undefined || s === null) s = key;
  if (params && typeof params === 'object') {
    s = s.replace(/\{(\w+)\}/g, function(_, k) {
      var v = params[k];
      return (v !== undefined && v !== null) ? String(v) : '{' + k + '}';
    });
  }
  return s;
}
if (window.kurotanBridge && window.kurotanBridge.onLocaleChanged) {
  window.kurotanBridge.onLocaleChanged(function(data) {
    if (!data) return;
    _i18nDict = data.dict || {};
    _i18nFallbackDict = data.fallbackDict || {};
  });
}

// 0.9.58: 子くろたん用ランダムセリフピッカー
function _pickChildLine(prefix, count) {
  var n = Math.floor(Math.random() * count) + 1;
  return i18nT(prefix + '_' + n);
}

// ─── 定数 ──────────────────────────────────────────────────────

const HIT_THROTTLE_MS = 16; // click-through hover 判定 throttle (60fps)
const DRAG_SAVE_DEBOUNCE_MS = 500; // 位置保存 debounce
const ULTRATHINK_DURATION_MS = 10000; // ULTRATHINK 演出上限 (§5.6.3)
const MATRIX_COLS = 20; // マトリックス列数 (DOM プール)

// §5.6.7 SubagentStop ✨ パーティクル演出
const SPARKLE_POOL_SIZE = 6; // 固定長 DOM プールサイズ (merge 最大 6 個まで対応)
const SPARKLE_BASE_COUNT = 4; // 通常時パーティクル数
const SPARKLE_MERGE_COUNT = 6; // throttle merge 時パーティクル数
const SPARKLE_THROTTLE_MS = 500; // 同一親への重複発火を merge する窓 (ms) (§5.6.7)
const SPARKLE_DURATION_MS = 500; // 演出時間 (CSS animation と同値)
// 放射角度 (度): 上方向 270deg を中心に ±30° の範囲で 4〜6 方向を均等配置
// JS の Math.cos/sin は radian なので変換: rad = deg * Math.PI / 180
const SPARKLE_ANGLES_4 = [255, 270, 285, 300]; // 4 粒子: 255/270/285/300 deg (上方向 ±30°)
// merge 時は上方向を広げて 6 粒子に増やす (±45° まで拡張)
const SPARKLE_ANGLES_6 = [240, 255, 270, 285, 300, 315]; // 6 粒子: 240〜315 deg (±37.5°)

// レアモーション設定 (§5.5) — 要望: 30〜60 秒に 1 回
const RARE_MOTION_MIN_MS = 30000; // 最短インターバル 30 秒
const RARE_MOTION_MAX_MS = 60000; // 最長インターバル 60 秒
const RARE_MOTION_DURATION_MS = 2000; // 1 モーション再生時間 (head-tilt 2.0s に合わせる)
const RARE_MOTIONS = ['yawn', 'stretch', 'tail-wag', 'ear-twitch', 'head-tilt'];

// 深夜時間帯 (§8.1): nightMode=true かつ 22:00〜07:00 はレアモーションをスキップ
const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR   = 7;

// ─── グローバル: 深夜モード状態 ────────────────────────────────
let _nightMode = false;

// ─── : contextMotion 設定 (§5.9.8) ──────────────────
/** contextMotion.enabled (デフォルト true) */
let _contextMotionEnabled = true;

// ─── グローバル: アートスタイル状態 ────────────────────────────
let _artStyle = 'sd';

// ─── グローバル: KORONE イースターエッグ状態 (§5.7.2) ──────────
// in-memory のみ。再起動でリセット。config.json 永続化なし。
// SD のみ有効 (pixel モードでは CSS ルールなし = EE 発火しても見た目変わらない仕様)
let _koroneMode = false;

// ─── グローバル: セッション名ラベル表示 ON/OFF (0.9.15) ─────────
// main から kurotan:show-session-label-change で broadcast される。
// 初期値は mascot-add payload の showSessionLabel から拾う (true をデフォルト)。
let _showSessionLabel = true;

/**
 * 現在の _artStyle に基づいてアセットパスを解決する。
 * @param {string} filename - 'idle.png' / 'child/child_idle.png' 等
 * @returns {string}
 */
function getAssetPath(filename) {
  return _artStyle === 'sd'
    ? `../../assets/sd/${filename}`
    : `../../assets/pixel/${filename}`;
}

/**
 * マスコット DOM 全体の background-image を現在の _artStyle で一斉再設定する。
 * artStyle 変更時に呼び出す。
 */
function applyArtStyleToAll() {
 // #mascot-stage に data-art-style を設定 → CSS セレクタ [data-art-style="sd"] によるサイズ切替
  const stageEl = document.getElementById('mascot-stage');
  if (stageEl) {
    stageEl.dataset.artStyle = _artStyle;
  }

 // 親スプライト: data-state に応じたアセット名
  const STATE_ASSET_MAP = {
    idle:       'idle.png',
    thinking:   'thinking.png',
    tool_read:  'tool_read.png',
    tool_edit:  'tool_edit.png',
    tool_bash:  'tool_bash.png',
    tool_web:   'tool_web.png',
    tool_skill: 'tool_skill.png',
    tool_other: 'tool_other.png',
    success:    'success.png',
    error:      'error.png',
    permission: 'permission.png',
    farewell:   'farewell.png',
    offline:    'offline.png',
  };

 // 親スプライト・子スプライトの background-image は CSS に委譲（inline style 上書き不可）。
 // #mascot-stage[data-art-style] への data-art-style 設定のみ行う（上記 stageEl.dataset.artStyle で実施済み）。
}

// 状態別吹き出し自動消去タイマー (0 = 消去しない)
const BUBBLE_TIMEOUT_MS = {
  idle:       0,
  thinking:   0,
  tool_read:  0,
  tool_edit:  0,
  tool_bash:  0,
  tool_web:   0,
  tool_skill: 0,
  tool_other: 0,
  success:    0,
  error:      4000,
  permission: 0,
  farewell:   3000,
  offline:    0,
};

// ─── ユーティリティ ────────────────────────────────────────────

function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

function detectUltrathink(text) {
  return typeof text === 'string' && /ultrathink/i.test(text);
}

// ─── MascotElement ─────────────────────────────────────────────

/**
 * 1 匹分のマスコット DOM と状態を管理するクラス。
 */
class MascotElement {
 /**
 * @param {string} sessionId
 * @param {{ cwd: string, model: string, position: {x: number, y: number}, hueIndex: number, badgeIndex: number }} opts
 */
  constructor(sessionId, opts) {
    this.sessionId = sessionId;
    this.cwd = opts.cwd || '';
    this.sessionLabel = opts.sessionLabel || '';
    this.model = opts.model || '';
    this.x = (opts.position && opts.position.x != null) ? opts.position.x : 100;
    this.y = (opts.position && opts.position.y != null) ? opts.position.y : 100;
    this.hueIndex = opts.hueIndex || 0;
    this.badgeIndex = opts.badgeIndex || 1;
    this.currentState = 'idle';
    this.isHidden = false;
    this.ultrathinkTimer = null;
    this.bubbleTimer = null;
    this.successIdleTimer = null;
    this.errorIdleTimer = null;
    this.taskDoneTimer = null;
    this.rareMotionTimer = null;

 // : contextLevel モディファイア (§5.9 / §5.8.1)
 // 'low' | 'mid' | 'high' | 'critical'
    this.contextLevel = 'low';
 this.compactRefreshThrottle = 0; // 最終 compact refresh 発火時刻 (ms)

 // 睡眠 / 目覚め
    this.isSleeping = false;
    this.sleepTimer = null;

 // permission ロック: true の間は setState/showBubble/popTaskDone を抑制する
    this.isInPermissionMode = false;
 // §5.10.6 permission queue (MAX_QUEUE=10, FIFO drop)
 /** @type {Array<{requestId:string, toolName:string, toolInput:object}>} */
    this.permissionQueue = [];
 // §5.10.4.1 renderer 55s auto-dismiss タイマー
    this._permissionDismissTimer = null;
 // §5.10.9 SHIP 基準: request 受信時刻 (durationMs 計算用)
    this._permissionReceivedAt = 0;
    this.sleepZzzTimer = null;
 this.sleepTalkTimer = null; // 0.9.66: 寝言の interval timer
 this.sleepAfterMs = 90000; // idle 90秒で睡眠
 this.stuckAfterMs = 180000; // 0.9.65: 非 idle state が 3 分維持されたら睡眠 (success 居座り対策)

 /** @type {Map<string, ChildEntry>} toolUseId → ChildEntry */
    this.children = new Map();
 /** FIFO キュー: toolUseId 不明の子を FIFO で対応 */
    this.childFifo = [];
 /** slotIndex → ChildEntry */
    this.slots = new Array(6).fill(null);

 // §5.6.7 ✨ パーティクル DOM プール (SPARKLE_POOL_SIZE = 6 要素)
 /** @type {HTMLElement[]} 固定長スパークルプール */
    this.sparklePool = [];
 /** throttle: 最後の sparkle 発火時刻 (epoch ms) */
    this._sparkleLastFiredAt = 0;
 /** throttle: 500ms 内の重複発火カウント (merge 判定用) */
    this._sparklePendingMerge = false;
    this._sparkleMergeTimer = null;

    this._buildDom();
    this._applyHue();
    this._applyBadge();
    this.setPosition(this.x, this.y);

 // ホバー / クリックで覚醒
 // 0.9.65: 起きた後の sleep スケジュールは現 state に応じて 90 秒 or 3 分
    const _reschedule = () => {
      if (this.currentState === 'farewell' || this.currentState === 'offline') return;
      this._scheduleSleep(this.currentState !== 'idle');
    };
    this.parentMascotEl.addEventListener('pointerenter', () => {
      if (this.isSleeping) this._wakeUp();
      _reschedule();
    });
    this.parentMascotEl.addEventListener('pointerdown', () => {
      if (this.isSleeping) this._wakeUp();
      _reschedule();
    });

 // 起動直後から idle なので睡眠スケジュール開始
    this._scheduleSleep();
  }

  _buildDom() {
    const el = document.createElement('div');
    el.className = 'mascot-container';
    el.dataset.sessionId = this.sessionId;
    el.dataset.state = 'idle';

    el.innerHTML = `
      <div class="float-shadow"></div>
      <div class="matrix-layer"></div>
      <div class="aura-layer"></div>
      <div class="bubble"></div>
      <div class="parent-mascot">
        <div class="sprite"></div>
        <div class="badge"></div>
        <div class="offline-exclaim"></div>
      </div>
      <div class="children-row"></div>
      <div class="session-label"></div>
      <div class="entry-e-spotlight" style="display:none;"></div>
      <div class="entry-e-logo" style="display:none;"></div>
      <div class="entry-e-ring" style="display:none;"></div>
    `;

    this.el = el;
    this.bubbleEl = el.querySelector('.bubble');
    this.spriteEl = el.querySelector('.sprite');
    this.badgeEl = el.querySelector('.badge');
    this.parentMascotEl = el.querySelector('.parent-mascot');
    this.childrenRowEl = el.querySelector('.children-row');
    this.matrixLayer = el.querySelector('.matrix-layer');
    this.sessionLabelEl = el.querySelector('.session-label');
    this._applySessionLabel();

 // 右クリック
    this.parentMascotEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (window.kurotanBridge && window.kurotanBridge.showContextMenu) {
        window.kurotanBridge.showContextMenu(this.sessionId, e.screenX, e.screenY);
      }
    });

 // ULTRATHINK: 吹き出しクリックで手動発火テスト用（本番では renderer 内の bubbleText 検知のみ）
    this.bubbleEl.addEventListener('click', () => {
      if (this.bubbleEl.textContent && detectUltrathink(this.bubbleEl.textContent)) {
        this.triggerUltrathink();
      }
    });

 // offline クリック → 再接続
    this.parentMascotEl.addEventListener('click', () => {
      if (this.currentState === 'offline' && window.kurotanBridge) {
        window.kurotanBridge.requestReconnect();
      }
    });

 // KORONE イースターエッグ (§5.7.2): 既に発火中なら新規 spawn にも適用
    if (_koroneMode) {
      el.dataset.easterEgg = 'korone';
    }

    document.getElementById('mascot-stage').appendChild(el);

 // ドラッグ有効化
    DragController.enable(this);

 // マトリックス DOM プール生成
    this._buildMatrixPool();

 // §5.6.7 スパークルプール生成 (固定長 6 要素 / 毎フレーム DOM 生成 BLOCK)
    this._buildSparklePool();

 // レアモーションタイマー開始 (§5.5)
    this._scheduleRareMotion();

 // artStyle は #mascot-stage[data-art-style] + .mascot-container[data-state] の CSS セレクタに委譲。
 // inline style を設定すると specificity でセレクタを上書きするため設定しない。
  }

  _buildMatrixPool() {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789考論深思';
    for (let i = 0; i < MATRIX_COLS; i++) {
      const col = document.createElement('div');
      col.className = 'matrix-col';
      col.style.left = `${(i / MATRIX_COLS) * 100}%`;
      const dur = (0.8 + Math.random() * 1.0).toFixed(2);
      const delay = (Math.random() * -2).toFixed(2);
      col.style.animationDuration = `${dur}s`;
      col.style.animationDelay = `${delay}s`;
 // ランダム文字列を生成
      let text = '';
      for (let j = 0; j < 15; j++) {
        text += CHARS[Math.floor(Math.random() * CHARS.length)] + '\n';
      }
      col.textContent = text;
      this.matrixLayer.appendChild(col);
    }
  }

 // ─── §5.6.7 ✨ スパークル DOM プール ────────────────────────

 /**
 * 固定長 DOM プール (SPARKLE_POOL_SIZE = 6) を起動時に予約する。
 * 要素は .mascot-container 直下に追加し、display:none で待機させる。
 * 毎フレーム DOM 生成は BLOCK (仕様 §5.6.7 / §5.6.8)。
 */
  _buildSparklePool() {
    for (let i = 0; i < SPARKLE_POOL_SIZE; i++) {
      const el = document.createElement('div');
      el.className = 'subagent-sparkle';
      el.dataset.sparkleIndex = String(i);
 // 頭上中央を基準位置とする。親マスコット上端 + 余白
 // parent-mascot の bottom は 0、height は artStyle 依存 (25〜43px)。
 // 演出時に JS で top 位置を動的セットするため、初期値は 0 で待機。
      el.style.left = '50%';
      el.style.top = '0px';
      this.el.appendChild(el);
      this.sparklePool.push(el);
    }
  }

 /**
 * SubagentStop 受信時に ✨ パーティクル演出を発火する。
 *
 * throttle / merge ルール (§5.6.7):
 * - 同一親に対し SPARKLE_THROTTLE_MS (500ms) 以内の重複発火は merge
 * - merge 時はパーティクル 4 → 最大 6 に増加
 * - 500ms 経過後は独立した演出として扱う (タイマーリセット)
 *
 * @param {{ success?: boolean }} [opts]
 */
  triggerSparkle(opts = {}) {
    if (this.currentState === 'farewell' || this.currentState === 'offline') return;

    const now = Date.now();
    const elapsed = now - this._sparkleLastFiredAt;

    if (elapsed < SPARKLE_THROTTLE_MS) {
 // 500ms 以内の重複発火: merge フラグを立てる
 // 演出はすでに走っているので追加 2 個だけ発火する
      if (!this._sparklePendingMerge) {
        this._sparklePendingMerge = true;
        this._fireSparkleParticles(SPARKLE_MERGE_COUNT, /* mergeExtra= */ true);
      }
      return;
    }

 // 新規演出開始
    this._sparkleLastFiredAt = now;
    this._sparklePendingMerge = false;
    if (this._sparkleMergeTimer) {
      clearTimeout(this._sparkleMergeTimer);
      this._sparkleMergeTimer = null;
    }

    this._fireSparkleParticles(SPARKLE_BASE_COUNT, /* mergeExtra= */ false);

 // SPARKLE_THROTTLE_MS 後に merge フラグをリセット (タイマー窓の終了)
    this._sparkleMergeTimer = setTimeout(() => {
      this._sparklePendingMerge = false;
      this._sparkleMergeTimer = null;
    }, SPARKLE_THROTTLE_MS);
  }

 /**
 * パーティクルを発火する内部メソッド。
 * プールから空き要素を取得して active にする。
 *
 * @param {number} count - 発火するパーティクル数 (4 or 6)
 * @param {boolean} mergeExtra - true のとき追加 2 個 (インデックス 4-5) を対象にする
 */
  _fireSparkleParticles(count, mergeExtra) {
 // 親マスコット可視高さから頭上 top 位置を算出
 // parent-mascot の bottom は 0; height は artStyle 依存
 // container の bottom:0 基準で、親の visible 上端 ≒ parent-mascot height
 // CSS で定義された値: pixel=25px, sd=43px, default=43px
    const parentH = _artStyle === 'pixel' ? 25 : 43;
 // 頭上 4px 上 を出発点とする
    const topPx = this.el.offsetHeight - parentH - 4;
    const angles = count <= 4 ? SPARKLE_ANGLES_4 : SPARKLE_ANGLES_6;
    const startIdx = mergeExtra ? SPARKLE_BASE_COUNT : 0;
    const endIdx = mergeExtra ? count : count;

    for (let i = startIdx; i < endIdx; i++) {
      const poolIdx = mergeExtra ? (SPARKLE_BASE_COUNT + (i - startIdx)) : i;
      const el = this.sparklePool[poolIdx];
      if (!el) continue;

 // 前回の animation をリセット (再発火用 reflow)
      el.classList.remove('active');
 // eslint-disable-next-line no-unused-expressions
 el.offsetWidth; // reflow trigger

 // 角度 (deg → rad) と距離 (±微変化で 24〜32px)
      const baseDeg = angles[i] || 270;
 // ±5deg のランダム微調整でわずかに散らす
      const deg = baseDeg + (Math.random() * 10 - 5);
      const distance = 24 + Math.random() * 8;
      const rad = (deg * Math.PI) / 180;
      const tx = Math.round(Math.cos(rad) * distance);
      const ty = Math.round(Math.sin(rad) * distance);

 // CSS 変数を設定 (keyframes が参照する --tx / --ty)
      el.style.top = `${topPx}px`;
      el.style.setProperty('--tx', `${tx}px`);
      el.style.setProperty('--ty', `${ty}px`);

 // active クラスで animation 発火
      el.classList.add('active');

 // SPARKLE_DURATION_MS 後にプールに返却 (display:none に戻す)
      setTimeout(() => {
        el.classList.remove('active');
 }, SPARKLE_DURATION_MS + 50); // +50ms バッファ
    }
  }

  _applyHue() {
    if (this.hueIndex > 0) {
      const filter = `hue-rotate(${this.hueIndex}deg)`;
      this.spriteEl.style.filter = filter;
 // 0.9.44: 子 sprite にも親と同じ hue-rotate を適用 (ユーザー報告: 黄色の親でも子はオレンジのまま)
      if (this.childrenRowEl) {
        this.childrenRowEl.querySelectorAll('.child-sprite').forEach((cs) => {
          cs.style.filter = filter;
        });
      }
    }
  }

  _applyBadge() {
    if (this.badgeIndex > 1) {
      this.badgeEl.textContent = `#${this.badgeIndex}`;
      this.el.dataset.badgeIndex = String(this.badgeIndex);
    } else {
      this.el.dataset.badgeIndex = '1';
    }
  }

  setPosition(x, y) {
    this.x = x;
    this.y = y;
 // B 案: position: fixed かつ 1 display 限定なので補正不要。
 // 座標はそのまま translate3d に渡す。
    this.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    this.el.style.setProperty('--mx', `${x}px`);
    this.el.style.setProperty('--my', `${y}px`);
  }

 /**
 * 状態遷移。Transition Matrix §5.7 に従う。
 * @param {string} newState
 */
  setState(newState) {
 if (this.currentState === 'farewell') return; // farewell は終端
 // permission ロック中は 'permission' 自身の遷移のみ通す（外部からの上書きをブロック）
    if (this.isInPermissionMode && newState !== 'permission') return;

 // 睡眠中に idle 以外の何かが来たら覚醒（state 同一でも起きる）
    if (this.isSleeping && newState !== 'idle' && newState !== 'offline') {
      this._wakeUp();
    }
 // sleep 中に offline へ遷移する場合、wake 演出は不要だが
 // sleep interval (zzz / sleep_talk) は停止しないと offline bubble を上書きする。
    if (this.isSleeping && newState === 'offline') {
      this._stopSleepIntervals();
      this.isSleeping = false;
      this.el.classList.remove('sleeping');
    }

    if (this.currentState === newState) {
 // 同一 state を再受信 = 活動継続。stuck タイマーをリスケして「3 分動きなし」判定をリセット。
 // 0.9.65: 旧実装は _cancelSleep() のみで stuck 検出不可だったため、reschedule に変更。
      if (newState !== 'idle' && newState !== 'farewell' && newState !== 'offline') {
        this._scheduleSleep(true);
      }
      return;
    }

 // 旧タイマーをクリア (success/error はお互いをクリアし合う)
    if (this.successIdleTimer) { clearTimeout(this.successIdleTimer); this.successIdleTimer = null; }
    if (this.errorIdleTimer) { clearTimeout(this.errorIdleTimer); this.errorIdleTimer = null; }

    this.currentState = newState;
    this.el.dataset.state = newState;

 // 睡眠スケジュール:
 // - idle: 90 秒で睡眠 (既存)
 // - farewell / offline: 終端なのでスケジュールなし
 // - その他 (success / error / thinking / tool_* / permission 等): 3 分維持で睡眠
 // (0.9.65: success 状態が次イベントまで永続のため stuck 化する問題への対処)
    if (newState === 'idle') {
      this._scheduleSleep();
 // §5.9 凍結 - で再検討
 // idle 復帰時の data-context-level 再適用は §5.9 凍結のため削除。
 // tool_* 等の bubble (durationMs=0 / 永続) を idle 遷移時に消去する
      this.hideBubble();
    } else if (newState === 'farewell' || newState === 'offline') {
      this._cancelSleep();
    } else {
      this._scheduleSleep(true);
    }

 // ULTRATHINK 中は farewell / offline に遷移した場合のみ演出停止
    if (newState === 'farewell' || newState === 'offline') {
      this._stopUltrathink();
    }

 // 状態タイマー
 // 0.9.14: success の 2 秒 auto-idle を撤廃。「次イベントまで
 // 『できたよ！』を維持」(permission 永続化と同思想)。次の UserPromptSubmit /
 // PreToolUse 等の setState 呼び出しで自然に上書きされる。
    if (newState === 'error') {
      this.errorIdleTimer = setTimeout(() => {
        this.setState('idle');
        this.hideBubble();
      }, 4000);
    } else if (newState === 'farewell') {
      this._startFarewell();
    }

 // 状態別頭上エフェクト (§VFX-2)
    this._spawnStateEffect(newState);
  }

  _startFarewell() {
 // t=0ms: 手振り開始 + 「またね！」吹き出し
    this.parentMascotEl.classList.add('waving-bye');
    this.showBubble(i18nT('bubble.farewell'), 1500);

 // t=800ms: 手振り終了 → farewell-bow (CSS が [data-state="farewell"] で発火)
    setTimeout(() => {
      this.parentMascotEl.classList.remove('waving-bye');
    }, 800);

 // t=2500ms: farewell-out (fade-out 開始)
    setTimeout(() => {
 // §6106e50 で inline animation:none をセットしてあるので、
 // farewell-out CSS class は specificity 負けする。
 // 同じ inline で fadeout を直接当てて上書きする。
      this.el.style.animation = 'mascot-fadeout 0.4s ease forwards';
      this.el.classList.add('farewell-out');
 // t=2900ms: DOM 削除
      setTimeout(() => this.dispose(), 400);
    }, 2500);
  }

 /**
 * 吹き出し表示
 * @param {string} text
 * @param {number} [durationMs] - 0 で自動消去しない
 * @param {boolean} [pin] - true: ピン留め (手動クリックまで消去しない)
 */
  showBubble(text, durationMs, pin) {
 // permission ロック中は外部からの吹き出し上書きをブロック
    if (this.isInPermissionMode) return;
    if (this.bubbleTimer) { clearTimeout(this.bubbleTimer); this.bubbleTimer = null; }
    this.bubbleEl.textContent = text || '';
    this.bubbleEl.classList.add('visible');

 // ULTRATHINK 検知
    if (detectUltrathink(text)) {
      setTimeout(() => this.triggerUltrathink(), 0);
    }

    const timeout = durationMs !== undefined ? durationMs : (BUBBLE_TIMEOUT_MS[this.currentState] || 0);
    if (timeout > 0 && !pin) {
      this.bubbleTimer = setTimeout(() => this.hideBubble(), timeout);
    }
  }

  hideBubble() {
    if (this.bubbleTimer) { clearTimeout(this.bubbleTimer); this.bubbleTimer = null; }
    this.bubbleEl.classList.remove('visible');
  }

 /**
 * 0.9.15: マスコット下のセッション名ラベルを表示/非表示する。
 * グローバル _showSessionLabel フラグと sessionLabel 文字列で制御。
 */
  _applySessionLabel() {
    if (!this.sessionLabelEl) return;
    this.sessionLabelEl.textContent = this.sessionLabel || '';
 // 0.9.26: title 属性で full text の OS tooltip 表示 (max-width で切れた時用)
    this.sessionLabelEl.title = this.sessionLabel || '';
    const visible = _showSessionLabel && !!this.sessionLabel;
    this.sessionLabelEl.classList.toggle('visible', visible);
  }

 /**
 * PostToolUse 時の "作業中だよ〜" かわいい演出。
 * 状態は維持したまま、親マスコットを軽く揺らしつつ、
 * きらめき粒子 (✨ / ♪ / 💭) を 3 個ランダムに飛ばす。
 */
  popTaskDone() {
    if (this.currentState === 'farewell' || this.currentState === 'offline') return;
 // permission ロック中はパーティクル演出も抑制
    if (this.isInPermissionMode) return;
 // 睡眠中なら起こす
    if (this.isSleeping) this._wakeUp();
 // 活動を検知したので sleep timer を再起動
 // 0.9.65: 非 idle state でも stuck 検出のため reschedule する
    if (this.currentState === 'idle') {
      this._scheduleSleep();
    } else if (this.currentState !== 'farewell' && this.currentState !== 'offline') {
      this._scheduleSleep(true);
    }

 // 親マスコットのウィグル
    this.parentMascotEl.classList.remove('task-done-wiggle');
 void this.parentMascotEl.offsetWidth; // reflow
    this.parentMascotEl.classList.add('task-done-wiggle');

 // 粒子は親マスコット内に 3 個生成 → 浮上 + フェードアウト後に DOM から除去
    const symbols = ['✨', '♪', '💭', '⭐', '✏️', '🔧'];
    const picks = [];
    while (picks.length < 3) {
      picks.push(symbols[Math.floor(Math.random() * symbols.length)]);
    }
    picks.forEach((sym, i) => {
      const el = document.createElement('div');
      el.className = 'task-done-particle';
      el.textContent = sym;
 // 横方向は -16px〜+16px の範囲でばらけさせる
      const offsetX = -16 + Math.random() * 32;
      el.style.setProperty('--px', `${offsetX}px`);
 // 開始タイミングを 0 / 80 / 160ms ずらす
      el.style.animationDelay = `${i * 80}ms`;
      this.parentMascotEl.appendChild(el);
      setTimeout(() => el.remove(), 1200 + i * 80);
    });

    if (this.taskDoneTimer) clearTimeout(this.taskDoneTimer);
    this.taskDoneTimer = setTimeout(() => {
      this.parentMascotEl.classList.remove('task-done-wiggle');
    }, 600);
  }

 // ─── 状態別頭上エフェクト (§VFX-2) ─────────────────────────
 //
 // setState() から呼ばれる。既存の popTaskDone / _wakeUp と干渉しないよう
 // 専用クラス名 (.thinking-dots / .tool-read-sparkle / .permission-mark /
 // .error-sweat) を使い、success ⭐ は task-done-particle を流用する。
 // lead-programmer が担当する子くろたんアニメとは別メソッドで完全独立。

 /**
 * 状態遷移時に頭上エフェクト要素を生成する。
 * @param {string} state
 */
  _spawnStateEffect(state) {
 // 前回の state エフェクトをクリア (重複防止)
    this._clearStateEffects();

    switch (state) {
      case 'thinking':
        this._spawnThinkingDots();
        break;
      case 'tool_read':
        this._spawnToolReadSparkle();
        break;
      case 'tool_edit':
        this._spawnToolEditSymbol();
        break;
      case 'tool_bash':
        this._spawnToolBashSymbol();
        break;
      case 'tool_web':
        this._spawnToolWebSymbol();
        break;
      case 'tool_skill':
        this._spawnToolSkillSymbol();
        break;
      case 'tool_other':
        this._spawnToolOtherSymbol();
        break;
      case 'permission':
        this._spawnPermissionMark();
        break;
      case 'success':
        this._spawnSuccessStars();
        break;
      case 'error':
        this._spawnErrorSweat();
        break;
      default:
        break;
    }
  }

 /** thinking 中 "..." を .el に追加し、state 変化まで維持 */
  _spawnThinkingDots() {
    const el = document.createElement('div');
    el.className = 'thinking-dots';
    el.textContent = '...';
    el.dataset.stateEffect = 'thinking';
    this.el.appendChild(el);
 // thinking → 他状態に変わったときに _clearStateEffects() で除去される
  }

 /** tool_read ✦ エフェクトを .el に追加 (無限ループ CSS) */
  _spawnToolReadSparkle() {
    const el = document.createElement('div');
    el.className = 'tool-read-sparkle';
    el.textContent = '✦';
    el.dataset.stateEffect = 'tool_read';
    this.el.appendChild(el);
  }

 /** tool_edit ✎ エフェクトを .el に追加 (無限ループ CSS) */
  _spawnToolEditSymbol() {
    const el = document.createElement('div');
    el.className = 'tool-edit-symbol';
    el.textContent = '✎';
    el.dataset.stateEffect = 'tool_edit';
    this.el.appendChild(el);
  }

 /** tool_bash >_ エフェクトを .el に追加 (無限ループ CSS) */
  _spawnToolBashSymbol() {
    const el = document.createElement('div');
    el.className = 'tool-bash-symbol';
    el.textContent = '>_';
    el.dataset.stateEffect = 'tool_bash';
    this.el.appendChild(el);
  }

 /** tool_web 🌐 エフェクトを .el に追加 (無限ループ CSS) */
  _spawnToolWebSymbol() {
    const el = document.createElement('div');
    el.className = 'tool-web-symbol';
    el.textContent = '🌐';
    el.dataset.stateEffect = 'tool_web';
    this.el.appendChild(el);
  }

 /** tool_skill ✨ エフェクトを .el に追加 (無限ループ CSS) */
  _spawnToolSkillSymbol() {
    const el = document.createElement('div');
    el.className = 'tool-skill-symbol';
    el.textContent = '✨';
    el.dataset.stateEffect = 'tool_skill';
    this.el.appendChild(el);
  }

 /** tool_other ◯ エフェクトを .el に追加 (無限ループ CSS) */
  _spawnToolOtherSymbol() {
    const el = document.createElement('div');
    el.className = 'tool-other-symbol';
    el.textContent = '◯';
    el.dataset.stateEffect = 'tool_other';
    this.el.appendChild(el);
  }

 /** permission 「？」マークを .el に追加 (1 回表示 → 残留) */
  _spawnPermissionMark() {
    const el = document.createElement('div');
    el.className = 'permission-mark';
    el.textContent = '？';
    el.dataset.stateEffect = 'permission';
    this.el.appendChild(el);
  }

 /** success ⭐ 3 個を task-done-particle 方式で飛ばす */
  _spawnSuccessStars() {
    const stars = ['⭐', '⭐', '✨'];
    stars.forEach((sym, i) => {
      const el = document.createElement('div');
      el.className = 'task-done-particle';
      el.textContent = sym;
      const offsetX = -18 + i * 18;
      el.style.setProperty('--px', `${offsetX}px`);
      el.style.animationDelay = `${i * 100}ms`;
      this.parentMascotEl.appendChild(el);
      setTimeout(() => el.remove(), 1300 + i * 100);
    });
  }

 /** error 💧汗マークを .el に追加 */
  _spawnErrorSweat() {
    const el = document.createElement('div');
    el.className = 'error-sweat';
    el.textContent = '💧';
    el.style.setProperty('--px', '10px');
    el.dataset.stateEffect = 'error';
    this.el.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }

 /** data-state-effect を持つ要素をすべて除去する */
  _clearStateEffects() {
    this.el.querySelectorAll('[data-state-effect]').forEach(n => n.remove());
  }

 // ─── 睡眠 / 目覚め ──────────────────────────────────────────

 /** idle / 非 idle stuck で _enterSleep を発火する
 * @param {boolean} stuck true なら stuckAfterMs (3 分) を使用。false なら sleepAfterMs (90 秒)
 */
  _scheduleSleep(stuck = false) {
    if (this.currentState === 'farewell' || this.currentState === 'offline') return;
    this._cancelSleep();
    const ms = stuck ? this.stuckAfterMs : this.sleepAfterMs;
    this.sleepTimer = setTimeout(() => this._enterSleep(), ms);
  }

  _cancelSleep() {
    if (this.sleepTimer) { clearTimeout(this.sleepTimer); this.sleepTimer = null; }
  }

  _enterSleep() {
    if (this.isSleeping) return;
 // 0.9.65: 旧実装は idle のみ睡眠だったが、success / その他 stuck state でも睡眠許可。
 // farewell / offline は終端のため除外。
    if (this.currentState === 'farewell' || this.currentState === 'offline') return;
    this.isSleeping = true;
    this.el.classList.add('sleeping');
 // 💤 を即時 + 4 秒ごとに生成
    this._spawnSleepZzz();
    this.sleepZzzTimer = setInterval(() => this._spawnSleepZzz(), 4000);
 // 0.9.66: 寝言を即時 + 10 秒ごとにランダム表示
    this._spawnSleepTalk();
    this.sleepTalkTimer = setInterval(() => this._spawnSleepTalk(), 10000);
  }

  _spawnSleepZzz() {
    if (!this.isSleeping) return;
 // farewell / offline 中は 💤 を出さない (defense in depth)
    if (this.currentState === 'farewell' || this.currentState === 'offline') return;
    const el = document.createElement('div');
    el.className = 'sleep-particle';
    el.textContent = '💤';
    this.el.appendChild(el);
    setTimeout(() => el.remove(), 3100);
  }

 /** 寝言をランダムに 1 つピックして吹き出し表示 (0.9.66)
 * 0.9.67: 70% は 1-2 (素の可愛さ) から、30% は 3-8 (うなされ / 皮肉) から選択。
 * farewell / offline 中は寝言を出さない (defense in depth)
 */
  _spawnSleepTalk() {
    if (!this.isSleeping) return;
    if (this.isInPermissionMode) return;
    if (this.currentState === 'farewell' || this.currentState === 'offline') return;
    let idx;
    if (Math.random() < 0.3) {
 idx = 3 + Math.floor(Math.random() * 6); // 3..8
    } else {
 idx = 1 + Math.floor(Math.random() * 2); // 1..2
    }
    const key = `bubble.sleep_talk_${idx}`;
    const line = i18nT(key);
    if (!line || line === key) return;
 // showBubble は通常パス。state 上書きはしない (sleep 中も currentState は維持)
    this.showBubble(line, 4000);
  }

 /** sleep の interval / particle / bubble をまとめてクリーンアップ (0.9.69) */
  _stopSleepIntervals() {
    if (this.sleepZzzTimer) { clearInterval(this.sleepZzzTimer); this.sleepZzzTimer = null; }
    if (this.sleepTalkTimer) { clearInterval(this.sleepTalkTimer); this.sleepTalkTimer = null; }
    this.el.querySelectorAll('.sleep-particle').forEach(n => n.remove());
  }

  _wakeUp() {
    if (!this.isSleeping) return;
    this.isSleeping = false;
    this.el.classList.remove('sleeping');
    this._stopSleepIntervals();
 // 寝言の吹き出しを即消去
    this.hideBubble();

 // 覚醒モーション
    this.parentMascotEl.classList.remove('waking');
 void this.parentMascotEl.offsetWidth; // reflow
    this.parentMascotEl.classList.add('waking');

 // 「！」マーク (0.9.66: 750ms → 2000ms に延長して「起きたカンジ」を残す)
    const mark = document.createElement('div');
    mark.className = 'wake-mark';
    mark.textContent = '！';
    this.el.appendChild(mark);
    setTimeout(() => mark.remove(), 2000);

 // 0.9.66: 寝起きの吹き出し「ふぁ…おはよ…」を 2.5 秒表示
 // 200ms 中に他の bubble (farewell / 通常 setState 系) が
 // 表示された場合は sleep_wake で上書きしない。bubble.visible で判定する。
    setTimeout(() => {
      if (this.isSleeping || this.isInPermissionMode) return;
      if (this.currentState === 'farewell' || this.currentState === 'offline') return;
      if (this.bubbleEl && this.bubbleEl.classList.contains('visible')) return;
      this.showBubble(i18nT('bubble.sleep_wake'), 2500);
    }, 200);

    setTimeout(() => this.parentMascotEl.classList.remove('waking'), 850);
  }

 // ─── 子くろたん管理 (§5.4) ──────────────────────────────────

 /**
 * 子くろたんを生成する。
 * §5.6.6 ChildMascotState スキーマ拡張:
 * agentId? - 公式 SubagentStart の agent_id (主トラック)
 * source - 'official' | 'pseudo' | 'merged'
 * spawnedVia - 'PreToolUse' | 'SubagentStart'
 * @param {{ childId: string, subagentType: string, toolUseId?: string, toolName?: string,
 * agentId?: string, source?: string, spawnedVia?: string }} opts
 * toolName: 親 tool 種別。child-sprite の background-image は CSS に委譲。
 */
  spawnChild(opts) {
    const { childId, subagentType, toolUseId, toolName, agentId, source, spawnedVia } = opts;

 // 上限チェック: 既存スロット数 >= 6
    const usedSlots = this.slots.filter(Boolean).length;
    if (usedSlots >= 6) {
 // +N 表示を更新
      this._updatePlusN(this.children.size + 1 - 6);
      return;
    }

 // 空きスロットを検索
    const slotIndex = this.slots.findIndex(s => s === null);
    if (slotIndex < 0) return;

    const child = document.createElement('div');
    child.className = 'child-mascot';
    child.dataset.childId = childId;
 // §5.6.6: source / spawnedVia を data 属性に記録 (QA / debug 用 / 本番 UI には出さない)
    if (source) child.dataset.source = source;
    if (spawnedVia) child.dataset.spawnedVia = spawnedVia;

 // 0.9.37: innerHTML 文字列補間を排除し、createElement + textContent で構築
 // (subagentType は信頼できるローカル hook 由来だが、公開コードのお作法として XSS 経路を残さない)
    const childBubble = document.createElement('div');
    childBubble.className = 'child-bubble';
 // 0.9.58: bubble は登場セリフ (ランダム)、agent 名は badge に分離して縦位置を分ける
    childBubble.textContent = _pickChildLine('bubble.child_spawn', 5);
    const childSprite = document.createElement('div');
    childSprite.className = 'child-sprite';
 // 0.9.44: 親の hueIndex を子にも継承 (新規 spawn 時)
    if (this.hueIndex > 0) {
      childSprite.style.filter = `hue-rotate(${this.hueIndex}deg)`;
    }
    const agentTypeBadge = document.createElement('div');
    agentTypeBadge.className = 'agent-type-badge';
    child.appendChild(childBubble);
    child.appendChild(childSprite);
    child.appendChild(agentTypeBadge);

    const bubbleEl = child.querySelector('.child-bubble');
    bubbleEl.classList.add('visible');
    setTimeout(() => bubbleEl.classList.remove('visible'), 1500);

 // §5.6.7: agent_type バッジ (1.5 秒表示)
 // フォールバック: 公式 agent_type → 副 subagent_type → 非表示
    const badgeLabel = subagentType || '';
    if (badgeLabel) {
      this._showAgentTypeBadge(child, badgeLabel);
    }

 // 子スプライトの background-image は CSS に委譲（inline style は specificity でセレクタを上書きするため設定しない）。

    this.childrenRowEl.appendChild(child);

 // child-popin flicker 修正 (#child-flicker):
 // appendChild 後に is-spawning を付与してポップインアニメを発火させ、300ms 後に除去する。
 // 除去後は opacity の CSS initial value (1) に自然復帰する。
 // 旧: 静的ルール .child-mascot { animation: child-popin forwards } は、親の data-state 変化に
 // 伴う CSS 再計算で forwards fill がリセットされ opacity:0 flicker が発生するため廃止。
 // CSS 側は .child-mascot.is-spawning { animation: child-popin ... } に変更済み。
    child.classList.add('is-spawning');
    setTimeout(() => child.classList.remove('is-spawning'), 300);

 // §5.6.6 ChildMascotState: agentId / source / spawnedVia を格納
    const entry = {
      childId,
      subagentType,
      toolUseId,
      agentId: agentId || undefined,
      source: source || 'pseudo',
      spawnedVia: spawnedVia || 'PreToolUse',
      slotIndex,
      el: child,
    };
    this.slots[slotIndex] = entry;
    this.children.set(childId, entry);
    if (agentId) {
 // 公式 agentId を正キーとして登録
      this.children.set(agentId, entry);
    }
    if (toolUseId) {
      this.children.set(toolUseId, entry);
    }
    if (!toolUseId && !agentId) {
      this.childFifo.push(entry);
    }

 // とことこ歩きウォーキング開始 (ランダム位相でタイマー起動)
    this._startChildWalk(entry);
  }

 /**
 * §5.6.7 agent_type バッジを 1.5 秒表示する。
 * 文字数上限 8 文字 + ellipsis、最大幅 56px、フォント 9px (§5.6.7 準拠)。
 * @param {HTMLElement} childEl
 * @param {string} agentType
 */
  _showAgentTypeBadge(childEl, agentType) {
    const badgeEl = childEl.querySelector('.agent-type-badge');
    if (!badgeEl || !agentType) return;
    const MAX_CHARS = 8;
    const label = agentType.length > MAX_CHARS
      ? agentType.slice(0, MAX_CHARS) + '…'
      : agentType;
    badgeEl.textContent = label;
    badgeEl.classList.add('visible');
    setTimeout(() => {
      badgeEl.classList.remove('visible');
    }, 1500);
  }

 /**
 * 副→公式統合: 既存エントリを agentId で昇格する (§5.6.5 突合成立時)。
 * main から childMerge payload で呼ばれる。
 * @param {{ childId: string, agentId: string, agentType: string, source: string, spawnedVia: string }} opts
 */
  mergeChild(opts) {
    const { childId, agentId, agentType, source, spawnedVia } = opts;
    const entry = this.children.get(childId);
    if (!entry) return;

 // agentId を正キーに昇格
    entry.agentId = agentId;
    entry.source = source || 'merged';
    entry.spawnedVia = spawnedVia || 'SubagentStart';
    this.children.set(agentId, entry);

 // DOM data 属性を更新
    if (entry.el) {
      entry.el.dataset.source = entry.source;
      entry.el.dataset.spawnedVia = entry.spawnedVia;
 // §5.6.7: 統合時にも agent_type バッジを再表示
      if (agentType) {
        this._showAgentTypeBadge(entry.el, agentType);
      }
    }
  }

 /**
 * 子くろたんを消滅させる。
 * §5.6.6 拡張: agentId (公式正キー) / toolUseId (副エイリアス) の両方に対応。
 * @param {{ toolUseId?: string, agentId?: string, agentType?: string, success: boolean, source?: string }} opts
 */
  despawnChild(opts) {
    const { toolUseId, agentId, success } = opts;
    let entry = null;

 // agentId (公式正キー) を優先して検索
    if (agentId && this.children.has(agentId)) {
      entry = this.children.get(agentId);
      const fifoIdx = this.childFifo.indexOf(entry);
      if (fifoIdx >= 0) this.childFifo.splice(fifoIdx, 1);
    } else if (toolUseId && this.children.has(toolUseId)) {
      entry = this.children.get(toolUseId);
 // childFifo に同じ entry があれば除去 (orphan 防止)
      const fifoIdx = this.childFifo.indexOf(entry);
      if (fifoIdx >= 0) this.childFifo.splice(fifoIdx, 1);
    } else if (this.childFifo.length > 0) {
      entry = this.childFifo.shift();
    }
    if (!entry) return;

 // ウォーキング停止
    this._stopChildWalk(entry);

 // 吹き出し表示
    const bubbleEl = entry.el.querySelector('.child-bubble');
    if (bubbleEl) {
      bubbleEl.textContent = _pickChildLine(success ? 'bubble.child_done_ok' : 'bubble.child_done_fail', 5);
      bubbleEl.classList.add('visible');
    }

 // 小手振りモーション (0.5s) → その後 farewell-out へ
    entry.el.classList.add('waving-bye-mini');
    setTimeout(() => {
      entry.el.classList.remove('waving-bye-mini');
    }, 500);

    setTimeout(() => {
      entry.el.classList.add('farewell-out');
      setTimeout(() => {
        entry.el.remove();
        if (this.slots[entry.slotIndex] === entry) {
          this.slots[entry.slotIndex] = null;
        }
        this.children.delete(entry.childId);
        if (entry.toolUseId) this.children.delete(entry.toolUseId);
 // §5.6.6: agentId (公式正キー) も削除
        if (entry.agentId) this.children.delete(entry.agentId);
 // +N を更新
        const excess = this.children.size - 6;
        this._updatePlusN(excess > 0 ? excess : 0);
      }, 400);
    }, 2000);
  }

 // ─── 子くろたん ウォーキング ───

 /**
 * 子くろたんのとことこ歩きを開始する。
 * children-row 内で ±8px 水平移動。0.6〜1.2 秒間隔でランダム反転。
 * CSS translate プロパティ経由で --child-tx を更新 (transform とは独立)。
 * @param {object} entry - ChildEntry
 */
  _startChildWalk(entry) {
 // ランダム位相オフセット (0〜1200ms)
    const phaseDelay = Math.floor(Math.random() * 1200);
    let tx = 0;
    let dir = Math.random() < 0.5 ? 1 : -1;

    const step = () => {
      if (!entry.el || !entry.el.isConnected) return;
 // 現在位置から ±1〜3px 動かす
      const delta = (1 + Math.random() * 2) * dir;
      tx = Math.max(-8, Math.min(8, tx + delta));
 // 端に達したら反転
      if (tx >= 8) dir = -1;
      else if (tx <= -8) dir = 1;
 // ランダムに方向転換 (20% の確率)
      else if (Math.random() < 0.2) dir = -dir;
      entry.el.style.setProperty('--child-tx', `${tx.toFixed(1)}px`);
 // 次のステップを 600〜1200ms 後にスケジュール
      const interval = 600 + Math.floor(Math.random() * 600);
      entry._walkTimer = setTimeout(step, interval);
    };

    entry._walkTimer = setTimeout(step, phaseDelay);
  }

 /**
 * 子くろたんのとことこ歩きを停止する。
 * @param {object} entry - ChildEntry
 */
  _stopChildWalk(entry) {
    if (entry._walkTimer) {
      clearTimeout(entry._walkTimer);
      entry._walkTimer = null;
    }
  }

  _updatePlusN(n) {
 // 吹き出しテキスト末尾の +N を更新
    const existing = this.bubbleEl.querySelector('.plus-n');
    if (existing) existing.remove();
    if (n > 0) {
      const span = document.createElement('span');
      span.className = 'plus-n';
      span.textContent = `+${n}`;
      this.bubbleEl.appendChild(span);
      this.bubbleEl.classList.add('visible');
    }
  }

 // ─── ULTRATHINK (§5.6) ─────────────────────────────────────

  triggerUltrathink() {
 if (this.ultrathinkTimer) return; // 連打抑止
    this.el.classList.add('ultrathink');
    this.showBubble(i18nT('bubble.ultrathink_start'), 1500);
    this.ultrathinkTimer = setTimeout(() => {
      this._stopUltrathink();
    }, ULTRATHINK_DURATION_MS);
  }

  _stopUltrathink() {
    if (this.ultrathinkTimer) { clearTimeout(this.ultrathinkTimer); this.ultrathinkTimer = null; }
    this.el.classList.remove('ultrathink');
    if (this.currentState !== 'farewell' && this.currentState !== 'offline') {
      this.showBubble(i18nT('bubble.ultrathink_end'), 1500);
    }
  }

 // ─── レアモーション (§5.5) ──────────────────────────────────

 /**
 * 深夜時間帯かどうかを判定する。
 * @returns {boolean} - nightMode=true かつ 22:00〜07:00 なら true
 */
  _isNightTime() {
    if (!_nightMode) return false;
    const h = new Date().getHours();
    return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
  }

 /**
 * 次のレアモーションをスケジュールする。
 * 20〜40 秒のランダムインターバル後に発火。
 */
  _scheduleRareMotion() {
    if (this.rareMotionTimer) { clearTimeout(this.rareMotionTimer); this.rareMotionTimer = null; }
    const delay = RARE_MOTION_MIN_MS + Math.random() * (RARE_MOTION_MAX_MS - RARE_MOTION_MIN_MS);
    this.rareMotionTimer = setTimeout(() => {
      this._fireRareMotion();
    }, delay);
  }

 /**
 * レアモーションを発火する。
 * nightMode=true かつ 22:00〜07:00 の場合はスキップ。
 * idle 状態以外でも現状は発火しない（他モーション優先）。
 */
  _fireRareMotion() {
    this.rareMotionTimer = null;
    if (this._isNightTime()) {
      console.log('[kurotan] rare motion skipped (nightMode + night hours)');
      this._scheduleRareMotion();
      return;
    }
 // idle 以外の状態では発火しない
    if (this.currentState !== 'idle') {
      this._scheduleRareMotion();
      return;
    }
    const motion = RARE_MOTIONS[Math.floor(Math.random() * RARE_MOTIONS.length)];
    console.log(`[kurotan] rare motion: ${motion}`);
    this.el.dataset.rareMotion = motion;
    setTimeout(() => {
      if (this.el) delete this.el.dataset.rareMotion;
      this._scheduleRareMotion();
    }, RARE_MOTION_DURATION_MS);
  }

 // ─── Permission Bridge (§5.10) ──────────────────────

 /**
 * §5.10.6 queue に積む。表示中でなければ即 _showPermissionUi() を呼ぶ。
 * MAX_QUEUE=10 超過時は最古を FIFO drop して console.warn する。
 *
 * @param {{ requestId: string, sessionId: string, toolName: string, toolInput: object }} data
 */
  _handlePermissionRequest(data) {
    const MAX_QUEUE = 10;

    if (this.isInPermissionMode) {
 // 表示中: queue に積む
      if (this.permissionQueue.length >= MAX_QUEUE) {
        const dropped = this.permissionQueue.shift();
        console.warn('permission queue overflow, dropped oldest sessionId=' + (dropped && dropped.requestId));
      }
      this.permissionQueue.push(data);
 // バッジ更新
      this._updatePermissionBadge(this.permissionQueue.length);
 // 吹き出し suffix 更新
      this._updatePermissionSuffix(this.permissionQueue.length);
      return;
    }

    this._showPermissionUi(data);
  }

 /**
 * §5.10.3 / §5.10.4 / §5.10.7 に従い permission UI を DOM に生成して表示する。
 *
 * @param {{ requestId: string, sessionId: string, toolName: string, toolInput: object }} data
 */
  _showPermissionUi(data) {
    const { requestId, toolName, toolInput } = data;

 // permission ロックを先に立てる（setState/showBubble のガードより前）
    this.isInPermissionMode = true;
    this._permissionReceivedAt = Date.now();

 // 旧 spike 互換: panel / ボタンが残っていれば除去
    this.el.querySelector('.permission-panel')?.remove();
    this.el.querySelector('.permission-side-btn--allow')?.remove();
    this.el.querySelector('.permission-side-btn--deny')?.remove();

 // state を permission に切替
    this.setState('permission');

 // 吹き出し: 2 span 構造 (§5.10.6.1)
    if (this.bubbleTimer) { clearTimeout(this.bubbleTimer); this.bubbleTimer = null; }
 this.bubbleEl.innerHTML = ''; // クリア

    const mainSpan = document.createElement('span');
    mainSpan.className = 'permission-bubble-text';
    mainSpan.textContent = i18nT('bubble.permission_confirm', { toolName: toolName });
    this.bubbleEl.appendChild(mainSpan);

 // suffix: queue が 0 のとき非生成
    if (this.permissionQueue.length > 0) {
      const suffixSpan = document.createElement('span');
      suffixSpan.className = 'permission-bubble-suffix';
      suffixSpan.textContent = i18nT('bubble.permission_queue', { count: this.permissionQueue.length });
      this.bubbleEl.appendChild(suffixSpan);
    }

    this.bubbleEl.classList.add('visible');

 // 左: いいよ (allow)
    const allowBtn = document.createElement('button');
    allowBtn.className = 'permission-side-btn permission-side-btn--allow';
    allowBtn.dataset.requestId = requestId;
    allowBtn.innerHTML = '';
    var allowIcon = document.createElement('span'); allowIcon.className = 'psb-icon'; allowIcon.textContent = '✓';
    var allowLabel = document.createElement('span'); allowLabel.className = 'psb-label'; allowLabel.textContent = i18nT('permission.allow_btn');
    allowBtn.appendChild(allowIcon); allowBtn.appendChild(allowLabel);

 // 右: やめて (deny)
    const denyBtn = document.createElement('button');
    denyBtn.className = 'permission-side-btn permission-side-btn--deny';
    denyBtn.dataset.requestId = requestId;
    denyBtn.innerHTML = '';
    var denyIcon = document.createElement('span'); denyIcon.className = 'psb-icon'; denyIcon.textContent = '✗';
    var denyLabel = document.createElement('span'); denyLabel.className = 'psb-label'; denyLabel.textContent = i18nT('permission.deny_btn');
    denyBtn.appendChild(denyIcon); denyBtn.appendChild(denyLabel);

 // Bug1 fix: CSS animation は Electron 非フォーカス透過ウィンドウで throttle され
 // running のまま opacity:0 に固着する。rAF でフェードインする。
 // まず opacity:0 で DOM に追加し、次フレームで opacity:1 + transition をセット。
    allowBtn.style.opacity = '0';
    denyBtn.style.opacity  = '0';
    this.el.appendChild(allowBtn);
    this.el.appendChild(denyBtn);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
 // 2フレーム待つことで DOM がレイアウト済みの状態で transition を開始する
        allowBtn.style.transition = 'opacity 0.25s ease, box-shadow 0.12s ease';
        denyBtn.style.transition  = 'opacity 0.25s ease, box-shadow 0.12s ease';
        allowBtn.style.opacity = '1';
        denyBtn.style.opacity  = '1';
      });
    });

 // queue バッジ表示
    this._updatePermissionBadge(this.permissionQueue.length);

 // click-through を OFF にして操作できるようにする
    _setClickThrough(false);

 // §5.10.4.1 renderer 55s auto-dismiss (bridge には送らない)
    if (this._permissionDismissTimer) { clearTimeout(this._permissionDismissTimer); }
    this._permissionDismissTimer = setTimeout(() => {
      this._permissionDismissTimer = null;
      this._dismissPermissionUi();
    }, 55000);

 // §5.10.3 first-run hint: 初回のみ 3 秒 tooltip
    const firstRunKey = 'kurotan.permissionUi.firstRunDone';
    if (!localStorage.getItem(firstRunKey)) {
 // 250ms (permission-btn-in) 完了後にフェードイン
      setTimeout(() => {
        this._showFirstRunHint();
        localStorage.setItem(firstRunKey, '1');
      }, 280);
    }

 // decide: クリック時の決定処理
    const decide = (decision) => {
 // 二重呼び出し防止: 150ms フェードアウト中の二度押しで _dequeuePermission() が
 // 2 回呼ばれて queue 余分消費するのを防ぐ (tech-lead 2026-05-02 WARNING 1)
      if (decide._called) return;
      decide._called = true;
      if (this._permissionDismissTimer) {
        clearTimeout(this._permissionDismissTimer);
        this._permissionDismissTimer = null;
      }
      const durationMs = Date.now() - this._permissionReceivedAt;

 // §5.10.7 演出
      if (decision === 'allow') {
 // allow: ボタン 150ms フェードアウト（吹き出し表示と並列）→ 「わかった！やってみるね」1.5 秒
 this._fadeOutPermissionButtons(null, 150); // callback 不要・吹き出しは同時開始
 this.isInPermissionMode = false; // ロック解除して bubbleEl を直接操作
        this.bubbleEl.innerHTML = '';
        const t = document.createElement('span');
        t.className = 'permission-bubble-text';
        t.textContent = i18nT('bubble.permission_allow');
        this.bubbleEl.appendChild(t);
        this.bubbleEl.classList.add('visible');
 this.isInPermissionMode = true; // 他の showBubble 上書き防止
        setTimeout(() => {
          this._finalDismissPermissionUi();
 // queue 次件
          this._dequeuePermission();
        }, 1500);
      } else {
 // deny: 250ms フェードアウト → 「うん、やめとくね」2 秒
        this._fadeOutPermissionButtons(() => {
          this.isInPermissionMode = false;
          this.bubbleEl.innerHTML = '';
          const t = document.createElement('span');
          t.className = 'permission-bubble-text';
          t.textContent = i18nT('bubble.permission_deny');
          this.bubbleEl.appendChild(t);
          this.bubbleEl.classList.add('visible');
          this.isInPermissionMode = true;
          setTimeout(() => {
            this._finalDismissPermissionUi();
            this._dequeuePermission();
          }, 2000);
        });
      }

 // main に決定を送信
      if (window.kurotanBridge && window.kurotanBridge.sendPermissionDecision) {
        window.kurotanBridge.sendPermissionDecision({
          requestId,
          decision,
          durationMs,
          source: 'click',
        });
      }
    };

    allowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      decide('allow');
    });

    denyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      decide('deny');
    });
  }

 /** §5.10.3 first-run hint: 3 秒表示後フェードアウト */
  _showFirstRunHint() {
    const existing = this.el.querySelector('.permission-firstrun-tooltip');
    if (existing) existing.remove();

    const tooltip = document.createElement('div');
    tooltip.className = 'permission-firstrun-tooltip';
    tooltip.textContent = i18nT('permission.tooltip');
    this.el.appendChild(tooltip);

 // フェードイン: requestAnimationFrame で opacity 0→1
    requestAnimationFrame(() => {
      tooltip.classList.add('visible');
    });

 // 3 秒後フェードアウト
    setTimeout(() => {
      tooltip.classList.remove('visible');
      setTimeout(() => tooltip.remove(), 400);
    }, 3000);
  }

 /** ボタン要素を DOM から即除去する */
  _removePermissionButtons() {
    this.el.querySelector('.permission-side-btn--allow')?.remove();
    this.el.querySelector('.permission-side-btn--deny')?.remove();
  }

 /**
 * opacity フェードアウト後にボタンを除去して callback を呼ぶ。
 * @param {function|null} callback - フェードアウト完了後に呼ぶ関数。null の場合は呼ばない
 * @param {number} [durationMs=250] - フェードアウト時間 (ms)。allow=150 / deny=250 (既定)
 */
  _fadeOutPermissionButtons(callback, durationMs = 250) {
    const allow = this.el.querySelector('.permission-side-btn--allow');
    const deny  = this.el.querySelector('.permission-side-btn--deny');
    let done = 0;
    const total = (allow ? 1 : 0) + (deny ? 1 : 0);

    if (total === 0) { if (callback) callback(); return; }

    const finish = () => {
      done++;
      if (done >= total && callback) callback();
    };

    const fadeClass = durationMs <= 150
      ? 'permission-btn-fadeout-allow'
      : 'permission-btn-fadeout';

    [allow, deny].forEach((btn) => {
      if (!btn) return;
      btn.classList.add(fadeClass);
      setTimeout(() => {
        btn.remove();
        finish();
      }, durationMs);
    });
  }

 /** §5.10.6 queue 件数バッジを更新する (0 件で非表示) */
  _updatePermissionBadge(count) {
    let badge = this.el.querySelector('.permission-queue-badge');
    if (count <= 0) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'permission-queue-badge';
      this.el.appendChild(badge);
    }
    badge.textContent = String(count);
  }

 /** 吹き出しの suffix span のみ更新する (queue 0 で suffix 非表示) */
  _updatePermissionSuffix(count) {
    if (!this.isInPermissionMode) return;
    let suffix = this.bubbleEl.querySelector('.permission-bubble-suffix');
    if (count <= 0) {
      if (suffix) suffix.remove();
      return;
    }
    if (!suffix) {
      suffix = document.createElement('span');
      suffix.className = 'permission-bubble-suffix';
      this.bubbleEl.appendChild(suffix);
    }
    suffix.textContent = i18nT('bubble.permission_queue', { count: count });
  }

 /**
 * 演出完了後の最終 dismiss (ロック解除 + 状態 idle 復帰 + click-through 戻し)。
 * ボタンと吹き出し は呼び出し前に処理済みであること。
 */
  _finalDismissPermissionUi() {
    this.isInPermissionMode = false;
    this._updatePermissionBadge(0);
    this.hideBubble();
    if (this.currentState === 'permission') {
      this.setState('idle');
    }
    HitDetector.forceCheck();
  }

 /**
 * §5.10.6 queue の次件を 200ms 後に処理する。
 * queue が空なら何もしない。
 */
  _dequeuePermission() {
    if (this.permissionQueue.length === 0) return;
    setTimeout(() => {
      const next = this.permissionQueue.shift();
      if (!next) return;
      this._updatePermissionBadge(this.permissionQueue.length);
      this._showPermissionUi(next);
    }, 200);
  }

 /**
 * §5.10.5 dismiss 経路 (a)(b)(c)(d)(e) すべてで通す汎用 dismiss。
 * ボタン除去 + 演出なし即 idle 復帰。
 * auto-dismiss (renderer 55s) / アンマウント / 外部 fallback から呼ぶ。
 */
  _dismissPermissionUi() {
    if (this._permissionDismissTimer) {
      clearTimeout(this._permissionDismissTimer);
      this._permissionDismissTimer = null;
    }
    this._removePermissionButtons();
 // 旧 spike 互換除去
    this.el.querySelector('.permission-panel')?.remove();
    this.el.querySelector('.permission-firstrun-tooltip')?.remove();
    this._updatePermissionBadge(0);
    this.isInPermissionMode = false;
    this.bubbleEl.innerHTML = '';
    this.hideBubble();
    if (this.currentState === 'permission') {
      this.setState('idle');
    }
    HitDetector.forceCheck();
 // queue もクリア (dismiss 経路では次件を処理しない)
    this.permissionQueue = [];
  }

 // ─── : contextLevel モディファイア (§5.9 / §5.8.1) ───

 /**
 * §5.9 凍結 - で再検討
 * 見た目への反映は停止。内部状態 (this.contextLevel) の保持のみ行う。
 * el.dataset.contextLevel / el.dataset.contextLocked は設定しない。
 *
 * @param {'low'|'mid'|'high'|'critical'|'critical-locked'} level
 */
  setContextLevel(level) {
 // §5.9 凍結のため見た目反映停止。内部値のみ保持する。
    const isCriticalLocked = level === 'critical-locked';
    this.contextLevel = isCriticalLocked ? 'critical' : (level || 'low');
 // el.dataset.contextLevel / el.dataset.contextLocked は意図的に設定しない。
  }

 /**
 * §5.9 凍結 - で再検討
 * 見た目反映は停止のため no-op。
 */
  _reapplyContextLevelAfterSuccess() {
 // §5.9 凍結のため no-op。el.dataset.contextLevel は設定しない。
  }

 /**
 * compact refresh 演出 (§5.9.5): 「ふぅ」吹き出し + 深呼吸 + 汗パーティクル。
 * throttle 30 秒 (重複発火防止)。
 * §5.9 凍結 - で再検討:
 * data-context-level の dataset 操作は削除。吹き出し / CSS クラス演出は維持。
 */
  triggerCompactRefresh() {
    const now = Date.now();
    const COMPACT_REFRESH_THROTTLE_MS = 30000;
    if (now - this.compactRefreshThrottle < COMPACT_REFRESH_THROTTLE_MS) return;
    this.compactRefreshThrottle = now;

 // §5.9 凍結: el.dataset.contextLevel 操作は行わない。

 // 「ふぅ」吹き出し (1.5 秒)
    if (!this.isInPermissionMode) {
      this.showBubble(i18nT('bubble.compact_refresh'), 1500);
    }

 // 深呼吸モーション (CSS クラスで制御)
    this.el.classList.add('compact-refresh');
    setTimeout(() => {
      this.el.classList.remove('compact-refresh');
    }, 1500);

 // 汗パーティクル (0.5 秒後に落下)
    setTimeout(() => {
      const sweat = document.createElement('div');
      sweat.className = 'compact-sweat-particle';
      sweat.textContent = '💧';
      this.parentMascotEl.appendChild(sweat);
      setTimeout(() => sweat.remove(), 600);
    }, 100);

 // §5.9 凍結: 1.5 秒後の el.dataset.contextLevel 復元も削除。
  }

 // ─── DOM 削除 ───────────────────────────────────────────────

  dispose() {
    this.isInPermissionMode = false;
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
    if (this.successIdleTimer) clearTimeout(this.successIdleTimer);
    if (this.errorIdleTimer) clearTimeout(this.errorIdleTimer);
    if (this.taskDoneTimer) clearTimeout(this.taskDoneTimer);
    if (this.ultrathinkTimer) clearTimeout(this.ultrathinkTimer);
    if (this.rareMotionTimer) clearTimeout(this.rareMotionTimer);
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    if (this.sleepZzzTimer) clearInterval(this.sleepZzzTimer);
    if (this.sleepTalkTimer) clearInterval(this.sleepTalkTimer);
 // §5.6.7 スパークル merge タイマーをクリア
    if (this._sparkleMergeTimer) { clearTimeout(this._sparkleMergeTimer); this._sparkleMergeTimer = null; }
    this._clearStateEffects();
    DragController.disable(this);
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }
}

// ─── DragController ────────────────────────────────────────────

const DragController = {
 _active: null, // 現在ドラッグ中の MascotElement

  enable(mascot) {
    mascot._onPointerDown = (e) => DragController._start(e, mascot);
    mascot.parentMascotEl.addEventListener('pointerdown', mascot._onPointerDown);
  },

  disable(mascot) {
    if (mascot._onPointerDown) {
      mascot.parentMascotEl.removeEventListener('pointerdown', mascot._onPointerDown);
      mascot._onPointerDown = null;
    }
  },

  _start(e, mascot) {
 if (e.button !== 0) return; // 左クリックのみ
    e.preventDefault();
    DragController._active = mascot;
    mascot.el.classList.add('dragging');
 // B 案: position: fixed / 1 display 限定なので e.clientX = 画面座標と一致する。
    mascot._dragStartX = e.clientX - mascot.x;
    mascot._dragStartY = e.clientY - mascot.y;
    mascot._saveTimer = null;

 // click-through OFF (ドラッグ中は常時クリック有効)
    _setClickThrough(false);

    document.addEventListener('pointermove', DragController._move);
    document.addEventListener('pointerup', DragController._end);
  },

  _move(e) {
    const mascot = DragController._active;
    if (!mascot) return;
    requestAnimationFrame(() => {
      const x = e.clientX - mascot._dragStartX;
      const y = e.clientY - mascot._dragStartY;
 // B 案: clamp を window 幅基準で行う
      const clampedX = clamp(x, 0, window.innerWidth - 320);
      const clampedY = clamp(y, 0, window.innerHeight - 220);
      mascot.setPosition(clampedX, clampedY);
    });
  },

  _end() {
    const mascot = DragController._active;
    if (!mascot) return;
    DragController._active = null;
    mascot.el.classList.remove('dragging');

 // debounce 保存
    if (mascot._saveTimer) clearTimeout(mascot._saveTimer);
    mascot._saveTimer = setTimeout(() => {
      if (window.kurotanBridge && window.kurotanBridge.savePosition) {
        window.kurotanBridge.savePosition(mascot.sessionId, mascot.x, mascot.y);
      }
    }, DRAG_SAVE_DEBOUNCE_MS);

    document.removeEventListener('pointermove', DragController._move);
    document.removeEventListener('pointerup', DragController._end);
 // hit test を再実行して click-through を戻す
    HitDetector.forceCheck();
  },
};

// ─── MascotRegistry ────────────────────────────────────────────

/**
 * sessionId → MascotElement の管理レジストリ。
 */
const MascotRegistry = {
 /** @type {Map<string, MascotElement>} */
  _map: new Map(),

 /**
 * 新しいマスコットを生成する。
 * @param {string} sessionId
 * @param {{ cwd, model, position, hueIndex, badgeIndex }} opts
 */
  spawn(sessionId, opts) {
 if (this._map.has(sessionId)) return; // 二重生成防止
    const mascot = new MascotElement(sessionId, opts);
    this._map.set(sessionId, mascot);
    HitDetector.invalidate();
 // 0.9.70: 親マスコット登場吹き出し (entry animation 後 1.1 秒で表示、3 秒間)
    setTimeout(() => {
      if (!mascot.el || !mascot.el.isConnected) return;
      if (mascot.isInPermissionMode) return;
      if (mascot.isSleeping) return;
      const idx = 1 + Math.floor(Math.random() * 5);
      const key = `bubble.parent_welcome_${idx}`;
      const line = i18nT(key);
      if (line && line !== key) {
        mascot.showBubble(line, 3000);
      }
    }, 1100);
  },

 /**
 * マスコットを削除する。
 * @param {string} sessionId
 * @param {boolean} withFarewell
 */
  despawn(sessionId, withFarewell) {
    const mascot = this._map.get(sessionId);
    if (!mascot) return;
    if (withFarewell) {
      mascot.setState('farewell');
      mascot.showBubble(i18nT('bubble.farewell'), 3000);
    } else {
      mascot.dispose();
    }
    this._map.delete(sessionId);
    HitDetector.invalidate();
  },

 /**
 * 状態更新。
 * @param {string} sessionId
 * @param {object} data
 */
  update(sessionId, data) {
    const mascot = this._map.get(sessionId);
    if (!mascot) return;

    if (data.hidden !== undefined) {
      mascot.el.classList.toggle('is-hidden', !!data.hidden);
    }

    if (data.position) {
      mascot.setPosition(data.position.x, data.position.y);
    }

 // 0.9.25: /rename customTitle の動的更新
    if (typeof data.sessionLabel === 'string' && data.sessionLabel !== mascot.sessionLabel) {
      mascot.sessionLabel = data.sessionLabel;
      mascot._applySessionLabel();
    }

    if (data.state) {
 // Bug2 fix (仕様 §5.10 A案): permission UI 表示中は state / bubbleText 更新をスキップ。
 // Notification(permission_prompt) が permission-request IPC より先に renderer へ届く
 // race condition で '承認待ち' が吹き出しを上書きする問題への対処。
      if (!mascot.isInPermissionMode) {
        mascot.setState(data.state);
      }
    }

    if (data.bubbleText != null) {
 // Bug2 fix: isInPermissionMode 中は bubbleText 更新をスキップ (race condition 対策)
 // showBubble() 内にも同ガードがあるが、onMascotUpdate が onPermissionRequest より
 // 先に処理された場合は isInPermissionMode = false のためガードが効かない。
 // ここで二重にガードすることで race condition を確実に防ぐ。
      if (!mascot.isInPermissionMode) {
        const timeout = BUBBLE_TIMEOUT_MS[data.state || mascot.currentState] || 0;
        mascot.showBubble(data.bubbleText, timeout, !!data.pinBubble);
      }
    }

    if (data.childSpawn) {
      mascot.spawnChild(data.childSpawn);
    }

    if (data.childDespawn) {
      mascot.despawnChild(data.childDespawn);
    }

 // §5.6.5: 副→公式統合 (childMerge payload)
    if (data.childMerge) {
      mascot.mergeChild(data.childMerge);
    }

 // サブエージェント完了時のパーティクル演出トリガー
    if (data.sparkle) {
      if (typeof mascot.triggerSparkle === 'function') {
        mascot.triggerSparkle(typeof data.sparkle === 'object' ? data.sparkle : {});
      }
    }

 // §5.12 登場モーション class 付与
    if (data._entryAnimation) {
      const anim = data._entryAnimation;
      if (anim.id) {
        const cls = 'entry-anim-' + anim.id.toLowerCase();
 // D モーション: CSS 変数で delay をセット
        if (anim.id === 'D' && anim.delayMs > 0) {
          mascot.el.style.setProperty('--entry-anim-delay', anim.delayMs + 'ms');
        }
 // E モーション: 専用 DOM 要素を一時 active 化
        if (anim.id === 'E') {
          const spotlightEl = mascot.el.querySelector('.entry-e-spotlight');
          const logoEl = mascot.el.querySelector('.entry-e-logo');
          const ringEl = mascot.el.querySelector('.entry-e-ring');
          if (spotlightEl) spotlightEl.style.display = '';
          if (logoEl) logoEl.style.display = '';
          if (ringEl) ringEl.style.display = '';
        }
        mascot.el.classList.add(cls);
 // animationend で class を自動除去 (once)
        mascot.el.addEventListener('animationend', function handler(event) {
 // 子要素 (.entry-e-*) の animationend は bubble で上がってくるので無視
          if (event.target !== mascot.el) return;
          mascot.el.classList.remove(cls);
          mascot.el.style.removeProperty('--entry-anim-delay');
 // E モーション: 専用 DOM 要素を非表示に戻す
          if (anim.id === 'E') {
            const spotlightEl = mascot.el.querySelector('.entry-e-spotlight');
            const logoEl = mascot.el.querySelector('.entry-e-logo');
            const ringEl = mascot.el.querySelector('.entry-e-ring');
            if (spotlightEl) spotlightEl.style.display = 'none';
            if (logoEl) logoEl.style.display = 'none';
            if (ringEl) ringEl.style.display = 'none';
          }
 // mascot-fadein 再トリガ防止 (animation-name 変化による replay を抑止)
 // entry-anim 完了後は inline animation:none で固定する
          mascot.el.style.animation = 'none';
          mascot.el.removeEventListener('animationend', handler);
        });
      }
 // anim.id が null (off) の場合: 既存 fade-in にフォールバック (何もしない)
    }
  },

  getAll() {
    return [...this._map.values()];
  },
};

// ─── click-through 制御 ─────────────────────────────────────────

let _lastIgnore = true;

function _setClickThrough(ignore) {
  if (_lastIgnore === ignore) return;
  _lastIgnore = ignore;
  if (window.kurotanBridge && window.kurotanBridge.setIgnoreMouseEvents) {
    window.kurotanBridge.setIgnoreMouseEvents(ignore);
  }
}

const HitDetector = {
  _throttleTimer: null,
  _dirty: false,
  _lastHovered: false,

  invalidate() { this._dirty = true; },

  forceCheck() {
    this._lastHovered = !_lastIgnore;
    _setClickThrough(true);
  },

  check(cx, cy) {
    if (this._throttleTimer) return;
    this._throttleTimer = setTimeout(() => {
      this._throttleTimer = null;
 // ドラッグ中はスキップ（常時 ignore=false 固定）
      if (DragController._active) return;

 const PERM_HIT_MARGIN = 8; // permission ボタン専用 hit area 拡大量 (px)

      let hovered = false;
      for (const mascot of MascotRegistry.getAll()) {
        if (mascot.isHidden) continue;
        const targets = [
          { el: mascot.parentMascotEl, margin: 0 },
          { el: mascot.bubbleEl,       margin: 0 },
        ];
        if (mascot.isInPermissionMode) {
          const allow = mascot.el.querySelector('.permission-side-btn--allow');
          const deny  = mascot.el.querySelector('.permission-side-btn--deny');
          if (allow) targets.push({ el: allow, margin: PERM_HIT_MARGIN });
          if (deny)  targets.push({ el: deny,  margin: PERM_HIT_MARGIN });
        }
        for (const t of targets) {
          if (!t.el) continue;
          const r = t.el.getBoundingClientRect();
          const m = t.margin;
          if (cx >= r.left - m && cx <= r.right + m && cy >= r.top - m && cy <= r.bottom + m) {
            hovered = true;
            break;
          }
        }
        if (hovered) break;
      }
      if (hovered !== this._lastHovered) {
        this._lastHovered = hovered;
 // hover: click-through OFF (ignore=false), 非 hover: click-through ON (ignore=true)
        _setClickThrough(!hovered);
      }
    }, HIT_THROTTLE_MS);
  },
};

document.addEventListener('mousemove', (e) => {
  HitDetector.check(e.clientX, e.clientY);
});

// ─── offline 全体切替 ───────────────────────────────────────────

function setAllOffline(isOffline) {
  for (const mascot of MascotRegistry.getAll()) {
    if (isOffline) {
      mascot.setState('offline');
      mascot.showBubble(i18nT('bubble.offline'), 0);
    } else {
      mascot.setState('idle');
      mascot.hideBubble();
    }
  }
}

// ─── IPC ブリッジ受信 ───────────────────────────────────────────

function setupIpc() {
  if (!window.kurotanBridge) {
    console.warn('[stage] kurotanBridge not available');
    return;
  }

 // B 案: kurotan:stage-bounds IPC は廃止。onStageBounds リスナーは登録しない。
 // CSS 100vw/100vh と position: fixed で 1 display に収める。

 // マスコット追加
  window.kurotanBridge.onMascotAdd((data) => {
 // 0.9.15: payload に showSessionLabel が来たらグローバル flag を更新
    if (typeof data.showSessionLabel === 'boolean') {
      _showSessionLabel = data.showSessionLabel;
    }
    MascotRegistry.spawn(data.sessionId, {
      cwd:          data.cwd,
      sessionLabel: data.sessionLabel,
      model:        data.model,
      position:     data.position,
      hueIndex:     data.hueIndex,
      badgeIndex:   data.badgeIndex,
    });
  });

 // 0.9.15: セッション名ラベル ON/OFF 切替通知
  if (window.kurotanBridge.onShowSessionLabelChange) {
    window.kurotanBridge.onShowSessionLabelChange((show) => {
      _showSessionLabel = show;
      MascotRegistry._map.forEach((mascot) => mascot._applySessionLabel());
    });
  }

 // マスコット状態更新
  window.kurotanBridge.onMascotUpdate((data) => {
    MascotRegistry.update(data.sessionId, data);
  });

 // マスコット削除
  window.kurotanBridge.onMascotRemove((data) => {
    MascotRegistry.despawn(data.sessionId, data.withFarewell);
  });

 // ULTRATHINK イースターエッグ (§5.7.1): main からの検知通知を受けて発火
  if (window.kurotanBridge.onUltrathinkTrigger) {
    window.kurotanBridge.onUltrathinkTrigger((sessionId) => {
      const mascot = MascotRegistry._map.get(sessionId);
      if (mascot) mascot.triggerUltrathink();
    });
  }

 // KORONE イースターエッグ (§5.7.2): main からの検知通知を受けてグローバル flag + 全 DOM に dataset 付与
  if (window.kurotanBridge.onEasterEggKorone) {
    window.kurotanBridge.onEasterEggKorone(() => {
      _koroneMode = true;
      document.querySelectorAll('.mascot-container').forEach((el) => {
        el.dataset.easterEgg = 'korone';
      });
    });
  }

 // online / offline
  if (window.kurotanBridge.onOnline) {
    window.kurotanBridge.onOnline(() => setAllOffline(false));
  }

 // 深夜モード変更通知 (§5.5 / §8.1)
  if (window.kurotanBridge.onNightModeChange) {
    window.kurotanBridge.onNightModeChange((nightMode) => {
      _nightMode = !!nightMode;
      console.log(`[kurotan] nightMode changed: ${_nightMode}`);
    });
  }

 // アートスタイル変更通知
  if (window.kurotanBridge.onArtStyleChange) {
    window.kurotanBridge.onArtStyleChange((artStyle) => {
      _artStyle = artStyle || 'sd';
      console.log(`[kurotan] artStyle changed: ${_artStyle}`);
      applyArtStyleToAll();
    });
  }

 // 吹き出しスタイル変更通知
  if (window.kurotanBridge.onBubbleStyleChange) {
    window.kurotanBridge.onBubbleStyleChange((bubble) => {
      applyBubbleStyle(bubble);
    });
  }

 // PostToolUse の "task done" ポップ演出
  if (window.kurotanBridge.onMascotTaskDone) {
    window.kurotanBridge.onMascotTaskDone((data) => {
      const mascot = MascotRegistry._map.get(data.sessionId);
      if (mascot) mascot.popTaskDone();
    });
  }

 // ─── §5.10 Permission Bridge () ────────────────────────
  if (window.kurotanBridge.onPermissionRequest) {
    window.kurotanBridge.onPermissionRequest((data) => {
      if (!data) return;

 // §5.10.5.1 sessionId fallback
      const sid = data.sessionId;
      const isFallback = !sid || !MascotRegistry._map.has(sid);

      let mascot = isFallback ? null : MascotRegistry._map.get(sid);

      if (isFallback) {
        if (MascotRegistry._map.size === 0) {
 // マスコット 0 体: §5.10.4 フォールバック (ask は main 60s timeout に任せる)
          console.warn('[stage] permission-request: no mascot available, dropping (sessionId:', sid, ')');
          return;
        }
 // 最初の既存マスコットに割り当て
        mascot = MascotRegistry._map.values().next().value;
        console.warn('[stage] permission-request: fallback to first mascot (sessionId was:', sid, ')');
 // operation log は KUROTAN_PERMISSION_LOG=1 のとき main 側で記録するため renderer では不要
 // fallback-no-sessionid の source は decide 時の IPC payload には含まれない
 // (決定時の source は 'click' / 'auto-dismiss' のみ)
      }

      if (mascot) {
 // fallback の場合は data を __defaultPermissionSession__ で補完
        const reqData = isFallback
          ? Object.assign({}, data, { sessionId: '__defaultPermissionSession__' })
          : data;
        mascot._handlePermissionRequest(reqData);
      }
    });
  }

 // 0.9.13: permission auto-dismiss 撤廃 (ask モードは永続承認待ち / 詰まり時は tray 再起動で脱出)

 // renderer クラッシュ後のセッション復元
  if (window.kurotanBridge.onSessionRestore) {
    window.kurotanBridge.onSessionRestore((sessions) => {
      for (const s of sessions) {
        MascotRegistry.spawn(s.sessionId, {
          cwd:        s.cwd,
          model:      s.model,
          position:   s.position,
          hueIndex:   s.hueIndex,
          badgeIndex: s.badgeIndex,
        });
        if (s.state) {
          MascotRegistry.update(s.sessionId, { state: s.state });
        }
      }
    });
  }

 // §5.6.7 SubagentStop ✨ パーティクル演出 (main process からの専用通知チャンネル)
 // main process は SubagentStop 受信時に { sessionId, sparkle: true } を送る。
 // 副トラック (PostToolUse(Agent)) 経由でも同チャンネルを使う (旧版 Claude Code 互換)。
  if (window.kurotanBridge.onSubagentSparkle) {
    window.kurotanBridge.onSubagentSparkle((data) => {
      const mascot = MascotRegistry._map.get(data.sessionId);
      if (mascot) {
        mascot.triggerSparkle({ success: data.success !== false });
      }
    });
  }

 // ─── : contextLevel 受信 (§5.9.2 / §5.9.6) ────────────
 // IPC payload は { sessionId, level } のみ (プライバシー §12 項目 6)。
  if (window.kurotanBridge.onContextLevel) {
    window.kurotanBridge.onContextLevel((data) => {
      if (!data || !data.sessionId) return;
      const mascot = MascotRegistry._map.get(data.sessionId);
      if (mascot) mascot.setContextLevel(data.level || 'low');
    });
  }

 // compact refresh 演出受信 (§5.9.5): SessionStart / PreCompact / PostCompact 時に発火
  if (window.kurotanBridge.onCompactRefresh) {
    window.kurotanBridge.onCompactRefresh((data) => {
      if (!data || !data.sessionId) return;
      const mascot = MascotRegistry._map.get(data.sessionId);
      if (mascot) mascot.triggerCompactRefresh();
    });
  }

 // contextMotion 設定変更受信 (§5.9.8): enabled 変更を全マスコットに反映
  if (window.kurotanBridge.onContextMotion) {
    window.kurotanBridge.onContextMotion((cm) => {
      if (!cm) return;
      _contextMotionEnabled = cm.enabled !== false;
 // enabled=false の場合は全マスコットの contextLevel を low にリセット
      for (const mascot of MascotRegistry.getAll()) {
        mascot.setContextLevel(mascot.contextLevel);
      }
    });
  }

 // ─── ローカル検証用 debug IPC リスナー (/3) ──────────

 // debug-context-level: 全マスコットの contextLevel を value (0.0〜1.0) で上書き
 // §5.9 準拠: 0.30未満=low / 0.30-0.60=mid / 0.60-0.80=high / 0.80-0.95=critical / 0.95+=critical-locked
  if (window.kurotanBridge.onDebugContextLevel) {
    window.kurotanBridge.onDebugContextLevel((data) => {
      if (!data || typeof data.value !== 'number') return;
      const v = data.value;
 // 数値 → level 文字列変換 (§5.9 コンテキスト閾値)
      let level;
      if (v >= 0.95) {
 level = 'critical-locked'; // 95-100%: sleepy 固定 + 視線追従停止
      } else if (v >= 0.80) {
 level = 'critical'; // 80-95%: sleepy 差分
      } else if (v >= 0.60) {
 level = 'high'; // 60-80%: drowsy 半開き
      } else if (v >= 0.30) {
 level = 'mid'; // 30-60%: stretch 抽選
      } else {
 level = 'low'; // 0-30%: 通常 idle
      }
      for (const mascot of MascotRegistry.getAll()) {
        mascot.setContextLevel(level);
      }
      console.log(`[stage][debug] context-level set value=${v} → level=${level} (${MascotRegistry.getAll().length} mascots)`);
    });
  }

 // debug-dom-dump: 全マスコットの DOM 状態を main process へ返す
  if (window.kurotanBridge.onDebugDomDump && window.kurotanBridge.sendDomDumpResponse) {
    window.kurotanBridge.onDebugDomDump((data) => {
      const stageEl = document.getElementById('mascot-stage');
      const mascots = MascotRegistry.getAll().map(m => {
        const spriteEl = m.el.querySelector('.sprite');
        const parentMascotEl = m.el.querySelector('.parent-mascot');
        const allowBtn = m.el.querySelector('.permission-side-btn--allow');
        const denyBtn  = m.el.querySelector('.permission-side-btn--deny');
        const getBtnInfo = (btn) => {
          if (!btn) return null;
          const cs = window.getComputedStyle(btn);
          const rect = btn.getBoundingClientRect();
          return {
            exists: true,
            opacity: cs.opacity,
            display: cs.display,
            visibility: cs.visibility,
            zIndex: cs.zIndex,
            left: cs.left,
            bottom: cs.bottom,
            width: cs.width,
            height: cs.height,
            animation: cs.animation,
            rectLeft: rect.left,
            rectTop: rect.top,
            rectWidth: rect.width,
            rectHeight: rect.height,
          };
        };
        return {
          sessionId: m.sessionId,
          currentState: m.currentState,
          contextLevel: m.contextLevel,
          dataset: Object.assign({}, m.el.dataset),
          spriteBgInline: spriteEl ? spriteEl.style.backgroundImage : null,
          spriteComputedBg: spriteEl ? window.getComputedStyle(spriteEl).backgroundImage : null,
          parentMascotComputedOpacity: parentMascotEl ? window.getComputedStyle(parentMascotEl).opacity : null,
          parentMascotRectBottom: parentMascotEl ? parentMascotEl.getBoundingClientRect().bottom : null,
          allowBtn: getBtnInfo(allowBtn),
          denyBtn: getBtnInfo(denyBtn),
          containerRect: (() => { const r = m.el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })(),
          childrenRow: (() => {
            const row = m.el.querySelector('.children-row');
            const rowRect = row ? row.getBoundingClientRect() : null;
            const childEls = m.el.querySelectorAll('.child-mascot');
            const children = Array.from(childEls).map(c => {
              const cr = c.getBoundingClientRect();
              const sprite = c.querySelector('.child-sprite');
              const sr = sprite ? sprite.getBoundingClientRect() : null;
              return {
                childId: c.dataset.childId,
                rectTop: cr.top, rectBottom: cr.bottom, rectLeft: cr.left, rectWidth: cr.width, rectHeight: cr.height,
                spriteRectBottom: sr ? sr.bottom : null,
              };
            });
            return {
              rowRect: rowRect ? { top: rowRect.top, bottom: rowRect.bottom, left: rowRect.left, height: rowRect.height } : null,
              count: childEls.length,
              children,
            };
          })(),
        };
      });
      window.kurotanBridge.sendDomDumpResponse({
        requestId: data.requestId,
        stageDataset: stageEl ? Object.assign({}, stageEl.dataset) : null,
        mascotCount: mascots.length,
        mascots,
      });
    });
  }

 // debug-reset-onboarding: localStorage の onboarding flag を全削除
  if (window.kurotanBridge.onDebugResetOnboarding) {
    window.kurotanBridge.onDebugResetOnboarding(() => {
      const ONBOARDING_KEYS = [
        'kurotan.contextMotion.firstRunDone',
        'kurotan.permissionUi.firstRunDone',
        'kurotan.onboarding.done',
        'kurotan.onboarding.firstRunDone',
        'kurotan.tooltip.shown',
      ];
      const removed = [];
      for (const key of ONBOARDING_KEYS) {
        if (localStorage.getItem(key) !== null) {
          localStorage.removeItem(key);
          removed.push(key);
        }
      }
 // localStorage に kurotan. プレフィックスのキーを網羅的にスキャン
      const allKeys = Object.keys(localStorage);
      for (const key of allKeys) {
        if (key.startsWith('kurotan.') && (key.includes('firstRun') || key.includes('onboarding') || key.includes('tooltip'))) {
          if (!removed.includes(key)) {
            localStorage.removeItem(key);
            removed.push(key);
          }
        }
      }
      console.log(`[stage][debug] reset-onboarding: removed ${removed.length} key(s):`, removed);
    });
  }
}

// ─── 起動 ──────────────────────────────────────────────────────

async function onReady() {
 // 初期 artStyle / bubble / contextMotion を config から取得して反映
  if (window.kurotanBridge && window.kurotanBridge.settings) {
    try {
      const cfg = await window.kurotanBridge.settings.getConfig();
      if (cfg && cfg.artStyle) {
        _artStyle = cfg.artStyle;
        applyArtStyleToAll();
      }
      if (cfg && cfg.bubble) {
        applyBubbleStyle(cfg.bubble);
      }
 // : contextMotion.enabled 初期値を反映
      if (cfg && cfg.contextMotion) {
        _contextMotionEnabled = cfg.contextMotion.enabled !== false;
      }
    } catch (e) {
      console.warn('[stage] getConfig failed, using defaults:', e);
    }
  }
  setupIpc();
}

// ─── 吹き出しスタイル適用 ──────────────────────────────────────
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = hex.replace('#', '').match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function applyBubbleStyle(bubble) {
  if (!bubble || typeof bubble !== 'object') return;
  const root = document.documentElement;
  if (bubble.fontSize) {
    root.style.setProperty('--bubble-font-size', `${bubble.fontSize}px`);
  }
  if (bubble.fontFamily) {
    root.style.setProperty('--bubble-font-family', `${bubble.fontFamily}, 'Noto Sans JP', 'Meiryo', sans-serif`);
  }
  if (bubble.textColor) {
    root.style.setProperty('--bubble-text-color', bubble.textColor);
  }
  if (bubble.bgColor) {
    const rgb = hexToRgb(bubble.bgColor);
    const opacity = (bubble.bgOpacity != null) ? bubble.bgOpacity : 0.85;
    if (rgb) {
      root.style.setProperty('--bubble-bg', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`);
    } else {
      root.style.setProperty('--bubble-bg', bubble.bgColor);
    }
  } else if (bubble.bgOpacity != null) {
 // bgColor 不変で opacity だけ更新する場合のフォールバック
    const rgb = hexToRgb('#1e1e32');
    root.style.setProperty('--bubble-bg', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${bubble.bgOpacity})`);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onReady);
} else {
  onReady();
}
