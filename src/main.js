// ─────────────────────────────────────────────────────────────
//  Soil — Electron Main Process
// ─────────────────────────────────────────────────────────────
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path  = require('path');
const fs    = require('fs');
const { SyncEngine }    = require('./sync-engine');
const { LatexCompiler }  = require('./latex-compiler');
const { ToolManager }    = require('./tool-manager');

// ── Globals ──────────────────────────────────────────────────
let mainWindow   = null;
let syncEngine   = null;
let compiler     = null;
let projectDir   = null;   // absolute path to the current project
let overleaf     = null;   // initialised after app ready (needs Electron session)
let toolManager  = null;   // manages bundled TinyTeX + MinGit
let ollamaProc   = null;   // child process if we spawned Ollama ourselves

// Path for recent-projects JSON
function recentsPath () { return path.join(app.getPath('userData'), 'recent-projects.json'); }
// Path for local-project-map JSON (overleaf project id → local dir)
function localMapPath () { return path.join(app.getPath('userData'), 'local-project-map.json'); }
// Path for Ollama preferences JSON
function ollamaPrefsPath () { return path.join(app.getPath('userData'), 'ollama-prefs.json'); }

/** Read Ollama preferences from disk */
function readOllamaPrefs () {
  try {
    if (fs.existsSync(ollamaPrefsPath())) return JSON.parse(fs.readFileSync(ollamaPrefsPath(), 'utf-8'));
  } catch { /* ignore */ }
  return { autoStart: 'ask', preferredModel: '', neverAsk: false };
}
/** Write Ollama preferences to disk */
function writeOllamaPrefs (prefs) {
  try { fs.writeFileSync(ollamaPrefsPath(), JSON.stringify(prefs, null, 2), 'utf-8'); } catch { /* ignore */ }
}

/** Read recent projects list from disk */
function readRecents () {
  try {
    if (fs.existsSync(recentsPath())) return JSON.parse(fs.readFileSync(recentsPath(), 'utf-8'));
  } catch { /* ignore */ }
  return [];
}
/** Write recent projects list to disk */
function writeRecents (arr) {
  try { fs.writeFileSync(recentsPath(), JSON.stringify(arr, null, 2), 'utf-8'); } catch { /* ignore */ }
}
/** Add/update a recent project entry */
function trackRecent (dir, name) {
  let recents = readRecents();
  recents = recents.filter(r => r.dir !== dir);
  recents.unshift({ name: name || path.basename(dir), dir, lastOpened: Date.now() });
  if (recents.length > 20) recents = recents.slice(0, 20);
  writeRecents(recents);
}

/** Read local-project-map (overleaf projectId → local dir) */
function readLocalMap () {
  try {
    if (fs.existsSync(localMapPath())) return JSON.parse(fs.readFileSync(localMapPath(), 'utf-8'));
  } catch { /* ignore */ }
  return {};
}
/** Write local-project-map */
function writeLocalMap (map) {
  try { fs.writeFileSync(localMapPath(), JSON.stringify(map, null, 2), 'utf-8'); } catch { /* ignore */ }
}
/** Record that an Overleaf project has been cloned locally */
function trackLocalProject (projectId, dir) {
  const map = readLocalMap();
  map[projectId] = dir;
  writeLocalMap(map);
}

