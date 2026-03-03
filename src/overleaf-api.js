// ─────────────────────────────────────────────────────────────
//  Soil — Overleaf API Client
//  Authentication via embedded Electron BrowserWindow (real
//  Overleaf login page — reCAPTCHA works natively).
//  Session cookies are persisted by Chromium via a named
//  partition so the user stays logged in across restarts.
// ─────────────────────────────────────────────────────────────
const { BrowserWindow, session } = require('electron');
const { net }  = require('electron');
const { URL }  = require('url');
const fs   = require('fs');
const pathMod = require('path');

const OVERLEAF_BASE    = 'https://www.overleaf.com';
const GIT_BASE         = 'https://git.overleaf.com';
const SESSION_PARTITION = 'persist:overleaf';   // Chromium stores cookies on disk

/** Path to the persisted token file inside Electron's userData folder */
function tokenFilePath () {
  const { app } = require('electron');
  return pathMod.join(app.getPath('userData'), '.soil-git-token');
}

class OverleafAPI {
  constructor () {
    this._email       = null;
    this._displayName = null;
    this._loggedIn    = false;
    this._gitToken    = null;
    this._loadPersistedToken();
  }

  /** Try to load a previously saved Git token from disk */
  _loadPersistedToken () {
    try {
      const fp = tokenFilePath();
      if (fs.existsSync(fp)) {
        const t = fs.readFileSync(fp, 'utf-8').trim();
        if (t.length >= 16) {
          this._gitToken = t;
          console.log('[SOIL] Loaded persisted Git token');
        }
      }
    } catch { /* ignore */ }
  }

  /** Save the current Git token to disk so it survives restarts */
  _persistToken () {
    try {
      if (this._gitToken) {
        fs.writeFileSync(tokenFilePath(), this._gitToken, 'utf-8');
        console.log('[SOIL] Git token persisted to disk');
      }
    } catch (err) {
      console.error('[SOIL] Failed to persist Git token:', err.message);
    }
  }

  /** Remove the persisted token file */
  _clearPersistedToken () {
    try { fs.unlinkSync(tokenFilePath()); } catch { /* ignore */ }
  }

  // ── Public API ────────────────────────────────────────────

  get isLoggedIn ()   { return this._loggedIn; }
  get email ()        { return this._email; }
  get displayName ()  { return this._displayName; }

  /** Return the persistent Electron session used for Overleaf */
  get session () {
    return session.fromPartition(SESSION_PARTITION);
  }

  // ────────────────────────────────────────────────────────────
  //  LOGIN — opens the real Overleaf login page in a popup
  //  window.  The user authenticates normally (reCAPTCHA, SSO,
  //  2FA all work).  We watch for navigation to /project which
  //  signals a successful login, then close the popup.
  // ────────────────────────────────────────────────────────────

  login (parentWindow) {
    return new Promise((resolve) => {
      const authWin = new BrowserWindow({
        width: 520,
        height: 720,
        parent: parentWindow || undefined,
        modal: true,
        show: false,
        title: 'Sign in to Overleaf',
        webPreferences: {
          partition: SESSION_PARTITION,   // persistent cookie store
          nodeIntegration: false,
          contextIsolation: true,
        }
      });

      authWin.setMenuBarVisibility(false);

      // Load the real Overleaf login page
      authWin.loadURL(`${OVERLEAF_BASE}/login`);
      authWin.once('ready-to-show', () => authWin.show());

      let resolved = false;

      // Watch every navigation — when the user lands on /project
      // (the dashboard), login succeeded.
      const checkUrl = (url) => {
        try {
          const u = new URL(url);
          if (u.pathname === '/project' || u.pathname.startsWith('/project')) {
            if (!resolved) {
              resolved = true;
              this._loggedIn = true;
              // Try to grab the email from cookies or page
              this._extractEmail(authWin).finally(() => {
                authWin.close();
                resolve({ ok: true, email: this._email, displayName: this._displayName });
              });
            }
          }
        } catch { /* ignore parse errors */ }
      };

      authWin.webContents.on('did-navigate',           (_e, url) => checkUrl(url));
      authWin.webContents.on('did-navigate-in-page',    (_e, url) => checkUrl(url));
      authWin.webContents.on('did-redirect-navigation', (_e, url) => checkUrl(url));

      // If the user closes the window without logging in
      authWin.on('closed', () => {
        if (!resolved) {
          resolved = true;
          resolve({ ok: false, error: 'Login window closed' });
        }
      });
    });
  }

