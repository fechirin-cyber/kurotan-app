'use strict';

/**
 * mascot.js - くろたん renderer メインスクリプト
 *
 * 担当:
 * - main process から IPC 経由でイベントを受け取り状態を更新
 * - 状態遷移ステートマシン（仕様 §5）
 * - 吹き出し表示・タイマー管理
 * - 子くろたん管理（Agent ツール発動時）
 * - offline 状態の表示
 * - カーソル追従（目の向き ±15° / 仕様 §5.5.1）
 */

// ─── 定数 ──────────────────────────────────────────────────────
const STATE = {
  IDLE: 'idle',
  THINKING: 'thinking',
  TOOL_READ: 'tool_read',
  TOOL_EDIT: 'tool_edit',
  TOOL_BASH: 'tool_bash',
  TOOL_WEB: 'tool_web',
  TOOL_SKILL: 'tool_skill',
  TOOL_OTHER: 'tool_other',
  SUCCESS: 'success',
  ERROR: 'error',
  PERMISSION: 'permission',
  FAREWELL: 'farewell',
  OFFLINE: 'offline',
};

const STATE_CSS_CLASS = {
  [STATE.IDLE]:       'state-idle',
  [STATE.THINKING]:   'state-thinking',
  [STATE.TOOL_READ]:  'state-tool-read',
  [STATE.TOOL_EDIT]:  'state-tool-edit',
  [STATE.TOOL_BASH]:  'state-tool-bash',
  [STATE.TOOL_WEB]:   'state-tool-web',
  [STATE.TOOL_SKILL]: 'state-tool-skill',
  [STATE.TOOL_OTHER]: 'state-tool-other',
  [STATE.SUCCESS]:    'state-success',
  [STATE.ERROR]:      'state-error',
  [STATE.PERMISSION]: 'state-permission',
  [STATE.FAREWELL]:   'state-farewell',
  [STATE.OFFLINE]:    'state-offline',
};

// PreToolUse tool_name → state ID のマッピング（仕様 §5.2）
const TOOL_STATE_MAP = {
  'Read':           STATE.TOOL_READ,
  'Glob':           STATE.TOOL_READ,
  'Grep':           STATE.TOOL_READ,
  'Edit':           STATE.TOOL_EDIT,
  'Write':          STATE.TOOL_EDIT,
  'NotebookEdit':   STATE.TOOL_EDIT,
  'Bash':           STATE.TOOL_BASH,
  'BashOutput':     STATE.TOOL_BASH,
  'KillShell':      STATE.TOOL_BASH,
  'WebFetch':       STATE.TOOL_WEB,
  'WebSearch':      STATE.TOOL_WEB,
  'Skill':          STATE.TOOL_SKILL,
 // Agent / Task は親の状態を変えない（子くろたん生成のみ）
};

const BUBBLE_TIMEOUT_MS = {
  [STATE.IDLE]:       0,
 [STATE.THINKING]: 0, // 次イベントまで維持
  [STATE.TOOL_READ]:  0,
  [STATE.TOOL_EDIT]:  0,
  [STATE.TOOL_BASH]:  0,
  [STATE.TOOL_WEB]:   0,
  [STATE.TOOL_SKILL]: 0,
  [STATE.TOOL_OTHER]: 0,
  [STATE.SUCCESS]:    2000,
  [STATE.ERROR]:      4000,
 [STATE.PERMISSION]: 0, // ユーザー操作まで維持
  [STATE.FAREWELL]:   3000,
 [STATE.OFFLINE]: 0, // 常時表示
};

// ─── DOM 参照 ──────────────────────────────────────────────────
const root = document.getElementById('mascot-root');
const bubble = document.getElementById('bubble');
const stateLabel = document.getElementById('state-label');
const skillStarFx = document.getElementById('skill-star-fx');
const offlineExclaim = document.getElementById('offline-exclaim');
const childrenRow = document.getElementById('children-row');
const sprite = document.getElementById('sprite');