// ── Window ───────────────────────────────────────────────────
function createWindow () {
  mainWindow = new BrowserWindow({
    width : 1400,
    height: 900,
    minWidth : 900,
    minHeight: 600,
    title: 'Soil',
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration : false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  mainWindow.maximize();

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Application menu ─────────────────────────────────────────
function buildMenu () {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Sign in to Overleaf…',
          click: () => mainWindow.webContents.send('menu:overleaf-login')
        },
        {
          label: 'Clone Overleaf Project…',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => mainWindow.webContents.send('menu:clone')
        },
        {
          label: 'Open Project Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => handleOpenProject()
        },
        { type: 'separator' },
        {
          label: 'Compile LaTeX',
          accelerator: 'CmdOrCtrl+B',
          click: () => mainWindow.webContents.send('menu:compile')
        },
        {
          label: 'Push + Commit',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow.webContents.send('menu:sync')
        },
        {
          label: 'Pull from Overleaf',
          click: () => mainWindow.webContents.send('menu:pull')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Soil on GitHub',
          click: () => shell.openExternal('https://github.com/soil-editor/soil')
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Helpers ──────────────────────────────────────────────────

/** Recursively list .tex files under `dir` */
function listTexFiles (dir, base = dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // skip hidden dirs and common build output
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      results = results.concat(listTexFiles(full, base));
    } else if (/\.(tex|bib|sty|cls|png|jpg|jpeg|gif|svg|eps|pdf)$/i.test(entry.name)) {
      results.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
  return results;
}

/** Send a log line to the renderer console */
function log (msg, level = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', { level, msg });
  }
}

// ── IPC Handlers ─────────────────────────────────────────────

async function handleOpenProject () {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Open LaTeX Project Folder'
  });
  if (canceled || !filePaths.length) return;
  await loadProject(filePaths[0]);
}

async function loadProject (dir) {
  projectDir = dir;

  // Tear down previous engines
  if (syncEngine) syncEngine.stop();
  if (compiler)   compiler.dispose();

  // Init sync engine (only if .git exists)
  const isGit = fs.existsSync(path.join(dir, '.git'));
  if (isGit) {
    syncEngine = new SyncEngine(dir, log, toolManager.gitBinary);
    syncEngine.setNotifyCallback(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('file-changed');
      }
    });
    syncEngine.setNetworkCallback((online) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('network-change', { online });
      }
    });
    syncEngine.start();
    log('Sync engine started — watching for changes');
  } else {
    syncEngine = null;
    log('No .git directory found — sync disabled', 'warn');
  }

  // Init compiler
  compiler = new LatexCompiler(dir, log, toolManager);

  // Gather file tree
  const files = listTexFiles(dir);
  mainWindow.webContents.send('project:opened', { dir, files, gitEnabled: isGit });
  log(`Project opened: ${dir}`);

  // Track in recent projects
  trackRecent(dir);
}

