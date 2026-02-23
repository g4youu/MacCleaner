const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, powerMonitor } = require('electron');
const { execSync, exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow;
let tray = null;
let trayInterval = null;
let isSuspended = false;
const DEFAULT_SETTINGS = { refreshProfile: 'balanced' };
let settings = { ...DEFAULT_SETTINGS };

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const p = getSettingsPath();
    if (!fs.existsSync(p)) return;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
  } catch {}
}

function normalizeRefreshProfile(value) {
  if (value === 'real-time' || value === 'balanced' || value === 'power-saver') return value;
  return DEFAULT_SETTINGS.refreshProfile;
}

function getRefreshProfile() {
  return normalizeRefreshProfile(settings.refreshProfile);
}

function createWindow() {
  const isDev = !app.isPackaged;
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0d0d14',
    vibrancy: 'dark',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    mainWindow.webContents.on('console-message', (e, level, msg) => console.log('[Renderer]', msg));
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.meta && input.shift && input.key === 'I') mainWindow.webContents.openDevTools();
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    resetTrayRefreshTimer();
  });
  mainWindow.on('focus', () => resetTrayRefreshTimer());
  mainWindow.on('blur', () => resetTrayRefreshTimer());
  mainWindow.on('show', () => resetTrayRefreshTimer());
  mainWindow.on('hide', () => resetTrayRefreshTimer());
  mainWindow.on('minimize', () => resetTrayRefreshTimer());
  mainWindow.on('restore', () => resetTrayRefreshTimer());
}

function showMainWindow() {
  // Window reference can exist but be destroyed after sleep/wake or manual close.
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  createTray();
  powerMonitor.on('suspend', () => {
    isSuspended = true;
    resetTrayRefreshTimer();
  });
  powerMonitor.on('resume', () => {
    isSuspended = false;
    updateTray();
    resetTrayRefreshTimer();
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (trayInterval) clearInterval(trayInterval);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 15000 }); }
  catch (e) { return ''; }
}

function runAsync(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'utf8', timeout: 30000 }, (err, stdout) => resolve(stdout || ''));
  });
}

