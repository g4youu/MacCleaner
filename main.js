const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, powerMonitor } = require('electron');
const { execSync, exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow;
let tray = null;
let trayInterval = null;
let isSuspended = false;
let autoCareTimer = null;
let autoCareStatus = {
  running: false,
  lastRunAt: null,
  nextRunAt: null,
  runCount: 0,
  lastError: null,
  lastResult: null,
};
const DEFAULT_SETTINGS = {
  refreshProfile: 'balanced',
  autoCare: {
    enabled: false,
    intervalMinutes: 30,
    ramCleanOnPressure: false,
    pressureTrigger: 'critical',
    minInactiveGb: 2,
    allowOnBattery: false,
  },
};
let settings = { ...DEFAULT_SETTINGS };
let protectionCache = { ts: 0, report: null };
const MAX_CLEANUP_HISTORY_ENTRIES = 120;
const MAX_HISTORY_FAILED_ITEMS = 200;
const MAX_HISTORY_ITEMS_PER_ENTRY = 6000;

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function getCleanupHistoryPath() {
  return path.join(app.getPath('userData'), 'cleanup-history.json');
}

function loadCleanupHistoryEntries() {
  try {
    const p = getCleanupHistoryPath();
    if (!fs.existsSync(p)) return [];
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.entries)) return parsed.entries;
    return [];
  } catch {
    return [];
  }
}

function saveCleanupHistoryEntries(entries) {
  try {
    const trimmed = Array.isArray(entries) ? entries.slice(0, MAX_CLEANUP_HISTORY_ENTRIES) : [];
    fs.writeFileSync(getCleanupHistoryPath(), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: trimmed,
    }, null, 2));
  } catch {}
}

function appendCleanupHistoryEntry(entry) {
  const entries = loadCleanupHistoryEntries();
  entries.unshift(entry);
  saveCleanupHistoryEntries(entries);
  return entry;
}

function getTrashDirectory() {
  return path.join(os.homedir(), '.Trash');
}

function listTrashEntries() {
  const trashDir = getTrashDirectory();
  if (!fs.existsSync(trashDir)) return [];
  let names = [];
  try {
    names = fs.readdirSync(trashDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const fullPath = path.join(trashDir, name);
    try {
      const st = fs.statSync(fullPath);
      out.push({ path: fullPath, name, mtimeMs: st.mtimeMs });
    } catch {}
  }
  return out;
}

function detectMovedTrashPath(beforePaths, originalPath) {
  const base = path.basename(originalPath);
  const after = listTrashEntries();
  const fresh = after.filter(item => !beforePaths.has(item.path));
  if (!fresh.length) return null;
  const exact = fresh.find(item => item.name === base);
  if (exact) return exact.path;
  const stem = base.replace(/\.[^/.]+$/, '');
  const prefix = fresh
    .filter(item => item.name.startsWith(stem))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (prefix.length) return prefix[0].path;
  fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return fresh[0].path;
}

function makeCleanupHistoryEntry({
  module = 'cleanup',
  action = 'Move items to Trash',
  dryRun = false,
  candidateCount = 0,
  movedItems = [],
  failed = [],
  meta = {},
}) {
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const items = movedItems.slice(0, MAX_HISTORY_ITEMS_PER_ENTRY).map(item => ({
    originalPath: item.originalPath,
    trashPath: item.trashPath || null,
    size: item.size || 0,
    restoredAt: null,
    restoreError: null,
  }));
  const bytes = movedItems.reduce((acc, item) => acc + (item.size || 0), 0);
  const restorableCount = items.length;
  return {
    id,
    createdAt: new Date().toISOString(),
    module,
    action,
    dryRun: !!dryRun,
    candidateCount: Number(candidateCount) || (movedItems.length + failed.length),
    movedCount: movedItems.length,
    bytes,
    failedCount: failed.length,
    restorableCount,
    restoredCount: 0,
    restoreFailedCount: 0,
    restoreComplete: false,
    truncated: movedItems.length > MAX_HISTORY_ITEMS_PER_ENTRY,
    items,
    failed: failed.slice(0, MAX_HISTORY_FAILED_ITEMS),
    meta: meta || {},
  };
}

function escapeAppleScriptString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function putBackFromTrash(trashPath) {
  return new Promise((resolve) => {
    const script = `tell application "Finder" to put back (POSIX file "${escapeAppleScriptString(trashPath)}" as alias)`;
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', (e) => resolve({ success: false, error: e.message }));
    child.on('close', (code) => {
      if (code === 0) resolve({ success: true });
      else resolve({ success: false, error: stderr.trim() || `osascript exited with code ${code}` });
    });
  });
}

function renameTrashItemBack(trashPath, originalPath) {
  try {
    if (!fs.existsSync(trashPath)) return { success: false, error: 'Trash item not found' };
    if (fs.existsSync(originalPath)) return { success: false, error: 'Original path already exists' };
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.renameSync(trashPath, originalPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || 'Rename fallback failed' };
  }
}

function findTrashPathForHistoryItem(item) {
  if (item && item.trashPath && fs.existsSync(item.trashPath)) return item.trashPath;
  const originalPath = item && item.originalPath ? item.originalPath : '';
  const base = path.basename(originalPath);
  if (!base) return null;
  const entries = listTrashEntries()
    .filter(entry => entry.name === base || entry.name.startsWith(base.replace(/\.[^/.]+$/, '')))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.length ? entries[0].path : null;
}

async function restoreCleanupEntryById(entryId) {
  const id = String(entryId || '').trim();
  if (!id) return { success: false, error: 'Entry id is required' };
  const entries = loadCleanupHistoryEntries();
  const index = entries.findIndex(entry => entry.id === id);
  if (index < 0) return { success: false, error: 'Cleanup history entry not found' };

  const entry = entries[index];
  const items = Array.isArray(entry.items) ? entry.items : [];
  if (!items.length) {
    entry.restoreComplete = true;
    entry.lastRestoreAt = new Date().toISOString();
    entries[index] = entry;
    saveCleanupHistoryEntries(entries);
    return { success: true, restoredCount: 0, failedCount: 0, entry };
  }

  let restoredCount = 0;
  let failedCount = 0;

  for (const item of items) {
    if (item.restoredAt) continue;
    const sourceTrashPath = findTrashPathForHistoryItem(item);
    if (!sourceTrashPath) {
      item.restoreError = 'Trash item no longer available';
      failedCount += 1;
      continue;
    }

    let restored = await putBackFromTrash(sourceTrashPath);
    if (!restored.success) {
      restored = renameTrashItemBack(sourceTrashPath, item.originalPath || '');
    }

    if (restored.success) {
      item.restoredAt = new Date().toISOString();
      item.restoreError = null;
      item.trashPath = sourceTrashPath;
      restoredCount += 1;
    } else {
      item.restoreError = restored.error || 'Restore failed';
      failedCount += 1;
    }
  }

  entry.restoredCount = items.filter(item => !!item.restoredAt).length;
  entry.restoreFailedCount = items.filter(item => !!item.restoreError && !item.restoredAt).length;
  entry.restoreComplete = entry.restoredCount >= (entry.restorableCount || 0);
  entry.lastRestoreAt = new Date().toISOString();
  entries[index] = entry;
  saveCleanupHistoryEntries(entries);

  return {
    success: failedCount === 0,
    restoredCount,
    failedCount,
    entry,
  };
}

async function trashPathsWithSafety(rawTargets, options = {}) {
  const targets = Array.isArray(rawTargets) ? rawTargets : [];
  const allowPath = typeof options.allowPath === 'function' ? options.allowPath : isHomePath;
  const dryRun = !!options.dryRun;
  const recordHistory = options.recordHistory !== false && !dryRun;
  const movedItems = [];
  const failed = [];
  let previewBytes = 0;

  for (const rawPath of targets) {
    const targetPath = path.resolve(String(rawPath || ''));
    if (!targetPath) continue;
    if (!allowPath(targetPath)) {
      failed.push({ path: targetPath, error: 'Path outside allowed cleanup scope' });
      continue;
    }
    if (!fs.existsSync(targetPath)) {
      failed.push({ path: targetPath, error: 'Path not found' });
      continue;
    }

    try {
      const st = fs.statSync(targetPath);
      if (!st.isFile() && !st.isDirectory()) {
        failed.push({ path: targetPath, error: 'Only files and folders can be moved to Trash' });
        continue;
      }
      const size = pathSize(targetPath);
      previewBytes += size;

      if (dryRun) {
        movedItems.push({
          originalPath: targetPath,
          trashPath: null,
          size,
        });
        continue;
      }

      const beforeTrashSet = new Set(listTrashEntries().map(entry => entry.path));
      await shell.trashItem(targetPath);
      const trashPath = detectMovedTrashPath(beforeTrashSet, targetPath);
      movedItems.push({
        originalPath: targetPath,
        trashPath: trashPath || null,
        size,
      });
    } catch (e) {
      failed.push({ path: targetPath, error: e.message || 'Failed to move to Trash' });
    }
  }

  let historyId = null;
  if (recordHistory && movedItems.length) {
    const historyEntry = makeCleanupHistoryEntry({
      module: options.module || 'cleanup',
      action: options.action || 'Move items to Trash',
      dryRun: false,
      candidateCount: movedItems.length + failed.length,
      movedItems,
      failed,
      meta: options.meta || {},
    });
    appendCleanupHistoryEntry(historyEntry);
    historyId = historyEntry.id;
  }

  const trashed = dryRun ? [] : movedItems.map(item => item.originalPath);
  const trashedBytes = dryRun ? 0 : movedItems.reduce((acc, item) => acc + (item.size || 0), 0);

  return {
    success: failed.length === 0,
    dryRun,
    candidateCount: movedItems.length + failed.length,
    previewCount: movedItems.length,
    previewBytes,
    trashed,
    trashedCount: trashed.length,
    trashedBytes,
    failed,
    restorableCount: movedItems.filter(item => !!item.trashPath).length,
    historyId,
  };
}

function loadSettings() {
  try {
    const p = getSettingsPath();
    if (!fs.existsSync(p)) {
      settings = normalizeSettings({});
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    settings = normalizeSettings(parsed);
  } catch {
    settings = normalizeSettings({});
  }
}

function saveSettings() {
  try {
    settings = normalizeSettings(settings);
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2));
  } catch {}
}

