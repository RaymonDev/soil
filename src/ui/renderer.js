// ─────────────────────────────────────────────────────────────
//  Soil — Renderer (Monaco + PDF.js + UI wiring)
// ─────────────────────────────────────────────────────────────

// ── State ────────────────────────────────────────────────────
let monacoEditor = null;
let currentFile  = null;
let projectFiles = [];
let pdfDoc       = null;
let pdfPage      = 1;
let pdfZoom      = 1.0;
let pendingSave  = null;
let pdfjsLib     = null;

// Auto-compile state
let autoCompileMode = 'normal';  // 'off', 'normal', 'fast'
let compileTimer    = null;
let _compileRunning = false;     // true while a compile IPC is in-flight
let _pushingNow     = false;     // true during push+commit (suppresses auto-compile)

// Monaco decoration IDs
let errorDecorationIds  = [];
let gutterDecorationIds = [];

const SAVE_DEBOUNCE = 800; // ms

// ── Theme ────────────────────────────────────────────────────
const $themeToggle = document.getElementById('theme-toggle');
let _currentTheme = localStorage.getItem('soil-theme') || 'dark';

function applyTheme (theme) {
  _currentTheme = theme;
  localStorage.setItem('soil-theme', theme);

  // Resolve effective theme
  let effective = theme;
  if (theme === 'system') {
    effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // Apply to DOM
  if (effective === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }

  // Update toggle buttons
  $themeToggle.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });

  // Switch Monaco theme
  if (typeof monaco !== 'undefined') {
    monaco.editor.setTheme(effective === 'light' ? 'soil-light' : 'soil-dark');
  }
}

// Listen for system preference changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (_currentTheme === 'system') applyTheme('system');
});

// Wire toggle buttons
$themeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('.theme-btn');
  if (!btn) return;
  applyTheme(btn.dataset.theme);
});

// Apply saved theme immediately
applyTheme(_currentTheme);

// ── DOM refs ─────────────────────────────────────────────────
const $welcome       = document.getElementById('welcome-screen');
const $editor        = document.getElementById('editor-screen');
const $btnClone      = document.getElementById('btn-clone');
const $btnOpen       = document.getElementById('btn-open');
const $cloneDialog   = document.getElementById('clone-dialog');
const $gitUrl        = document.getElementById('git-url');
const $btnCloneGo    = document.getElementById('btn-clone-go');
const $btnCloneCancel= document.getElementById('btn-clone-cancel');
const $cloneStatus   = document.getElementById('clone-status');
const $fileSelect    = document.getElementById('file-select');
const $fileTree      = document.getElementById('file-tree');
const $btnCompile    = document.getElementById('btn-compile');
const $btnPush       = document.getElementById('btn-push');
const $btnPull       = document.getElementById('btn-pull');
const $autoCompile   = document.getElementById('auto-compile-select');
const $syncIndicator = document.getElementById('sync-indicator');
const $compileInd    = document.getElementById('compile-indicator');
const $pdfCanvas     = document.getElementById('pdf-canvas');
const $pdfPlaceholder= document.getElementById('pdf-placeholder');
const $pdfPageInfo   = document.getElementById('pdf-page-info');
const $pdfZoomLevel  = document.getElementById('pdf-zoom-level');
const $logContent    = document.getElementById('log-content');
const $logHeader     = document.getElementById('log-header');
const $logPanel      = document.getElementById('log-panel');
const $btnNewFile    = document.getElementById('btn-new-file');
const $btnUploadFile = document.getElementById('btn-upload-file');
const $btnDownloadPdf= document.getElementById('btn-download-pdf');
const $btnBackProjects = document.getElementById('btn-back-projects');

// Git token dialog
const $gitTokenDialog  = document.getElementById('git-token-dialog');
const $gitTokenInput   = document.getElementById('git-token-input');
const $gitTokenStatus  = document.getElementById('git-token-status');
const $btnTokenCancel  = document.getElementById('btn-token-cancel');
const $btnTokenSettings = document.getElementById('btn-token-settings');
const $btnTokenSave    = document.getElementById('btn-token-save');

// Offline banner & back-online dialog
const $offlineBanner     = document.getElementById('offline-banner');
const $offlineUnpushed   = document.getElementById('offline-unpushed');
const $backOnlineDialog  = document.getElementById('back-online-dialog');
const $backOnlineCount   = document.getElementById('back-online-count');
const $btnOnlineSync     = document.getElementById('btn-online-sync');
const $btnOnlineLater    = document.getElementById('btn-online-later');

// Network state
let _isOnline    = true;   // assume online until proven otherwise
let _gitEnabled  = false;  // set when project opens
let _loggedIn    = false;  // Overleaf session active

// Overleaf login & project browser
const $btnOverleafLogin = document.getElementById('btn-overleaf-login');
const $loginDialog      = document.getElementById('login-dialog');
const $btnLoginGo       = document.getElementById('btn-login-go');
const $btnLoginCancel   = document.getElementById('btn-login-cancel');
const $loginStatus      = document.getElementById('login-status');
const $projectBrowser   = document.getElementById('project-browser');
const $projectSearch    = document.getElementById('project-search');
const $projectList      = document.getElementById('project-list');
const $projectStatus    = document.getElementById('project-status');
const $btnRefreshProjects = document.getElementById('btn-refresh-projects');
const $btnLogout        = document.getElementById('btn-logout');
const $userIndicator    = document.getElementById('user-indicator');
const $userEmail        = document.getElementById('user-email');
const $btnEditorLogout  = document.getElementById('btn-editor-logout');

// Cached project data for search filtering
let allProjects = [];

// Setup overlay refs
const $setupOverlay = document.getElementById('setup-overlay');
const $setupMessage = document.getElementById('setup-message');
const $setupBar     = document.getElementById('setup-progress-bar');
const $btnRetrySetup = document.getElementById('btn-retry-setup');

// Settings / Recent / Reset refs
const $btnSettings         = document.getElementById('btn-settings');
const $settingsDialog      = document.getElementById('settings-dialog');
const $settingsTokenDisplay = document.getElementById('settings-token-display');
const $settingsTokenRow    = document.getElementById('settings-token-row');
const $settingsTokenEdit   = document.getElementById('settings-token-edit');
const $settingsTokenInput  = document.getElementById('settings-token-input');
const $settingsTokenStatus = document.getElementById('settings-token-status');
const $btnSettingsTokenChange = document.getElementById('btn-settings-token-change');
const $btnSettingsTokenDelete = document.getElementById('btn-settings-token-delete');
const $btnSettingsTokenEditSave = document.getElementById('btn-settings-token-edit-save');
const $btnSettingsTokenEditCancel = document.getElementById('btn-settings-token-edit-cancel');
const $btnResetAll         = document.getElementById('btn-reset-all');
const $btnSettingsClose    = document.getElementById('btn-settings-close');
const $resetConfirmDialog  = document.getElementById('reset-confirm-dialog');
const $btnResetCancel      = document.getElementById('btn-reset-cancel');
const $btnResetConfirm     = document.getElementById('btn-reset-confirm');
const $recentProjects      = document.getElementById('recent-projects');
const $recentList          = document.getElementById('recent-list');

// AI / Ollama refs
const $btnAI               = document.getElementById('btn-ai');
const $aiPanel             = document.getElementById('ai-panel');
const $aiPanelClose        = document.getElementById('ai-panel-close');
const $aiModelSelect       = document.getElementById('ai-model-select');
const $aiMessages          = document.getElementById('ai-messages');
const $aiInput             = document.getElementById('ai-input');
const $aiSend              = document.getElementById('ai-send');
const $aiCancel            = document.getElementById('ai-cancel');
const $ollamaPromptDialog  = document.getElementById('ollama-prompt-dialog');
const $ollamaInstallDialog = document.getElementById('ollama-install-dialog');
const $btnOllamaYesOnce    = document.getElementById('btn-ollama-yes-once');
const $btnOllamaYesAlways  = document.getElementById('btn-ollama-yes-always');
const $btnOllamaNo         = document.getElementById('btn-ollama-no');
const $ollamaNeverAsk      = document.getElementById('ollama-never-ask');
const $btnOllamaGet        = document.getElementById('btn-ollama-get');
const $btnOllamaInstallClose = document.getElementById('btn-ollama-install-close');
const $settingsAiModel     = document.getElementById('settings-ai-model');
const $settingsAiStartup   = document.getElementById('settings-ai-startup');
const $settingsOllamaStatus = document.getElementById('settings-ollama-status');

// AI state
let _ollamaRunning  = false;
let _ollamaModels   = [];
let _ollamaPrefs    = { autoStart: 'ask', preferredModel: '', neverAsk: false };
let _aiStreaming     = false;      // true while streaming response
let _aiConversation = [];          // { role, content } array for chat context

// Compile errors panel
const $compileErrors = document.getElementById('compile-errors');
const $logTabs       = document.querySelectorAll('.log-tab');

// Local project map cache (overleaf project id → local dir)
let _localProjectMap = {};

// ── Helpers ──────────────────────────────────────────────────

function appendLog (msg, level = 'info') {
  const el = document.createElement('div');
  el.className = `log-line ${level}`;
  el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  $logContent.appendChild(el);
  $logContent.scrollTop = $logContent.scrollHeight;
}

function showScreen (name) {
  $welcome.classList.toggle('active', name === 'welcome');
  $editor.classList.toggle('active',  name === 'editor');
}

// ── Monaco setup ─────────────────────────────────────────────