function bytesToHuman(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function dirSize(dirPath) {
  try {
    const result = execSync(`du -sk "${dirPath}" 2>/dev/null`, { encoding: 'utf8', timeout: 10000 });
    const kb = parseInt(result.split('\t')[0]) || 0;
    return kb * 1024;
  } catch { return 0; }
}

function rmDir(dirPath) {
  try {
    execSync(`rm -rf "${dirPath}"`, { timeout: 30000 });
    return true;
  } catch { return false; }
}

function getRamSnapshot() {
  const vmstat = run('vm_stat');
  const pageSize = parseInt(run('pagesize').trim()) || 16384;
  const parsePages = (key) => {
    const m = vmstat.match(new RegExp(`${key}:\\s+(\\d+)`));
    return m ? parseInt(m[1], 10) * pageSize : 0;
  };

  const wired = parsePages('Pages wired down');
  const active = parsePages('Pages active');
  const inactive = parsePages('Pages inactive');
  const compressed = parsePages('Pages occupied by compressor');
  const free = parsePages('Pages free');
  const total = os.totalmem();
  const used = total - (free + inactive);
  const usedPct = Math.max(0, Math.min(100, Math.round((used / total) * 100)));

  return {
    total, used, free: free + inactive, wired, active, inactive, compressed, usedPct,
  };
}

function getMemoryPressure() {
  const out = run('memory_pressure');
  const pctMatch = out.match(/System-wide memory free percentage:\s*(\d+)%/i);
  const statusMatch = out.match(/System-wide memory status:\s*([A-Z]+)/i);
  const freePct = pctMatch ? parseInt(pctMatch[1], 10) : null;
  const rawStatus = statusMatch ? statusMatch[1].toUpperCase() : null;
  const level = rawStatus === 'CRITICAL'
    ? 'critical'
    : rawStatus === 'WARNING'
      ? 'warning'
      : rawStatus === 'OK'
        ? 'normal'
        : null;

  // If status parsing fails, infer from free percentage as fallback.
  const inferred = freePct === null ? 'unknown' : (freePct < 5 ? 'critical' : freePct < 12 ? 'warning' : 'normal');

  return {
    level: level || inferred,
    status: rawStatus || (inferred === 'normal' ? 'OK' : inferred === 'warning' ? 'WARNING' : inferred === 'critical' ? 'CRITICAL' : 'UNKNOWN'),
    freePct,
  };
}

function isProtectedProcessName(name) {
  const n = String(name || '').toLowerCase();
  const protectedNames = [
    'kernel_task', 'launchd', 'windowserver', 'loginwindow', 'syslogd',
    'distnoted', 'cfprefsd', 'notifyd', 'coreservicesd', 'opendirectoryd',
    'hidd', 'airportd', 'bluetoothd', 'finder', 'dock', 'controlcenter',
    'systemsettings', 'activity monitor', 'maccleaner', 'electron',
  ];
  return protectedNames.some(p => n === p || n.includes(p));
}

function getTrayIcon() {
  const trayPath = path.join(__dirname, 'assets', 'trayTemplate.png');
  if (fs.existsSync(trayPath)) {
    const img = nativeImage.createFromPath(trayPath).resize({ width: 18, height: 18 });
    img.setTemplateImage(true);
    return img;
  }

  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.icns')).resize({ width: 18, height: 18 });
}

function purgeRamWithAdminPrompt() {
  return new Promise((resolve) => {
    exec(
      `osascript -e 'do shell script "purge" with administrator privileges'`,
      { timeout: 45000 },
      (err) => {
        if (err) resolve({ success: false, error: err.message });
        else resolve({ success: true });
      }
    );
  });
}

function isSudoAuthorized() {
  try {
    execSync('sudo -n true', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function getAskpassScriptPath() {
  return path.join(app.getPath('userData'), 'askpass-maccleaner.sh');
}

function ensureAskpassScript() {
  const askpassPath = getAskpassScriptPath();
  if (fs.existsSync(askpassPath)) return askpassPath;
  const script = `#!/bin/sh
exec /usr/bin/osascript \
  -e 'text returned of (display dialog "MacCleaner needs administrator access to clean RAM." default answer "" with hidden answer buttons {"Cancel","OK"} default button "OK" with title "MacCleaner")'
`;
  fs.writeFileSync(askpassPath, script, { mode: 0o700 });
  try { fs.chmodSync(askpassPath, 0o700); } catch {}
  return askpassPath;
}

function authorizeSudoSession() {
  return new Promise((resolve) => {
    try {
      const askpassPath = ensureAskpassScript();
      exec('sudo -A -v', {
        timeout: 30000,
        env: { ...process.env, SUDO_ASKPASS: askpassPath },
      }, (err, stdout, stderr) => {
        if (err) resolve({ success: false, error: stderr || err.message });
        else resolve({ success: true });
      });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

function purgeRamWithSudoNoPrompt() {
  try {
    execSync('sudo -n purge', { stdio: 'ignore', timeout: 45000 });
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function purgeRamSmart() {
  // Fast path: use cached sudo credentials without prompting.
  if (isSudoAuthorized()) {
    const noPrompt = purgeRamWithSudoNoPrompt();
    if (noPrompt.success) return { success: true, method: 'sudo-cached' };
  }

  // Ask once via secure AskPass dialog, then retry non-interactive sudo.
  const auth = await authorizeSudoSession();
  if (auth.success) {
    const noPrompt = purgeRamWithSudoNoPrompt();
    if (noPrompt.success) return { success: true, method: 'sudo-askpass' };
  }

  // Fallback to native admin prompt for compatibility.
  const fallback = await purgeRamWithAdminPrompt();
  if (fallback.success) return { success: true, method: 'osascript-admin' };
  return { success: false, error: fallback.error || auth.error || 'Unable to authorize RAM cleanup' };
}

async function buildRamCleanupMetrics(before) {
  const immediate = getRamSnapshot();
  const immediatePressure = getMemoryPressure();
  const immediateFreeGainBytes = Math.max(0, immediate.free - before.free);
  const immediateUsedDropBytes = Math.max(0, before.used - immediate.used);

  // Wait briefly so macOS cache rebalancing settles before reporting "real" gain.
  await sleep(12000);
  const stabilized = getRamSnapshot();
  const stabilizedPressure = getMemoryPressure();
  const stabilizedFreeGainBytes = Math.max(0, stabilized.free - before.free);
  const stabilizedUsedDropBytes = Math.max(0, before.used - stabilized.used);

  return {
    immediate,
    immediatePressure,
    stabilized,
    stabilizedPressure,
    immediateFreeGainBytes,
    immediateUsedDropBytes,
    stabilizedFreeGainBytes,
    stabilizedUsedDropBytes,
  };
}

function buildTrayMenu() {
  const ram = getRamSnapshot();
  const pressure = getMemoryPressure();
  const pressureLabel = pressure.level === 'critical' ? 'Critical' : pressure.level === 'warning' ? 'Warning' : 'Normal';

  return Menu.buildFromTemplate([
    { label: `RAM Used: ${bytesToHuman(ram.used)} / ${bytesToHuman(ram.total)} (${ram.usedPct}%)`, enabled: false },
    { label: `RAM Free: ${bytesToHuman(ram.free)}`, enabled: false },
    { label: `Pressure: ${pressureLabel}${pressure.freePct !== null ? ` (${pressure.freePct}% free)` : ''}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Free Inactive RAM Now',
      click: async () => {
        const result = await purgeRamSmart();
        if (!result.success) {
          dialog.showErrorBox('RAM Cleanup Failed', result.error || 'Unable to run purge.');
        }
        updateTray();
      },
    },
    { label: 'Refresh', click: () => updateTray() },
    {
      label: 'Show MacCleaner',
      click: () => {
        showMainWindow();
      },
    },
    { type: 'separator' },
    {
      label: 'Refresh Mode',
      submenu: [
        {
          label: 'Real-time',
          type: 'radio',
          checked: getRefreshProfile() === 'real-time',
          click: () => setRefreshProfile('real-time'),
        },
        {
          label: 'Balanced',
          type: 'radio',
          checked: getRefreshProfile() === 'balanced',
          click: () => setRefreshProfile('balanced'),
        },
        {
          label: 'Power Saver',
          type: 'radio',
          checked: getRefreshProfile() === 'power-saver',
          click: () => setRefreshProfile('power-saver'),
        },
      ],
    },
    { type: 'separator' },
    { label: 'Quit MacCleaner', click: () => app.quit() },
  ]);
}

function updateTray() {
  if (!tray) return;
  try {
    const ram = getRamSnapshot();
    tray.setTitle(` ${ram.usedPct}%`);
    tray.setToolTip(`MacCleaner · RAM ${ram.usedPct}%`);
    tray.setContextMenu(buildTrayMenu());
  } catch {}
}

function getTrayRefreshMs() {
  if (isSuspended) return 60000;
  const profile = getRefreshProfile();
  const schedule = profile === 'real-time'
    ? { focused: 5000, visible: 8000, hidden: 15000 }
    : profile === 'power-saver'
      ? { focused: 15000, visible: 25000, hidden: 45000 }
      : { focused: 10000, visible: 15000, hidden: 30000 };
  if (!mainWindow || mainWindow.isDestroyed()) return schedule.hidden;
  if (mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused()) return schedule.focused;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) return schedule.visible;
  return schedule.hidden;
}

function resetTrayRefreshTimer() {
  if (trayInterval) {
    clearInterval(trayInterval);
    trayInterval = null;
  }
  if (!tray || isSuspended) return;
  trayInterval = setInterval(updateTray, getTrayRefreshMs());
}

function createTray() {
  if (process.platform !== 'darwin' || tray) return;
  tray = new Tray(getTrayIcon());
  updateTray();
  resetTrayRefreshTimer();
  tray.on('click', () => updateTray());
}

function setRefreshProfile(profile) {
  settings.refreshProfile = normalizeRefreshProfile(profile);
  saveSettings();
  resetTrayRefreshTimer();
  updateTray();
}

// ─── IPC: System Info ─────────────────────────────────────────────────────────

ipcMain.handle('get-system-info', async () => {
  const ram = getRamSnapshot();
  const pressure = getMemoryPressure();

  // ── CPU ──
  const cpuLoad = run("top -l 1 -n 0 | grep 'CPU usage'").trim();
  const cpuMatch = cpuLoad.match(/(\d+\.?\d*)% user/);
  const cpuPct = cpuMatch ? Math.round(parseFloat(cpuMatch[1])) : 0;
  const load = os.loadavg();
  const cores = os.cpus().length || 1;

  // ── Disk ──
  const dfOut = run('df -k /').split('\n')[1]?.split(/\s+/) || [];
  const diskTotal = parseInt(dfOut[1] || 0) * 1024;
  const diskUsed  = parseInt(dfOut[2] || 0) * 1024;
  const diskFree  = parseInt(dfOut[3] || 0) * 1024;
  const diskPct   = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

  // ── Battery ──
  const battOut = run('pmset -g batt');
  const battMatch = battOut.match(/(\d+)%/);
  const battPct = battMatch ? parseInt(battMatch[1]) : null;
  const isCharging = battOut.includes('AC Power') || battOut.includes('charging');

    return {
    ram: { ...ram, pressure },
    cpu: {
      pct: cpuPct,
      load1: load[0],
      load5: load[1],
      load15: load[2],
      cores,
    },
    disk: { total: diskTotal, used: diskUsed, free: diskFree, pct: diskPct },
    battery: battPct !== null ? { pct: battPct, charging: isCharging } : null,
    hostname: os.hostname(),
    platform: process.arch,
  };
});

ipcMain.handle('get-settings', async () => {
  return { ...settings, refreshProfile: getRefreshProfile() };
});

ipcMain.handle('set-refresh-profile', async (event, profile) => {
  setRefreshProfile(profile);
  return { success: true, refreshProfile: getRefreshProfile() };
});

// ─── IPC: RAM Processes ────────────────────────────────────────────────────────

ipcMain.handle('get-ram-processes', async () => {
  const me = os.userInfo().username;
  const out = run('ps -axo pid=,rss=,user=,comm= 2>/dev/null').split('\n');
  const procs = out
    .map(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) return null;
      const [pidRaw, rssRaw, user, ...rest] = parts;
      const pid = parseInt(pidRaw, 10);
      const mem = parseInt(rssRaw, 10) * 1024;
      const cmd = rest.join(' ');
      const name = cmd.split('/').pop();
      if (!Number.isFinite(pid) || !Number.isFinite(mem) || !name) return null;
      const canQuit = user === me && pid !== process.pid && !isProtectedProcessName(name);
      return { pid, mem, user, cmd, name, canQuit };
    })
    .filter(p => p && p.mem > 1024 * 1024)
    .sort((a, b) => b.mem - a.mem)
    .slice(0, 10)
    .map(p => ({ ...p, memStr: bytesToHuman(p.mem) }));
  return procs;
});

ipcMain.handle('quit-process', async (event, pid) => {
  const targetPid = parseInt(pid, 10);
  if (!Number.isFinite(targetPid) || targetPid <= 1 || targetPid === process.pid) {
    return { success: false, error: 'Invalid process id' };
  }

  const me = os.userInfo().username;
  const meta = run(`ps -o user=,comm= -p ${targetPid} 2>/dev/null`).trim();
  if (!meta) return { success: false, error: 'Process not found' };
  const pieces = meta.split(/\s+/);
  const owner = pieces[0];
  const name = pieces.slice(1).join(' ').split('/').pop();

  if (owner !== me) return { success: false, error: 'Refusing to terminate non-user process' };
  if (isProtectedProcessName(name)) return { success: false, error: 'Protected process cannot be terminated' };

  try {
    process.kill(targetPid, 'SIGTERM');
  } catch (e) {
    return { success: false, error: e.message };
  }

  await new Promise(r => setTimeout(r, 1200));
  const alive = run(`ps -p ${targetPid} -o pid= 2>/dev/null`).trim();
  if (alive) return { success: false, error: 'Process did not exit in time' };
  return { success: true };
});

ipcMain.handle('get-cpu-processes', async () => {
  const out = run('ps -A -o pid=,%cpu=,comm= -r 2>/dev/null')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  return out
    .map(line => {
      const parts = line.split(/\s+/);
      if (parts.length < 3) return null;
      const [pidRaw, cpuRaw, ...rest] = parts;
      const pid = parseInt(pidRaw, 10);
      const cpu = parseFloat(cpuRaw);
      const name = rest.join(' ').split('/').pop();
      if (!Number.isFinite(pid) || !Number.isFinite(cpu) || !name) return null;
      return { pid, cpu, name };
    })
    .filter(p => p && p.cpu >= 0.1)
    .slice(0, 12);
});

ipcMain.handle('open-activity-monitor', async () => {
  const target = '/System/Applications/Utilities/Activity Monitor.app';
  const err = await shell.openPath(target);
  return { success: !err, error: err || null };
});

// ─── IPC: Free RAM ─────────────────────────────────────────────────────────────

ipcMain.handle('free-ram', async () => {
  const before = getRamSnapshot();
  const beforePressure = getMemoryPressure();
  const result = await purgeRamSmart();
  if (!result.success) {
    return { success: false, error: result.error, before, beforePressure };
  }

  const metrics = await buildRamCleanupMetrics(before);
  const after = metrics.immediate;
  const afterPressure = metrics.immediatePressure;
  const reclaimedBytes = metrics.immediateFreeGainBytes;
  updateTray();

  return {
    success: true,
    before,
    after,
    beforePressure,
    afterPressure,
    reclaimedBytes,
    immediateFreeGainBytes: metrics.immediateFreeGainBytes,
    immediateUsedDropBytes: metrics.immediateUsedDropBytes,
    stabilizedFreeGainBytes: metrics.stabilizedFreeGainBytes,
    stabilizedUsedDropBytes: metrics.stabilizedUsedDropBytes,
    stabilized: metrics.stabilized,
    stabilizedPressure: metrics.stabilizedPressure,
  };
});

ipcMain.handle('deep-clean-ram', async (event, pids = []) => {
  const before = getRamSnapshot();
  const beforePressure = getMemoryPressure();
  const me = os.userInfo().username;
  const stopped = [];
  const skipped = [];

  const targetPids = Array.isArray(pids) ? pids.slice(0, 5) : [];
  for (const raw of targetPids) {
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) {
      skipped.push({ pid: raw, reason: 'invalid pid' });
      continue;
    }

    const meta = run(`ps -o user=,comm= -p ${pid} 2>/dev/null`).trim();
    if (!meta) {
      skipped.push({ pid, reason: 'not found' });
      continue;
    }
    const parts = meta.split(/\s+/);
    const owner = parts[0];
    const name = parts.slice(1).join(' ').split('/').pop();
    if (owner !== me || isProtectedProcessName(name)) {
      skipped.push({ pid, reason: 'not allowed' });
      continue;
    }

    try {
      process.kill(pid, 'SIGTERM');
      stopped.push({ pid, name });
    } catch {
      skipped.push({ pid, reason: 'termination failed' });
    }
  }

  await new Promise(r => setTimeout(r, 1200));
  const purgeResult = await purgeRamSmart();
  if (!purgeResult.success) {
    return { success: false, error: purgeResult.error, before, beforePressure, stopped, skipped };
  }

  const metrics = await buildRamCleanupMetrics(before);
  const after = metrics.immediate;
  const afterPressure = metrics.immediatePressure;
  const reclaimedBytes = metrics.immediateFreeGainBytes;
  updateTray();

  return {
    success: true,
    before,
    after,
    beforePressure,
    afterPressure,
    reclaimedBytes,
    stopped,
    skipped,
    immediateFreeGainBytes: metrics.immediateFreeGainBytes,
    immediateUsedDropBytes: metrics.immediateUsedDropBytes,
    stabilizedFreeGainBytes: metrics.stabilizedFreeGainBytes,
    stabilizedUsedDropBytes: metrics.stabilizedUsedDropBytes,
    stabilized: metrics.stabilized,
    stabilizedPressure: metrics.stabilizedPressure,
  };
});

// ─── IPC: Disk Junk ───────────────────────────────────────────────────────────

ipcMain.handle('get-disk-junk', async () => {
  const home = os.homedir();

  const categories = [
    {
      id: 'user_cache',
      name: 'User Cache',
      icon: '💾',
      path: `${home}/Library/Caches`,
      color: '#5b8af5',
      description: 'App caches stored in your Library folder',
    },
    {
      id: 'system_logs',
      name: 'System Logs',
      icon: '📋',
      paths: [`${home}/Library/Logs`, '/private/var/log'],
      color: '#eab308',
      description: 'Application and system log files',
    },
    {
      id: 'trash',
      name: 'Trash',
      icon: '🗑️',
      path: `${home}/.Trash`,
      color: '#ef4444',
      description: 'Files in your Trash waiting to be emptied',
    },
    {
      id: 'mail_cache',
      name: 'Mail Downloads',
      icon: '📧',
      path: `${home}/Library/Containers/com.apple.mail/Data/Library/Caches`,
      color: '#a855f7',
      description: 'Downloaded attachments cached by Mail',
    },
    {
      id: 'language_files',
      name: 'Language Files',
      icon: '🌐',
      note: 'Requires app-by-app removal',
      color: '#22d3b8',
      description: 'Unused language packs in installed apps',
      scanOnly: true,
    },
    {
      id: 'xcode_derived',
      name: 'Xcode Derived Data',
      icon: '⚙️',
      path: `${home}/Library/Developer/Xcode/DerivedData`,
      color: '#f97316',
      description: 'Xcode build artifacts and indexes',
    },
    {
      id: 'ios_backups',
      name: 'iOS Device Backups',
      icon: '📱',
      path: `${home}/Library/Application Support/MobileSync/Backup`,
      color: '#6366f1',
      description: 'iPhone/iPad backups stored on this Mac',
    },
    {
      id: 'app_downloads',
      name: 'Downloads Folder',
      icon: '⬇️',
      path: `${home}/Downloads`,
      color: '#22c55e',
      description: 'Files accumulated in your Downloads folder',
      scanOnly: true,
    },
  ];

  const results = await Promise.all(categories.map(async cat => {
    let bytes = 0;
    if (cat.path) bytes = dirSize(cat.path);
    else if (cat.paths) bytes = cat.paths.reduce((acc, p) => acc + dirSize(p), 0);
    return { ...cat, bytes, sizeStr: bytesToHuman(bytes) };
  }));

  return results.filter(r => r.bytes > 0 || r.scanOnly);
});

// ─── IPC: Clean Disk Item ─────────────────────────────────────────────────────

ipcMain.handle('clean-disk-item', async (event, id) => {
  const home = os.homedir();
  const targets = {
    user_cache:   { path: `${home}/Library/Caches` },
    system_logs:  { paths: [`${home}/Library/Logs`] },
    trash:        { cmd: `osascript -e 'tell application "Finder" to empty trash'` },
    mail_cache:   { path: `${home}/Library/Containers/com.apple.mail/Data/Library/Caches` },
    xcode_derived:{ path: `${home}/Library/Developer/Xcode/DerivedData` },
    ios_backups:  { path: `${home}/Library/Application Support/MobileSync/Backup` },
  };

  const target = targets[id];
  if (!target) return { success: false, error: 'Unknown category' };

  return new Promise((resolve) => {
    if (target.cmd) {
      exec(target.cmd, { timeout: 30000 }, (err) => {
        resolve({ success: !err, error: err?.message });
      });
    } else {
      const paths = target.paths || [target.path];
      try {
        paths.forEach(p => {
          if (fs.existsSync(p)) {
            // Clear contents but keep folder
            const contents = fs.readdirSync(p);
            contents.forEach(item => {
              try { execSync(`rm -rf "${path.join(p, item)}"`, { timeout: 10000 }); }
              catch {}
            });
          }
        });
        resolve({ success: true });
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    }
  });
});

// ─── IPC: List Apps ────────────────────────────────────────────────────────────

ipcMain.handle('list-apps', async () => {
  const dirs = ['/Applications', `${os.homedir()}/Applications`];
  const apps = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.app'));
    for (const entry of entries) {
      const appPath = path.join(dir, entry);
      const name = entry.replace('.app', '');
      const appSize = dirSize(appPath);

      // Find leftover files
      const home = os.homedir();
      const leftoverPaths = [
        `${home}/Library/Application Support/${name}`,
        `${home}/Library/Caches/${name}`,
        `${home}/Library/Preferences/com.${name.toLowerCase()}.plist`,
        `${home}/Library/Logs/${name}`,
        `${home}/Library/Containers/com.${name.toLowerCase()}`,
      ];
      const leftoverSize = leftoverPaths.reduce((acc, p) => acc + dirSize(p), 0);

      // Get bundle info for category/icon
      let category = 'Application';
      try {
        const plistPath = path.join(appPath, 'Contents/Info.plist');
        if (fs.existsSync(plistPath)) {
          const plist = run(`defaults read "${plistPath}" LSApplicationCategoryType 2>/dev/null`).trim();
          if (plist) category = plist.split('.').pop().replace(/-/g, ' ');
        }
      } catch {}

      apps.push({
        id: name,
        name,
        path: appPath,
        size: appSize,
        sizeStr: bytesToHuman(appSize),
        leftover: leftoverSize,
        leftoverStr: bytesToHuman(leftoverSize),
        category: category || 'Application',
        leftoverPaths: leftoverPaths.filter(p => fs.existsSync(p)),
      });
    }
  }

  return apps.sort((a, b) => b.size - a.size);
});

// ─── IPC: Uninstall App ────────────────────────────────────────────────────────

ipcMain.handle('uninstall-app', async (event, { appPath, leftoverPaths }) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Uninstall'],
    defaultId: 0,
    cancelId: 0,
    title: 'Confirm Uninstall',
    message: `Uninstall ${path.basename(appPath)}?`,
    detail: 'The app and all its support files will be permanently deleted.',
  });

  if (response === 0) return { success: false, cancelled: true };

  return new Promise((resolve) => {
    // Move to trash (safer than rm -rf)
    shell.trashItem(appPath)
      .then(() => {
        // Also trash leftovers
        const promises = (leftoverPaths || []).filter(p => fs.existsSync(p)).map(p => shell.trashItem(p).catch(() => {}));
        return Promise.allSettled(promises);
      })
      .then(() => resolve({ success: true }))
      .catch(e => {
        // Fallback: require admin
        exec(
          `osascript -e 'do shell script "rm -rf \\"${appPath}\\"" with administrator privileges'`,
          (err) => resolve({ success: !err, error: err?.message })
        );
      });
  });
});

// ─── IPC: Startup Items ────────────────────────────────────────────────────────

ipcMain.handle('get-startup-items', async () => {
  const home = os.homedir();
  const agentDirs = [
    { dir: `${home}/Library/LaunchAgents`, system: false },
    { dir: '/Library/LaunchAgents', system: true },
    { dir: '/Library/LaunchDaemons', system: true },
  ];

  const items = [];

  for (const { dir, system } of agentDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.plist'));

    for (const file of files) {
      const filePath = path.join(dir, file);
      const name = file.replace('.plist', '');

      // Check if loaded
      const loadedOut = run(`launchctl list 2>/dev/null | grep "${name}"`).trim();
      const enabled = loadedOut !== '';

      // Estimate impact
      let impact = 'Low';
      const heavy = ['spotify', 'dropbox', 'googledrive', 'onedrive', 'creative cloud', 'adobe', 'microsoft'];
      if (heavy.some(h => name.toLowerCase().includes(h))) impact = 'High';
      else if (name.toLowerCase().includes('helper') || name.toLowerCase().includes('agent')) impact = 'Medium';

      items.push({ id: file, name, filePath, enabled, impact, system });
    }
  }

  // Also get login items via osascript
  try {
    const loginItems = run(`osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null`).trim();
    if (loginItems) {
      loginItems.split(', ').filter(Boolean).forEach(name => {
        if (!items.find(i => i.name.includes(name))) {
          items.push({ id: `login-${name}`, name, enabled: true, impact: 'Medium', system: false, loginItem: true });
        }
      });
    }
  } catch {}

  return items;
});

// ─── IPC: Toggle Startup Item ─────────────────────────────────────────────────

ipcMain.handle('toggle-startup-item', async (event, { id, filePath, enabled, loginItem, name }) => {
  return new Promise((resolve) => {
    if (loginItem) {
      const action = enabled ? 'delete' : 'make';
      const script = enabled
        ? `tell application "System Events" to delete login item "${name}"`
        : `tell application "System Events" to make login item at end with properties {name:"${name}", hidden:false}`;
      exec(`osascript -e '${script}'`, (err) => resolve({ success: !err }));
      return;
    }

    const action = enabled ? 'unload' : 'load';
    const cmd = `launchctl ${action} "${filePath}" 2>/dev/null`;

    exec(cmd, (err) => {
      if (!err) { resolve({ success: true }); return; }
      // Try with admin
      exec(
        `osascript -e 'do shell script "launchctl ${action} \\"${filePath}\\"" with administrator privileges'`,
        (err2) => resolve({ success: !err2, error: err2?.message })
      );
    });
  });
});

// ─── IPC: Privacy ─────────────────────────────────────────────────────────────

ipcMain.handle('clear-privacy', async (event, itemId) => {
  const home = os.homedir();

  const actions = {
    browser_history: async () => {
      // Safari
      const safariHistory = `${home}/Library/Safari/History.db`;
      if (fs.existsSync(safariHistory)) run(`sqlite3 "${safariHistory}" "DELETE FROM history_visits; DELETE FROM history_items;"`);
      // Chrome
      const chromeHistory = `${home}/Library/Application Support/Google/Chrome/Default/History`;
      if (fs.existsSync(chromeHistory)) run(`sqlite3 "${chromeHistory}" "DELETE FROM urls; DELETE FROM visits;"`);
    },
    recent_files: () => {
      run(`defaults delete com.apple.recentitems 2>/dev/null`);
      run(`osascript -e 'tell application "System Events" to delete every login item' 2>/dev/null`);
    },
    downloads_history: () => {
      run(`sqlite3 "${home}/Library/Safari/Downloads.db" "DELETE FROM downloads;" 2>/dev/null`);
    },
    clipboard: () => {
      run(`pbcopy < /dev/null`);
    },
    wifi_passwords: async () => {
      // Show confirmation first
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Cancel', 'Clear Wi-Fi History'],
        message: 'Clear Wi-Fi network history?',
        detail: 'This removes remembered networks. You\'ll need to re-enter passwords.',
      });
      if (response === 1) {
        run(`networksetup -removeallpreferredwirelessnetworks en0 2>/dev/null`);
      }
    },
    crash_logs: () => {
      const logDirs = [
        `${home}/Library/Logs/DiagnosticReports`,
        `${home}/Library/Logs/CrashReporter`,
        `/Library/Logs/DiagnosticReports`,
      ];
      logDirs.forEach(d => {
        if (fs.existsSync(d)) {
          fs.readdirSync(d).forEach(f => {
            try { fs.unlinkSync(path.join(d, f)); } catch {}
          });
        }
      });
    },
    location_history: () => {
      run(`defaults delete com.apple.locationd 2>/dev/null`);
    },
    siri_history: () => {
      run(`rm -rf "${home}/Library/Application Support/com.apple.siriknowledged" 2>/dev/null`);
    },
  };

  const action = actions[itemId];
  if (!action) return { success: false };

  try {
    await action();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── IPC: App Info ─────────────────────────────────────────────────────────────

ipcMain.handle('open-in-finder', async (event, filePath) => {
  shell.showItemInFinder(filePath);
});

ipcMain.handle('get-app-version', () => app.getVersion());