function normalizeRefreshProfile(value) {
  if (value === 'live' || value === 'real-time' || value === 'balanced' || value === 'power-saver') return value;
  return DEFAULT_SETTINGS.refreshProfile;
}

function normalizeAutoCareSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  const intervalMinutes = Number(v.intervalMinutes);
  const minInactiveGb = Number(v.minInactiveGb);
  return {
    enabled: !!v.enabled,
    intervalMinutes: Number.isFinite(intervalMinutes) ? Math.max(5, Math.min(240, Math.round(intervalMinutes))) : DEFAULT_SETTINGS.autoCare.intervalMinutes,
    ramCleanOnPressure: !!v.ramCleanOnPressure,
    pressureTrigger: v.pressureTrigger === 'warning' ? 'warning' : 'critical',
    minInactiveGb: Number.isFinite(minInactiveGb) ? Math.max(0.5, Math.min(8, Math.round(minInactiveGb * 10) / 10)) : DEFAULT_SETTINGS.autoCare.minInactiveGb,
    allowOnBattery: !!v.allowOnBattery,
  };
}

function normalizeSettings(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    refreshProfile: normalizeRefreshProfile(v.refreshProfile),
    autoCare: normalizeAutoCareSettings(v.autoCare),
  };
}

function getRefreshProfile() {
  settings.refreshProfile = normalizeRefreshProfile(settings.refreshProfile);
  return settings.refreshProfile;
}