function initMonaco () {
  return new Promise((resolve) => {
    require.config({
      paths: {
        vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs'
      }
    });

    require(['vs/editor/editor.main'], function () {
      // Register LaTeX language
      monaco.languages.register({ id: 'latex' });
      monaco.languages.setMonarchTokensProvider('latex', getLatexTokens());

      // Register Soil dark theme
      monaco.editor.defineTheme('soil-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: '', foreground: 'e0e0e0', background: '1a1a1a' },
          { token: 'comment', foreground: '555555', fontStyle: 'italic' },
          { token: 'keyword', foreground: '5c9fd6' },
          { token: 'string', foreground: '6dbf73' },
          { token: 'delimiter', foreground: '8a8a8a' },
          { token: 'delimiter.bracket', foreground: 'd4952a' },
          { token: 'delimiter.square', foreground: 'd4952a' },
        ],
        colors: {
          'editor.background': '#1a1a1a',
          'editor.foreground': '#e0e0e0',
          'editor.lineHighlightBackground': '#22222240',
          'editor.selectionBackground': '#33333380',
          'editor.inactiveSelectionBackground': '#2a2a2a40',
          'editorCursor.foreground': '#43a047',
          'editorWhitespace.foreground': '#2a2a2a',
          'editorIndentGuide.background': '#2a2a2a',
          'editorIndentGuide.activeBackground': '#3e3e3e',
          'editorLineNumber.foreground': '#555555',
          'editorLineNumber.activeForeground': '#8a8a8a',
          'editorGutter.background': '#1a1a1a',
          'editor.selectionHighlightBackground': '#43a04714',
          'editorBracketMatch.background': '#43a04718',
          'editorBracketMatch.border': '#43a04750',
          'scrollbar.shadow': '#00000000',
          'scrollbarSlider.background': '#3e3e3e50',
          'scrollbarSlider.hoverBackground': '#3e3e3e80',
          'scrollbarSlider.activeBackground': '#3e3e3ea0',
          'minimap.background': '#1a1a1a',
        }
      });

      // Register Soil light theme
      monaco.editor.defineTheme('soil-light', {
        base: 'vs',
        inherit: true,
        rules: [
          { token: '', foreground: '2c2c2c', background: 'f4f1ec' },
          { token: 'comment', foreground: '9a9894', fontStyle: 'italic' },
          { token: 'keyword', foreground: '2e7d32' },
          { token: 'string', foreground: '43a047' },
          { token: 'delimiter', foreground: '636360' },
          { token: 'delimiter.bracket', foreground: 'b5651d' },
          { token: 'delimiter.square', foreground: 'b5651d' },
        ],
        colors: {
          'editor.background': '#f4f1ec',
          'editor.foreground': '#2c2c2c',
          'editor.lineHighlightBackground': '#efe9e440',
          'editor.selectionBackground': '#43a04720',
          'editor.inactiveSelectionBackground': '#e6e1dc40',
          'editorCursor.foreground': '#43a047',
          'editorWhitespace.foreground': '#dad5d0',
          'editorIndentGuide.background': '#dad5d0',
          'editorIndentGuide.activeBackground': '#bdb8b3',
          'editorLineNumber.foreground': '#b5b0ab',
          'editorLineNumber.activeForeground': '#636360',
          'editorGutter.background': '#f4f1ec',
          'editor.selectionHighlightBackground': '#43a04710',
          'editorBracketMatch.background': '#43a04712',
          'editorBracketMatch.border': '#43a04740',
          'scrollbar.shadow': '#00000008',
          'scrollbarSlider.background': '#b5b0ab50',
          'scrollbarSlider.hoverBackground': '#b5b0ab80',
          'scrollbarSlider.activeBackground': '#b5b0aba0',
          'minimap.background': '#f4f1ec',
        }
      });

      // Determine initial theme
      const savedTheme = localStorage.getItem('soil-theme') || 'dark';
      let initEffective = savedTheme;
      if (savedTheme === 'system') {
        initEffective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }

      monacoEditor = monaco.editor.create(
        document.getElementById('monaco-container'),
        {
          value: '% Open or clone a project to start editing',
          language: 'latex',
          theme: initEffective === 'light' ? 'soil-light' : 'soil-dark',
          fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
          fontSize: 14,
          lineNumbers: 'on',
          wordWrap: 'on',
          minimap: { enabled: true },
          glyphMargin: true,
          automaticLayout: true,
          scrollBeyondLastLine: false,
          renderWhitespace: 'selection',
          bracketPairColorization: { enabled: true },
          tabSize: 2,
        }
      );

      // Save on content change (debounced) + auto-compile
      monacoEditor.onDidChangeModelContent(() => {
        scheduleSave();
        scheduleAutoCompile();
      });

      // Ctrl+S — save to disk only (no push)
      monacoEditor.addAction({
        id: 'soil-save',
        label: 'Save File',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: async () => {
          if (!currentFile) return;
          clearTimeout(pendingSave);
          const content = monacoEditor.getValue();
          const res = await window.soil.writeFile(currentFile, content);
          if (res.ok) appendLog(`Saved ${currentFile}`);
          else appendLog('Save error: ' + res.error, 'error');
        }
      });

      // Compile shortcut
      monacoEditor.addAction({
        id: 'soil-compile',
        label: 'Compile LaTeX',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB],
        run: () => doCompile()
      });

      // Push + Commit shortcut
      monacoEditor.addAction({
        id: 'soil-push',
        label: 'Push + Commit',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS],
        run: () => doPushCommit()
      });

      resolve();
    });
  });
}

