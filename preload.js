const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSystemInfo:     ()            => ipcRenderer.invoke('get-system-info'),
  getSettings:       ()            => ipcRenderer.invoke('get-settings'),
  setRefreshProfile: (profile)     => ipcRenderer.invoke('set-refresh-profile', profile),
  getRamProcesses:   ()            => ipcRenderer.invoke('get-ram-processes'),
  getCpuProcesses:   ()            => ipcRenderer.invoke('get-cpu-processes'),
  freeRAM:           ()            => ipcRenderer.invoke('free-ram'),
  deepCleanRAM:      (pids)        => ipcRenderer.invoke('deep-clean-ram', pids),
  quitProcess:       (pid)         => ipcRenderer.invoke('quit-process', pid),
  getDiskJunk:       ()            => ipcRenderer.invoke('get-disk-junk'),
  cleanDiskItem:     (id)          => ipcRenderer.invoke('clean-disk-item', id),
  listApps:          ()            => ipcRenderer.invoke('list-apps'),
  uninstallApp:      (data)        => ipcRenderer.invoke('uninstall-app', data),
  getStartupItems:   ()            => ipcRenderer.invoke('get-startup-items'),
  toggleStartupItem: (data)        => ipcRenderer.invoke('toggle-startup-item', data),
  clearPrivacy:      (itemId)      => ipcRenderer.invoke('clear-privacy', itemId),
  openActivityMonitor:()           => ipcRenderer.invoke('open-activity-monitor'),
  openInFinder:      (filePath)    => ipcRenderer.invoke('open-in-finder', filePath),
  getAppVersion:     ()            => ipcRenderer.invoke('get-app-version'),
  platform:          process.platform,
  arch:              process.arch,
});