// ─── Transition Matrix（仕様 §5.7） ───────────────────────────
// O = 許可、X = 禁止（値 false）、- = 同状態（no-op、遷移しない）
// 行 = 遷移元、列 = 遷移先。許可遷移先の Set で管理する。
// 自己遷移（STATE.X → STATE.X）は setState の先頭 no-op チェックで処理するため Set には含めない。
//
// 仕様 §5.7 Matrix（行 = from, 列 = to, O のみ列挙）:
// idle: thinking / tool_* / success / error / permission / farewell / offline
// thinking: tool_* / success / error / permission / farewell / offline (idle は X)
// tool_read: success / error / farewell / offline
// tool_edit: success / error / farewell / offline
// tool_bash: success / error / farewell / offline
// tool_web: success / error / farewell / offline
// tool_other: success / error / farewell / offline
// tool_skill: success / error / farewell / offline
// success: idle / thinking / tool_* / permission / farewell / offline (error は X)
// error: idle / thinking / tool_* / permission / farewell / offline (success は X)
// permission: idle / thinking / tool_* / farewell / offline (success / error は X)
// farewell: (なし) ─ 終端状態
// offline: idle / farewell
const ALLOWED_TRANSITIONS = {
  [STATE.IDLE]:       new Set([STATE.THINKING, STATE.TOOL_READ, STATE.TOOL_EDIT, STATE.TOOL_BASH, STATE.TOOL_WEB, STATE.TOOL_SKILL, STATE.TOOL_OTHER, STATE.SUCCESS, STATE.ERROR, STATE.PERMISSION, STATE.FAREWELL, STATE.OFFLINE]),
  [STATE.THINKING]:   new Set([STATE.TOOL_READ, STATE.TOOL_EDIT, STATE.TOOL_BASH, STATE.TOOL_WEB, STATE.TOOL_SKILL, STATE.TOOL_OTHER, STATE.SUCCESS, STATE.ERROR, STATE.PERMISSION, STATE.FAREWELL, STATE.OFFLINE]),
  [STATE.TOOL_READ]:  new Set([STATE.SUCCESS, STATE.ERROR, STATE.FAREWELL, STATE.OFFLINE]),
  [STATE.TOOL_EDIT]:  new Set([STATE.SUCCESS, STATE.ERROR, STATE.FAREWELL, STATE.OFFLINE]),
  [STATE.TOOL_BASH]:  new Set([STATE.SUCCESS, STATE.ERROR, STATE.FAREWELL, STATE.OFFLINE]),
  [STATE.TOOL_WEB]:   new Set([STATE.SUCCESS, STATE.ERROR, STATE.FAREWELL, STATE.OFFLINE]),
  [STATE.TOOL_OTHER]: new Set([STATE.SUCCESS, STATE.ERROR, STATE.FAREWELL, STATE.OFFLINE]),
  [STATE.TOOL_SKILL]: new Set([STATE.SUCCESS, STATE.ERROR, STATE.FAREWELL, STATE.OFFLINE]),
  [STATE.SUCCESS]:    new Set([STATE.IDLE, STATE.THINKING, STATE.TOOL_READ, STATE.TOOL_EDIT, STATE.TOOL_BASH, STATE.TOOL_WEB, STATE.TOOL_SKILL, STATE.TOOL_OTHER, STATE.PERMISSION, STATE.FAREWELL, STATE.OFFLINE]),
  [STATE.ERROR]:      new Set([STATE.IDLE, STATE.THINKING, STATE.TOOL_READ, STATE.TOOL_EDIT, STATE.TOOL_BASH, STATE.TOOL_WEB, STATE.TOOL_SKILL, STATE.TOOL_OTHER, STATE.PERMISSION, STATE.FAREWELL, STATE.OFFLINE]),
  [STATE.PERMISSION]: new Set([STATE.IDLE, STATE.THINKING, STATE.TOOL_READ, STATE.TOOL_EDIT, STATE.TOOL_BASH, STATE.TOOL_WEB, STATE.TOOL_SKILL, STATE.TOOL_OTHER, STATE.FAREWELL, STATE.OFFLINE]),
  [STATE.FAREWELL]:   new Set([]),
  [STATE.OFFLINE]:    new Set([STATE.IDLE, STATE.FAREWELL]),
};

// ─── ステートマシン ────────────────────────────────────────────
let currentState = STATE.IDLE;
let bubbleTimer = null;
let stateTimer = null;
let isBubblePinned = false;