/** Return a Monarch tokenizer for LaTeX */
function getLatexTokens () {
  return {
    defaultToken: '',
    tokenPostfix: '.tex',
    tokenizer: {
      root: [
        [/\\[a-zA-Z@]+/, 'keyword'],        // commands
        [/\\[{}$&#%_^~]/, 'keyword'],        // escaped specials
        [/%.*$/, 'comment'],                 // line comments
        [/\$\$/, { token: 'string', next: '@mathDisplay' }],
        [/\$/, { token: 'string', next: '@mathInline' }],
        [/[{}]/, 'delimiter.bracket'],
        [/\[|\]/, 'delimiter.square'],
        [/[&]/, 'delimiter'],
        [/\\\\/, 'keyword'],                 // line break
      ],
      mathInline: [
        [/[^$\\]+/, 'string'],
        [/\\[a-zA-Z@]+/, 'string'],
        [/\$/, { token: 'string', next: '@pop' }],
      ],
      mathDisplay: [
        [/[^$\\]+/, 'string'],
        [/\\[a-zA-Z@]+/, 'string'],
        [/\$\$/, { token: 'string', next: '@pop' }],
      ]
    }
  };
}

// ── PDF.js setup ─────────────────────────────────────────────

async function initPdfJs () {
  // PDF.js loaded as ES module from CDN
  try {
    pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
  } catch (e) {
    appendLog('PDF.js failed to load: ' + e.message, 'error');
  }
}

async function loadPdf (pdfPath) {
  if (!pdfjsLib || !pdfPath) return;
  try {
    // Read the file as an ArrayBuffer via fetch on the file:// protocol
    const data = await fetch(`file://${pdfPath.replace(/\\/g, '/')}`).then(r => r.arrayBuffer()).catch(() => null);
    if (!data) {
      // Fallback: read via Node through preload
      appendLog('Direct file fetch not available; using file-protocol.', 'warn');
      return;
    }
    pdfDoc  = await pdfjsLib.getDocument({ data }).promise;
    pdfPage = 1;
    $pdfPlaceholder.classList.add('hidden');
    renderPdfPage();
  } catch (err) {
    appendLog('PDF load error: ' + err.message, 'error');
  }
}

async function renderPdfPage () {
  if (!pdfDoc) return;
  const page   = await pdfDoc.getPage(pdfPage);
  const vp     = page.getViewport({ scale: pdfZoom * 1.5 });
  const canvas = $pdfCanvas;
  canvas.width  = vp.width;
  canvas.height = vp.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  $pdfPageInfo.textContent = `${pdfPage} / ${pdfDoc.numPages}`;
  $pdfZoomLevel.textContent = `${Math.round(pdfZoom * 100)}%`;
}

// ── File I/O ─────────────────────────────────────────────────

async function openFile (relPath) {
  if (!relPath) return;
  const res = await window.soil.readFile(relPath);
  if (!res.ok) { appendLog('Read error: ' + res.error, 'error'); return; }

  currentFile = relPath;
  const model = monacoEditor.getModel();
  monaco.editor.setModelLanguage(model, 'latex');
  model.setValue(res.content);
  monacoEditor.setScrollTop(0);

  // Refresh gutter decorations for the new file
  refreshGutterDecorations();

  // Highlight in file tree
  document.querySelectorAll('#file-tree li').forEach(li => {
    li.classList.toggle('active', li.dataset.path === relPath);
  });

  // Update selector
  $fileSelect.value = relPath;
}

function scheduleSave () {
  clearTimeout(pendingSave);
  pendingSave = setTimeout(async () => {
    if (!currentFile) return;
    const content = monacoEditor.getValue();
    const res = await window.soil.writeFile(currentFile, content);
    if (!res.ok) appendLog('Save error: ' + res.error, 'error');
  }, SAVE_DEBOUNCE);
}

// ── Compile ──────────────────────────────────────────────────

async function doCompile () {
  if (_pushingNow) return;  // never compile while pushing
  // Determine main tex file
  const mainTex = detectMainTex();
  $compileInd.textContent = 'Compiling\u2026';
  $compileInd.className = 'indicator syncing compiling';
  appendLog(`Compiling ${mainTex}\u2026`);

  _compileRunning = true;
  const result = await window.soil.compile(mainTex);
  _compileRunning = false;
  if (result.ok) {
    $compileInd.textContent = '✓ Compiled';
    $compileInd.className = 'indicator online';
    appendLog('Compilation succeeded');
    // Reload PDF
    const pdfPath = await window.soil.getPdfPath(mainTex);
    if (pdfPath) loadPdf(pdfPath);
  } else {
    $compileInd.textContent = '✗ Error';
    $compileInd.className = 'indicator error';
    appendLog('Compilation failed: ' + (result.error || ''), 'error');
    // Pulse AI button to hint it can help
    if (_ollamaRunning) {
      $btnAI.classList.add('ai-pulse');
      setTimeout(() => $btnAI.classList.remove('ai-pulse'), 8000);
    }
  }

  // Apply error/warning decorations to the editor
  applyCompileDecorations(result.errors || [], result.warnings || []);

  // Populate compile errors panel
  populateCompileErrors(result.errors || [], result.warnings || [], result.ok);
}

function detectMainTex () {
  // Prefer currently open file, then main.tex, then first .tex
  if (currentFile && currentFile.endsWith('.tex')) return currentFile;
  if (projectFiles.includes('main.tex')) return 'main.tex';
  const first = projectFiles.find(f => f.endsWith('.tex'));
  return first || 'main.tex';
}

// ── Auto-compile ─────────────────────────────────────────────

function scheduleAutoCompile () {
  clearTimeout(compileTimer);
  if (autoCompileMode === 'off' || _pushingNow) return;
  const delay = autoCompileMode === 'fast' ? 1500 : 5000;
  compileTimer = setTimeout(() => doCompile(), delay);
}

// ── Error / Warning decorations ──────────────────────────────

function applyCompileDecorations (errors, warnings) {
  if (!monacoEditor) return;
  const decorations = [];

  for (const err of errors) {
    if (!err.line) continue;
    if (currentFile && err.file && !currentFile.endsWith(err.file)) continue;
    decorations.push({
      range: new monaco.Range(err.line, 1, err.line, 1),
      options: {
        isWholeLine: true,
        className: 'line-error',
        inlineClassName: 'line-error-text',
        glyphMarginClassName: 'glyph-error',
        minimap: { color: '#e05550', position: monaco.editor.MinimapPosition.Inline },
        overviewRuler: { color: '#e05550', position: monaco.editor.OverviewRulerLane.Right },
        glyphMarginHoverMessage: { value: `**Error:** ${err.message}` },
        hoverMessage: { value: `**Error:** ${err.message}` }
      }
    });
  }

  for (const warn of warnings) {
    if (!warn.line) continue;
    if (currentFile && warn.file && !currentFile.endsWith(warn.file)) continue;
    decorations.push({
      range: new monaco.Range(warn.line, 1, warn.line, 1),
      options: {
        isWholeLine: true,
        className: 'line-warning',
        inlineClassName: 'line-warning-text',
        glyphMarginClassName: 'glyph-warning',
        minimap: { color: '#d4952a', position: monaco.editor.MinimapPosition.Inline },
        overviewRuler: { color: '#d4952a', position: monaco.editor.OverviewRulerLane.Right },
        glyphMarginHoverMessage: { value: `**Warning:** ${warn.message}` },
        hoverMessage: { value: `**Warning:** ${warn.message}` }
      }
    });
  }

  errorDecorationIds = monacoEditor.deltaDecorations(errorDecorationIds, decorations);
}

// ── Compile errors panel ─────────────────────────────────────

function populateCompileErrors (errors, warnings, ok) {
  $compileErrors.innerHTML = '';

  if (ok && errors.length === 0 && warnings.length === 0) {
    const el = document.createElement('div');
    el.className = 'compile-success';
    el.textContent = '✓ Compilation succeeded — no errors or warnings.';
    $compileErrors.appendChild(el);
    // Update the tab badge
    updateErrorTabBadge(0, 0);
    return;
  }

  if (!ok && errors.length === 0 && warnings.length === 0) {
    const el = document.createElement('div');
    el.className = 'compile-empty';
    el.textContent = 'Compilation failed but no structured errors were parsed from the log.';
    $compileErrors.appendChild(el);
    updateErrorTabBadge(0, 0);
    return;
  }

  // Show errors first, then warnings
  for (const err of errors) {
    $compileErrors.appendChild(createIssueRow('error', err));
  }
  for (const warn of warnings) {
    $compileErrors.appendChild(createIssueRow('warning', warn));
  }

  updateErrorTabBadge(errors.length, warnings.length);

  // Auto-switch to errors tab if there are errors and panel is collapsed
  if (errors.length > 0) {
    switchLogTab('errors');
    if ($logPanel.classList.contains('collapsed')) {
      $logPanel.classList.remove('collapsed');
      document.getElementById('log-toggle').textContent = '▾';
    }
  }
}

function createIssueRow (type, issue) {
  const row = document.createElement('div');
  row.className = 'compile-issue';

  const icon = document.createElement('span');
  icon.className = `issue-icon ${type}`;
  icon.textContent = type === 'error' ? '✗' : '⚠';

  const body = document.createElement('div');
  body.className = 'issue-body';

  const msg = document.createElement('div');
  msg.className = 'issue-message';
  msg.textContent = issue.message;

  body.appendChild(msg);

  if (issue.file || issue.line) {
    const loc = document.createElement('div');
    loc.className = 'issue-location';
    let locText = '';
    if (issue.file) locText += issue.file;
    if (issue.line) locText += (locText ? ':' : 'line ') + issue.line;
    loc.textContent = locText;
    body.appendChild(loc);
  }

  row.appendChild(icon);
  row.appendChild(body);

  // Click to jump to line in editor
  if (issue.line) {
    row.addEventListener('click', () => {
      if (monacoEditor) {
        monacoEditor.revealLineInCenter(issue.line);
        monacoEditor.setPosition({ lineNumber: issue.line, column: 1 });
        monacoEditor.focus();
      }
    });
  }

  return row;
}

function updateErrorTabBadge (errorCount, warnCount) {
  const tab = document.querySelector('.log-tab[data-tab="errors"]');
  if (!tab) return;
  if (errorCount > 0) {
    tab.textContent = `Errors & Warnings (${errorCount}E ${warnCount}W)`;
    tab.style.color = 'var(--error)';
  } else if (warnCount > 0) {
    tab.textContent = `Errors & Warnings (${warnCount}W)`;
    tab.style.color = 'var(--warn)';
  } else {
    tab.textContent = 'Errors & Warnings';
    tab.style.color = '';
  }
}

// ── Log panel tabs ───────────────────────────────────────────

function switchLogTab (tabName) {
  for (const t of $logTabs) {
    t.classList.toggle('active', t.dataset.tab === tabName);
  }
  $compileErrors.classList.toggle('active', tabName === 'errors');
  $logContent.classList.toggle('active', tabName === 'console');
  // Auto-scroll to bottom when switching tabs
  if (tabName === 'console') {
    requestAnimationFrame(() => { $logContent.scrollTop = $logContent.scrollHeight; });
  } else {
    requestAnimationFrame(() => { $compileErrors.scrollTop = $compileErrors.scrollHeight; });
  }
}

// ── Git gutter decorations ───────────────────────────────────

async function refreshGutterDecorations () {
  if (!monacoEditor || !currentFile) return;
  const hunks = await window.soil.getFileDiff(currentFile);
  const decorations = [];

  for (const hunk of hunks) {
    const color = hunk.type === 'added'  ? '#43a047'
               : hunk.type === 'modified' ? '#5c9fd6'
               : '#e05550';
    const css = hunk.type === 'added'  ? 'gutter-added'
              : hunk.type === 'modified' ? 'gutter-modified'
              : 'gutter-deleted';

    for (let line = hunk.startLine; line <= hunk.endLine; line++) {
      decorations.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: css,
          minimap: { color, position: monaco.editor.MinimapPosition.Gutter }
        }
      });
    }
  }

  gutterDecorationIds = monacoEditor.deltaDecorations(gutterDecorationIds, decorations);
}

// ── Create / Upload / Download ───────────────────────────────

async function doNewFile () {
  const name = await showNewFileDialog();
  if (!name) return;
  const relPath = name.trim();
  const res = await window.soil.createFile(relPath);
  if (res.ok) {
    populateFileTree(res.files);
    openFile(relPath);
    appendLog(`Created ${relPath}`);
  } else {
    appendLog('Create failed: ' + res.error, 'error');
  }
}

let _newFileResolve = null;

function showNewFileDialog () {
  return new Promise((resolve) => {
    _newFileResolve = resolve;
    const $dlg = document.getElementById('new-file-dialog');
    const $inp = document.getElementById('new-file-name');
    $inp.value = '';
    $dlg.classList.remove('hidden');
    setTimeout(() => $inp.focus(), 50);
  });
}

async function doUploadFiles () {
  const res = await window.soil.uploadFiles();
  if (res.ok) {
    populateFileTree(res.files);
    appendLog('Files uploaded');
  } else if (res.error !== 'Cancelled') {
    appendLog('Upload failed: ' + res.error, 'error');
  }
}

async function doDownloadPdf () {
  const mainTex = detectMainTex();
  const res = await window.soil.downloadPdf(mainTex);
  if (res.ok) {
    appendLog('PDF downloaded ✓');
  } else if (res.error !== 'Cancelled') {
    appendLog('Download PDF: ' + res.error, 'error');
  }
}

// ── Push + Commit (with confirmation dialog) ─────────────────

let _pushResolve = null;

