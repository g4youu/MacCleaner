const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = require('electron');
const { execSync, exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow;

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
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

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

// ─── IPC: System Info ─────────────────────────────────────────────────────────

ipcMain.handle('get-system-info', async () => {
  // ── RAM via vm_stat ──
  const vmstat = run('vm_stat');
  const pageSize = 16384; // macOS ARM page size (16KB), x86 is 4096
  const actualPageSize = parseInt(run('pagesize').trim()) || 16384;

  const parse = key => {
    const m = vmstat.match(new RegExp(`${key}:\\s+(\\d+)`));
    return m ? parseInt(m[1]) * actualPageSize : 0;
  };

  const wired      = parse('Pages wired down');
  const active     = parse('Pages active');
  const inactive   = parse('Pages inactive');
  const compressed = parse('Pages occupied by compressor');
  const free       = parse('Pages free');
  const totalRam   = os.totalmem();
  const used       = totalRam - (free + inactive);
  const usedPct    = Math.round((used / totalRam) * 100);

  // ── CPU ──
  const cpuLoad = run("top -l 1 -n 0 | grep 'CPU usage'").trim();
  const cpuMatch = cpuLoad.match(/(\d+\.?\d*)% user/);
  const cpuPct = cpuMatch ? Math.round(parseFloat(cpuMatch[1])) : 0;

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
    ram: {
      total: totalRam, used, free: free + inactive,
      wired, active, inactive, compressed,
      usedPct,
    },
    cpu: { pct: cpuPct },
    disk: { total: diskTotal, used: diskUsed, free: diskFree, pct: diskPct },
    battery: battPct !== null ? { pct: battPct, charging: isCharging } : null,
    hostname: os.hostname(),
    platform: process.arch,
  };
});

// ─── IPC: RAM Processes ────────────────────────────────────────────────────────

ipcMain.handle('get-ram-processes', async () => {
  const out = run('ps -Arcko pid,rss,comm 2>/dev/null').split('\n').slice(1);
  const procs = out
    .map(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) return null;
      const [pid, rss, ...rest] = parts;
      return { pid: parseInt(pid), mem: parseInt(rss) * 1024, name: rest.join(' ').split('/').pop() };
    })
    .filter(p => p && p.mem > 1024 * 1024 && p.name)
    .sort((a, b) => b.mem - a.mem)
    .slice(0, 10)
    .map(p => ({ ...p, memStr: bytesToHuman(p.mem) }));
  return procs;
});

// ─── IPC: Free RAM ─────────────────────────────────────────────────────────────

ipcMain.handle('free-ram', async () => {
  return new Promise((resolve) => {
    exec(
      `osascript -e 'do shell script "purge" with administrator privileges'`,
      { timeout: 30000 },
      (err) => {
        if (err) resolve({ success: false, error: err.message });
        else resolve({ success: true });
      }
    );
  });
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