  // ────────────────────────────────────────────────────────────
  //  CHECK SESSION — ping /project with existing cookies to see
  //  if the user is already authenticated (persistent session).
  // ────────────────────────────────────────────────────────────

  async checkSession () {
    try {
      // Use a quick hidden window to see if Overleaf redirects us to /login
      const ok = await new Promise((resolve) => {
        const win = new BrowserWindow({
          width: 800, height: 600, show: false,
          webPreferences: {
            partition: SESSION_PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
          }
        });

        const timer = setTimeout(() => { try { win.close(); } catch {} resolve(false); }, 15000);

        win.webContents.on('did-finish-load', () => {
          clearTimeout(timer);
          const url = win.webContents.getURL();
          const loggedIn = !url.includes('/login');
          try { win.close(); } catch {}
          resolve(loggedIn);
        });

        win.webContents.on('did-fail-load', () => {
          clearTimeout(timer);
          try { win.close(); } catch {}
          resolve(false);
        });

        win.loadURL(`${OVERLEAF_BASE}/project`);
      });

      if (ok) {
        this._loggedIn = true;
        await this._readEmailFromCookies();
        await this._readDisplayNameFromSession();
        return { loggedIn: true, email: this._email, displayName: this._displayName };
      }
    } catch { /* offline or error */ }
    this._loggedIn = false;
    this._email = null;
    this._displayName = null;
    return { loggedIn: false, email: null, displayName: null };
  }

  // ────────────────────────────────────────────────────────────
  //  LIST PROJECTS
  // ────────────────────────────────────────────────────────────