function showPushDialog () {
  return new Promise(async (resolve) => {
    _pushResolve = resolve;
    const files = await window.soil.getChangedFiles();
    const $list = document.getElementById('push-changed-files');
    $list.innerHTML = '';

    if (files.length === 0) {
      $list.innerHTML = '<p class="no-changes">No changes to push</p>';
    } else {
      for (const f of files) {
        const div = document.createElement('div');
        div.className = `changed-file ${f.status}`;
        const prefix = f.status === 'new' ? '+' : f.status === 'deleted' ? '−' : '~';
        div.textContent = `${prefix} ${f.path}`;
        $list.appendChild(div);
      }
    }

    document.getElementById('push-dialog').classList.remove('hidden');
  });
}

async function doPushCommit () {
  // If offline, offer to commit locally instead
  if (!_isOnline) {
    appendLog('Offline — committing changes locally…');
    const res = await window.soil.commitLocal();
    if (res.ok) {
      if (res.nothingToCommit) {
        appendLog('Nothing to commit');
      } else {
        $syncIndicator.textContent = '● Committed locally';
        $syncIndicator.className = 'indicator offline';
        appendLog(`Committed ${res.committed} file(s) locally — will push when back online`);
        updateOfflineUnpushedCount();
      }
    } else {
      appendLog('Local commit error: ' + (res.error || ''), 'error');
    }
    return;
  }

  const confirmed = await showPushDialog();
  if (!confirmed) return;

  // ── Pause auto-compile and wait for any in-flight compile ──
  _pushingNow = true;
  clearTimeout(compileTimer);
  if (_compileRunning) {
    appendLog('Waiting for compile to finish before pushing…');
    while (_compileRunning) await new Promise(r => setTimeout(r, 200));
  }

  $syncIndicator.textContent = '● Pushing…';
  $syncIndicator.className = 'indicator syncing';
  appendLog('Push + Commit…');

  const result = await window.soil.pushCommit();
  _pushingNow = false;   // resume auto-compile
  if (result.ok) {
    if (result.nothingToCommit) {
      $syncIndicator.textContent = '● Nothing to push';
      $syncIndicator.className = 'indicator online';
      appendLog('Nothing to commit');
    } else if (result.offline) {
      $syncIndicator.textContent = '● Committed locally';
      $syncIndicator.className = 'indicator offline';
      appendLog('Committed locally (offline)');
    } else {
      $syncIndicator.textContent = '● Pushed ✓';
      $syncIndicator.className = 'indicator online';
      appendLog('Push + Commit complete ✓');
    }
    refreshGutterDecorations();
  } else {
    $syncIndicator.textContent = '● Error';
    $syncIndicator.className = 'indicator error';
    appendLog('Push + Commit failed: ' + (result.error || ''), 'error');
  }
}

async function doPull () {
  if (!_isOnline) {
    appendLog('Cannot pull — you are offline', 'warn');
    return;
  }
  $syncIndicator.textContent = '● Pulling…';
  $syncIndicator.className = 'indicator syncing';
  appendLog('Pulling from Overleaf…');

  const result = await window.soil.pull();
  if (result.ok) {
    $syncIndicator.textContent = '● Up to date';
    $syncIndicator.className = 'indicator online';
    appendLog('Pull complete ✓');
    await refreshFileTree();
    if (currentFile) openFile(currentFile);
    refreshGutterDecorations();
  } else {
    $syncIndicator.textContent = '● Error';
    $syncIndicator.className = 'indicator error';
    appendLog('Pull failed: ' + (result.error || ''), 'error');
  }
}

// ── Sync (backward compat) ──────────────────────────────────

async function doSync () {
  return doPushCommit();
}

// ── Offline / Online handling ────────────────────────────────

async function updateOfflineUnpushedCount () {
  try {
    const info = await window.soil.hasUnpushed();
    if (info.unpushed && info.count > 0) {
      $offlineUnpushed.textContent = `(${info.count} unpushed commit${info.count > 1 ? 's' : ''})`;
    } else {
      $offlineUnpushed.textContent = '';
    }
  } catch { $offlineUnpushed.textContent = ''; }
}

function setOfflineUI (offline) {
  _isOnline = !offline;
  if (offline) {
    $offlineBanner.classList.remove('hidden');
    $syncIndicator.textContent = '● Offline';
    $syncIndicator.className = 'indicator offline';
    $btnPush.title = 'Commit locally (offline)';
    $btnPull.disabled = true;
    $btnPull.style.opacity = '0.4';
    updateOfflineUnpushedCount();
  } else {
    $offlineBanner.classList.add('hidden');
    $btnPush.title = 'Push + Commit (Ctrl+Shift+S)';
    $btnPull.disabled = false;
    $btnPull.style.opacity = '';
    $syncIndicator.textContent = '● Online';
    $syncIndicator.className = 'indicator online';
  }
}

async function handleBackOnline () {
  setOfflineUI(false);
  appendLog('Network restored — you are back online');
  // Check for unpushed commits and show dialog
  try {
    const info = await window.soil.hasUnpushed();
    if (info.unpushed && info.count > 0) {
      showBackOnlineDialog(info.count);
    }
  } catch { /* ignore */ }
}

function showBackOnlineDialog (count) {
  $backOnlineCount.textContent = count;
  $backOnlineDialog.classList.remove('hidden');
  appendLog(`${count} unsynced commit(s) — sync dialog shown`);
}

function handleGoneOffline () {
  setOfflineUI(true);
  appendLog('Network lost — working offline. All changes saved locally.', 'warn');
}

async function pollSyncStatus () {
  try {
    const status = await window.soil.syncStatus();
    if (!status.active) return;
    // Don’t override the offline/online banner indicator while idle
    if (status.syncing) {
      $syncIndicator.textContent = '● Syncing…';
      $syncIndicator.className = 'indicator syncing';
    } else if (status.error) {
      $syncIndicator.textContent = '● Error';
      $syncIndicator.className = 'indicator error';
    } else if (status.online === false) {
      $syncIndicator.textContent = '● Offline';
      $syncIndicator.className = 'indicator offline';
    } else {
      $syncIndicator.textContent = '● Online';
      $syncIndicator.className = 'indicator online';
    }
  } catch { /* ignore */ }
}

// ── File tree ────────────────────────────────────────────────

function populateFileTree (files) {
  projectFiles = files;
  $fileTree.innerHTML = '';
  $fileSelect.innerHTML = '';

  files.forEach(f => {
    // Sidebar list
    const li = document.createElement('li');
    li.textContent = f;
    li.dataset.path = f;
    li.addEventListener('click', () => openFile(f));
    $fileTree.appendChild(li);

    // Dropdown
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    $fileSelect.appendChild(opt);
  });
}

async function refreshFileTree () {
  const files = await window.soil.listFiles();
  populateFileTree(files);
}

// ── Gutter (resize) ─────────────────────────────────────────

function initGutter () {
  const gutter   = document.getElementById('gutter');
  const editorP  = document.getElementById('editor-pane');
  const pdfP     = document.getElementById('pdf-pane');
  let dragging   = false;
  let startX     = 0;
  let startEditorW = 0;

  function getAvailableWidth () {
    const container = document.getElementById('split-container');
    const sidebar   = document.getElementById('sidebar');
    const aiPanel   = document.getElementById('ai-panel');
    let used = sidebar.getBoundingClientRect().width + gutter.offsetWidth;
    if (aiPanel && !aiPanel.classList.contains('hidden')) {
      used += aiPanel.getBoundingClientRect().width;
    }
    return container.getBoundingClientRect().width - used;
  }

  gutter.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startEditorW = editorP.getBoundingClientRect().width;
    gutter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const available = getAvailableWidth();
    const delta = e.clientX - startX;
    const newEditorW = Math.max(200, Math.min(available - 200, startEditorW + delta));
    editorP.style.flex = `0 0 ${newEditorW}px`;
    pdfP.style.flex    = `0 0 ${available - newEditorW}px`;
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    gutter.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // Double-click gutter → reset to 50/50
  gutter.addEventListener('dblclick', () => {
    editorP.style.flex = '1';
    pdfP.style.flex    = '1';
  });
}

// ── Log panel toggle ─────────────────────────────────────────

function initLogToggle () {
  // Chevron toggles collapse
  document.getElementById('log-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    $logPanel.classList.toggle('collapsed');
    document.getElementById('log-toggle').textContent =
      $logPanel.classList.contains('collapsed') ? '▸' : '▾';
  });

  // Tab switching
  for (const tab of $logTabs) {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      switchLogTab(tab.dataset.tab);
      // Expand panel if collapsed
      if ($logPanel.classList.contains('collapsed')) {
        $logPanel.classList.remove('collapsed');
        document.getElementById('log-toggle').textContent = '▾';
      }
    });
  }

  // Drag-resize from top edge of log panel
  let dragging = false;
  let startY = 0;
  let startH = 0;
  const $resizeHandle = document.getElementById('log-resize-handle');

  $resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = $logPanel.offsetHeight;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    const newH = Math.max(60, Math.min(startH + delta, window.innerHeight * 0.6));
    $logPanel.style.height = newH + 'px';
    $logPanel.classList.remove('collapsed');
    document.getElementById('log-toggle').textContent = '▾';
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // Double-click resize handle → reset to default height
  $resizeHandle.addEventListener('dblclick', () => {
    $logPanel.style.height = '';
    $logPanel.classList.remove('collapsed');
    document.getElementById('log-toggle').textContent = '▾';
  });
}

// ── Event wiring ─────────────────────────────────────────────

/** Check if user is logged in to Overleaf (multiple signals for robustness) */
function isOverleafLoggedIn () {
  return _loggedIn || allProjects.length > 0 || $btnOverleafLogin.textContent.includes('\u2713');
}

/** Hide all welcome dialogs */
function hideAllDialogs () {
  $loginDialog.classList.add('hidden');
  $cloneDialog.classList.add('hidden');
  $projectBrowser.classList.add('hidden');
  $loginStatus.textContent = '';
  $cloneStatus.textContent = '';
  $projectStatus.textContent = '';
}

