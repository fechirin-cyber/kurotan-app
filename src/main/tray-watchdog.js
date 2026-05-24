'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

const parentPid = Number.parseInt(argValue('--parent-pid') || '', 10);
const refreshScript = argValue('--script');
const logPath = argValue('--log');
const runtimePath = argValue('--runtime');
let parentWindowHandles = [];

function log(message) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] tray-watchdog ${message}\n`, 'utf8');
  } catch (e) {
 // Ignore logging failures. The helper must never keep the app alive.
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function captureParentWindowHandles() {
  if (process.platform !== 'win32' || !refreshScript || !fs.existsSync(refreshScript)) return;

  try {
    const result = spawnSync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', refreshScript,
      '-CapturePid', String(parentPid),
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });

    if (result.status === 0 && result.stdout) {
      parentWindowHandles = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      log(`captured-hwnds count=${parentWindowHandles.length}`);
    } else {
      log(`capture-hwnds-skipped status=${result.status}`);
    }
  } catch (e) {
    log(`capture-hwnds-error ${e.message}`);
  }
}

function refreshTray() {
  if (process.platform !== 'win32' || !refreshScript || !fs.existsSync(refreshScript)) {
    log('refresh-skipped');
    process.exit(0);
  }

  const child = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', refreshScript,
    '-DeleteHwnds', parentWindowHandles.join(','),
  ], {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });

  const timeout = setTimeout(() => {
    try {
      child.kill();
    } catch (e) {
 // Best effort only.
    }
    log('refresh-timeout');
    process.exit(0);
  }, 5000);

  child.on('exit', (code) => {
    clearTimeout(timeout);
    log(`refresh-exit code=${code}`);
    process.exit(0);
  });

  child.on('error', (e) => {
    clearTimeout(timeout);
    log(`refresh-error ${e.message}`);
    process.exit(0);
  });
}

function deleteRuntimeIfOwned() {
  if (!runtimePath || !fs.existsSync(runtimePath)) return;

  try {
    const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
    if (runtime && runtime.pid === parentPid) {
      fs.unlinkSync(runtimePath);
      log('runtime-deleted');
    }
  } catch (e) {
    log(`runtime-delete-skipped ${e.message}`);
  }
}

if (!Number.isInteger(parentPid) || parentPid <= 0) {
  log('invalid-parent-pid');
  process.exit(0);
}

log(`watching parent=${parentPid}`);
captureParentWindowHandles();

const startedAt = Date.now();
const interval = setInterval(() => {
  if (!isPidAlive(parentPid)) {
    clearInterval(interval);
    log(`parent-exited elapsedMs=${Date.now() - startedAt}`);
    deleteRuntimeIfOwned();
    setTimeout(refreshTray, 250);
  }
}, 500);

setTimeout(() => {
  clearInterval(interval);
  log('watchdog-expired');
  process.exit(0);
}, 24 * 60 * 60 * 1000);