// ── App lifecycle ────────────────────────────────────────────
app.whenReady().then(async () => {
  // Initialise Overleaf API (requires Electron session to be ready)
  const { OverleafAPI } = require('./overleaf-api');
  overleaf = new OverleafAPI();

  // Initialise tool manager (TinyTeX + MinGit)
  toolManager = new ToolManager(log);
  toolManager.onProgress((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('setup:progress', data);
    }
  });

  buildMenu();
  createWindow();

  // After the renderer has loaded, check if tools need to be downloaded
  mainWindow.webContents.once('did-finish-load', async () => {
    if (!toolManager.isReady) {
      mainWindow.webContents.send('setup:start');
      try {
        await toolManager.ensureTools();
        mainWindow.webContents.send('setup:complete');
      } catch (err) {
        log(`Setup failed: ${err.message}`, 'error');
        mainWindow.webContents.send('setup:error', { error: err.message });
      }
    }
  });

  // ── IPC: Clone ──
  ipcMain.handle('clone-project', async (_e, gitUrl) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose destination folder for clone'
    });
    if (canceled || !filePaths.length) return { ok: false, error: 'Cancelled' };

    const dest = filePaths[0];

    // If it's an Overleaf URL, ensure we have a Git auth token
    let cloneUrl = gitUrl;
    if (gitUrl.includes('git.overleaf.com')) {
      if (!overleaf.gitToken) {
        log('No Git token — requesting from user…');
        mainWindow.webContents.send('request-git-token');
        return { ok: false, error: 'TOKEN_REQUIRED' };
      }
      cloneUrl = gitUrl.replace('https://git.overleaf.com', `https://git:${overleaf.gitToken}@git.overleaf.com`);
    }

    try {
      log(`Cloning ${gitUrl} → ${dest}…`);
      const git = require('simple-git')({ binary: toolManager.gitBinary });
      await git.clone(cloneUrl, dest);
      log('Clone complete');
      await loadProject(dest);
      return { ok: true, dir: dest };
    } catch (err) {
      log(`Clone failed: ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }
  });

  // ── IPC: Open project ──
  ipcMain.handle('open-project', async () => {
    await handleOpenProject();
  });

  // ── IPC: Read file ──
  ipcMain.handle('read-file', async (_e, relPath) => {
    if (!projectDir) return { ok: false, error: 'No project open' };
    const full = path.join(projectDir, relPath);
    try {
      const content = fs.readFileSync(full, 'utf-8');
      return { ok: true, content };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── IPC: Write file ──
  ipcMain.handle('write-file', async (_e, relPath, content) => {
    if (!projectDir) return { ok: false, error: 'No project open' };
    const full = path.join(projectDir, relPath);
    try {
      fs.writeFileSync(full, content, 'utf-8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── IPC: Compile ──
  ipcMain.handle('compile', async (_e, mainTex) => {
    if (!compiler) return { ok: false, error: 'No project open' };
    if (!toolManager.isReady) return { ok: false, error: 'Tools still setting up — please wait' };
    return compiler.compile(mainTex);
  });

  // ── IPC: Setup status ──
  ipcMain.handle('setup-status', () => ({ ready: toolManager.isReady }));
  ipcMain.handle('retry-setup', async () => {
    if (toolManager.isReady) return { ok: true };
    try {
      mainWindow.webContents.send('setup:start');
      await toolManager.ensureTools();
      mainWindow.webContents.send('setup:complete');
      return { ok: true };
    } catch (err) {
      mainWindow.webContents.send('setup:error', { error: err.message });
      return { ok: false, error: err.message };
    }
  });

  // ── IPC: Get PDF path ──
  ipcMain.handle('get-pdf-path', (_e, mainTex) => {
    if (!projectDir) return null;
    const base = mainTex ? mainTex.replace(/\.tex$/i, '') : 'main';
    const pdfPath = path.join(projectDir, `${base}.pdf`);
    if (fs.existsSync(pdfPath)) return pdfPath;
    // fallback: search for any pdf
    const pdfs = fs.readdirSync(projectDir).filter(f => f.endsWith('.pdf'));
    return pdfs.length ? path.join(projectDir, pdfs[0]) : null;
  });

  // ── IPC: Force sync (backward compat) ──
  ipcMain.handle('force-sync', async () => {
    if (!syncEngine) return { ok: false, error: 'Sync not active' };
    return syncEngine.commitAndPush();
  });

  // ── IPC: Push + Commit ──
  ipcMain.handle('push-commit', async () => {
    if (!syncEngine) return { ok: false, error: 'Sync not active' };
    return syncEngine.commitAndPush();
  });

  // ── IPC: Pull ──
  ipcMain.handle('pull', async () => {
    if (!syncEngine) return { ok: false, error: 'Sync not active' };
    return syncEngine.pull();
  });

  // ── IPC: Sync status ──
  ipcMain.handle('sync-status', () => {
    if (!syncEngine) return { active: false };
    return syncEngine.getStatus();
  });

  // ── IPC: Check network ──
  ipcMain.handle('check-network', async () => {
    if (!syncEngine) return { online: false };
    const online = await syncEngine._checkNetwork();
    return { online };
  });

  // ── IPC: Has unpushed commits ──
  ipcMain.handle('has-unpushed', async () => {
    if (!syncEngine) return { unpushed: false, count: 0 };
    return syncEngine.hasUnpushedCommits();
  });

  // ── IPC: Commit locally (offline) ──
  ipcMain.handle('commit-local', async () => {
    if (!syncEngine) return { ok: false, error: 'Sync not active' };
    return syncEngine.commitLocally();
  });

  // ── IPC: Get changed files ──
  ipcMain.handle('get-changed-files', async () => {
    if (!syncEngine) return [];
    return syncEngine.getChangedFiles();
  });

  // ── IPC: Get file diff ──
  ipcMain.handle('get-file-diff', async (_e, relPath) => {
    if (!syncEngine) return [];
    return syncEngine.getFileDiff(relPath);
  });

  // ── IPC: List files ──
  ipcMain.handle('list-files', () => {
    if (!projectDir) return [];
    return listTexFiles(projectDir);
  });

  // ── IPC: Create file ──
  ipcMain.handle('create-file', async (_e, relPath) => {
    if (!projectDir) return { ok: false, error: 'No project open' };
    const full = path.join(projectDir, relPath);
    try {
      // Create parent directories if needed
      const dir = path.dirname(full);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(full)) return { ok: false, error: 'File already exists' };
      fs.writeFileSync(full, '', 'utf-8');
      log(`Created file: ${relPath}`);
      return { ok: true, files: listTexFiles(projectDir) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── IPC: Upload files ──
  ipcMain.handle('upload-files', async () => {
    if (!projectDir) return { ok: false, error: 'No project open' };
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: 'Upload files to project',
      filters: [
        { name: 'LaTeX & Images', extensions: ['tex', 'bib', 'sty', 'cls', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'eps', 'pdf'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (canceled || !filePaths.length) return { ok: false, error: 'Cancelled' };
    try {
      for (const src of filePaths) {
        const name = path.basename(src);
        const dest = path.join(projectDir, name);
        fs.copyFileSync(src, dest);
        log(`Uploaded: ${name}`);
      }
      return { ok: true, files: listTexFiles(projectDir) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── IPC: Download PDF ──
  ipcMain.handle('download-pdf', async (_e, mainTex) => {
    if (!projectDir) return { ok: false, error: 'No project open' };
    const base = mainTex ? mainTex.replace(/\.tex$/i, '') : 'main';
    let pdfPath = path.join(projectDir, `${base}.pdf`);
    if (!fs.existsSync(pdfPath)) {
      // fallback: find any PDF
      const pdfs = fs.readdirSync(projectDir).filter(f => f.endsWith('.pdf'));
      if (!pdfs.length) return { ok: false, error: 'No PDF found — compile first' };
      pdfPath = path.join(projectDir, pdfs[0]);
    }
    const { canceled, filePath: dest } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save PDF',
      defaultPath: path.basename(pdfPath),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (canceled || !dest) return { ok: false, error: 'Cancelled' };
    try {
      fs.copyFileSync(pdfPath, dest);
      log(`PDF saved to ${dest}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── IPC: Overleaf login (opens real Overleaf page in a popup) ──
  ipcMain.handle('overleaf-login', async () => {
    log('Opening Overleaf login…');
    const result = await overleaf.login(mainWindow);
    if (result.ok) {
      const email = result.email || 'user';
      log(`Overleaf login successful (${email})`);
    } else {
      log(`Overleaf login cancelled or failed: ${result.error || ''}`, 'warn');
    }
    return result;
  });

  // ── IPC: Check persisted session (called on startup) ──
  ipcMain.handle('overleaf-check-session', async () => {
    return overleaf.checkSession();
  });

  // ── IPC: Overleaf list projects ──
  ipcMain.handle('overleaf-list-projects', async () => {
    return overleaf.listProjects();
  });

  // ── IPC: Overleaf logout (clears persistent cookies) ──
  ipcMain.handle('overleaf-logout', async () => {
    await overleaf.logout();
    log('Logged out of Overleaf (cookies cleared)');
    return { ok: true };
  });

  // ── IPC: Overleaf login status ──
  ipcMain.handle('overleaf-status', () => {
    return { loggedIn: overleaf.isLoggedIn, email: overleaf.email, displayName: overleaf.displayName };
  });

  // ── IPC: Clone from project browser (auto-picks folder) ──
  ipcMain.handle('clone-overleaf-project', async (_e, projectId, projectName) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: `Choose destination for "${projectName}"`
    });
    if (canceled || !filePaths.length) return { ok: false, error: 'Cancelled' };

    const safeName = projectName.replace(/[^a-zA-Z0-9_\- .]/g, '_');
    const dest = path.join(filePaths[0], safeName);

    // Fetch the Git auth token if we don't have one yet
    if (!overleaf.gitToken) {
      log('No Git token — requesting from user…');
      mainWindow.webContents.send('request-git-token');
      return { ok: false, error: 'TOKEN_REQUIRED' };
    }

    const gitUrl = overleaf.authenticatedGitUrl(projectId);

    try {
      log(`Cloning ${projectName} → ${dest}…`);
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      const git = require('simple-git')({ binary: toolManager.gitBinary });
      await git.clone(gitUrl, dest);
      log('Clone complete');
      trackLocalProject(projectId, dest);
      await loadProject(dest);
      return { ok: true, dir: dest };
    } catch (err) {
      log(`Clone failed: ${err.message}`, 'error');
      return { ok: false, error: err.message };
    }
  });

  // Forward sync events to renderer
  ipcMain.on('sync-engine-event', (_e, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync-event', payload);
    }
  });

  // ── IPC: Set Git token (user paste) ──
  ipcMain.handle('set-git-token', async (_e, token) => {
    return overleaf.setGitToken(token);
  });

  // ── IPC: Open Overleaf settings in external browser ──
  ipcMain.handle('open-overleaf-settings', async () => {
    shell.openExternal('https://www.overleaf.com/user/settings');
    return { ok: true };
  });

  // ── IPC: Get recent projects ──
  ipcMain.handle('get-recent-projects', () => {
    return readRecents();
  });

  // ── IPC: Open a project by directory path ──
  ipcMain.handle('open-project-dir', async (_e, dir) => {
    if (!fs.existsSync(dir)) {
      // Remove from recents if dir no longer exists
      let recents = readRecents();
      recents = recents.filter(r => r.dir !== dir);
      writeRecents(recents);
      return { ok: false, error: 'Directory no longer exists' };
    }
    await loadProject(dir);
    return { ok: true };
  });

  // ── IPC: Remove a single recent project entry ──
  ipcMain.handle('remove-recent-project', (_e, dir) => {
    let recents = readRecents();
    recents = recents.filter(r => r.dir !== dir);
    writeRecents(recents);
    return { ok: true, recents };
  });

  // ── IPC: Get masked Git token ──
  ipcMain.handle('get-git-token', () => {
    const token = overleaf.gitToken;
    if (!token) return { hasToken: false, masked: null };
    const masked = token.length > 8
      ? token.slice(0, 4) + '•'.repeat(token.length - 8) + token.slice(-4)
      : '•'.repeat(token.length);
    return { hasToken: true, masked };
  });

  // ── IPC: Clear Git token ──
  ipcMain.handle('clear-git-token', () => {
    overleaf._gitToken = null;
    overleaf._clearPersistedToken();
    return { ok: true };
  });

  // ── IPC: Get local project map ──
  ipcMain.handle('get-local-project-map', () => {
    const map = readLocalMap();
    // Verify each path still exists, prune stale entries
    let changed = false;
    for (const [id, dir] of Object.entries(map)) {
      if (!fs.existsSync(dir)) { delete map[id]; changed = true; }
    }
    if (changed) writeLocalMap(map);
    return map;
  });

  // ── IPC: Reset all data ──
  ipcMain.handle('reset-all-data', async () => {
    try {
      // Clear Overleaf session cookies + storage
      await overleaf.logout();
      // Clear recent projects
      try { fs.unlinkSync(recentsPath()); } catch { /* ignore */ }
      // Clear local project map
      try { fs.unlinkSync(localMapPath()); } catch { /* ignore */ }
      // Clear Ollama prefs
      try { fs.unlinkSync(ollamaPrefsPath()); } catch { /* ignore */ }
      // Clear Git token (already cleared by overleaf.logout, but be safe)
      overleaf._clearPersistedToken();
      log('All stored data has been cleared');
      // Reload the app
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.reload();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── IPC: Ollama ─────────────────────────────────────────────

  /** Check if Ollama is reachable */
  ipcMain.handle('ollama-check', async () => {
    try {
      const resp = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
      if (resp.ok) return { running: true };
      return { running: false };
    } catch {
      return { running: false };
    }
  });

  /** List available models */
  ipcMain.handle('ollama-list-models', async () => {
    try {
      const resp = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return { ok: false, error: 'Ollama not reachable' };
      const data = await resp.json();
      const models = (data.models || []).map(m => ({ name: m.name, size: m.size }));
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /** Send a chat request to Ollama (non-streaming, returns full response) */
  ipcMain.handle('ollama-chat', async (_e, { model, messages }) => {
    try {
      const resp = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false })
      });
      if (!resp.ok) {
        const text = await resp.text();
        return { ok: false, error: text || `HTTP ${resp.status}` };
      }
      const data = await resp.json();
      return { ok: true, content: data.message?.content || '' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /** Stream chat tokens to the renderer via events (supports cancellation) */
  let _streamAbort = null;
  ipcMain.handle('ollama-chat-stream', async (_e, { model, messages }) => {
    try {
      _streamAbort = new AbortController();
      const resp = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true }),
        signal: _streamAbort.signal
      });
      if (!resp.ok) {
        const text = await resp.text();
        _streamAbort = null;
        return { ok: false, error: text || `HTTP ${resp.status}` };
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line in buffer
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const json = JSON.parse(line);
              if (json.message?.content) {
                mainWindow.webContents.send('ollama-token', json.message.content);
              }
              if (json.done) {
                mainWindow.webContents.send('ollama-done');
              }
            } catch { /* ignore parse error in stream */ }
          }
        }
        // Process remaining buffer
        if (buffer.trim()) {
          try {
            const json = JSON.parse(buffer);
            if (json.message?.content) {
              mainWindow.webContents.send('ollama-token', json.message.content);
            }
          } catch { /* ignore */ }
        }
      } catch (readErr) {
        if (readErr.name === 'AbortError') {
          mainWindow.webContents.send('ollama-done');
          _streamAbort = null;
          return { ok: true, cancelled: true };
        }
        throw readErr;
      }
      mainWindow.webContents.send('ollama-done');
      _streamAbort = null;
      return { ok: true };
    } catch (err) {
      _streamAbort = null;
      if (err.name === 'AbortError') {
        mainWindow.webContents.send('ollama-done');
        return { ok: true, cancelled: true };
      }
      return { ok: false, error: err.message };
    }
  });

  /** Cancel an in-progress stream */
  ipcMain.handle('ollama-cancel-stream', () => {
    if (_streamAbort) {
      _streamAbort.abort();
      _streamAbort = null;
      return { ok: true };
    }
    return { ok: false, error: 'No active stream' };
  });

  /** Try to start Ollama (ollama serve) */
  ipcMain.handle('ollama-start', async () => {
    if (ollamaProc) return { ok: true, message: 'Already started by Soil' };
    try {
      const { spawn } = require('child_process');
      ollamaProc = spawn('ollama', ['serve'], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        shell: false,
        windowsHide: true
      });
      ollamaProc.unref();
      ollamaProc.on('error', () => { ollamaProc = null; });
      ollamaProc.on('exit', () => { ollamaProc = null; });
      // Give it a moment to start
      await new Promise(r => setTimeout(r, 2000));
      // Verify it's running
      try {
        const resp = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(3000) });
        if (resp.ok) return { ok: true };
      } catch { /* ignore */ }
      return { ok: false, error: 'Ollama process started but not responding' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /** Get Ollama preferences */
  ipcMain.handle('ollama-get-prefs', () => {
    return readOllamaPrefs();
  });

  /** Save Ollama preferences */
  ipcMain.handle('ollama-set-prefs', (_e, prefs) => {
    const current = readOllamaPrefs();
    const merged = { ...current, ...prefs };
    writeOllamaPrefs(merged);
    return { ok: true };
  });
});

app.on('window-all-closed', () => {
  if (syncEngine) syncEngine.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