// ── Recent projects ──────────────────────────────────────────

async function loadRecentProjects () {
  const recents = await window.soil.getRecentProjects();
  if (!recents || recents.length === 0) {
    $recentProjects.classList.add('hidden');
    return;
  }
  $recentProjects.classList.remove('hidden');
  renderRecentList(recents);
}

function renderRecentList (recents) {
  $recentList.innerHTML = '';
  for (const r of recents) {
    const item = document.createElement('div');
    item.className = 'recent-item';
    item.title = r.dir;
    item.addEventListener('click', () => openRecentProject(r.dir));

    const name = document.createElement('span');
    name.className = 'recent-item-name';
    name.textContent = r.name;

    const pathEl = document.createElement('span');
    pathEl.className = 'recent-item-path';
    pathEl.textContent = r.dir;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'recent-item-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove from recent';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const result = await window.soil.removeRecentProject(r.dir);
      if (result.ok) renderRecentList(result.recents);
      if (!result.recents || result.recents.length === 0) $recentProjects.classList.add('hidden');
    });

    item.appendChild(name);
    item.appendChild(pathEl);
    item.appendChild(removeBtn);
    $recentList.appendChild(item);
  }
}

async function openRecentProject (dir) {
  const result = await window.soil.openProjectDir(dir);
  if (!result.ok) {
    appendLog(`Could not open project: ${result.error}`, 'warn');
    // Refresh recents (stale entry removed on the backend)
    loadRecentProjects();
  }
}

// ── Ollama / AI helpers ──────────────────────────────────────

/** Check if Ollama is reachable and populate models */
async function ollamaDetect () {
  const check = await window.soil.ollamaCheck();
  _ollamaRunning = check.running;
  if (_ollamaRunning) {
    await ollamaLoadModels();
  }
  return _ollamaRunning;
}

/** Refresh the model list from Ollama */
async function ollamaLoadModels () {
  const result = await window.soil.ollamaListModels();
  if (result.ok) {
    _ollamaModels = result.models;
    populateModelSelects();
  }
}

/** Populate both the panel and settings model dropdowns */
function populateModelSelects () {
  const selects = [$aiModelSelect, $settingsAiModel];
  for (const sel of selects) {
    const prev = sel.value;
    sel.innerHTML = '';
    if (_ollamaModels.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = _ollamaRunning ? 'No models installed' : 'Not connected';
      sel.appendChild(opt);
    } else {
      for (const m of _ollamaModels) {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = m.name;
        sel.appendChild(opt);
      }
      // Restore preferred model if available
      if (_ollamaPrefs.preferredModel && _ollamaModels.some(m => m.name === _ollamaPrefs.preferredModel)) {
        sel.value = _ollamaPrefs.preferredModel;
      } else if (prev && _ollamaModels.some(m => m.name === prev)) {
        sel.value = prev;
      }
    }
  }
  // Sync initial value
  if ($aiModelSelect.value && $aiModelSelect.value !== $settingsAiModel.value) {
    $settingsAiModel.value = $aiModelSelect.value;
  }
}

/** Handle the AI button click — detect, prompt, or open panel */
async function handleAIClick () {
  if (_aiStreaming) return; // ignore while streaming

  if (!_ollamaRunning) {
    const running = await ollamaDetect();
    if (running) {
      openAIPanel();
      return;
    }

    // Check prefs
    _ollamaPrefs = await window.soil.ollamaGetPrefs();

    if (_ollamaPrefs.neverAsk) {
      // User said never ask — show install dialog (they might have uninstalled)
      $ollamaInstallDialog.classList.remove('hidden');
      return;
    }

    if (_ollamaPrefs.autoStart === 'always') {
      // Try to start automatically (silently)
      const startResult = await window.soil.ollamaStart();
      if (startResult.ok) {
        _ollamaRunning = true;
        await ollamaLoadModels();
        openAIPanel();
        $btnAI.classList.add('ai-active');
        appendLog('Ollama started automatically');
        return;
      }
      // Start failed — Ollama may have been uninstalled
      $ollamaInstallDialog.classList.remove('hidden');
      return;
    }

    // autoStart is 'ask' — show the prompt, don't start yet
    $ollamaPromptDialog.classList.remove('hidden');
    return;
  }

  // Already running — toggle panel
  toggleAIPanel();
}

function openAIPanel () {
  $aiPanel.classList.remove('hidden');
  $btnAI.classList.add('ai-active');
  $aiInput.focus();
}

function closeAIPanel () {
  $aiPanel.classList.add('hidden');
  $btnAI.classList.remove('ai-active');
}

function toggleAIPanel () {
  if ($aiPanel.classList.contains('hidden')) {
    openAIPanel();
  } else {
    closeAIPanel();
  }
}

/** Build the system prompt — unified assistant */
function buildSystemPrompt () {
  return 'You are an expert LaTeX assistant embedded in the Soil editor. Be concise and precise. When providing LaTeX code, wrap it in fenced code blocks using ```latex ... ```. Use plain text for explanations. You can help fix compilation errors, generate LaTeX code, explain concepts, and assist with formatting, equations, tables, bibliographies, and document structure. When the user shares code or errors from their document, focus on identifying the issue and providing corrected code.';
}

/** Get context (current file content + last compile errors) for "fix" mode */
function getEditorContext () {
  const context = {};
  if (monacoEditor) {
    context.source = monacoEditor.getValue();
    context.fileName = currentFile || 'unknown.tex';
  }
  // Grab the last error from the compile indicator if available
  const compileText = $compileInd.textContent;
  if (compileText && compileText.includes('error')) {
    context.compileStatus = compileText;
  }
  // Grab last error log lines
  const logLines = $logContent.querySelectorAll('.log-line.error, .log-line.warn');
  if (logLines.length > 0) {
    const recentErrors = [];
    const startIdx = Math.max(0, logLines.length - 10);
    for (let i = startIdx; i < logLines.length; i++) {
      recentErrors.push(logLines[i].textContent);
    }
    context.recentErrors = recentErrors.join('\n');
  }
  return context;
}

