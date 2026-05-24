#!/usr/bin/env node
/**
 * build-prepare.js — kurotan ビルド前処理スクリプト
 *
 * 呼び出し: package.json の "prebuild" スクリプト経由
 * "prebuild": "node scripts/build-prepare.js"
 *
 * 処理内容:
 * 1. EULA.md を UTF-8 BOM 付き .txt に変換 → build/license/EULA.txt
 * (NSIS インストーラの「使用許諾」画面で表示するため BOM 必須)
 * 2. npx license-checker --production --json を実行
 * → build/license/third-party-licenses.json 生成
 * (失敗時はスキップして警告のみ — devDependency のみ環境では空になる可能性がある)
 * 3. assets/icons/kurotan.ico の存在確認
 * なければビルド前警告 (ビルドは継続、NSIS がデフォルトアイコンを使用)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── パス定義 ────────────────────────────────────────────────────
const ROOT        = path.join(__dirname, '..');
const EULA_SRC    = path.join(ROOT, 'EULA.md');
const BUILD_DIR   = path.join(ROOT, 'build');
const LICENSE_DIR = path.join(BUILD_DIR, 'license');
const EULA_TXT    = path.join(LICENSE_DIR, 'EULA.txt');
const THIRD_PARTY = path.join(LICENSE_DIR, 'third-party-licenses.json');
const ICON_PATH   = path.join(ROOT, 'assets', 'icons', 'kurotan.ico');

// ─── ユーティリティ ──────────────────────────────────────────────
function log(msg)  { console.log(`[build-prepare] ${msg}`); }
function warn(msg) { console.warn(`[build-prepare] WARN: ${msg}`); }
function err(msg)  { console.error(`[build-prepare] ERROR: ${msg}`); }

// ─── Step 1: EULA.md → build/license/EULA.txt (UTF-8 BOM 付き) ──
function convertEula() {
  log('Step 1: EULA.md → build/license/EULA.txt (UTF-8 BOM)');

  if (!fs.existsSync(EULA_SRC)) {
    err(`EULA.md が見つかりません: ${EULA_SRC}`);
    err('EULA.md をリポジトリルートに配置してください。');
    process.exit(1);
  }

 // build/license/ ディレクトリを作成
  if (!fs.existsSync(LICENSE_DIR)) {
    fs.mkdirSync(LICENSE_DIR, { recursive: true });
    log(`  作成: ${LICENSE_DIR}`);
  }

 // Markdown を読み込み
  const md = fs.readFileSync(EULA_SRC, 'utf8');

 // NSIS が表示できるようにシンプルなテキストに変換
 // Markdown の # 見出しを == 区切りに、** を除去する程度の変換に留める
 // (完全な Markdown → テキスト変換は不要。NSIS は改行・通常テキストを表示できる)
  let txt = md
 .replace(/^#{1,6}\s+(.+)$/gm, '=== $1 ===') // # 見出し → === 見出し ===
 .replace(/\*\*(.+?)\*\*/g, '$1') // **太字** → 太字
 .replace(/\*(.+?)\*/g, '$1') // *斜体* → 斜体
 .replace(/^---+$/gm, '──────────────────────────────────────────────') // --- → 水平線
 .replace(/^\|(.+)\|$/gm, (line) => line) // テーブル行はそのまま保持
 .replace(/^- /gm, ' - '); // リスト項目に軽いインデント

 // UTF-8 BOM (0xEF, 0xBB, 0xBF) を先頭に付与
  const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
  const content = Buffer.concat([BOM, Buffer.from(txt, 'utf8')]);
  fs.writeFileSync(EULA_TXT, content);

  log(`  出力: ${EULA_TXT} (${content.length} bytes, UTF-8 BOM 付き)`);
}

// ─── Step 2: license-checker でサードパーティライセンス収集 ─────
function collectLicenses() {
  log('Step 2: license-checker でサードパーティライセンス収集');

  try {
 // npx license-checker --production --json
 // --production: devDependencies を除外 (electron-builder 等はビルド時のみ)
 // kurotan は本番依存ゼロ想定だが将来のため仕掛けを入れておく
    const output = execSync(
      'npx --yes license-checker --production --json',
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
 timeout: 60000, // 60 秒タイムアウト
      }
    );

    if (!fs.existsSync(LICENSE_DIR)) {
      fs.mkdirSync(LICENSE_DIR, { recursive: true });
    }
    fs.writeFileSync(THIRD_PARTY, output, 'utf8');
    log(`  出力: ${THIRD_PARTY}`);

 // 件数表示
    try {
      const parsed = JSON.parse(output);
      log(`  収集件数: ${Object.keys(parsed).length} パッケージ`);
    } catch (_) {
 // JSON パース失敗は無視
    }
  } catch (e) {
 // license-checker の失敗はビルドを止めない (警告のみ)
    warn('license-checker の実行に失敗しました。third-party-licenses.json はスキップします。');
    warn(`  詳細: ${e.message ? e.message.split('\n')[0] : String(e)}`);
    warn('  npm install 後に再実行してください。');

 // 空の JSON を生成して electron-builder が参照できる状態にする
    if (!fs.existsSync(LICENSE_DIR)) {
      fs.mkdirSync(LICENSE_DIR, { recursive: true });
    }
    if (!fs.existsSync(THIRD_PARTY)) {
      fs.writeFileSync(THIRD_PARTY, '{}', 'utf8');
      warn(`  空ファイルを生成: ${THIRD_PARTY}`);
    }
  }
}

// ─── Step 3: アイコンファイル存在確認 ───────────────────────────
function checkIcon() {
  log('Step 3: assets/icons/kurotan.ico 存在確認');

  if (fs.existsSync(ICON_PATH)) {
    const stat = fs.statSync(ICON_PATH);
    log(`  OK: ${ICON_PATH} (${stat.size} bytes)`);
  } else {
    warn(`アイコンファイルが見つかりません: ${ICON_PATH}`);
    warn('  アイコンなしでビルドすると NSIS がデフォルトアイコンを使用します。');
    warn('  ビルド自体は継続します。');
  }
}

// ─── メイン ──────────────────────────────────────────────────────
log('=== kurotan ビルド前処理 開始 ===');

convertEula();
collectLicenses();
checkIcon();

log('=== kurotan ビルド前処理 完了 ===');