  async listProjects () {
    if (!this._loggedIn) return { ok: false, error: 'Not logged in' };

    try {
      const result = await this._fetchProjectsViaBrowser();
      if (!result.ok) return result;

      let projects = [];
      const raw = result.projects;
      if (Array.isArray(raw)) {
        projects = raw.map(p => this._normalizeProject(p));
      }
      return { ok: true, projects };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ────────────────────────────────────────────────────────────
  //  LOGOUT — clear all Overleaf cookies from the partition.
  // ────────────────────────────────────────────────────────────

  async logout () {
    try {
      await this.session.clearStorageData({
        storages: ['cookies', 'localstorage', 'sessionstorage']
      });
    } catch { /* ignore */ }
    this._loggedIn = false;
    this._email = null;
    this._displayName = null;
    this._gitToken = null;
    this._clearPersistedToken();
  }

  /**
   * Build the Git clone URL for a project.
   * @param {string} projectId
   * @returns {string}
   */
  gitUrl (projectId) {
    return `${GIT_BASE}/${projectId}`;
  }

  // ────────────────────────────────────────────────────────────
  //  REMOTE COMPILE — trigger compilation on Overleaf and
  //  download the resulting PDF.
  // ────────────────────────────────────────────────────────────

  /**
   * Compile a project on Overleaf and download the PDF.
   * @param {string} projectId  – the 24-char hex project ID
   * @param {string} destDir    – local directory to save the PDF
   * @returns {Promise<{ok, pdf?, error?}>}
   */
  async compileOnOverleaf (projectId, destDir) {
    if (!this._loggedIn) return { ok: false, error: 'Not logged in to Overleaf' };
    const fs = require('fs');
    const pathMod = require('path');

    try {
      // Step 1: Trigger compilation via Overleaf's internal API
      const compileRes = await this._postJson(
        `/project/${projectId}/compile`,
        { rootDoc_id: '', draft: false, check: 'silent', incrementalCompilesEnabled: true }
      );

      if (!compileRes.ok) {
        return { ok: false, error: `Compile request failed: HTTP ${compileRes.status}` };
      }

      let compileData;
      try { compileData = JSON.parse(compileRes.body); } catch {
        return { ok: false, error: 'Invalid compile response' };
      }

      if (compileData.status !== 'success') {
        return { ok: false, error: `Overleaf compile status: ${compileData.status}` };
      }

      // Step 2: Find the PDF in the output files
      const outputFiles = compileData.outputFiles || [];
      const pdfFile = outputFiles.find(f => f.path === 'output.pdf' || f.path.endsWith('.pdf'));
      if (!pdfFile) {
        return { ok: false, error: 'No PDF in compile output' };
      }

      // Step 3: Download the PDF
      const pdfUrl = pdfFile.url.startsWith('http')
        ? pdfFile.url
        : `${OVERLEAF_BASE}${pdfFile.url}`;

      const pdfData = await this._fetchBinary(pdfUrl);
      if (!pdfData.ok) {
        return { ok: false, error: `PDF download failed: HTTP ${pdfData.status}` };
      }

      // Step 4: Save to the project directory
      const pdfDest = pathMod.join(destDir, 'output.pdf');
      fs.writeFileSync(pdfDest, pdfData.buffer);
      
      return { ok: true, pdf: pdfDest };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Build an authenticated Git clone URL using the stored token.
   * Format: https://git:<token>@git.overleaf.com/<projectId>
   */
  authenticatedGitUrl (projectId) {
    if (!this._gitToken) return this.gitUrl(projectId);
    return `https://git:${this._gitToken}@git.overleaf.com/${projectId}`;
  }

  // ────────────────────────────────────────────────────────────
  //  GIT AUTH TOKEN — fetch or create the Overleaf Git
  //  authentication token from the user settings page.
  //  Overleaf requires these tokens for Git access.
  // ────────────────────────────────────────────────────────────

  get gitToken () { return this._gitToken || null; }

  /**
   * Set the Git token manually (from user input) and persist it.
   */
  setGitToken (token) {
    if (!token || token.length < 8) return { ok: false, error: 'Invalid token' };
    this._gitToken = token.trim();
    this._persistToken();
    console.log('[SOIL] Git token set manually and persisted');
    return { ok: true, token: this._gitToken };
  }

  /** Normalize a project object from various Overleaf API shapes */
  _normalizeProject (p) {
    const id   = p.id || p._id || '';
    const name = p.name || 'Untitled';
    const lastUpdated = p.lastUpdated || p.lastUpdatedAt || p.lastOpened || null;
    const owner = p.owner_ref || p.owner || null;
    let ownerName = '';
    if (owner && typeof owner === 'object') {
      // Overleaf uses camelCase: firstName/lastName
      const first = owner.firstName || owner.first_name || '';
      const last  = owner.lastName  || owner.last_name  || '';
      ownerName = (first + ' ' + last).trim();
      if (!ownerName && owner.email) ownerName = owner.email;
    } else if (typeof owner === 'string') {
      ownerName = owner;
    }

    return {
      id,
      name,
      lastUpdated,
      ownerName,
      accessLevel: p.accessLevel || '',
      gitUrl: this.gitUrl(id),
      archived: !!(p.archived || p.trashed)
    };
  }

  /** Read Overleaf email from the user's cookies or meta */
  async _readEmailFromCookies () {
    try {
      const cookies = await this.session.cookies.get({ domain: '.overleaf.com' });
      // Some Overleaf instances store the email in an `ol.email` cookie
      const emailCookie = cookies.find(c =>
        c.name === 'ol.email' || c.name === 'email'
      );
      if (emailCookie) {
        this._email = decodeURIComponent(emailCookie.value);
      }
    } catch { /* ignore */ }
  }

  /** Try to read display name from Overleaf's /user/settings page via hidden window */
  async _readDisplayNameFromSession () {
    if (this._displayName) return; // already have it
    try {
      const win = new BrowserWindow({
        width: 800, height: 600, show: false,
        webPreferences: {
          partition: SESSION_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
        }
      });
      await win.loadURL(`${OVERLEAF_BASE}/project`);
      const info = await win.webContents.executeJavaScript(`
        (() => {
          let displayName = null;
          const userEl = document.querySelector('meta[name="ol-user"]');
          if (userEl) {
            try {
              const u = JSON.parse(userEl.content);
              const parts = [u.first_name, u.last_name].filter(Boolean);
              if (parts.length > 0) displayName = parts.join(' ');
            } catch {}
          }
          return displayName;
        })()
      `);
      try { win.close(); } catch {}
      if (info) this._displayName = info;
    } catch { /* best effort */ }
  }

  /** Try to extract email and display name from the auth window's page before closing */
  async _extractEmail (win) {
    try {
      // Try cookie first
      await this._readEmailFromCookies();

      // Extract display name + email from Overleaf's meta tags
      const info = await win.webContents.executeJavaScript(`
        (() => {
          let email = null, displayName = null;
          // Email from meta
          const emailEl = document.querySelector('meta[name="ol-usersEmail"]');
          if (emailEl) email = emailEl.content;
          if (!email) {
            const m = document.cookie.match(/ol\\.email=([^;]+)/);
            if (m) email = decodeURIComponent(m[1]);
          }
          // Display name from ol-user meta (JSON with first_name, last_name)
          const userEl = document.querySelector('meta[name="ol-user"]');
          if (userEl) {
            try {
              const u = JSON.parse(userEl.content);
              const parts = [u.first_name, u.last_name].filter(Boolean);
              if (parts.length > 0) displayName = parts.join(' ');
            } catch {}
          }
          // Fallback: try ol-usersName meta
          if (!displayName) {
            const nameEl = document.querySelector('meta[name="ol-userName"]');
            if (nameEl && nameEl.content) displayName = nameEl.content;
          }
          return { email, displayName };
        })()
      `);
      if (info.email && !this._email) this._email = info.email;
      if (info.displayName) this._displayName = info.displayName;
    } catch { /* best effort */ }
  }

  /**
   * Make an HTTP request using Electron's net module, which
   * automatically includes cookies from the persistent session.
   */
  _fetch (urlPath, { accept = '*/*', method = 'GET' } = {}) {
    return new Promise((resolve, reject) => {
      const url = `${OVERLEAF_BASE}${urlPath}`;
      let finalUrl = url;

      const request = net.request({
        method,
        url,
        session: this.session,
        redirect: 'follow'        // let Chromium handle redirects
      });

      request.setHeader('Accept', accept);
      request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      request.on('redirect', (statusCode, _method, redirectUrl) => {
        // Track the final URL so callers can detect /login bounces
        finalUrl = redirectUrl;
        request.followRedirect();
      });

      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 400,
            status: response.statusCode,
            url: finalUrl,
            body: Buffer.concat(chunks).toString('utf-8')
          });
        });
      });

      request.on('error', reject);
      request.end();
    });
  }

  /**
   * POST JSON to Overleaf using cookies from the persistent session.
   * Fetches a CSRF token from the session first.
   */
  _postJson (urlPath, body) {
    return new Promise(async (resolve, reject) => {
      // Get CSRF token from cookies
      let csrfToken = '';
      try {
        const cookies = await this.session.cookies.get({ domain: '.overleaf.com' });
        const csrf = cookies.find(c => c.name === 'GCLB' || c.name === '_csrf' || c.name === 'overleaf_session2');
        // Also try fetching from a page meta tag
      } catch {}

      // First fetch the project page to get the CSRF token
      try {
        const pageRes = await this._fetch(`/project/${urlPath.split('/')[2]}`, { accept: 'text/html' });
        const match = pageRes.body && pageRes.body.match(/<meta\s+name="ol-csrfToken"\s+content="([^"]*)"/i);
        if (match) csrfToken = match[1];
      } catch {}

      const url = `${OVERLEAF_BASE}${urlPath}`;

      const request = net.request({
        method: 'POST',
        url,
        session: this.session,
        redirect: 'follow'
      });

      request.setHeader('Content-Type', 'application/json');
      request.setHeader('Accept', 'application/json');
      request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      if (csrfToken) request.setHeader('X-Csrf-Token', csrfToken);

      request.on('redirect', (_code, _method, redirectUrl) => {
        request.followRedirect();
      });

      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 400,
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf-8')
          });
        });
      });

      request.on('error', reject);
      request.write(JSON.stringify(body));
      request.end();
    });
  }

  /**
   * Download a binary file (e.g. PDF) using cookies from the persistent session.
   */
  _fetchBinary (url) {
    return new Promise((resolve, reject) => {
      const fullUrl = url.startsWith('http') ? url : `${OVERLEAF_BASE}${url}`;

      const request = net.request({
        method: 'GET',
        url: fullUrl,
        session: this.session,
        redirect: 'follow'
      });

      request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      request.on('redirect', (_code, _method, redirectUrl) => {
        request.followRedirect();
      });

      request.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 400,
            status: response.statusCode,
            buffer: Buffer.concat(chunks)
          });
        });
      });

      request.on('error', reject);
      request.end();
    });
  }

  /**
   * Load the /project dashboard in a hidden BrowserWindow sharing
   * the persistent session, then extract project data from the DOM.
   * This is the most reliable method since it runs all JS/redirects
   * exactly as a real browser would.
   */
  _fetchProjectsViaBrowser () {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 800,
        height: 600,
        show: false,
        webPreferences: {
          partition: SESSION_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
        }
      });

      let resolved = false;
      const finish = (result) => {
        if (resolved) return;
        resolved = true;
        try { win.close(); } catch {}
        resolve(result);
      };

      // Timeout after 30 seconds
      const timer = setTimeout(() => finish({ ok: false, error: 'Timeout loading projects' }), 30000);

      // ── Strategy A: Intercept Overleaf's internal API response ──
      // Modern Overleaf fetches /api/project or similar via XHR after
      // the SPA loads.  We watch all completed requests for JSON that
      // looks like a project list.
      let interceptedProjects = null;

      win.webContents.session.webRequest.onCompleted(
        { urls: ['https://www.overleaf.com/*'] },
        (details) => {
          // We only care about the initial HTML or API calls
          if (interceptedProjects) return;
        }
      );

      // Use the debugger protocol to capture response bodies
      try {
        win.webContents.debugger.attach('1.3');
        win.webContents.debugger.sendCommand('Network.enable');

        const pendingRequests = new Map();

        win.webContents.debugger.on('message', (event, method, params) => {
          // Track request URLs
          if (method === 'Network.requestWillBeSent') {
            pendingRequests.set(params.requestId, params.request.url);
          }

          // When a response is received, check if it's the project list
          if (method === 'Network.responseReceived') {
            const url = params.response.url || pendingRequests.get(params.requestId) || '';
            const ct = (params.response.headers['content-type'] || params.response.headers['Content-Type'] || '');

            if (ct.includes('json') && (url.includes('/api/project') || url.includes('/project'))) {
              // Fetch the body
              win.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId })
                .then(result => {
                  try {
                    const json = JSON.parse(result.body);
                    // Could be { projects: [...] } or { totalSize: ..., projects: [...] } or just [...]
                    const arr = json.projects || json.totalSize !== undefined && json.projects || (Array.isArray(json) ? json : null);
                    if (arr && Array.isArray(arr) && arr.length > 0 && arr[0].id) {
                      interceptedProjects = arr;
                      clearTimeout(timer);
                      try { win.webContents.debugger.detach(); } catch {}
                      finish({ ok: true, projects: arr });
                    }
                  } catch { /* not the response we want */ }
                })
                .catch(() => {});
            }
          }
        });
      } catch (dbgErr) {
        // debugger attach failed — fall through to DOM strategies
        console.warn('Debugger attach failed:', dbgErr.message);
      }

      win.webContents.on('did-finish-load', async () => {
        try {
          const url = win.webContents.getURL();
          if (url.includes('/login')) {
            clearTimeout(timer);
            try { win.webContents.debugger.detach(); } catch {}
            finish({ ok: false, error: 'Session expired' });
            return;
          }

          // ── Strategy B: poll the DOM for project data ──
          // Wait for React to render projects (retry a few times)
          const pollForProjects = async (retries = 10, delay = 2000) => {
            for (let i = 0; i < retries; i++) {
              if (interceptedProjects) return; // Strategy A already got it

              const projects = await win.webContents.executeJavaScript(`
                (async () => {
                  // ── 1. ol-prefetchedProjectsBlob — may be inline JSON, a URL, or a blob ref ──
                  const blobMeta = document.querySelector('meta[name="ol-prefetchedProjectsBlob"]');
                  if (blobMeta && blobMeta.content) {
                    let data = null;
                    const raw = blobMeta.content;

                    // Try parsing as inline JSON first
                    try { data = JSON.parse(raw); } catch {}

                    // If it's a URL/path, fetch it
                    if (!data && (raw.startsWith('/') || raw.startsWith('http') || raw.startsWith('blob:'))) {
                      try {
                        const url = raw.startsWith('/') ? location.origin + raw : raw;
                        const resp = await fetch(url, { credentials: 'include' });
                        const text = await resp.text();
                        try { data = JSON.parse(text); } catch {}
                      } catch {}
                    }

                    if (data) {
                      // data could be { projects: [...], totalSize: ... } or just [...]
                      const arr = Array.isArray(data) ? data : (data.projects || data.totalSize !== undefined ? data.projects : null);
                      if (arr && Array.isArray(arr) && arr.length > 0) return arr;
                    }
                  }

                  // ── 2. ol-projects meta tag (older Overleaf) ──
                  const projMeta = document.querySelector('meta[name="ol-projects"]');
                  if (projMeta && projMeta.content) {
                    try {
                      const d = JSON.parse(projMeta.content);
                      if (Array.isArray(d) && d.length > 0) return d;
                    } catch {}
                  }

                  // ── 3. Extract from DOM links ──
                  const links = document.querySelectorAll('a[href*="/project/"]');
                  if (links.length > 0) {
                    const seen = new Set();
                    const projects = [];
                    for (const a of links) {
                      const href = a.getAttribute('href') || '';
                      const match = href.match(/\\/project\\/([a-f0-9]{24})/);
                      if (match && !seen.has(match[1])) {
                        seen.add(match[1]);
                        // Walk up to find the row and get the name
                        let name = a.textContent.trim();
                        // If the link text is empty, try the closest table row
                        if (!name) {
                          const row = a.closest('tr') || a.closest('[class*="item"]') || a.parentElement;
                          if (row) name = (row.querySelector('.dash-cell-name') || row.querySelector('td') || row).textContent.trim();
                        }
                        projects.push({ id: match[1], name: name || 'Untitled' });
                      }
                    }
                    if (projects.length > 0) return projects;
                  }

                  // ── 4. React / __NEXT_DATA__ ──
                  if (window.__NEXT_DATA__) {
                    try {
                      const p = window.__NEXT_DATA__.props.pageProps.projects;
                      if (Array.isArray(p)) return p;
                    } catch {}
                  }

                  return null;
                })()
              `);

              if (projects && projects.length > 0) {
                console.log('[SOIL] Found', projects.length, 'projects');
                if (projects.length > 0) {
                  console.log('[SOIL] Sample project keys:', Object.keys(projects[0]));
                }
                clearTimeout(timer);
                try { win.webContents.debugger.detach(); } catch {}
                finish({ ok: true, projects });
                return;
              }

              // Wait before next attempt
              await new Promise(r => setTimeout(r, delay));
            }

            // All retries exhausted — return empty
            if (!interceptedProjects) {
              clearTimeout(timer);
              try { win.webContents.debugger.detach(); } catch {}
              finish({ ok: true, projects: [] });
            }
          };

          pollForProjects();
        } catch (err) {
          clearTimeout(timer);
          try { win.webContents.debugger.detach(); } catch {}
          finish({ ok: false, error: err.message });
        }
      });

      win.webContents.on('did-fail-load', (_e, code, desc) => {
        clearTimeout(timer);
        try { win.webContents.debugger.detach(); } catch {}
        finish({ ok: false, error: `Load failed: ${desc} (${code})` });
      });

      win.loadURL(`${OVERLEAF_BASE}/project`);
    });
  }
}

module.exports = { OverleafAPI };