/** Render markdown-like text into an element (code blocks, inline code, bold, italic) */
function renderAIMarkdown (el, text) {
  // Split text into segments: fenced code blocks vs. everything else
  const parts = text.split(/(```[\s\S]*?```|```[\s\S]*$)/g);
  el.innerHTML = '';

  for (const part of parts) {
    if (!part) continue;

    // Fenced code block (complete or in-progress)
    const codeMatch = part.match(/^```(\w*)\n?([\s\S]*?)(?:```)?$/);
    if (part.startsWith('```')) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      const lang = codeMatch ? codeMatch[1] : '';
      let content = codeMatch ? codeMatch[2] : part.slice(3);
      // Remove trailing ``` if present
      if (content.endsWith('```')) content = content.slice(0, -3);
      // Remove trailing newline
      if (content.endsWith('\n')) content = content.slice(0, -1);
      if (lang) pre.dataset.lang = lang;
      code.textContent = content;
      pre.appendChild(code);
      el.appendChild(pre);
      continue;
    }

    // Regular text — handle inline code, bold, italic
    const span = document.createElement('span');
    // Process inline formatting
    let html = escapeHtml(part);
    // Inline code: `...`
    html = html.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');
    // Bold: **...**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic: *...*
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Line breaks
    html = html.replace(/\n/g, '<br>');
    span.innerHTML = html;
    el.appendChild(span);
  }
}

/** Escape HTML special characters */
function escapeHtml (str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Send a message in the AI panel */
async function sendAIMessage () {
  const text = $aiInput.value.trim();
  if (!text || _aiStreaming) return;
  if (!_ollamaRunning) { handleAIClick(); return; }

  const model = $aiModelSelect.value;
  if (!model) {
    addAIMessage('error', 'No model selected. Install a model in Ollama first (e.g. `ollama pull llama3`).');
    return;
  }

  // Build user message — always include editor context if available
  let userContent = text;
  const ctx = getEditorContext();
  if (ctx.recentErrors) {
    userContent += `\n\nRECENT COMPILE LOG:\n${ctx.recentErrors}`;
  }
  if (ctx.source) {
    const src = ctx.source.length > 8000 ? ctx.source.slice(0, 8000) + '\n... (truncated)' : ctx.source;
    userContent += `\n\nCURRENT SOURCE (${ctx.fileName}):\n${src}`;
  }

  // Show user message in panel
  addAIMessage('user', text);
  $aiInput.value = '';

  // Build messages array — always keep conversation history
  const systemMsg = { role: 'system', content: buildSystemPrompt() };
  _aiConversation.push({ role: 'user', content: userContent });
  // Keep last 20 messages to avoid context overflow
  if (_aiConversation.length > 20) {
    _aiConversation = _aiConversation.slice(-20);
  }

  const messages = [systemMsg, ..._aiConversation];

  // Show thinking indicator and switch to cancel button
  const thinkingEl = addAIMessage('thinking', 'Thinking');
  _aiStreaming = true;
  $aiSend.classList.add('hidden');
  $aiCancel.classList.remove('hidden');

  // Stream the response
  let fullResponse = '';
  const responseEl = document.createElement('div');
  responseEl.className = 'ai-msg assistant';

  const tokenHandler = (token) => {
    if (thinkingEl.parentNode) thinkingEl.remove();
    fullResponse += token;
    renderAIMarkdown(responseEl, fullResponse);
    if (!responseEl.parentNode) {
      $aiMessages.appendChild(responseEl);
    }
    $aiMessages.scrollTop = $aiMessages.scrollHeight;
  };

  const doneHandler = () => {
    if (thinkingEl.parentNode) thinkingEl.remove();
    // Final render with formatting
    if (fullResponse) {
      renderAIMarkdown(responseEl, fullResponse);
    }
    _aiStreaming = false;
    $aiSend.classList.remove('hidden');
    $aiCancel.classList.add('hidden');
    if (fullResponse) {
      _aiConversation.push({ role: 'assistant', content: fullResponse });
    }
    // Clean up listeners
    window.soil.onOllamaToken(() => {});
    window.soil.onOllamaDone(() => {});
  };

  window.soil.onOllamaToken(tokenHandler);
  window.soil.onOllamaDone(doneHandler);

  const result = await window.soil.ollamaChatStream({ model, messages });
  if (!result.ok) {
    if (thinkingEl.parentNode) thinkingEl.remove();
    addAIMessage('error', `Error: ${result.error}`);
    _aiStreaming = false;
    $aiSend.classList.remove('hidden');
    $aiCancel.classList.add('hidden');
  }
}

/** Cancel the current AI generation */
async function cancelAIGeneration () {
  if (!_aiStreaming) return;
  await window.soil.ollamaCancelStream();
}

/** Add a message bubble to the AI panel */
function addAIMessage (type, text) {
  // Remove welcome message if present
  const welcome = $aiMessages.querySelector('.ai-welcome-msg');
  if (welcome) welcome.remove();

  const el = document.createElement('div');
  el.className = `ai-msg ${type}`;
  el.textContent = text;
  $aiMessages.appendChild(el);
  $aiMessages.scrollTop = $aiMessages.scrollHeight;
  return el;
}

/** Wire all AI-related events */
function wireAIEvents () {
  // AI button
  $btnAI.addEventListener('click', handleAIClick);

  // Panel close
  $aiPanelClose.addEventListener('click', closeAIPanel);

  // Send button
  $aiSend.addEventListener('click', sendAIMessage);

  // Cancel button — stop generation
  $aiCancel.addEventListener('click', cancelAIGeneration);

  // Enter to send (Shift+Enter for newline), Escape to cancel
  $aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAIMessage();
    }
    if (e.key === 'Escape' && _aiStreaming) {
      e.preventDefault();
      cancelAIGeneration();
    }
  });

  // Model select in panel — sync to prefs
  $aiModelSelect.addEventListener('change', () => {
    const model = $aiModelSelect.value;
    $settingsAiModel.value = model;
    window.soil.ollamaSetPrefs({ preferredModel: model });
    _ollamaPrefs.preferredModel = model;
  });

  // Ollama prompt dialog buttons
  $btnOllamaYesOnce.addEventListener('click', async () => {
    $ollamaPromptDialog.classList.add('hidden');
    if ($ollamaNeverAsk.checked) {
      await window.soil.ollamaSetPrefs({ neverAsk: false, autoStart: 'ask' });
    }
    appendLog('Starting Ollama…');
    const startResult = await window.soil.ollamaStart();
    if (startResult.ok) {
      _ollamaRunning = true;
      await ollamaLoadModels();
      openAIPanel();
      $btnAI.classList.add('ai-active');
      appendLog('Ollama connected');
    } else {
      $ollamaInstallDialog.classList.remove('hidden');
    }
  });

  $btnOllamaYesAlways.addEventListener('click', async () => {
    $ollamaPromptDialog.classList.add('hidden');
    await window.soil.ollamaSetPrefs({ autoStart: 'always', neverAsk: false });
    _ollamaPrefs.autoStart = 'always';
    appendLog('Starting Ollama…');
    const startResult = await window.soil.ollamaStart();
    if (startResult.ok) {
      _ollamaRunning = true;
      await ollamaLoadModels();
      openAIPanel();
      $btnAI.classList.add('ai-active');
      appendLog('Ollama connected — will auto-start on future launches');
    } else {
      $ollamaInstallDialog.classList.remove('hidden');
    }
  });

  $btnOllamaNo.addEventListener('click', async () => {
    $ollamaPromptDialog.classList.add('hidden');
    if ($ollamaNeverAsk.checked) {
      await window.soil.ollamaSetPrefs({ neverAsk: true });
      _ollamaPrefs.neverAsk = true;
    }
  });

  // Install dialog
  $btnOllamaGet.addEventListener('click', () => {
    // Open Ollama website in the system browser via a simple anchor trick
    const a = document.createElement('a');
    a.href = 'https://ollama.com/download';
    a.target = '_blank';
    a.rel = 'noopener';
    a.click();
    $ollamaInstallDialog.classList.add('hidden');
  });
  $btnOllamaInstallClose.addEventListener('click', () => {
    $ollamaInstallDialog.classList.add('hidden');
  });
}

// ── Settings dialog helpers ──────────────────────────────────

async function openSettingsDialog () {
  // Fetch current token state
  const tokenInfo = await window.soil.getGitToken();
  if (tokenInfo.hasToken) {
    $settingsTokenDisplay.textContent = tokenInfo.masked;
    $btnSettingsTokenDelete.classList.remove('hidden');
  } else {
    $settingsTokenDisplay.textContent = 'No token saved';
    $btnSettingsTokenDelete.classList.add('hidden');
  }
  $settingsTokenEdit.classList.add('hidden');
  $settingsTokenRow.classList.remove('hidden');
  $settingsTokenInput.value = '';
  $settingsTokenStatus.textContent = '';

  // Load Ollama prefs & status into settings
  _ollamaPrefs = await window.soil.ollamaGetPrefs();
  $settingsAiStartup.value = _ollamaPrefs.autoStart || 'ask';
  if (_ollamaRunning) {
    $settingsOllamaStatus.textContent = '● Connected';
    $settingsOllamaStatus.style.color = 'var(--success)';
    await ollamaLoadModels();
  } else {
    $settingsOllamaStatus.textContent = '○ Not running';
    $settingsOllamaStatus.style.color = 'var(--t3)';
    populateModelSelects();
  }

  $settingsDialog.classList.remove('hidden');
}

function closeSettingsDialog () {
  $settingsDialog.classList.add('hidden');
}