// 子くろたん管理
// childId → { element, bubbleEl, toolUseId, state }
const children = new Map();
// 上限超過（7匹目以降）のカウンタ
let overflowCount = 0;

function setState(newState) {
  if (currentState === STATE.FAREWELL) {
 // farewell 中は他の状態遷移を受け付けない（既存ガード維持）
    return;
  }

 // Transition Matrix チェック（仕様 §5.7）
  const allowed = ALLOWED_TRANSITIONS[currentState];
  if (allowed && !allowed.has(newState)) {
    console.warn(
      `[kurotan] setState BLOCKED: ${currentState} → ${newState} is not allowed by Transition Matrix (§5.7)`
    );
    return;
  }

 // 同状態（no-op）はスキップ
  if (currentState === newState) return;

 // ULTRATHINK 演出中断（farewell / offline 遷移時）
  if (newState === STATE.FAREWELL || newState === STATE.OFFLINE) {
    stopUltrathink();
  }

 // CSS クラスの切り替え
  const oldClass = STATE_CSS_CLASS[currentState];
  const newClass = STATE_CSS_CLASS[newState];
  if (oldClass) root.classList.remove(oldClass);
  if (newClass) root.classList.add(newClass);

  currentState = newState;
  stateLabel.textContent = newState;

 // 0.9.32: notifyStateChange 呼び出し削除 (mouseFollow 撤廃に伴い main 側ハンドラなし)

 // 星エフェクト
  if (newState === STATE.TOOL_SKILL) {
    triggerSkillStarFx();
  } else {
    skillStarFx.classList.remove('active');
  }

 // offline エフェクト
  if (newState === STATE.OFFLINE) {
    offlineExclaim.classList.add('active');
  } else {
    offlineExclaim.classList.remove('active');
  }
}

function triggerSkillStarFx() {
  skillStarFx.classList.remove('active');
 // リフロー強制してアニメを再トリガー
  void skillStarFx.offsetWidth;
  skillStarFx.classList.add('active');
}

// ─── 吹き出し ──────────────────────────────────────────────────
function showBubble(text, durationMs) {
  if (isBubblePinned) return;

  clearTimeout(bubbleTimer);
  bubble.textContent = text;
  bubble.classList.add('visible');

  if (durationMs > 0) {
    bubbleTimer = setTimeout(() => hideBubble(), durationMs);
  }

 // ULTRATHINK 検出（仕様 §5.6.1: 吹き出し本文を主検出源）
  if (ULTRATHINK_RE.test(text)) {
    startUltrathink();
  }
}

function hideBubble() {
  if (isBubblePinned) return;
  bubble.classList.remove('visible');
  bubble.textContent = '';
}

// ─── イベントハンドラ ──────────────────────────────────────────
function handleEvent(payload) {
 // Claude Code hooks は hook_event_name キーで送信する。
 // 内部イベントは event キーを使う。両方を参照してフォールバック。
  const event = payload.event || payload.hook_event_name || '';
  const toolName = payload.tool_name || '';
  const digest = payload.tool_input_digest || {};

  clearTimeout(stateTimer);

  switch (event) {
    case 'SessionStart':
      setState(STATE.IDLE);
      showBubble('こんにちは！', 1500);
      break;

    case 'UserPromptSubmit':
      setState(STATE.THINKING);
      showBubble('考え中...', 0);
      break;

    case 'UserPromptExpansion':
 // Skill フォールバック検出（仕様 §5.3 / §2.1）
 // PreToolUse で Skill が発火しない場合のフォールバック
 // この段階では tool_skill への遷移は行わない（PreToolUse を優先）
      break;

    case 'PreToolUse':
      handlePreToolUse(toolName, digest, payload);
      break;

    case 'PostToolUse':
      handlePostToolUse(toolName, digest, payload);
      break;

    case 'PostToolUseFailure':
      handlePostToolUseFailure(toolName, digest, payload);
      break;

    case 'Stop':
      setState(STATE.SUCCESS);
      showBubble('できたよ！', BUBBLE_TIMEOUT_MS[STATE.SUCCESS]);
      stateTimer = setTimeout(() => {
        setState(STATE.IDLE);
        hideBubble();
      }, 2000);
      break;

    case 'StopFailure':
      setState(STATE.ERROR);
      showBubble('エラーが発生したよ…', BUBBLE_TIMEOUT_MS[STATE.ERROR]);
      stateTimer = setTimeout(() => {
        setState(STATE.IDLE);
      }, 4000);
      break;

    case 'Notification':
 // 仕様 §2.2: matcher が permission_prompt のときのみ permission 遷移
 // idle_prompt / auth_success / elicitation_dialog は対象外
      if (payload.matcher === 'permission_prompt') {
        setState(STATE.PERMISSION);
        showBubble('？ 承認待ちです', 0);
      }
 // matcher が permission_prompt 以外の場合は無視（遷移しない）
      break;

    case 'SessionEnd':
      handleSessionEnd(payload);
      break;

    case 'offline':
      setState(STATE.OFFLINE);
      showBubble('Claude Code と未接続 / クリックで再接続', 0);
      break;

    default:
 // 不明なイベントは無視
      break;
  }
}

