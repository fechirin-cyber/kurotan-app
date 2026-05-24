#!/usr/bin/env node
/**
 * kurotan hooks インストーラ CLI
 * ~/.claude/settings.json に kurotan の hooks エントリをマージ追記する。
 *
 * 使用方法:
 * node src/installer/install-hooks.js # インストール
 * node src/installer/install-hooks.js --dry-run # diff 表示のみ（実書き込みなし）
 * node src/installer/install-hooks.js --uninstall # kurotanManaged エントリ削除
 * node src/installer/install-hooks.js --restore-backup # バックアップから復元
 *
 * マージポリシー (spec §13.2.1):
 * 1. 同一 event × matcher × command が既存なら skip
 * 2. 同一 event × matcher で異なる command → append（既存破壊しない）
 * 3. 追加エントリに kurotanManaged: true マーカー付与
 * 4. 書き込み前にバックアップ保存
 * 5. JSON 破損時は中止してメッセージ表示
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── 引数パース ───────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const UNINSTALL = args.includes('--uninstall');
const RESTORE_BACKUP = args.includes('--restore-backup');

// ─── パス定義 ─────────────────────────────────────────────────
const HOME = os.homedir();
const SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');

/**
 * kurotan-notify.js / kurotan-permission-bridge.js の絶対パスを動的解決する。
 *
 * 解決優先順位 (spec §13.6.3):
 * 1. 環境変数 KUROTAN_NOTIFY_SCRIPT_OVERRIDE (テスト用上書き)
 * 2. process.resourcesPath が存在する場合 = Electron 配布版
 * → $INSTDIR/resources/app.asar.unpacked/src/notify/... を使用
 * (asar 内 JS は外部 node.exe から直接実行不可。unpacked 展開版を使う)
 * 3. それ以外 = 開発時 (__dirname 起点)
 * → kurotan/src/installer/../notify/... を使用
 */
function resolveNotifyScriptPath(filename) {
 // 優先 1: テスト用環境変数上書き
  if (process.env.KUROTAN_NOTIFY_SCRIPT_OVERRIDE) {
    return path.join(process.env.KUROTAN_NOTIFY_SCRIPT_OVERRIDE, filename);
  }

 // 優先 2: Electron 配布版 — process.resourcesPath 配下の unpacked が **実在** する場合のみ採用
 // (開発時 Electron では resourcesPath は <electron>/resources で実在するが
 //  unpacked 配下に kurotan ファイルはないため target file の存在まで確認する)
  if (process.resourcesPath) {
    const packagedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'notify', filename);
    if (fs.existsSync(packagedPath)) {
      return packagedPath;
    }
  }

 // 優先 3: 開発時 (__dirname = kurotan/src/installer/)
  return path.join(__dirname, '..', 'notify', filename);
}

const NOTIFY_SCRIPT  = resolveNotifyScriptPath('kurotan-notify.js');
const BRIDGE_SCRIPT  = resolveNotifyScriptPath('kurotan-permission-bridge.js');
const NOTIFY_COMMAND = `node "${NOTIFY_SCRIPT}"`;
const BRIDGE_COMMAND = `node "${BRIDGE_SCRIPT}"`;