function wireEvents () {
  // ── Welcome screen buttons ──
  $btnOverleafLogin.addEventListener('click', () => {
    hideAllDialogs();
    if (isOverleafLoggedIn()) {
      // Already logged in — show project browser directly
      $projectBrowser.classList.remove('hidden');
      loadOverleafProjects();
    } else {
      $loginDialog.classList.remove('hidden');
    }
  });

  $btnClone.addEventListener('click', () => {
    hideAllDialogs();
    $cloneDialog.classList.remove('hidden');
    $gitUrl.focus();
  });

  $btnOpen.addEventListener('click', () => window.soil.openProject());

  // ── Back to projects ──
  $btnBackProjects.addEventListener('click', () => {
    showScreen('welcome');
    // If logged in, auto-show project browser
    if (isOverleafLoggedIn()) {
      hideAllDialogs();
      $projectBrowser.classList.remove('hidden');
      loadOverleafProjects();
    }
  });

  // ── Login dialog ──
  $btnLoginCancel.addEventListener('click', () => {
    $loginDialog.classList.add('hidden');
    $loginStatus.textContent = '';
    // If already logged in, restore project browser
    if (isOverleafLoggedIn()) {
      $projectBrowser.classList.remove('hidden');
    }
  });

  $btnLoginGo.addEventListener('click', doOverleafLogin);

  // ── Project browser ──
  $btnRefreshProjects.addEventListener('click', loadOverleafProjects);
  $btnLogout.addEventListener('click', async () => {
    await window.soil.overleafLogout();
    hideAllDialogs();
    _loggedIn = false;
    $btnOverleafLogin.textContent = 'Sign in to Overleaf';
    $userIndicator.classList.add('hidden');
    allProjects = [];
    appendLog('Signed out of Overleaf');
  });

  // Editor toolbar logout
  $btnEditorLogout.addEventListener('click', async () => {
    await window.soil.overleafLogout();
    _loggedIn = false;
    $btnOverleafLogin.textContent = 'Sign in to Overleaf';
    $userIndicator.classList.add('hidden');
    allProjects = [];
    appendLog('Signed out of Overleaf');
  });
  $projectSearch.addEventListener('input', () => renderProjectList(allProjects));

  // ── Clone dialog ──
  $btnCloneCancel.addEventListener('click', () => {
    $cloneDialog.classList.add('hidden');
    $cloneStatus.textContent = '';
  });

  $btnCloneGo.addEventListener('click', async () => {
    const url = $gitUrl.value.trim();
    if (!url) { $cloneStatus.textContent = 'Please enter a Git URL'; $cloneStatus.className = 'status-msg error'; return; }
    $cloneStatus.textContent = 'Cloning…';
    $cloneStatus.className = 'status-msg';
    $btnCloneGo.disabled = true;

    const result = await window.soil.cloneProject(url);
    $btnCloneGo.disabled = false;
    if (result.ok) {
      $cloneStatus.textContent = 'Done!';
      $cloneStatus.className = 'status-msg success';
    } else if (result.error === 'TOKEN_REQUIRED') {
      $cloneStatus.textContent = 'Git token needed — paste it in the dialog';
      $cloneStatus.className = 'status-msg';
    } else {
      $cloneStatus.textContent = result.error || 'Clone failed';
      $cloneStatus.className = 'status-msg error';
    }
  });

  // ── Toolbar ──
  $btnCompile.addEventListener('click', doCompile);
  $btnPush.addEventListener('click', doPushCommit);
  $btnPull.addEventListener('click', doPull);
  $autoCompile.addEventListener('change', (e) => { autoCompileMode = e.target.value; });
  $fileSelect.addEventListener('change', (e) => openFile(e.target.value));

  // ── Sidebar: New file / Upload ──
  $btnNewFile.addEventListener('click', doNewFile);
  $btnUploadFile.addEventListener('click', doUploadFiles);

  // ── PDF: Download ──
  $btnDownloadPdf.addEventListener('click', doDownloadPdf);

  // ── Settings dialog ──
  $btnSettings.addEventListener('click', openSettingsDialog);
  $btnSettingsClose.addEventListener('click', closeSettingsDialog);
  // Close settings when clicking overlay backdrop
  $settingsDialog.addEventListener('click', (e) => {
    if (e.target === $settingsDialog) closeSettingsDialog();
  });

  // Token: Change
  $btnSettingsTokenChange.addEventListener('click', () => {
    $settingsTokenRow.classList.add('hidden');
    $settingsTokenEdit.classList.remove('hidden');
    $settingsTokenInput.focus();
  });
  $btnSettingsTokenEditCancel.addEventListener('click', () => {
    $settingsTokenEdit.classList.add('hidden');
    $settingsTokenRow.classList.remove('hidden');
    $settingsTokenInput.value = '';
    $settingsTokenStatus.textContent = '';
  });
  $btnSettingsTokenEditSave.addEventListener('click', async () => {
    const token = $settingsTokenInput.value.trim();
    if (!token) {
      $settingsTokenStatus.textContent = 'Please paste a token';
      $settingsTokenStatus.className = 'status-msg error';
      return;
    }
    const result = await window.soil.setGitToken(token);
    if (result.ok) {
      $settingsTokenStatus.textContent = 'Token saved';
      $settingsTokenStatus.className = 'status-msg success';
      $settingsTokenInput.value = '';
      // Refresh display
      const info = await window.soil.getGitToken();
      $settingsTokenDisplay.textContent = info.hasToken ? info.masked : 'No token saved';
      $btnSettingsTokenDelete.classList.toggle('hidden', !info.hasToken);
      $settingsTokenEdit.classList.add('hidden');
      $settingsTokenRow.classList.remove('hidden');
      setTimeout(() => { $settingsTokenStatus.textContent = ''; }, 2000);
    } else {
      $settingsTokenStatus.textContent = result.error || 'Failed';
      $settingsTokenStatus.className = 'status-msg error';
    }
  });

  // Token: Delete
  $btnSettingsTokenDelete.addEventListener('click', async () => {
    await window.soil.clearGitToken();
    $settingsTokenDisplay.textContent = 'No token saved';
    $btnSettingsTokenDelete.classList.add('hidden');
    $settingsTokenStatus.textContent = 'Token deleted';
    $settingsTokenStatus.className = 'status-msg';
    setTimeout(() => { $settingsTokenStatus.textContent = ''; }, 2000);
  });

  // Reset All Data — double confirmation
  $btnResetAll.addEventListener('click', () => {
    $resetConfirmDialog.classList.remove('hidden');
  });
  $btnResetCancel.addEventListener('click', () => {
    $resetConfirmDialog.classList.add('hidden');
  });
  $resetConfirmDialog.addEventListener('click', (e) => {
    if (e.target === $resetConfirmDialog) $resetConfirmDialog.classList.add('hidden');
  });
  $btnResetConfirm.addEventListener('click', async () => {
    $btnResetConfirm.disabled = true;
    $btnResetConfirm.textContent = 'Resetting…';
    await window.soil.resetAllData();
    // App will reload via main.js, but hide dialog in case something is slow
    $resetConfirmDialog.classList.add('hidden');
    $settingsDialog.classList.add('hidden');
  });

  // ── Git token dialog ──
  $btnTokenCancel.addEventListener('click', () => {
    $gitTokenDialog.classList.add('hidden');
    $gitTokenInput.value = '';
    $gitTokenStatus.textContent = '';
    // If logged in, still show project browser (they can add token later)
    if (_loggedIn) {
      hideAllDialogs();
      $projectBrowser.classList.remove('hidden');
      loadOverleafProjects();
    }
  });

  $btnTokenSettings.addEventListener('click', () => {
    window.soil.openOverleafSettings();
  });

  $btnTokenSave.addEventListener('click', async () => {
    const token = $gitTokenInput.value.trim();
    if (!token) {
      $gitTokenStatus.textContent = 'Please paste your token';
      $gitTokenStatus.className = 'status-msg error';
      return;
    }
    $btnTokenSave.disabled = true;
    $gitTokenStatus.textContent = 'Saving…';
    $gitTokenStatus.className = 'status-msg';
    const result = await window.soil.setGitToken(token);
    $btnTokenSave.disabled = false;
    if (result.ok) {
      $gitTokenStatus.textContent = 'Token saved! Opening projects…';
      $gitTokenStatus.className = 'status-msg success';
      $gitTokenInput.value = '';
      setTimeout(() => {
        $gitTokenDialog.classList.add('hidden');
        // If logged in, open project browser automatically
        if (_loggedIn) {
          hideAllDialogs();
          $projectBrowser.classList.remove('hidden');
          loadOverleafProjects();
        }
      }, 800);
    } else {
      $gitTokenStatus.textContent = result.error || 'Failed to save token';
      $gitTokenStatus.className = 'status-msg error';
    }
  });

  // Listen for token request from main process
  window.soil.onRequestGitToken(() => {
    $gitTokenDialog.classList.remove('hidden');
    $gitTokenInput.value = '';
    $gitTokenStatus.textContent = '';
    $gitTokenInput.focus();
  });

  // ── Back-online sync dialog ──
  $btnOnlineSync.addEventListener('click', () => {
    $backOnlineDialog.classList.add('hidden');
    doPushCommit();
  });
  $btnOnlineLater.addEventListener('click', () => {
    $backOnlineDialog.classList.add('hidden');
    appendLog('Sync postponed — push when you\'re ready');
  });

  // ── Push dialog ──
  document.getElementById('btn-push-confirm').addEventListener('click', () => {
    document.getElementById('push-dialog').classList.add('hidden');
    if (_pushResolve) _pushResolve(true);
    _pushResolve = null;
  });
  document.getElementById('btn-push-cancel').addEventListener('click', () => {
    document.getElementById('push-dialog').classList.add('hidden');
    if (_pushResolve) _pushResolve(false);
    _pushResolve = null;
  });

  // ── New-file dialog ──
  const $newFileDlg = document.getElementById('new-file-dialog');
  const $newFileInp = document.getElementById('new-file-name');
  const confirmNewFile = () => {
    $newFileDlg.classList.add('hidden');
    const val = $newFileInp.value.trim();
    if (_newFileResolve) _newFileResolve(val || null);
    _newFileResolve = null;
  };
  const cancelNewFile = () => {
    $newFileDlg.classList.add('hidden');
    if (_newFileResolve) _newFileResolve(null);
    _newFileResolve = null;
  };
  document.getElementById('btn-newfile-create').addEventListener('click', confirmNewFile);
  document.getElementById('btn-newfile-cancel').addEventListener('click', cancelNewFile);
  $newFileInp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmNewFile();
    if (e.key === 'Escape') cancelNewFile();
  });

  // ── PDF controls ──
  document.getElementById('pdf-prev').addEventListener('click', () => {
    if (pdfDoc && pdfPage > 1) { pdfPage--; renderPdfPage(); }
  });
  document.getElementById('pdf-next').addEventListener('click', () => {
    if (pdfDoc && pdfPage < pdfDoc.numPages) { pdfPage++; renderPdfPage(); }
  });
  document.getElementById('pdf-zoom-in').addEventListener('click', () => {
    pdfZoom = Math.min(3, pdfZoom + 0.2); renderPdfPage();
  });
  document.getElementById('pdf-zoom-out').addEventListener('click', () => {
    pdfZoom = Math.max(0.4, pdfZoom - 0.2); renderPdfPage();
  });

  // ── IPC from main process ──
  window.soil.onProjectOpened(async (data) => {
    showScreen('editor');
    populateFileTree(data.files);
    _gitEnabled = data.gitEnabled;
    appendLog('Project loaded: ' + data.dir);
    if (data.gitEnabled) {
      // Check initial network state
      try {
        const net = await window.soil.checkNetwork();
        _isOnline = net.online;
        if (!net.online) {
          setOfflineUI(true);
        } else {
          $syncIndicator.textContent = '● Online';
          $syncIndicator.className = 'indicator online';
          // Check for unpushed commits from a previous offline session
          const info = await window.soil.hasUnpushed();
          if (info.unpushed && info.count > 0) {
            showBackOnlineDialog(info.count);
            appendLog(`${info.count} unpushed commit(s) from a previous session`);
          }
        }
      } catch {
        $syncIndicator.textContent = '● Online';
        $syncIndicator.className = 'indicator online';
      }
    } else {
      $syncIndicator.textContent = '● No Git';
      $syncIndicator.className = 'indicator offline';
    }
    // Auto-open main.tex or first file
    const first = data.files.includes('main.tex') ? 'main.tex' : data.files[0];
    if (first) openFile(first);

    // Auto-compile on project open
    setTimeout(() => doCompile(), 500);

    // Initial gutter decorations
    setTimeout(() => refreshGutterDecorations(), 800);
  });

  window.soil.onLog((data) => appendLog(data.msg, data.level));

  // Refresh gutter when files change on disk
  window.soil.onFileChanged(() => {
    setTimeout(() => refreshGutterDecorations(), 300);
  });

  // Network status changes from sync engine
  window.soil.onNetworkChange((data) => {
    if (!_gitEnabled) return;
    if (data.online) {
      handleBackOnline();
    } else {
      handleGoneOffline();
    }
  });
  window.soil.onMenuClone(() => {
    showScreen('welcome');
    hideAllDialogs();
    $cloneDialog.classList.remove('hidden');
  });
  window.soil.onMenuCompile(() => doCompile());
  window.soil.onMenuSync(() => doPushCommit());
  window.soil.onMenuPull(() => doPull());
  window.soil.onMenuOverleafLogin(() => {
    showScreen('welcome');
    hideAllDialogs();
    if (isOverleafLoggedIn()) {
      $projectBrowser.classList.remove('hidden');
      loadOverleafProjects();
    } else {
      $loginDialog.classList.remove('hidden');
    }
  });

  // ── Settings AI listeners ──
  $settingsAiModel.addEventListener('change', () => {
    const model = $settingsAiModel.value;
    $aiModelSelect.value = model;
    window.soil.ollamaSetPrefs({ preferredModel: model });
    _ollamaPrefs.preferredModel = model;
  });
  $settingsAiStartup.addEventListener('change', () => {
    const val = $settingsAiStartup.value;
    window.soil.ollamaSetPrefs({ autoStart: val, neverAsk: val === 'never' });
    _ollamaPrefs.autoStart = val;
    _ollamaPrefs.neverAsk = val === 'never';
  });

  // ── AI events ──
  wireAIEvents();
}