function handlePreToolUse(toolName, digest, payload) {
 // Agent / Task は親の状態を変えない（子くろたん生成のみ）
  if (toolName === 'Agent' || toolName === 'Task') {
    spawnChild(payload);
    return;
  }

  const newState = TOOL_STATE_MAP[toolName] || STATE.TOOL_OTHER;
  setState(newState);

  const bubbleText = buildToolBubble(newState, toolName, digest);
  showBubble(bubbleText, 0);
}

function handlePostToolUse(toolName, digest, payload) {
 // 子くろたんの PostToolUse 処理
  if (toolName === 'Agent' || toolName === 'Task') {
    const toolUseId = payload.tool_use_id || '';
    resolveChild(toolUseId, false);
    return;
  }

 // 200ms の微笑み差分（仕様 §5 / agent_guide §5）
  setState(STATE.SUCCESS);
  stateTimer = setTimeout(() => {
    setState(STATE.IDLE);
    hideBubble();
  }, 200);
}

function handlePostToolUseFailure(toolName, digest, payload) {
 // 子くろたんの失敗処理
  if (toolName === 'Agent' || toolName === 'Task') {
    const toolUseId = payload.tool_use_id || '';
    resolveChild(toolUseId, true);
    return;
  }

  setState(STATE.ERROR);
  const errorMsg = digest.command
    ? `${toolName} 失敗: ${digest.command}`
    : `${toolName} でエラー`;
  showBubble(errorMsg, BUBBLE_TIMEOUT_MS[STATE.ERROR]);
  stateTimer = setTimeout(() => {
    setState(STATE.IDLE);
    hideBubble();
  }, 4000);
}

function handleSessionEnd(payload) {
  setState(STATE.FAREWELL);
  showBubble('おつかれさま！', BUBBLE_TIMEOUT_MS[STATE.FAREWELL]);

 // 3 秒後にウィンドウクローズ（仕様 §5.1 farewell）
  setTimeout(() => {
    if (window.kurotanBridge) {
      window.kurotanBridge.closeWindow();
    }
  }, 3000);
}

// ─── 吹き出し文言構築 ────────────────────────────────────────
function buildToolBubble(state, toolName, digest) {
  switch (state) {
    case STATE.TOOL_READ: {
      const name = digest.file_path
        ? basename(digest.file_path)
        : (digest.pattern || '');
      return name ? `${name} を読んでる` : 'ファイルを読んでる';
    }
    case STATE.TOOL_EDIT: {
      const name = digest.file_path ? basename(digest.file_path) : '';
      return name ? `${name} を編集中` : 'ファイルを編集中';
    }
    case STATE.TOOL_BASH: {
      const cmd = digest.command || '';
      return cmd ? `${cmd} 実行中` : 'コマンド実行中';
    }
    case STATE.TOOL_WEB: {
      return '検索中...';
    }
    case STATE.TOOL_SKILL: {
 // 仕様 §5.3: skill_name が欠落した場合は「Skill 発動中…」
      const skillName = digest.skill_name || '';
      return skillName ? `「${skillName}」発動！` : 'Skill 発動中…';
    }
    case STATE.TOOL_OTHER:
    default: {
      return `${toolName} 実行中`;
    }
  }
}

function basename(filePath) {
  if (!filePath) return '';
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath;
}