function getAutoCareSettings() {
  settings.autoCare = normalizeAutoCareSettings(settings.autoCare);
  return settings.autoCare;
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
  resetAutoCareScheduler(false);
  powerMonitor.on('suspend', () => {
    isSuspended = true;
    resetTrayRefreshTimer();
    stopAutoCareScheduler();
  });
  powerMonitor.on('resume', () => {
    isSuspended = false;
    updateTray();
    resetTrayRefreshTimer();
    resetAutoCareScheduler(true);
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (trayInterval) clearInterval(trayInterval);
  stopAutoCareScheduler();
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

function isHomePath(targetPath) {
  const home = os.homedir();
  const resolved = path.resolve(targetPath);
  return resolved === home || resolved.startsWith(`${home}${path.sep}`);
}

function resolveSpaceLensPath(targetPath) {
  const home = os.homedir();
  const resolved = path.resolve(String(targetPath || home));
  if (!isHomePath(resolved)) return home;
  if (!fs.existsSync(resolved)) return home;
  try {
    const st = fs.statSync(resolved);
    return st.isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return home;
  }
}

function buildHomeBreadcrumbs(targetPath) {
  const home = os.homedir();
  const resolved = path.resolve(targetPath);
  const relative = path.relative(home, resolved);
  if (!relative || relative === '') {
    return [{ name: '~', path: home }];
  }
  const parts = relative.split(path.sep).filter(Boolean);
  const crumbs = [{ name: '~', path: home }];
  let cursor = home;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    crumbs.push({ name: part, path: cursor });
  }
  return crumbs;
}

async function scanSpaceLensDirectory(options = {}) {
  const targetPath = resolveSpaceLensPath(options.targetPath);
  const maxEntries = Math.max(10, Math.min(120, Number(options.maxEntries) || 60));
  const children = [];
  const entries = await fs.promises.readdir(targetPath, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (children.length >= maxEntries) break;
    const name = entry.name;
    if (!name || name.startsWith('.')) continue;
    const fullPath = path.join(targetPath, name);
    if (!isHomePath(fullPath)) continue;

    try {
      let size = 0;
      if (entry.isDirectory()) {
        size = dirSize(fullPath);
      } else if (entry.isFile()) {
        size = fs.statSync(fullPath).size;
      } else {
        continue;
      }
      children.push({
        name,
        path: fullPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size,
        sizeStr: bytesToHuman(size),
      });
    } catch {}
  }

  children.sort((a, b) => b.size - a.size);
  const topItems = children.slice(0, 30);
  const listedBytes = topItems.reduce((acc, item) => acc + item.size, 0);
  const totalBytes = dirSize(targetPath);
  const denominator = totalBytes > 0 ? totalBytes : listedBytes;

  const items = topItems.map(item => ({
    ...item,
    pct: denominator > 0 ? Math.max(0, Math.min(100, Math.round((item.size / denominator) * 1000) / 10)) : 0,
  }));

  return {
    success: true,
    targetPath,
    parentPath: targetPath === os.homedir() ? null : path.dirname(targetPath),
    breadcrumbs: buildHomeBreadcrumbs(targetPath),
    totalBytes,
    totalStr: bytesToHuman(totalBytes),
    listedBytes,
    listedStr: bytesToHuman(listedBytes),
    itemCount: items.length,
    items,
  };
}

function listCloudStorageRoots() {
  const cloudStorageDir = path.join(os.homedir(), 'Library', 'CloudStorage');
  if (!fs.existsSync(cloudStorageDir)) return [];
  try {
    return fs.readdirSync(cloudStorageDir)
      .map(name => path.join(cloudStorageDir, name))
      .filter(full => {
        try { return fs.statSync(full).isDirectory(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

function buildCloudProviders() {
  const home = os.homedir();
  const cloudRoots = listCloudStorageRoots();
  const googleRoots = cloudRoots.filter(p => path.basename(p).toLowerCase().startsWith('googledrive'));
  const oneDriveRoots = cloudRoots.filter(p => path.basename(p).toLowerCase().startsWith('onedrive'));

  const providers = [
    {
      id: 'icloud',
      name: 'iCloud Drive',
      icon: '☁️',
      syncRoots: [path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')].filter(p => fs.existsSync(p)),
      cacheRoots: [
        path.join(home, 'Library', 'Caches', 'CloudKit'),
        path.join(home, 'Library', 'Caches', 'com.apple.bird'),
      ].filter(p => fs.existsSync(p)),
    },
    {
      id: 'google-drive',
      name: 'Google Drive',
      icon: '🟢',
      syncRoots: googleRoots,
      cacheRoots: [
        path.join(home, 'Library', 'Caches', 'com.google.drivefs'),
        path.join(home, 'Library', 'Application Support', 'Google', 'DriveFS'),
      ].filter(p => fs.existsSync(p)),
    },
    {
      id: 'onedrive',
      name: 'OneDrive',
      icon: '🔵',
      syncRoots: oneDriveRoots,
      cacheRoots: [
        path.join(home, 'Library', 'Caches', 'com.microsoft.OneDrive'),
        path.join(home, 'Library', 'Application Support', 'OneDrive'),
      ].filter(p => fs.existsSync(p)),
    },
  ];

  return providers.map(provider => ({
    ...provider,
    present: provider.syncRoots.length > 0 || provider.cacheRoots.length > 0,
  }));
}

async function collectStaleCacheCandidates(cacheRoots, staleDays, maxFiles) {
  const minMtimeMs = Date.now() - (staleDays * 24 * 60 * 60 * 1000);
  const candidates = [];

  async function walk(dirPath, depth) {
    if (candidates.length >= maxFiles || depth > 6) return;
    let entries = [];
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (candidates.length >= maxFiles) break;
      const name = entry.name;
      if (!name || name === '.DS_Store') continue;
      const fullPath = path.join(dirPath, name);
      if (!isHomePath(fullPath)) continue;

      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const st = await fs.promises.stat(fullPath);
        if (!st.isFile()) continue;
        if (st.mtimeMs > minMtimeMs) continue;
        if (st.size < 128 * 1024) continue;
        candidates.push({
          path: fullPath,
          name,
          size: st.size,
          sizeStr: bytesToHuman(st.size),
          mtimeMs: st.mtimeMs,
          modifiedAt: new Date(st.mtimeMs).toISOString(),
        });
      } catch {}
    }
  }

  for (const root of cacheRoots) {
    if (candidates.length >= maxFiles) break;
    await walk(root, 0);
  }

  candidates.sort((a, b) => b.size - a.size);
  return candidates;
}

async function getCloudCleanupReport(options = {}) {
  const staleDays = Math.max(7, Math.min(120, Number(options.staleDays) || 21));
  const maxFiles = Math.max(100, Math.min(4000, Number(options.maxFiles) || 1200));
  const providers = buildCloudProviders();
  const reportProviders = [];

  for (const provider of providers) {
    const syncBytes = provider.syncRoots.reduce((acc, p) => acc + dirSize(p), 0);
    const cacheBytes = provider.cacheRoots.reduce((acc, p) => acc + dirSize(p), 0);
    const staleCandidates = provider.cacheRoots.length
      ? await collectStaleCacheCandidates(provider.cacheRoots, staleDays, maxFiles)
      : [];
    const staleBytes = staleCandidates.reduce((acc, c) => acc + c.size, 0);

    reportProviders.push({
      id: provider.id,
      name: provider.name,
      icon: provider.icon,
      present: provider.present,
      syncRoots: provider.syncRoots,
      cacheRoots: provider.cacheRoots,
      syncBytes,
      syncStr: bytesToHuman(syncBytes),
      cacheBytes,
      cacheStr: bytesToHuman(cacheBytes),
      staleDays,
      staleCount: staleCandidates.length,
      staleBytes,
      staleStr: bytesToHuman(staleBytes),
      staleCandidates: staleCandidates.slice(0, 80),
    });
  }

  const summary = {
    providersDetected: reportProviders.filter(p => p.present).length,
    syncBytes: reportProviders.reduce((acc, p) => acc + p.syncBytes, 0),
    cacheBytes: reportProviders.reduce((acc, p) => acc + p.cacheBytes, 0),
    staleBytes: reportProviders.reduce((acc, p) => acc + p.staleBytes, 0),
    staleCount: reportProviders.reduce((acc, p) => acc + p.staleCount, 0),
    scannedAt: new Date().toISOString(),
  };

  return {
    success: true,
    staleDays,
    summary: {
      ...summary,
      syncStr: bytesToHuman(summary.syncBytes),
      cacheStr: bytesToHuman(summary.cacheBytes),
      staleStr: bytesToHuman(summary.staleBytes),
    },
    providers: reportProviders,
  };
}

async function cleanCloudProviderCache({
  providerId,
  staleDays = 21,
  maxFiles = 1500,
  dryRun = false,
  recordHistory = true,
}) {
  const report = await getCloudCleanupReport({ staleDays, maxFiles });
  if (!report.success) return report;
  const provider = (report.providers || []).find(p => p.id === providerId);
  if (!provider) return { success: false, error: 'Cloud provider not found' };

  const result = await trashPathsWithSafety(
    (provider.staleCandidates || []).map(item => item.path),
    {
      dryRun: !!dryRun,
      recordHistory,
      module: 'cloud-trim',
      action: `Cloud Trim · ${provider.name}`,
      allowPath: isHomePath,
      meta: {
        providerId,
        providerName: provider.name,
        staleDays,
      },
    }
  );

  return {
    ...result,
    providerId,
  };
}

async function collectFilesForDuplicateScan(roots, { minSizeBytes, maxFiles, maxDepth = 8 }) {
  const files = [];
  const skipDirNames = new Set(['.git', '.svn', '.Trash', 'node_modules']);

  async function walk(dirPath, depth) {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const name = entry.name;
      if (!name || name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, name);

      if (entry.isDirectory()) {
        if (skipDirNames.has(name)) continue;
        await walk(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      try {
        const st = await fs.promises.stat(fullPath);
        if (st.size >= minSizeBytes) {
          files.push({
            path: fullPath,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        }
      } catch {}
    }
  }

  for (const root of roots) {
    if (files.length >= maxFiles) break;
    await walk(root, 0);
  }

  return files;
}

async function quickFileSignature(filePath, size) {
  const sampleSize = 64 * 1024;
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const startLen = Math.min(sampleSize, size);
    const startBuf = Buffer.alloc(startLen);
    const startRead = await fd.read(startBuf, 0, startLen, 0);

    let endBuf = Buffer.alloc(0);
    if (size > sampleSize) {
      const endLen = Math.min(sampleSize, Math.max(0, size - startRead.bytesRead));
      if (endLen > 0) {
        endBuf = Buffer.alloc(endLen);
        const endPos = Math.max(0, size - endLen);
        const endRead = await fd.read(endBuf, 0, endLen, endPos);
        endBuf = endBuf.subarray(0, endRead.bytesRead);
      }
    }

    const hash = crypto.createHash('sha256');
    hash.update(Buffer.from(String(size)));
    hash.update(startBuf.subarray(0, startRead.bytesRead));
    hash.update(endBuf);
    return hash.digest('hex');
  } finally {
    await fd.close();
  }
}

function fullFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function scanDuplicateFiles(options = {}) {
  const home = os.homedir();
  const defaultRoots = ['Downloads', 'Desktop', 'Documents', 'Pictures', 'Movies']
    .map(name => path.join(home, name))
    .filter(p => fs.existsSync(p));

  const rootsInput = Array.isArray(options.roots) && options.roots.length ? options.roots : defaultRoots;
  const roots = rootsInput
    .map(p => path.resolve(String(p)))
    .filter(p => isHomePath(p) && fs.existsSync(p));

  const minSizeBytes = Math.max(256 * 1024, Number(options.minSizeBytes) || 1024 * 1024);
  const maxFiles = Math.max(200, Math.min(10000, Number(options.maxFiles) || 2500));
  const maxGroups = Math.max(10, Math.min(500, Number(options.maxGroups) || 150));
  const startedAt = Date.now();

  const files = await collectFilesForDuplicateScan(roots, { minSizeBytes, maxFiles });
  const scannedBytes = files.reduce((acc, f) => acc + f.size, 0);

  const sizeGroups = new Map();
  for (const file of files) {
    const key = String(file.size);
    if (!sizeGroups.has(key)) sizeGroups.set(key, []);
    sizeGroups.get(key).push(file);
  }

  const quickCandidates = [];
  for (const group of sizeGroups.values()) {
    if (group.length > 1) quickCandidates.push(...group);
  }

  const quickGroups = new Map();
  for (const file of quickCandidates) {
    try {
      const signature = await quickFileSignature(file.path, file.size);
      const key = `${file.size}:${signature}`;
      if (!quickGroups.has(key)) quickGroups.set(key, []);
      quickGroups.get(key).push(file);
    } catch {}
  }

  const duplicates = [];
  for (const maybeGroup of quickGroups.values()) {
    if (maybeGroup.length < 2) continue;
    const contentGroups = new Map();

    for (const file of maybeGroup) {
      try {
        const hash = await fullFileHash(file.path);
        if (!contentGroups.has(hash)) contentGroups.set(hash, []);
        contentGroups.get(hash).push(file);
      } catch {}
    }

    for (const [hash, group] of contentGroups.entries()) {
      if (group.length < 2) continue;
      const sorted = group.slice().sort((a, b) => a.mtimeMs - b.mtimeMs);
      const keepIndex = sorted.length - 1; // Keep newest by default.
      const perFileSize = sorted[0].size;
      const reclaimableBytes = perFileSize * (sorted.length - 1);

      const filesOut = sorted.map((f, idx) => ({
        path: f.path,
        name: path.basename(f.path),
        dir: path.dirname(f.path),
        size: f.size,
        sizeStr: bytesToHuman(f.size),
        mtimeMs: f.mtimeMs,
        modifiedAt: new Date(f.mtimeMs).toISOString(),
        selected: idx !== keepIndex,
      }));

      duplicates.push({
        id: `${hash.slice(0, 12)}:${perFileSize}`,
        hash,
        count: sorted.length,
        size: perFileSize,
        sizeStr: bytesToHuman(perFileSize),
        reclaimableBytes,
        reclaimableStr: bytesToHuman(reclaimableBytes),
        keepPath: filesOut[keepIndex].path,
        files: filesOut,
      });
    }
  }

  duplicates.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
  const groups = duplicates.slice(0, maxGroups);
  const reclaimableBytes = groups.reduce((acc, g) => acc + g.reclaimableBytes, 0);

  return {
    success: true,
    roots,
    minSizeBytes,
    maxFiles,
    scannedFiles: files.length,
    scannedBytes,
    duplicateCandidates: quickCandidates.length,
    groupCount: groups.length,
    reclaimableBytes,
    reclaimableStr: bytesToHuman(reclaimableBytes),
    groups,
    durationMs: Date.now() - startedAt,
  };
}

function getProtectionBaselinePath() {
  return path.join(app.getPath('userData'), 'protection-baseline.json');
}

function loadProtectionBaseline() {
  try {
    const p = getProtectionBaselinePath();
    if (!fs.existsSync(p)) return { keys: [], updatedAt: null };
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      keys: Array.isArray(parsed.keys) ? parsed.keys : [],
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return { keys: [], updatedAt: null };
  }
}

function saveProtectionBaseline(keys) {
  try {
    fs.writeFileSync(getProtectionBaselinePath(), JSON.stringify({
      keys: Array.from(new Set(keys || [])),
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

function isTrustedVendorName(value) {
  const n = String(value || '').toLowerCase();
  const trusted = [
    'apple', 'microsoft', 'google', 'adobe', 'dropbox', 'spotify', 'zoom',
    'brave', 'mozilla', 'firefox', 'chrome', 'slack', 'notion', 'onedrive',
    'teamviewer', 'jetbrains', 'github', 'docker', 'setapp', 'bitdefender',
  ];
  return trusted.some(v => n.includes(v));
}

function getStartupItemsInternal() {
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
      const loadedOut = run(`launchctl list 2>/dev/null | grep "${name}"`).trim();
      const enabled = loadedOut !== '';
      let impact = 'Low';
      const heavy = ['spotify', 'dropbox', 'googledrive', 'onedrive', 'creative cloud', 'adobe', 'microsoft'];
      if (heavy.some(h => name.toLowerCase().includes(h))) impact = 'High';
      else if (name.toLowerCase().includes('helper') || name.toLowerCase().includes('agent')) impact = 'Medium';
      items.push({ id: file, name, filePath, enabled, impact, system });
    }
  }

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
}

function toggleStartupItemInternal({ filePath, enabled, loginItem, name }) {
  return new Promise((resolve) => {
    if (loginItem) {
      const script = enabled
        ? `tell application "System Events" to delete login item "${name}"`
        : `tell application "System Events" to make login item at end with properties {name:"${name}", hidden:false}`;
      exec(`osascript -e '${script}'`, (err) => resolve({ success: !err, error: err?.message }));
      return;
    }

    const action = enabled ? 'unload' : 'load';
    const cmd = `launchctl ${action} "${filePath}" 2>/dev/null`;
    exec(cmd, (err) => {
      if (!err) { resolve({ success: true }); return; }
      exec(
        `osascript -e 'do shell script "launchctl ${action} \\"${filePath}\\"" with administrator privileges'`,
        (err2) => resolve({ success: !err2, error: err2?.message })
      );
    });
  });
}

function listInstalledAppPaths(limit = 80) {
  const dirs = ['/Applications', `${os.homedir()}/Applications`];
  const seen = new Set();
  const apps = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir).filter(name => name.endsWith('.app'));
    for (const entry of entries) {
      const appPath = path.join(dir, entry);
      if (seen.has(appPath)) continue;
      seen.add(appPath);
      apps.push(appPath);
      if (apps.length >= limit) return apps;
    }
  }
  return apps;
}

function isAppSigned(appPath) {
  try {
    execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'ignore', timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

function toProtectionSeverityScore(severity) {
  if (severity === 'critical') return 18;
  if (severity === 'warning') return 9;
  return 3;
}

function makeProtectionReport(findings, previousBaseline) {
  const prevSet = new Set(previousBaseline.keys || []);
  const keys = findings.map(f => f.id);
  const annotated = findings.map(f => ({ ...f, isNew: !prevSet.has(f.id) }));
  const counts = {
    critical: annotated.filter(f => f.severity === 'critical').length,
    warning: annotated.filter(f => f.severity === 'warning').length,
    info: annotated.filter(f => f.severity === 'info').length,
    new: annotated.filter(f => f.isNew).length,
  };
  const scoreDrop = annotated.reduce((acc, f) => acc + toProtectionSeverityScore(f.severity), 0);
  const score = Math.max(0, 100 - scoreDrop);
  const status = score >= 85 ? 'Excellent' : score >= 70 ? 'Good' : score >= 55 ? 'Caution' : 'Risky';

  const report = {
    success: true,
    scannedAt: new Date().toISOString(),
    baselinePreviousAt: previousBaseline.updatedAt || null,
    score,
    status,
    counts,
    findings: annotated.sort((a, b) => {
      const rank = { critical: 0, warning: 1, info: 2 };
      if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
      return (a.title || '').localeCompare(b.title || '');
    }),
  };

  saveProtectionBaseline(keys);
  protectionCache = { ts: Date.now(), report };
  return report;
}

async function scanProtection(options = {}) {
  const force = !!options.force;
  if (!force && protectionCache.report && (Date.now() - protectionCache.ts) < 120000) {
    return { ...protectionCache.report, cached: true };
  }

  const home = os.homedir();
  const findings = [];

  // 1) Startup/login items risk scan.
  const startupItems = getStartupItemsInternal();
  startupItems.forEach(item => {
    if (!item.enabled || item.system) return;
    const suspicious = !isTrustedVendorName(item.name) || item.impact === 'High';
    if (!suspicious) return;
    const severity = item.impact === 'High' && !isTrustedVendorName(item.name) ? 'critical' : 'warning';
    findings.push({
      id: `startup:${item.loginItem ? `login:${item.name}` : item.filePath || item.id}`,
      type: 'startup-item',
      severity,
      title: item.name,
      description: `${item.loginItem ? 'Login Item' : 'Launch item'} is enabled at startup${item.impact ? ` (${item.impact} impact)` : ''}.`,
      path: item.filePath || null,
      actions: ['disable-startup', 'reveal-path'],
      data: {
        id: item.id,
        filePath: item.filePath || null,
        enabled: item.enabled,
        loginItem: !!item.loginItem,
        name: item.name,
      },
    });
  });

  // 2) Unusual LaunchAgents in user Library.
  const userLaunchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
  if (fs.existsSync(userLaunchAgentsDir)) {
    const loadedListOut = run('launchctl list 2>/dev/null');
    const loadedLabels = new Set(
      loadedListOut.split('\n')
        .map(line => line.trim().split(/\s+/).pop())
        .filter(v => v && v !== 'Label')
    );
    const plists = fs.readdirSync(userLaunchAgentsDir).filter(name => name.endsWith('.plist'));
    plists.forEach(file => {
      const filePath = path.join(userLaunchAgentsDir, file);
      const label = run(`defaults read "${filePath}" Label 2>/dev/null`).trim() || file.replace(/\.plist$/, '');
      const loaded = loadedLabels.has(label) || loadedLabels.has(file.replace(/\.plist$/, ''));
      const unusual = !isTrustedVendorName(file) && !file.startsWith('com.apple.');
      if (!unusual) return;
      findings.push({
        id: `launch-agent:${filePath}`,
        type: 'launch-agent',
        severity: loaded ? 'critical' : 'warning',
        title: file,
        description: `User LaunchAgent ${loaded ? 'is loaded and ' : ''}does not match trusted vendor patterns.`,
        path: filePath,
        actions: ['disable-launch-agent', 'reveal-path', 'trash-path'],
        data: { filePath, loaded, label },
      });
    });
  }

  // 3) Unsiged apps check (user-space app bundles).
  const appPaths = listInstalledAppPaths(60);
  appPaths.forEach(appPath => {
    const appName = path.basename(appPath, '.app');
    const trusted = isTrustedVendorName(appName);
    if (trusted) return;
    if (isAppSigned(appPath)) return;
    const inHome = isHomePath(appPath);
    findings.push({
      id: `unsigned-app:${appPath}`,
      type: 'unsigned-app',
      severity: inHome ? 'critical' : 'warning',
      title: appName,
      description: `App bundle failed code signature verification (${inHome ? 'user space' : '/Applications'}).`,
      path: appPath,
      actions: ['reveal-path', 'trash-path'],
      data: { appPath },
    });
  });

  const baseline = loadProtectionBaseline();
  return makeProtectionReport(findings, baseline);
}

function canTrashProtectionPath(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  if (isHomePath(resolved)) return true;
  return resolved.startsWith('/Applications/') && resolved.endsWith('.app');
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
    'systemsettings', 'activity monitor', 'maccleaner', 'lumasweep', 'electron',
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
  return path.join(app.getPath('userData'), 'askpass-lumasweep.sh');
}

function ensureAskpassScript() {
  const askpassPath = getAskpassScriptPath();
  if (fs.existsSync(askpassPath)) return askpassPath;
  const script = `#!/bin/sh
exec /usr/bin/osascript \
  -e 'text returned of (display dialog "LumaSweep needs administrator access to clean RAM." default answer "" with hidden answer buttons {"Cancel","OK"} default button "OK" with title "LumaSweep")'
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

function getBatterySnapshot() {
  const battOut = run('pmset -g batt');
  const battMatch = battOut.match(/(\d+)%/);
  const battPct = battMatch ? parseInt(battMatch[1], 10) : null;
  if (battPct === null) return null;
  const isCharging = battOut.includes('AC Power') || battOut.includes('charging');
  return { pct: battPct, charging: isCharging };
}

function getSystemInfoSnapshot() {
  const ram = getRamSnapshot();
  const pressure = getMemoryPressure();

  const cpuLoad = run("top -l 1 -n 0 | grep 'CPU usage'").trim();
  const cpuMatch = cpuLoad.match(/(\d+\.?\d*)% user/);
  const cpuPct = cpuMatch ? Math.round(parseFloat(cpuMatch[1])) : 0;
  const load = os.loadavg();
  const cores = os.cpus().length || 1;

  const dfOut = run('df -k /').split('\n')[1]?.split(/\s+/) || [];
  const diskTotal = parseInt(dfOut[1] || 0, 10) * 1024;
  const diskUsed = parseInt(dfOut[2] || 0, 10) * 1024;
  const diskFree = parseInt(dfOut[3] || 0, 10) * 1024;
  const diskPct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

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
    battery: getBatterySnapshot(),
    hostname: os.hostname(),
    platform: process.arch,
  };
}

function getAutoCareState() {
  return {
    settings: getAutoCareSettings(),
    status: {
      running: !!autoCareStatus.running,
      lastRunAt: autoCareStatus.lastRunAt || null,
      nextRunAt: autoCareStatus.nextRunAt || null,
      runCount: Number(autoCareStatus.runCount || 0),
      lastError: autoCareStatus.lastError || null,
      lastResult: autoCareStatus.lastResult || null,
    },
  };
}

function stopAutoCareScheduler() {
  if (autoCareTimer) {
    clearTimeout(autoCareTimer);
    autoCareTimer = null;
  }
  autoCareStatus.nextRunAt = null;
}

function getPressureRank(level) {
  if (level === 'critical') return 2;
  if (level === 'warning') return 1;
  return 0;
}

async function runAutoCareOnce(trigger = 'scheduled') {
  const cfg = getAutoCareSettings();
  if (autoCareStatus.running) return { success: true, skipped: true, reason: 'already-running' };
  if (trigger !== 'manual' && !cfg.enabled) return { success: true, skipped: true, reason: 'disabled' };
  if (trigger !== 'manual' && isSuspended) return { success: true, skipped: true, reason: 'suspended' };

  autoCareStatus.running = true;
  autoCareStatus.lastError = null;
  const startedAt = Date.now();
  try {
    const snapshot = getSystemInfoSnapshot();
    const actions = [];

    if (cfg.ramCleanOnPressure) {
      const pressureLevel = (snapshot.ram.pressure && snapshot.ram.pressure.level) || 'normal';
      const pressureRank = getPressureRank(pressureLevel);
      const neededRank = cfg.pressureTrigger === 'warning' ? 1 : 2;
      const inactiveGb = snapshot.ram.inactive / (1024 ** 3);
      const blockedByBattery = !!(snapshot.battery && !snapshot.battery.charging && !cfg.allowOnBattery);

      if (blockedByBattery) {
        actions.push({
          type: 'ram-clean',
          status: 'skipped',
          reason: 'on-battery',
          pressureLevel,
          inactiveGb: Number(inactiveGb.toFixed(2)),
        });
      } else if (pressureRank < neededRank) {
        actions.push({
          type: 'ram-clean',
          status: 'skipped',
          reason: 'pressure-below-threshold',
          pressureLevel,
          inactiveGb: Number(inactiveGb.toFixed(2)),
        });
      } else if (inactiveGb < cfg.minInactiveGb) {
        actions.push({
          type: 'ram-clean',
          status: 'skipped',
          reason: 'inactive-below-threshold',
          pressureLevel,
          inactiveGb: Number(inactiveGb.toFixed(2)),
        });
      } else {
        const before = getRamSnapshot();
        const beforePressure = getMemoryPressure();
        let purgeResult = null;
        if (trigger === 'manual') {
          purgeResult = await purgeRamSmart();
        } else {
          if (isSudoAuthorized()) purgeResult = purgeRamWithSudoNoPrompt();
          else purgeResult = { success: false, error: 'Sudo not authorized for non-interactive cleanup' };
        }

        if (!purgeResult || !purgeResult.success) {
          actions.push({
            type: 'ram-clean',
            status: 'failed',
            error: (purgeResult && purgeResult.error) || 'RAM cleanup failed',
            pressureLevel,
            inactiveGb: Number(inactiveGb.toFixed(2)),
          });
        } else {
          const metrics = await buildRamCleanupMetrics(before);
          updateTray();
          actions.push({
            type: 'ram-clean',
            status: 'done',
            method: trigger === 'manual' ? 'interactive' : 'cached-sudo',
            immediateFreeGainBytes: metrics.immediateFreeGainBytes,
            stabilizedFreeGainBytes: metrics.stabilizedFreeGainBytes,
            beforePressure: beforePressure.level || 'unknown',
            afterPressure: (metrics.stabilizedPressure && metrics.stabilizedPressure.level) || 'unknown',
          });
        }
      }
    }

    const summary = {
      trigger,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      snapshot: {
        ramUsedPct: snapshot.ram.usedPct,
        cpuPct: snapshot.cpu.pct,
        diskPct: snapshot.disk.pct,
        pressure: (snapshot.ram.pressure && snapshot.ram.pressure.level) || 'unknown',
      },
      actions,
    };

    autoCareStatus.lastRunAt = summary.finishedAt;
    autoCareStatus.runCount = Number(autoCareStatus.runCount || 0) + 1;
    autoCareStatus.lastResult = summary;
    return { success: true, ...summary };
  } catch (e) {
    autoCareStatus.lastRunAt = new Date().toISOString();
    autoCareStatus.runCount = Number(autoCareStatus.runCount || 0) + 1;
    autoCareStatus.lastError = e.message || 'Auto Care run failed';
    autoCareStatus.lastResult = {
      trigger,
      finishedAt: autoCareStatus.lastRunAt,
      durationMs: Date.now() - startedAt,
      actions: [],
      error: autoCareStatus.lastError,
    };
    return { success: false, error: autoCareStatus.lastError };
  } finally {
    autoCareStatus.running = false;
  }
}

function resetAutoCareScheduler(immediate = false) {
  stopAutoCareScheduler();
  const cfg = getAutoCareSettings();
  if (!cfg.enabled || isSuspended) return;
  const delayMs = immediate ? 2000 : cfg.intervalMinutes * 60 * 1000;
  const nextAt = Date.now() + delayMs;
  autoCareStatus.nextRunAt = new Date(nextAt).toISOString();
  autoCareTimer = setTimeout(async () => {
    await runAutoCareOnce('scheduled');
    resetAutoCareScheduler(false);
  }, delayMs);
}

function setAutoCareSettings(patch = {}) {
  const current = getAutoCareSettings();
  const merged = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
  settings.autoCare = normalizeAutoCareSettings(merged);
  saveSettings();
  resetAutoCareScheduler(false);
  return getAutoCareSettings();
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
      label: 'Show LumaSweep',
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
          label: 'Live (No Delay)',
          type: 'radio',
          checked: getRefreshProfile() === 'live',
          click: () => setRefreshProfile('live'),
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
    { label: 'Quit LumaSweep', click: () => app.quit() },
  ]);
}

function updateTray() {
  if (!tray) return;
  try {
    const ram = getRamSnapshot();
    tray.setTitle(` ${ram.usedPct}%`);
    tray.setToolTip(`LumaSweep · RAM ${ram.usedPct}%`);
    tray.setContextMenu(buildTrayMenu());
  } catch {}
}

function getTrayRefreshMs() {
  if (isSuspended) return 60000;
  const profile = getRefreshProfile();
  const schedule = profile === 'live'
    ? { focused: 1000, visible: 2000, hidden: 6000 }
    : profile === 'real-time'
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
  return getSystemInfoSnapshot();
});

ipcMain.handle('get-settings', async () => {
  return {
    ...settings,
    refreshProfile: getRefreshProfile(),
    autoCare: getAutoCareSettings(),
  };
});

ipcMain.handle('set-refresh-profile', async (event, profile) => {
  setRefreshProfile(profile);
  return { success: true, refreshProfile: getRefreshProfile() };
});

ipcMain.handle('get-auto-care-state', async () => {
  return { success: true, ...getAutoCareState() };
});

ipcMain.handle('set-auto-care-settings', async (event, patch = {}) => {
  const updated = setAutoCareSettings(patch || {});
  return { success: true, settings: updated, status: getAutoCareState().status };
});

ipcMain.handle('run-auto-care-now', async () => {
  const result = await runAutoCareOnce('manual');
  resetAutoCareScheduler(false);
  return {
    success: !!result.success,
    result,
    status: getAutoCareState().status,
  };
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

ipcMain.handle('clean-disk-item', async (event, id, options = {}) => {
  const dryRun = !!options.dryRun;
  const recordHistory = options.recordHistory !== false;
  const home = os.homedir();
  const targets = {
    user_cache:   { paths: [`${home}/Library/Caches`] },
    system_logs:  { paths: [`${home}/Library/Logs`] },
    trash:        { cmd: `osascript -e 'tell application "Finder" to empty trash'` },
    mail_cache:   { paths: [`${home}/Library/Containers/com.apple.mail/Data/Library/Caches`] },
    xcode_derived:{ paths: [`${home}/Library/Developer/Xcode/DerivedData`] },
    ios_backups:  { paths: [`${home}/Library/Application Support/MobileSync/Backup`] },
  };

  const target = targets[id];
  if (!target) return { success: false, error: 'Unknown category' };

  if (target.cmd) {
    const trashDir = path.join(home, '.Trash');
    let trashEntries = [];
    if (fs.existsSync(trashDir)) {
      try {
        trashEntries = fs.readdirSync(trashDir).map(name => path.join(trashDir, name));
      } catch {
        trashEntries = [];
      }
    }
    const previewBytes = trashEntries.reduce((acc, p) => acc + pathSize(p), 0);
    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        candidateCount: trashEntries.length,
        previewCount: trashEntries.length,
        previewBytes,
      };
    }
    return new Promise((resolve) => {
      exec(target.cmd, { timeout: 30000 }, (err) => {
        if (!err && recordHistory) {
          const historyEntry = makeCleanupHistoryEntry({
            module: 'storage-sweep',
            action: 'Storage Sweep · Empty Trash',
            dryRun: false,
            candidateCount: trashEntries.length,
            movedItems: [],
            failed: [],
            meta: {
              nonRestorable: true,
              category: id,
              bytesRemoved: previewBytes,
            },
          });
          historyEntry.bytes = previewBytes;
          appendCleanupHistoryEntry(historyEntry);
        }
        resolve({
          success: !err,
          error: err?.message,
          trashedCount: 0,
          trashedBytes: previewBytes,
          candidateCount: trashEntries.length,
        });
      });
    });
  }

  const roots = target.paths || [];
  const candidatePaths = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let contents = [];
    try { contents = fs.readdirSync(root); } catch { contents = []; }
    for (const item of contents) {
      const full = path.join(root, item);
      if (!isHomePath(full)) continue;
      if (!fs.existsSync(full)) continue;
      candidatePaths.push(full);
    }
  }

  return trashPathsWithSafety(candidatePaths, {
    dryRun,
    recordHistory,
    module: 'storage-sweep',
    action: `Storage Sweep · ${id}`,
    allowPath: isHomePath,
    meta: { category: id },
  });
});

// ─── IPC: Duplicate Scanner ────────────────────────────────────────────────────

ipcMain.handle('scan-duplicates', async (event, options = {}) => {
  try {
    return await scanDuplicateFiles(options || {});
  } catch (e) {
    return { success: false, error: e.message || 'Duplicate scan failed' };
  }
});

ipcMain.handle('trash-paths', async (event, payload = {}) => {
  const usingLegacyArray = Array.isArray(payload);
  const targets = usingLegacyArray ? payload : (Array.isArray(payload.paths) ? payload.paths : []);
  const dryRun = !usingLegacyArray && !!payload.dryRun;
  const module = !usingLegacyArray && payload.module ? String(payload.module) : 'cleanup';
  const action = !usingLegacyArray && payload.action ? String(payload.action) : 'Move selected items to Trash';
  const recordHistory = usingLegacyArray ? true : payload.recordHistory !== false;

  return trashPathsWithSafety(targets, {
    dryRun,
    recordHistory,
    module,
    action,
    allowPath: isHomePath,
  });
});

ipcMain.handle('get-space-lens', async (event, options = {}) => {
  try {
    return await scanSpaceLensDirectory(options || {});
  } catch (e) {
    return { success: false, error: e.message || 'Space Lens scan failed' };
  }
});

ipcMain.handle('get-cloud-cleanup-report', async (event, options = {}) => {
  try {
    return await getCloudCleanupReport(options || {});
  } catch (e) {
    return { success: false, error: e.message || 'Cloud cleanup scan failed' };
  }
});

ipcMain.handle('clean-cloud-provider-cache', async (event, payload = {}) => {
  const providerId = String(payload.providerId || '');
  if (!providerId) return { success: false, error: 'Provider id is required' };
  try {
    return await cleanCloudProviderCache({
      providerId,
      staleDays: payload.staleDays,
      maxFiles: payload.maxFiles,
      dryRun: !!payload.dryRun,
      recordHistory: payload.recordHistory !== false,
    });
  } catch (e) {
    return { success: false, error: e.message || 'Cloud cleanup action failed' };
  }
});

function readPlistValue(plistPath, key) {
  if (!plistPath || !key || !fs.existsSync(plistPath)) return '';
  return run(`defaults read "${plistPath}" ${key} 2>/dev/null`).trim();
}

function pathSize(targetPath) {
  try {
    const st = fs.statSync(targetPath);
    if (st.isDirectory()) return dirSize(targetPath);
    if (st.isFile()) return st.size;
  } catch {}
  return 0;
}

function toAppSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.app$/i, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function addHomePathIfExists(bucket, targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  if (!resolved || !isHomePath(resolved) || !fs.existsSync(resolved)) return;
  bucket.add(resolved);
}

function addMatchingEntries(bucket, dirPath, predicate) {
  if (!fs.existsSync(dirPath)) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!predicate(entry)) continue;
    addHomePathIfExists(bucket, path.join(dirPath, entry));
  }
}

function collectAppLeftoverPaths(home, appName, bundleId) {
  const leftover = new Set();
  const slug = toAppSlug(appName);
  const bundle = String(bundleId || '').trim();
  const supportDirs = [
    path.join(home, 'Library', 'Application Support'),
    path.join(home, 'Library', 'Caches'),
    path.join(home, 'Library', 'Logs'),
    path.join(home, 'Library', 'HTTPStorages'),
    path.join(home, 'Library', 'WebKit'),
  ];
  const directNames = new Set([appName, slug].filter(Boolean));
  if (bundle) {
    directNames.add(bundle);
    directNames.add(bundle.replace(/^com\./, ''));
  }

  for (const dir of supportDirs) {
    for (const name of directNames) {
      addHomePathIfExists(leftover, path.join(dir, name));
    }
  }

  if (bundle) {
    addHomePathIfExists(leftover, path.join(home, 'Library', 'Containers', bundle));
    addHomePathIfExists(leftover, path.join(home, 'Library', 'Saved Application State', `${bundle}.savedState`));
    addHomePathIfExists(leftover, path.join(home, 'Library', 'Preferences', `${bundle}.plist`));
    addMatchingEntries(
      leftover,
      path.join(home, 'Library', 'Preferences', 'ByHost'),
      name => name.startsWith(`${bundle}.`) && name.endsWith('.plist')
    );
    addMatchingEntries(
      leftover,
      path.join(home, 'Library', 'LaunchAgents'),
      name => name.startsWith(bundle) && name.endsWith('.plist')
    );
    addMatchingEntries(
      leftover,
      path.join(home, 'Library', 'Group Containers'),
      name => name === bundle || name.startsWith(`${bundle}.`) || name.endsWith(`.${bundle}`)
    );
  }

  if (slug) {
    const slugBundle = `com.${slug}`;
    addHomePathIfExists(leftover, path.join(home, 'Library', 'Preferences', `${slugBundle}.plist`));
    addHomePathIfExists(leftover, path.join(home, 'Library', 'Containers', slugBundle));
    addHomePathIfExists(leftover, path.join(home, 'Library', 'Saved Application State', `${slugBundle}.savedState`));
    addMatchingEntries(
      leftover,
      path.join(home, 'Library', 'LaunchAgents'),
      name => name.startsWith(slugBundle) && name.endsWith('.plist')
    );
  }

  return Array.from(leftover);
}

function isUninstallableAppPath(appPath) {
  const resolved = path.resolve(String(appPath || ''));
  if (!resolved.endsWith('.app')) return false;
  return resolved.startsWith('/Applications/') || resolved.startsWith(path.join(os.homedir(), 'Applications') + path.sep);
}

function sanitizeAppLeftoverPaths(paths) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const p = path.resolve(String(raw || ''));
    if (!p || seen.has(p) || !isHomePath(p) || !fs.existsSync(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

async function trashTargets(targets, options = {}) {
  const result = await trashPathsWithSafety(targets, {
    dryRun: !!options.dryRun,
    recordHistory: options.recordHistory !== false,
    allowPath: isHomePath,
    module: options.module || 'app-manager',
    action: options.action || 'App Manager cleanup',
    meta: options.meta || {},
  });
  return {
    trashed: result.trashed,
    failed: result.failed,
    bytes: result.trashedBytes,
    dryRun: result.dryRun,
    candidateCount: result.candidateCount,
    previewCount: result.previewCount,
    previewBytes: result.previewBytes,
    historyId: result.historyId || null,
  };
}

// ─── IPC: List Apps ────────────────────────────────────────────────────────────

ipcMain.handle('list-apps', async () => {
  const dirs = ['/Applications', `${os.homedir()}/Applications`];
  const apps = [];
  const home = os.homedir();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir).filter(f => f.endsWith('.app'));
    for (const entry of entries) {
      const appPath = path.join(dir, entry);
      const name = entry.replace('.app', '');
      const appSize = dirSize(appPath);

      // Get bundle info for category/icon
      let category = 'Application';
      let bundleId = '';
      let bundleName = name;
      try {
        const plistPath = path.join(appPath, 'Contents/Info.plist');
        if (fs.existsSync(plistPath)) {
          bundleId = readPlistValue(plistPath, 'CFBundleIdentifier');
          bundleName = readPlistValue(plistPath, 'CFBundleName') || name;
          const plistCategory = readPlistValue(plistPath, 'LSApplicationCategoryType');
          if (plistCategory) category = plistCategory.split('.').pop().replace(/-/g, ' ');
        }
      } catch {}

      const leftoverPaths = collectAppLeftoverPaths(home, name, bundleId);
      const leftoverSize = leftoverPaths.reduce((acc, p) => acc + pathSize(p), 0);

      apps.push({
        id: `app:${appPath}`,
        name,
        bundleName,
        bundleId: bundleId || null,
        path: appPath,
        size: appSize,
        sizeStr: bytesToHuman(appSize),
        leftover: leftoverSize,
        leftoverStr: bytesToHuman(leftoverSize),
        category: category || 'Application',
        leftoverPathCount: leftoverPaths.length,
        leftoverPaths,
      });
    }
  }

  return apps.sort((a, b) => {
    if ((b.leftover || 0) !== (a.leftover || 0)) return (b.leftover || 0) - (a.leftover || 0);
    return (b.size || 0) - (a.size || 0);
  });
});

// ─── IPC: Uninstall App ────────────────────────────────────────────────────────

ipcMain.handle('uninstall-app', async (event, payload = {}) => {
  const appPath = path.resolve(String(payload.appPath || ''));
  const appName = path.basename(appPath, '.app') || 'app';
  const skipConfirm = !!payload.skipConfirm;
  const dryRun = !!payload.dryRun;
  const recordHistory = payload.recordHistory !== false;
  const leftoverTargets = sanitizeAppLeftoverPaths(payload.leftoverPaths);

  if (!isUninstallableAppPath(appPath)) {
    return { success: false, error: 'Unsupported app path. Only /Applications or ~/Applications bundles are allowed.' };
  }
  if (!fs.existsSync(appPath)) return { success: false, error: 'App not found' };

  const appPreview = await trashPathsWithSafety([appPath], {
    dryRun: true,
    recordHistory: false,
    allowPath: isUninstallableAppPath,
    module: 'app-manager',
    action: `Uninstall ${appName}`,
  });
  const leftoversPreview = await trashTargets(leftoverTargets, {
    dryRun: true,
    recordHistory: false,
    module: 'app-manager',
    action: `Leftover cleanup · ${appName}`,
  });

  const preview = {
    appCandidateCount: appPreview.previewCount,
    leftoverCandidateCount: leftoversPreview.previewCount,
    candidateCount: appPreview.previewCount + leftoversPreview.previewCount,
    previewBytes: (appPreview.previewBytes || 0) + (leftoversPreview.previewBytes || 0),
    appFailed: appPreview.failed || [],
    leftoverFailed: leftoversPreview.failed || [],
  };

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      ...preview,
    };
  }

  if (!skipConfirm) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Uninstall'],
      defaultId: 0,
      cancelId: 0,
      title: 'Confirm Uninstall',
      message: `Uninstall ${path.basename(appPath)}?`,
      detail: `${preview.candidateCount} item(s) will be moved to Trash (${bytesToHuman(preview.previewBytes)}).`,
    });
    if (response === 0) return { success: false, cancelled: true };
  }

  const appResult = await trashPathsWithSafety([appPath], {
    dryRun: false,
    recordHistory,
    allowPath: isUninstallableAppPath,
    module: 'app-manager',
    action: `Uninstall ${appName}`,
    meta: {
      appPath,
      appName,
    },
  });

  let appTrashed = appResult.trashedCount > 0;
  let usedAdminDeleteFallback = false;
  if (!appTrashed) {
    // Fallback: require admin
    const appBytes = pathSize(appPath);
    await new Promise((resolve) => {
      exec(
        `osascript -e 'do shell script "rm -rf \\"${appPath}\\"" with administrator privileges'`,
        (err) => {
          appTrashed = !err;
          resolve();
        }
      );
    });
    if (appTrashed) {
      usedAdminDeleteFallback = true;
      if (recordHistory) {
        appendCleanupHistoryEntry(makeCleanupHistoryEntry({
          module: 'app-manager',
          action: `Uninstall ${appName} (admin delete)`,
          dryRun: false,
          candidateCount: 1,
          movedItems: [],
          failed: [],
          meta: {
            nonRestorable: true,
            deletedDirectly: true,
            appPath,
            appName,
            bytesRemoved: appBytes,
          },
        }));
      }
    }
    if (!appTrashed) return { success: false, error: `Could not uninstall ${appName}` };
  }

  const cleanup = await trashTargets(leftoverTargets, {
    dryRun: false,
    recordHistory,
    module: 'app-manager',
    action: `Leftover cleanup · ${appName}`,
    meta: {
      appPath,
      appName,
    },
  });

  return {
    success: cleanup.failed.length === 0,
    appTrashed: true,
    appDeleteFallback: usedAdminDeleteFallback,
    cleanedLeftoverCount: cleanup.trashed.length,
    cleanedLeftoverBytes: cleanup.bytes,
    failedLeftovers: cleanup.failed,
    appHistoryId: appResult.historyId || null,
    leftoversHistoryId: cleanup.historyId || null,
    preview,
  };
});

ipcMain.handle('clean-app-leftovers', async (event, payload = {}) => {
  const appName = String(payload.appName || 'this app');
  const skipConfirm = !!payload.skipConfirm;
  const dryRun = !!payload.dryRun;
  const recordHistory = payload.recordHistory !== false;
  const targets = sanitizeAppLeftoverPaths(payload.leftoverPaths);
  if (!targets.length) return { success: true, cleanedCount: 0, cleanedBytes: 0, failed: [] };

  const preview = await trashTargets(targets, {
    dryRun: true,
    recordHistory: false,
    module: 'app-manager',
    action: `Leftover cleanup · ${appName}`,
  });
  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      candidateCount: preview.candidateCount,
      previewCount: preview.previewCount,
      previewBytes: preview.previewBytes,
      failed: preview.failed,
    };
  }

  if (!skipConfirm) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Cancel', 'Move to Trash'],
      defaultId: 0,
      cancelId: 0,
      title: 'Cleanup Leftovers',
      message: `Clean leftovers for ${appName}?`,
      detail: `${preview.previewCount} file/folder item(s) will be moved to Trash (${bytesToHuman(preview.previewBytes)}).`,
    });
    if (response === 0) return { success: false, cancelled: true };
  }

  const cleanup = await trashTargets(targets, {
    dryRun: false,
    recordHistory,
    module: 'app-manager',
    action: `Leftover cleanup · ${appName}`,
  });
  return {
    success: cleanup.failed.length === 0,
    cleanedCount: cleanup.trashed.length,
    cleanedBytes: cleanup.bytes,
    failed: cleanup.failed,
    historyId: cleanup.historyId || null,
    preview,
  };
});

// ─── IPC: Startup Items ────────────────────────────────────────────────────────

ipcMain.handle('get-startup-items', async () => {
  return getStartupItemsInternal();
});

// ─── IPC: Toggle Startup Item ─────────────────────────────────────────────────

ipcMain.handle('toggle-startup-item', async (event, { id, filePath, enabled, loginItem, name }) => {
  return toggleStartupItemInternal({ id, filePath, enabled, loginItem, name });
});

// ─── IPC: Protection ───────────────────────────────────────────────────────────

ipcMain.handle('get-protection-report', async (event, options = {}) => {
  return scanProtection(options || {});
});

ipcMain.handle('run-protection-action', async (event, payload = {}) => {
  const action = String(payload.action || '');
  const finding = payload.finding || {};

  if (action === 'reveal-path') {
    const targetPath = finding.path || finding.data?.filePath || finding.data?.appPath;
    if (!targetPath) return { success: false, error: 'No path available to reveal' };
    shell.showItemInFinder(targetPath);
    return { success: true };
  }

  if (action === 'disable-startup') {
    const data = finding.data || {};
    if (!data || !data.name) return { success: false, error: 'Startup payload missing' };
    if (!data.enabled) return { success: true, already: true };
    const result = await toggleStartupItemInternal({
      id: data.id,
      filePath: data.filePath,
      enabled: true,
      loginItem: !!data.loginItem,
      name: data.name,
    });
    if (result.success) protectionCache = { ts: 0, report: null };
    return result;
  }

  if (action === 'disable-launch-agent') {
    const filePath = finding.data?.filePath || finding.path;
    if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'LaunchAgent file not found' };
    const result = await toggleStartupItemInternal({
      filePath,
      enabled: true,
      loginItem: false,
      name: path.basename(filePath, '.plist'),
    });
    if (result.success) protectionCache = { ts: 0, report: null };
    return result;
  }

  if (action === 'trash-path') {
    const targetPath = path.resolve(String(finding.path || finding.data?.filePath || finding.data?.appPath || ''));
    if (!targetPath || !fs.existsSync(targetPath)) return { success: false, error: 'Target not found' };
    if (!canTrashProtectionPath(targetPath)) return { success: false, error: 'Path is outside allowed cleanup scope' };

    const preview = await trashPathsWithSafety([targetPath], {
      dryRun: true,
      recordHistory: false,
      allowPath: canTrashProtectionPath,
      module: 'shield',
      action: `Shield cleanup · ${path.basename(targetPath)}`,
    });
    const previewCount = preview.previewCount || 0;
    const previewBytes = preview.previewBytes || 0;
    if (previewCount < 1) return { success: false, error: 'Nothing available to move to Trash' };

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Move to Trash'],
      defaultId: 0,
      cancelId: 0,
      title: 'Confirm Cleanup Action',
      message: `Move ${path.basename(targetPath)} to Trash?`,
      detail: `Dry run: ${previewCount} item(s), ${bytesToHuman(previewBytes)}. This action can be undone from Trash.`,
    });
    if (response === 0) return { success: false, cancelled: true };
    const result = await trashPathsWithSafety([targetPath], {
      dryRun: false,
      recordHistory: true,
      allowPath: canTrashProtectionPath,
      module: 'shield',
      action: `Shield cleanup · ${path.basename(targetPath)}`,
    });
    if (result.success) {
      protectionCache = { ts: 0, report: null };
      return result;
    }
    return { success: false, error: (result.failed[0] && result.failed[0].error) || 'Failed to move item to Trash' };
  }

  return { success: false, error: 'Unsupported action' };
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

// ─── IPC: Safety Center ───────────────────────────────────────────────────────

ipcMain.handle('get-cleanup-history', async (event, options = {}) => {
  const limit = Math.max(10, Math.min(200, Number(options.limit) || 80));
  const entries = loadCleanupHistoryEntries().slice(0, limit);
  return { success: true, entries };
});

ipcMain.handle('restore-cleanup-entry', async (event, payload = {}) => {
  try {
    const res = await restoreCleanupEntryById(payload.entryId);
    return res;
  } catch (e) {
    return { success: false, error: e.message || 'Restore failed' };
  }
});

ipcMain.handle('clear-cleanup-history', async () => {
  saveCleanupHistoryEntries([]);
  return { success: true };
});

// ─── IPC: App Info ─────────────────────────────────────────────────────────────

ipcMain.handle('open-in-finder', async (event, filePath) => {
  shell.showItemInFinder(filePath);
});

ipcMain.handle('get-app-version', () => app.getVersion());