// ── Overleaf login flow ──────────────────────────────────────

async function doOverleafLogin () {
  $loginStatus.textContent = 'Opening Overleaf login…';
  $loginStatus.className = 'status-msg';
  $btnLoginGo.disabled = true;

  const result = await window.soil.overleafLogin();
  $btnLoginGo.disabled = false;

  if (result.ok) {
    $loginStatus.textContent = '';
    $loginDialog.classList.add('hidden');
    _loggedIn = true;
    const label = result.displayName || result.email || 'Overleaf';
    $btnOverleafLogin.textContent = '✓ Signed in';
    $userIndicator.classList.remove('hidden');
    $userEmail.textContent = label;
    appendLog(`Signed in to Overleaf as ${label}`);

    // Check if user already has a Git token before opening projects
    const tokenInfo = await window.soil.getGitToken();
    if (!tokenInfo.hasToken) {
      // Prompt for Git token right after login
      hideAllDialogs();
      $gitTokenDialog.classList.remove('hidden');
      $gitTokenInput.value = '';
      $gitTokenStatus.textContent = 'To sync with Overleaf, Soil needs your Git authentication token.';
      $gitTokenStatus.className = 'status-msg';
      $gitTokenInput.focus();
    } else {
      // Already have a token — go straight to project browser
      hideAllDialogs();
      $projectBrowser.classList.remove('hidden');
      loadOverleafProjects();
    }
  } else {
    $loginStatus.textContent = result.error || 'Login failed';
    $loginStatus.className = 'status-msg error';
  }
}

// ── Overleaf project browser ─────────────────────────────────

async function loadOverleafProjects () {
  $projectList.innerHTML = '<p class="project-list-empty">Loading projects…</p>';
  $projectStatus.textContent = '';

  // Fetch local project map in parallel with Overleaf projects
  const [result, localMap] = await Promise.all([
    window.soil.overleafProjects(),
    window.soil.getLocalProjectMap()
  ]);
  _localProjectMap = localMap || {};

  if (!result.ok) {
    $projectList.innerHTML = '<p class="project-list-empty">Failed to load projects</p>';
    $projectStatus.textContent = result.error || 'Error';
    $projectStatus.className = 'status-msg error';
    return;
  }

  allProjects = (result.projects || []).filter(p => !p.archived);
  // Sort by last updated (newest first)
  allProjects.sort((a, b) => {
    const da = a.lastUpdated ? new Date(a.lastUpdated) : 0;
    const db = b.lastUpdated ? new Date(b.lastUpdated) : 0;
    return db - da;
  });

  renderProjectList(allProjects);
  appendLog(`Loaded ${allProjects.length} project(s) from Overleaf`);
}

function renderProjectList (projects) {
  const query = ($projectSearch.value || '').toLowerCase().trim();
  const filtered = query
    ? projects.filter(p => p.name.toLowerCase().includes(query))
    : projects;

  $projectList.innerHTML = '';

  if (filtered.length === 0) {
    $projectList.innerHTML = '<p class="project-list-empty">No projects found</p>';
    return;
  }

  for (const p of filtered) {
    const item = document.createElement('div');
    item.className = 'project-item';

    const info = document.createElement('div');
    info.className = 'project-item-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'project-item-name';
    nameRow.textContent = p.name;

    // Check if project is cloned locally
    const localDir = _localProjectMap[p.id];
    if (localDir) {
      const badge = document.createElement('span');
      badge.className = 'project-local-badge';
      badge.textContent = '● local';
      nameRow.appendChild(badge);
    }
    info.appendChild(nameRow);

    const meta = document.createElement('div');
    meta.className = 'project-item-meta';
    const parts = [];
    if (p.lastUpdated) {
      const d = new Date(p.lastUpdated);
      parts.push(d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }));
    }
    if (p.ownerName) parts.push(p.ownerName);
    meta.textContent = parts.join(' · ') || 'No date';
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'project-item-actions';

    if (localDir) {
      // Project already cloned — show Open local + Re-clone
      const openBtn = document.createElement('button');
      openBtn.className = 'btn small local';
      openBtn.textContent = 'Open local';
      openBtn.addEventListener('click', () => {
        window.soil.openProjectDir(localDir);
      });

      const recloneBtn = document.createElement('button');
      recloneBtn.className = 'btn small';
      recloneBtn.textContent = 'Re-clone';
      recloneBtn.addEventListener('click', () => cloneFromBrowser(p));

      actions.appendChild(openBtn);
      actions.appendChild(recloneBtn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn small primary';
      btn.textContent = 'Clone';
      btn.addEventListener('click', () => cloneFromBrowser(p));
      actions.appendChild(btn);
    }

    item.appendChild(info);
    item.appendChild(actions);
    $projectList.appendChild(item);
  }
}

async function cloneFromBrowser (project) {
  $projectStatus.textContent = `Cloning "${project.name}"…`;
  $projectStatus.className = 'status-msg';
  appendLog(`Cloning project: ${project.name} (${project.id})`);

  const result = await window.soil.cloneOverleafProject(project.id, project.name);
  if (result.ok) {
    $projectStatus.textContent = 'Done!';
    $projectStatus.className = 'status-msg success';
  } else if (result.error === 'TOKEN_REQUIRED') {
    $projectStatus.textContent = 'Git token needed — paste it in the dialog';
    $projectStatus.className = 'status-msg';
  } else {
    $projectStatus.textContent = result.error || 'Clone failed';
    $projectStatus.className = 'status-msg error';
  }
}

// ── Setup events (first-launch tool download) ───────────────

function wireSetup () {
  window.soil.onSetupStart(() => {
    $setupOverlay.classList.remove('hidden');
    $btnRetrySetup.classList.add('hidden');
    $setupMessage.style.color = '';
  });

  window.soil.onSetupProgress((data) => {
    $setupMessage.textContent = data.message;
    if (data.percent >= 0) {
      $setupBar.style.width = `${data.percent}%`;
    }
  });

  window.soil.onSetupComplete(() => {
    $setupOverlay.classList.add('hidden');
    appendLog('Tools setup complete');
  });

  window.soil.onSetupError((data) => {
    $setupMessage.textContent = `Setup failed: ${data.error}`;
    $setupMessage.style.color = 'var(--error)';
    $btnRetrySetup.classList.remove('hidden');
  });

  $btnRetrySetup.addEventListener('click', async () => {
    $btnRetrySetup.classList.add('hidden');
    $setupMessage.style.color = '';
    $setupMessage.textContent = 'Retrying…';
    $setupBar.style.width = '0%';
    await window.soil.retrySetup();
  });
}

// ── Bootstrap ────────────────────────────────────────────────

(async function main () {
  showScreen('welcome');
  await Promise.all([initMonaco(), initPdfJs()]);
  initGutter();
  initLogToggle();
  wireEvents();
  wireSetup();
  appendLog('Soil is ready');

  // Load recent projects on welcome screen
  loadRecentProjects();

  // Check if session is still valid from a previous run
  // (cookies persisted by Chromium in the named partition)
  try {
    const session = await window.soil.overleafCheckSession();
    if (session.loggedIn) {
      const label = session.displayName || session.email || 'Overleaf user';
      _loggedIn = true;
      $btnOverleafLogin.textContent = `✓ ${label}`;
      $userIndicator.classList.remove('hidden');
      $userEmail.textContent = label;
      appendLog(`Session restored — signed in as ${label}`);
      // Auto-open project browser
      hideAllDialogs();
      $projectBrowser.classList.remove('hidden');
      loadOverleafProjects();
    }
  } catch { /* offline or first run */ }

  // Poll sync status periodically
  setInterval(pollSyncStatus, 5000);

  // ── Ollama auto-detection ──
  try {
    _ollamaPrefs = await window.soil.ollamaGetPrefs();
    const running = await ollamaDetect();
    if (running) {
      $btnAI.classList.add('ai-active');
      appendLog(`Ollama detected — ${_ollamaModels.length} model(s) available`);
    } else if (_ollamaPrefs.autoStart === 'always' && !_ollamaPrefs.neverAsk) {
      // Try to auto-start
      const startResult = await window.soil.ollamaStart();
      if (startResult.ok) {
        _ollamaRunning = true;
        await ollamaLoadModels();
        $btnAI.classList.add('ai-active');
        appendLog('Ollama auto-started');
      }
    }
  } catch { /* Ollama not available — that's fine */ }
})();