// ─── 子くろたん管理 ──────────────────────────────────────────
const MAX_CHILDREN = 6; // 仕様 §5.4.3

function spawnChild(payload) {
  const toolUseId = payload.tool_use_id || ('child-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  const digest = payload.tool_input_digest || {};
  const subagentType = digest.subagent_type || 'agent';

 // 上限チェック（仕様 §5.4.3: 7匹目以降は +N 表示）
  if (children.size >= MAX_CHILDREN) {
    overflowCount++;
    updateOverflowBadge();
    return;
  }

  const slotIndex = findFreeSlot();
  const el = document.createElement('div');
  el.className = 'child-mascot spawning child-state-spawn';
  el.dataset.toolUseId = toolUseId;
  el.dataset.slotIndex = String(slotIndex);

  const childSprite = document.createElement('div');
  childSprite.className = 'child-sprite';
  el.appendChild(childSprite);

  const childBubble = document.createElement('div');
  childBubble.className = 'child-bubble visible';
  childBubble.textContent = subagentType;
  el.appendChild(childBubble);

  childrenRow.appendChild(el);
  children.set(toolUseId, { element: el, bubbleEl: childBubble, toolUseId, slotIndex });

 // ポップインアニメ完了後に spawn → idle クラスへ切替
  el.addEventListener('animationend', () => {
    el.classList.remove('spawning', 'child-state-spawn');
    el.classList.add('child-state-idle');
  }, { once: true });

 // 1.5 秒後に吹き出しを消す
  setTimeout(() => {
    childBubble.classList.remove('visible');
  }, 1500);
}

function resolveChild(toolUseId, isError) {
 // overflow カウンタ分の PostToolUse かどうかを先に確認
  if (overflowCount > 0 && !children.has(toolUseId)) {
    overflowCount = Math.max(0, overflowCount - 1);
    updateOverflowBadge();
    return;
  }

 // toolUseId 一致優先、なければ FIFO
  let child = children.get(toolUseId);
  if (!child && children.size > 0) {
 // FIFO: 最古のエントリを使用
    child = children.values().next().value;
  }
  if (!child) return;

  const fareText = isError ? 'ごめん…' : 'おつかれ！';
  child.bubbleEl.textContent = fareText;
  child.bubbleEl.classList.add('visible');

  setTimeout(() => {
 // farewell アセットへ切替してからフェードアウト
    child.element.classList.remove('child-state-idle', 'child-state-mimic', 'child-state-spawn');
    child.element.classList.add('child-state-farewell', 'dying');
    child.element.addEventListener('animationend', () => {
      child.element.remove();
      children.delete(child.toolUseId);
      updateOverflowBadge();
    }, { once: true });
  }, 2000);
}

function findFreeSlot() {
  const usedSlots = new Set([...children.values()].map(c => c.slotIndex));
  for (let i = 0; i < MAX_CHILDREN; i++) {
    if (!usedSlots.has(i)) return i;
  }
  return children.size;
}

function updateOverflowBadge() {
 // 既存の overflow badge を除去
  const existing = bubble.querySelector('.overflow-badge');
  if (existing) existing.remove();

  if (overflowCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'overflow-badge';
    badge.textContent = `+${overflowCount} 匹作業中`;
    bubble.appendChild(badge);
 // badge が見えるよう bubble を表示（未表示の場合のみ）
    if (!bubble.classList.contains('visible')) {
      bubble.classList.add('visible');
    }
  }
}

// 0.9.32: handleCursor / カーソル追従ロジック削除 (mouseFollow 機能撤廃)

// ─── ULTRATHINK 演出（仕様 §5.6 イースターエッグ） ────────────
// DOM プール（最大 30 要素）で matrix 背景を管理
const ULTRATHINK_DURATION_MS = 10000;
const MATRIX_POOL_SIZE = 30;
const MATRIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789考論深思';

let ultrathinkActive = false;
let ultrathinkTimer = null;
let matrixEl = null;
let matrixPool = [];
let matrixInterval = null;

function startUltrathink() {
 // 連打抑止: 演出中の再ヒットは無視
  if (ultrathinkActive) return;
 // farewell / offline 中は起動しない
  if (currentState === STATE.FAREWELL || currentState === STATE.OFFLINE) return;

  ultrathinkActive = true;

 // マトリックス背景レイヤーを生成
  matrixEl = document.createElement('div');
  matrixEl.id = 'ultrathink-matrix';
  root.appendChild(matrixEl);

 // DOM プール作成（最大 30 要素）
  matrixPool = [];
  for (let i = 0; i < MATRIX_POOL_SIZE; i++) {
    const span = document.createElement('span');
    span.className = 'matrix-char';
    span.style.left = (Math.random() * 100).toFixed(1) + '%';
    span.style.top = (Math.random() * 100).toFixed(1) + '%';
    matrixEl.appendChild(span);
    matrixPool.push(span);
  }

 // 10Hz でテキストをランダム更新（毎フレーム DOM 生成は禁止）
  matrixInterval = setInterval(() => {
    const idx = Math.floor(Math.random() * MATRIX_POOL_SIZE);
    const sp = matrixPool[idx];
    sp.textContent = MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)];
    sp.style.left = (Math.random() * 100).toFixed(1) + '%';
    sp.style.top = (Math.random() * 100).toFixed(1) + '%';
  }, 100);

 // hue-rotate アニメ
  root.classList.add('ultrathink-active');

 // 0.5 秒後に吹き出しを表示して 1.5 秒で消す
  setTimeout(() => {
    showBubble('ULTRATHINK モード起動！', 1500);
  }, 500);

 // 10 秒ハードストップ
  ultrathinkTimer = setTimeout(() => {
    stopUltrathink();
  }, ULTRATHINK_DURATION_MS);
}