// バックアップファイルパス（インストール時に作成、--restore-backup で使用）
function getBackupPath(timestamp) {
  const ts = timestamp || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${SETTINGS_PATH}.backup-${ts}`;
}

// ─── kurotan が管理する 14 イベントの定義 ─────────────────────
// spec §2.1 / §2.2 / §5.6.3 / §5.9.5 準拠
// UserPromptSubmit / Stop / PreCompact / PostCompact は matcher 非対応
// SubagentStart / SubagentStop: §5.6.3 に従い matcher: '*' で受け、デーモン側でフィルタ
// PreCompact: blocking hook (exit 0 必須) — kurotan-notify は即 exit 0 (agent_guide §2 項目 1)
// §13.2.1 マージポリシー: 既存値の上書き禁止。未登録の場合のみ追記する
const KUROTAN_HOOKS = [
  { event: 'SessionStart',        matcher: '*',                hasMatcher: true  },
  { event: 'UserPromptSubmit',    matcher: null,               hasMatcher: false },
  { event: 'UserPromptExpansion', matcher: '*',                hasMatcher: true  },
  { event: 'PreToolUse',          matcher: '.*',               hasMatcher: true  },
  { event: 'PostToolUse',         matcher: '.*',               hasMatcher: true  },
  { event: 'PostToolUseFailure',  matcher: '.*',               hasMatcher: true  },
  { event: 'Stop',                matcher: null,               hasMatcher: false },
  { event: 'StopFailure',         matcher: '.*',               hasMatcher: true  },
  { event: 'Notification',        matcher: 'permission_prompt', hasMatcher: true },
  { event: 'SessionEnd',          matcher: '.*',               hasMatcher: true  },
 // : 公式 SubagentStart / SubagentStop (spec §5.6.3)
  { event: 'SubagentStart',       matcher: '*',                hasMatcher: true  },
  { event: 'SubagentStop',        matcher: '*',                hasMatcher: true  },
 // : コンテキスト圧縮検知 (§5.9.5)
  { event: 'PreCompact',          matcher: null,               hasMatcher: false },
  { event: 'PostCompact',         matcher: null,               hasMatcher: false },
];

// ─── 各イベントの hook command エントリを生成 ─────────────────
function makeHookCommand(command, options) {
  return Object.assign({ type: 'command', command, kurotanManaged: true }, options);
}

// ─── settings.json 読み込み ───────────────────────────────────
function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return {};
  }
  const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`settings.json のパースに失敗: ${e.message}\nファイル: ${SETTINGS_PATH}`);
  }
}

// ─── JSON を atomic write（一時ファイル → rename） ────────────
function writeSettingsAtomic(settings) {
 // 親 ~/.claude/ ディレクトリが未作成だと初回環境で失敗するので先に作成する
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmpPath = `${SETTINGS_PATH}.kurotan-tmp-${Date.now()}`;
  const json = JSON.stringify(settings, null, 2) + '\n';
  fs.writeFileSync(tmpPath, json, 'utf8');
  fs.renameSync(tmpPath, SETTINGS_PATH);
}

// ─── バックアップ作成 ─────────────────────────────────────────
function createBackup() {
  if (!fs.existsSync(SETTINGS_PATH)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = getBackupPath(ts);
  fs.copyFileSync(SETTINGS_PATH, backupPath);
  console.log(`[backup] ${backupPath}`);
  return backupPath;
}

// ─── 最新バックアップを探す ───────────────────────────────────
function findLatestBackup() {
  const dir = path.dirname(SETTINGS_PATH);
  const base = path.basename(SETTINGS_PATH);
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith(base + '.backup-'))
      .sort()
      .reverse();
    return files.length > 0 ? path.join(dir, files[0]) : null;
  } catch (e) {
    return null;
  }
}

// ─── diff 表示ヘルパー ────────────────────────────────────────
function showDiff(label, before, after) {
  console.log(`\n===== diff: ${label} =====`);
  const beforeStr = JSON.stringify(before, null, 2);
  const afterStr = JSON.stringify(after, null, 2);
  if (beforeStr === afterStr) {
    console.log('  (変更なし)');
    return;
  }
 // 簡易 diff: 追加行に + 、削除行に - を付けて表示
  const beforeLines = beforeStr.split('\n');
  const afterLines = afterStr.split('\n');
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  const addedLines = afterLines.filter(l => !beforeLines.includes(l));
  const removedLines = beforeLines.filter(l => !afterLines.includes(l));
  for (const l of removedLines) console.log(`  - ${l}`);
  for (const l of addedLines)   console.log(`  + ${l}`);
}

// ─── インストール処理 ─────────────────────────────────────────
function install() {
  console.log('=== kurotan hooks インストーラ ===');
  if (DRY_RUN) console.log('[dry-run] 実際の書き込みは行いません\n');

  let settings;
  try {
    settings = readSettings();
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    console.error('手動で settings.json を確認してください。');
    if (require.main === module) process.exit(1);
    throw e;
  }

  const before = JSON.parse(JSON.stringify(settings));

 // hooks キーが無ければ初期化
  if (!settings.hooks) settings.hooks = {};

  let addedCount = 0;
  let skippedCount = 0;

  for (const def of KUROTAN_HOOKS) {
    const { event, matcher, hasMatcher } = def;

 // 既存のイベント配列を取得（無ければ空配列）
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const eventArr = settings.hooks[event];

 // 既存エントリの中から同一 matcher を持つ group を探す
 // matcher なし(UserPromptSubmit/Stop)の場合は hasMatcher===false のエントリが対象
    let targetGroup = null;
    for (const group of eventArr) {
      const groupHasMatcher = 'matcher' in group;
      if (!hasMatcher && !groupHasMatcher) {
        targetGroup = group;
        break;
      }
      if (hasMatcher && groupHasMatcher && group.matcher === matcher) {
        targetGroup = group;
        break;
      }
    }

 // group が無ければ作成
    if (!targetGroup) {
      targetGroup = hasMatcher ? { matcher, hooks: [] } : { hooks: [] };
      eventArr.push(targetGroup);
    }

 // hooks 配列内で同一 command が既存かチェック
    if (!targetGroup.hooks) targetGroup.hooks = [];
    const already = targetGroup.hooks.some(h => h.command === NOTIFY_COMMAND);
    if (already) {
      console.log(`[skip]  ${event}${hasMatcher ? ` (matcher: ${matcher})` : ''} — 既存エントリあり`);
      skippedCount++;
      continue;
    }

 // 追加
    targetGroup.hooks.push(makeHookCommand(NOTIFY_COMMAND, { async: true, timeout: 2 }));
    console.log(`[add]   ${event}${hasMatcher ? ` (matcher: ${matcher})` : ''}`);
    addedCount++;
  }

 // ─── bridge (PreToolUse sync) 登録 ───────────────────────────
  {
    const event = 'PreToolUse';
    const matcher = '.*';
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const eventArr = settings.hooks[event];

    let targetGroup = eventArr.find(g => 'matcher' in g && g.matcher === matcher) || null;
    if (!targetGroup) {
      targetGroup = { matcher, hooks: [] };
      eventArr.push(targetGroup);
    }
    if (!targetGroup.hooks) targetGroup.hooks = [];

    const bridgeAlready = targetGroup.hooks.some(h => h.command === BRIDGE_COMMAND);
    if (bridgeAlready) {
      console.log(`[skip]  ${event} (matcher: ${matcher}) bridge — 既存エントリあり`);
      skippedCount++;
    } else {
      targetGroup.hooks.push(makeHookCommand(BRIDGE_COMMAND, { async: false, timeout: 65000 }));
      console.log(`[add]   ${event} (matcher: ${matcher}) bridge`);
      addedCount++;
    }
  }

  console.log(`\n追加: ${addedCount} / スキップ: ${skippedCount}`);

 // diff 表示
  showDiff('hooks', before.hooks || {}, settings.hooks);

  if (DRY_RUN) {
    console.log('\n[dry-run] 書き込みをスキップしました。--dry-run を外すと適用されます。');
    return;
  }

  if (addedCount === 0) {
    console.log('\n変更なし。settings.json は更新しません。');
    return;
  }

 // バックアップ
  const backupPath = createBackup();

 // atomic write
  writeSettingsAtomic(settings);
  console.log(`\n[done] ${SETTINGS_PATH} を更新しました。`);
  if (backupPath) console.log(`       バックアップ: ${backupPath}`);
  console.log('\nClaude Code を再起動すると hooks が有効になります。');
}

// ─── アンインストール処理 ─────────────────────────────────────
function uninstall() {
  console.log('=== kurotan hooks アンインストーラ ===');
  if (DRY_RUN) console.log('[dry-run] 実際の書き込みは行いません\n');

  let settings;
  try {
    settings = readSettings();
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    if (require.main === module) process.exit(1);
    throw e;
  }

  if (!settings.hooks) {
    console.log('hooks エントリがありません。何もしません。');
    return;
  }

  const before = JSON.parse(JSON.stringify(settings));
  let removedCount = 0;

  for (const [eventName, eventArr] of Object.entries(settings.hooks)) {
    if (!Array.isArray(eventArr)) continue;

    for (const group of eventArr) {
      if (!Array.isArray(group.hooks)) continue;

      const before_len = group.hooks.length;
      group.hooks = group.hooks.filter(h => {
        if (h.kurotanManaged === true) {
          console.log(`[remove] ${eventName}${group.matcher ? ` (matcher: ${group.matcher})` : ''} — ${h.command}`);
          removedCount++;
          return false;
        }
        return true;
      });
    }

 // hooks が空になった group を除去
    settings.hooks[eventName] = eventArr.filter(group => {
      if (!Array.isArray(group.hooks)) return true;
      return group.hooks.length > 0;
    });

 // event 配列が空になったら event キー自体を削除
    if (settings.hooks[eventName].length === 0) {
      delete settings.hooks[eventName];
    }
  }

 // hooks オブジェクトが空になったら削除
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  console.log(`\n削除: ${removedCount}`);

  if (removedCount === 0) {
    console.log('kurotanManaged エントリが見つかりませんでした。何もしません。');
    return;
  }

 // diff 表示
  showDiff('hooks', before.hooks || {}, settings.hooks || {});

  if (DRY_RUN) {
    console.log('\n[dry-run] 書き込みをスキップしました。');
    return;
  }

 // バックアップ
  const backupPath = createBackup();

 // atomic write
  writeSettingsAtomic(settings);
  console.log(`\n[done] ${SETTINGS_PATH} を更新しました。`);
  if (backupPath) console.log(`       バックアップ: ${backupPath}`);
}

// ─── バックアップ復元処理 ─────────────────────────────────────
function restoreBackup() {
  console.log('=== kurotan バックアップ復元 ===');

  const backupPath = findLatestBackup();
  if (!backupPath) {
    console.error('[ERROR] バックアップファイルが見つかりません。');
    if (require.main === module) process.exit(1);
    throw new Error('backup not found');
  }

  console.log(`復元元: ${backupPath}`);
  console.log(`復元先: ${SETTINGS_PATH}`);

  if (DRY_RUN) {
    console.log('[dry-run] 復元をスキップしました。');
    return;
  }

 // 現在の状態をバックアップしてから復元
  createBackup();
  fs.copyFileSync(backupPath, SETTINGS_PATH);
  console.log('[done] 復元完了。');
}

// ─── ヘルプ表示 ───────────────────────────────────────────────
function showHelp() {
  console.log(`
kurotan hooks インストーラ

使用方法:
  node src/installer/install-hooks.js              インストール
  node src/installer/install-hooks.js --dry-run    diff 表示のみ（実書き込みなし）
  node src/installer/install-hooks.js --uninstall  kurotanManaged エントリ削除
  node src/installer/install-hooks.js --restore-backup  最新バックアップから復元

オプション:
  --dry-run         実書き込みなしで diff のみ表示
  --uninstall       kurotanManaged: true のエントリをすべて削除
  --restore-backup  最新バックアップファイルから settings.json を復元
  --help            このヘルプを表示

備考:
  PreToolUse (matcher: .*) には notify (観測, async) と bridge (承認応答, sync) の 2 件が登録される。

対象ファイル: ${SETTINGS_PATH}
  `.trim());
}

// ─── モジュールエクスポート (Electron main から require で呼び出す用) ──
// CLI として直接実行された場合のみエントリポイントを動かす。
// require() 経由では即実行しない。
if (require.main === module) {
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
  } else if (RESTORE_BACKUP) {
    restoreBackup();
  } else if (UNINSTALL) {
    uninstall();
  } else {
    install();
  }
}

module.exports = { install, uninstall };
