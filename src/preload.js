// ─────────────────────────────────────────────────────────────
//  Soil — Preload (Context Bridge)
//  Exposes a safe API surface to the renderer process.
// ─────────────────────────────────────────────────────────────
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('soil', {
  // ── Project ──
  cloneProject : (gitUrl) => ipcRenderer.invoke('clone-project', gitUrl),
  openProject  : ()       => ipcRenderer.invoke('open-project'),
  listFiles    : ()       => ipcRenderer.invoke('list-files'),

  // ── File I/O ──
  readFile    : (relPath)          => ipcRenderer.invoke('read-file', relPath),
  writeFile   : (relPath, content) => ipcRenderer.invoke('write-file', relPath, content),
  createFile  : (relPath)          => ipcRenderer.invoke('create-file', relPath),
  uploadFiles : ()                 => ipcRenderer.invoke('upload-files'),

  // ── Compiler ──
  compile     : (mainTex) => ipcRenderer.invoke('compile', mainTex),
  getPdfPath  : (mainTex) => ipcRenderer.invoke('get-pdf-path', mainTex),
  downloadPdf : (mainTex) => ipcRenderer.invoke('download-pdf', mainTex),

  // ── Sync ──
  forceSync  : ()         => ipcRenderer.invoke('force-sync'),
  pushCommit : ()         => ipcRenderer.invoke('push-commit'),
  pull       : ()         => ipcRenderer.invoke('pull'),
  syncStatus : ()         => ipcRenderer.invoke('sync-status'),
  checkNetwork    : ()          => ipcRenderer.invoke('check-network'),
  hasUnpushed     : ()          => ipcRenderer.invoke('has-unpushed'),
  commitLocal     : ()          => ipcRenderer.invoke('commit-local'),
  getChangedFiles : ()          => ipcRenderer.invoke('get-changed-files'),
  getFileDiff     : (relPath)   => ipcRenderer.invoke('get-file-diff', relPath),

  // ── Overleaf account ──
  overleafLogin        : ()          => ipcRenderer.invoke('overleaf-login'),
  overleafCheckSession : ()          => ipcRenderer.invoke('overleaf-check-session'),
  overleafProjects     : ()          => ipcRenderer.invoke('overleaf-list-projects'),
  overleafLogout       : ()          => ipcRenderer.invoke('overleaf-logout'),
  overleafStatus       : ()          => ipcRenderer.invoke('overleaf-status'),
  cloneOverleafProject : (id, name) => ipcRenderer.invoke('clone-overleaf-project', id, name),
  setGitToken          : (token)     => ipcRenderer.invoke('set-git-token', token),
  openOverleafSettings : ()          => ipcRenderer.invoke('open-overleaf-settings'),

  // ── Settings / Recent / Reset ──
  getRecentProjects    : ()          => ipcRenderer.invoke('get-recent-projects'),
  openProjectDir       : (dir)       => ipcRenderer.invoke('open-project-dir', dir),
  removeRecentProject  : (dir)       => ipcRenderer.invoke('remove-recent-project', dir),
  getGitToken          : ()          => ipcRenderer.invoke('get-git-token'),
  clearGitToken        : ()          => ipcRenderer.invoke('clear-git-token'),
  getLocalProjectMap   : ()          => ipcRenderer.invoke('get-local-project-map'),
  resetAllData         : ()          => ipcRenderer.invoke('reset-all-data'),

  // ── Events from main → renderer ──
  onProjectOpened : (cb) => ipcRenderer.on('project:opened', (_e, d) => cb(d)),
  onSyncEvent     : (cb) => ipcRenderer.on('sync-event',     (_e, d) => cb(d)),
  onLog           : (cb) => ipcRenderer.on('log',             (_e, d) => cb(d)),
  onRequestGitToken : (cb) => ipcRenderer.on('request-git-token', () => cb()),
  onMenuClone     : (cb) => ipcRenderer.on('menu:clone',      ()     => cb()),
  onMenuCompile   : (cb) => ipcRenderer.on('menu:compile',    ()     => cb()),
  onMenuSync      : (cb) => ipcRenderer.on('menu:sync',       ()     => cb()),
  onMenuPull      : (cb) => ipcRenderer.on('menu:pull',       ()     => cb()),
  onMenuOverleafLogin : (cb) => ipcRenderer.on('menu:overleaf-login', () => cb()),
  onFileChanged   : (cb) => ipcRenderer.on('file-changed',    ()     => cb()),
  onNetworkChange : (cb) => ipcRenderer.on('network-change',  (_e, d) => cb(d)),

  // ── Setup (first-launch tool download) ──
  setupStatus     : ()   => ipcRenderer.invoke('setup-status'),
  retrySetup      : ()   => ipcRenderer.invoke('retry-setup'),
  onSetupStart    : (cb) => ipcRenderer.on('setup:start',    ()     => cb()),
  onSetupProgress : (cb) => ipcRenderer.on('setup:progress', (_e, d) => cb(d)),
  onSetupComplete : (cb) => ipcRenderer.on('setup:complete', ()     => cb()),
  onSetupError    : (cb) => ipcRenderer.on('setup:error',    (_e, d) => cb(d)),
});