function stopUltrathink() {
  if (!ultrathinkActive) return;
  ultrathinkActive = false;

  if (ultrathinkTimer) {
    clearTimeout(ultrathinkTimer);
    ultrathinkTimer = null;
  }
  if (matrixInterval) {
    clearInterval(matrixInterval);
    matrixInterval = null;
  }
  if (matrixEl) {
    matrixEl.remove();
    matrixEl = null;
  }
  matrixPool = [];
  root.classList.remove('ultrathink-active');
}

const ULTRATHINK_RE = /ultrathink/i;


// ─── デバッグ: state-label を #debug ハッシュ時のみ表示 ───────
if (window.location.hash === '#debug') {
  stateLabel.classList.add('debug-visible');
}

// ─── IPC ブリッジ接続 ─────────────────────────────────────────
if (window.kurotanBridge) {
  window.kurotanBridge.onEvent(handleEvent);
 // 0.9.32: onCursor 削除 (mouseFollow 機能撤廃)
  window.kurotanBridge.onOnline((data) => {
 // オンライン復旧
    if (currentState === STATE.OFFLINE) {
      setState(STATE.IDLE);
      hideBubble();
    }
  });

 // welcome 吹き出し（起動時 / トレイメニューから再表示）
  window.kurotanBridge.onWelcome((data) => {
    const text = (data && data.text) ? data.text : '起動しました！';
    const duration = (data && data.durationMs > 0) ? data.durationMs : 8000;
 // SessionStart で既に idle 状態になっているので、そのまま吹き出しだけ上書き
    showBubble(text, duration);
  });

 // welcome fade-out 要求（main から 8 秒後に送信される）
  window.kurotanBridge.onWelcomeClose(() => {
    hideBubble();
 // ウィンドウ全体を fade-out させる
    root.style.transition = 'opacity 0.4s ease';
    root.style.opacity = '0';
  });
} else {
 // プリロードなし環境（テスト用）
  console.warn('[kurotan] kurotanBridge not available (preload missing?)');
}

// ─── 吹き出しクリック: ピン留め ─────────────────────────────
bubble.addEventListener('click', (e) => {
 // root の offline クリックハンドラへのバブリングを防ぐ（仕様 §5 / G2 #5）
  e.stopPropagation();
  isBubblePinned = !isBubblePinned;
  if (isBubblePinned) {
    bubble.classList.add('pinned');
  } else {
    bubble.classList.remove('pinned');
  }
});

// ─── offline 状態のクリック: 再接続（#mascot-root のみ検出） ──
root.addEventListener('click', (e) => {
  if (currentState === STATE.OFFLINE && window.kurotanBridge) {
    window.kurotanBridge.requestReconnect();
  }
});
