#!/usr/bin/env node
/**
 * after-pack.js — electron-builder の afterPack フック
 *
 * 目的:
 * electron-builder v25 + electron 33 環境で win.icon の自動埋め込みが silently
 * skip される事象 (winCodeSign 内 rcedit-x64.exe の解決失敗) への対策として、
 * afterPack で rcedit を直接呼び出して kurotan.exe にアイコンを再埋め込みする。
 *
 * 実行タイミング: dist/win-unpacked/ が作られた直後、NSIS パッケージ前
 *
 * 失敗時の挙動: rcedit が見つからない / 実行失敗時は警告のみ、ビルドは継続。
 * (元の electron-builder の挙動と同等)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function afterPack(context) {
 // Windows ビルドのみ対象
  if (context.electronPlatformName !== 'win32') {
    return;
  }

 const appOutDir = context.appOutDir; // 例: dist/win-unpacked
 const projectDir = context.packager.projectDir; // kurotan ルート
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(appOutDir, exeName);
  const iconPath = path.join(projectDir, 'assets', 'icons', 'kurotan.ico');

  if (!fs.existsSync(exePath)) {
    console.warn(`[after-pack] kurotan.exe が見つかりません: ${exePath}`);
    return;
  }
  if (!fs.existsSync(iconPath)) {
    console.warn(`[after-pack] kurotan.ico が見つかりません: ${iconPath}`);
    return;
  }

 // rcedit-x64.exe の候補パスを順に探索
  const rceditCandidates = [
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign', '106121839', 'rcedit-x64.exe'),
    path.join(projectDir, 'node_modules', '@electron', 'rcedit', 'bin', 'rcedit-x64.exe'),
    path.join(projectDir, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
  ];

  let rcedit = null;
  for (const cand of rceditCandidates) {
    if (cand && fs.existsSync(cand)) {
      rcedit = cand;
      break;
    }
  }

  if (!rcedit) {
    console.warn('[after-pack] rcedit-x64.exe が見つかりません。アイコン再埋め込みをスキップします。');
    console.warn('  確認候補:');
    for (const c of rceditCandidates) console.warn(`    - ${c}`);
    return;
  }

  try {
    execFileSync(rcedit, [exePath, '--set-icon', iconPath], { stdio: 'inherit' });
    console.log(`[after-pack] アイコン再埋め込み成功: ${exeName} ← kurotan.ico`);
  } catch (e) {
    console.warn(`[after-pack] rcedit 実行失敗: ${e.message}`);
  }
};
