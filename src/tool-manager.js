// ─────────────────────────────────────────────────────────────
//  Soil — Tool Manager
//  Downloads and manages bundled TinyTeX + MinGit so Soil
//  is fully self-contained with zero external dependencies.
// ─────────────────────────────────────────────────────────────
const { app } = require('electron');
const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { exec }      = require('child_process');
const { promisify }  = require('util');

const execP = promisify(exec);

// ── Download URLs ────────────────────────────────────────────
// TinyTeX "daily" tag always points to the latest build
const TINYTEX_URLS = {
  win32  : 'https://github.com/rstudio/tinytex-releases/releases/download/daily/TinyTeX-1.zip',
  darwin : 'https://github.com/rstudio/tinytex-releases/releases/download/daily/TinyTeX-1.tgz',
  linux  : 'https://github.com/rstudio/tinytex-releases/releases/download/daily/TinyTeX-1.tar.gz'
};

// ── Package-name exceptions (.sty → TeX Live package) ────────
const PACKAGE_MAP = {
  'algpseudocode.sty' : 'algorithmicx',
  'algorithm.sty'     : 'algorithms',
  'IEEEtran.cls'      : 'ieeetran',
  'IEEEtran.bst'      : 'ieeetran',
  'tikz.sty'             : 'pgf',
  'pgffor.sty'           : 'pgf',
  'pgfmath.sty'          : 'pgf',
  'amssymb.sty'          : 'amsfonts',
  'revtex4-2.cls'        : 'revtex',
  'aastex631.cls'        : 'aastex',
  'mnras.cls'            : 'mnras',
  'acmart.cls'           : 'acmart',
  'tikzfill.image.sty'   : 'tikzfill',
  'tikzfill.path.sty'    : 'tikzfill',
  'tikzfill.pattern.sty' : 'tikzfill',
};

class ToolManager {
  constructor (log) {
    this.log = log || (() => {});
    this._progressCb = null;
    this._toolsDir = null;
  }

  /** Register a progress callback: ({ step, message, percent }) */
  onProgress (cb) { this._progressCb = cb; }

  /** @private */
  _emit (step, message, percent = -1) {
    if (this._progressCb) this._progressCb({ step, message, percent });
    this.log(message);
  }

  // ── Paths ──────────────────────────────────────────────────

  get toolsDir () {
    if (!this._toolsDir) {
      this._toolsDir = path.join(app.getPath('userData'), 'tools');
    }
    return this._toolsDir;
  }

  get texDir () { return path.join(this.toolsDir, 'TinyTeX'); }

  /** Dynamically find the bin/ subdirectory inside TinyTeX */
  get texBinDir () {
    const binBase = path.join(this.texDir, 'bin');
    try {
      const entries = fs.readdirSync(binBase)
        .filter(e => fs.statSync(path.join(binBase, e)).isDirectory());
      if (entries.length > 0) return path.join(binBase, entries[0]);
    } catch { /* not installed yet */ }
    // Fallback to expected platform directory
    const plat = process.platform === 'win32' ? 'windows'
               : process.platform === 'darwin' ? 'universal-darwin'
               : 'x86_64-linux';
    return path.join(binBase, plat);
  }

  get gitDir () { return path.join(this.toolsDir, 'git'); }

  get gitBinary () {
    if (process.platform === 'win32') {
      return path.join(this.gitDir, 'cmd', 'git.exe');
    }
    return 'git';   // macOS / Linux — use system git
  }

  /** Full PATH string with bundled tools prepended */
  get toolPATH () {
    const parts = [this.texBinDir];
    if (process.platform === 'win32') {
      parts.push(path.join(this.gitDir, 'cmd'));
    }
    parts.push(process.env.PATH);
    return parts.filter(Boolean).join(path.delimiter);
  }

  // ── Status ─────────────────────────────────────────────────

  get isTexInstalled () {
    const bin = process.platform === 'win32' ? 'pdflatex.exe' : 'pdflatex';
    return fs.existsSync(path.join(this.texBinDir, bin));
  }

  get isGitInstalled () {
    if (process.platform !== 'win32') return true;
    return fs.existsSync(this.gitBinary);
  }

  get isReady () { return this.isTexInstalled && this.isGitInstalled; }

  // ── Main entry point ───────────────────────────────────────

  async ensureTools () {
    fs.mkdirSync(this.toolsDir, { recursive: true });

    if (!this.isTexInstalled) {
      await this._installTinyTeX();
    } else {
      this._emit('tex', 'TinyTeX already installed ✓');
    }

    if (!this.isGitInstalled) {
      await this._installMinGit();
    } else {
      this._emit('git', 'Git already installed ✓');
    }
  }

  // ── TinyTeX ────────────────────────────────────────────────

  async _installTinyTeX () {
    const url = TINYTEX_URLS[process.platform] || TINYTEX_URLS.linux;
    const ext = process.platform === 'win32' ? '.zip'
              : process.platform === 'darwin' ? '.tgz' : '.tar.gz';
    const archivePath = path.join(this.toolsDir, `TinyTeX-1${ext}`);

    // 1. Download
    this._emit('tex', 'Downloading TinyTeX…', 0);
    await this._download(url, archivePath, 'TinyTeX');

    // 2. Remove previous install
    if (fs.existsSync(this.texDir)) {
      fs.rmSync(this.texDir, { recursive: true, force: true });
    }

    // 3. Extract
    this._emit('tex', 'Extracting TinyTeX (this may take a minute)…', -1);
    await this._extract(archivePath, this.toolsDir);

    // 4. Clean up archive
    try { fs.unlinkSync(archivePath); } catch { /* ok */ }

    // 5. Verify
    if (!this.isTexInstalled) {
      throw new Error('TinyTeX extraction failed — pdflatex not found');
    }

    // 6. Configure package repository (detect TL version → use pretest if needed)
    this._emit('tex', 'Configuring TeX package manager…', -1);
    await this._configureTlmgrRepo();

    // 7. Update tlmgr itself so package installs work reliably
    this._emit('tex', 'Updating TeX package manager…', -1);
    try { await this._runTlmgr(['update', '--self']); } catch { /* non-fatal */ }

    this._emit('tex', 'TinyTeX installed ✓', 100);
  }

  // ── MinGit (Windows only) ─────────────────────────────────

  async _installMinGit () {
    if (process.platform !== 'win32') return;

    this._emit('git', 'Finding latest MinGit release…', 0);
    const url = await this._getMinGitUrl();

    const archivePath = path.join(this.toolsDir, 'MinGit.zip');

    // 1. Download
    this._emit('git', 'Downloading MinGit…', 0);
    await this._download(url, archivePath, 'MinGit');

    // 2. Remove previous install
    if (fs.existsSync(this.gitDir)) {
      fs.rmSync(this.gitDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.gitDir, { recursive: true });

    // 3. Extract  (MinGit zip has no root folder → extract into gitDir)
    this._emit('git', 'Extracting MinGit…', -1);
    await this._extract(archivePath, this.gitDir);

    // 4. Clean up
    try { fs.unlinkSync(archivePath); } catch { /* ok */ }

    // 5. Verify
    if (!this.isGitInstalled) {
      throw new Error('MinGit extraction failed — git.exe not found');
    }

    this._emit('git', 'MinGit installed ✓', 100);
  }

  /** Discover the latest MinGit download URL via the GitHub API */
  _getMinGitUrl () {
    return new Promise((resolve, reject) => {
      // Use the GitHub API to list assets on the latest release
      https.get('https://api.github.com/repos/git-for-windows/git/releases/latest', {
        headers: {
          'User-Agent': 'Soil-Editor/1.0',
          'Accept': 'application/vnd.github.v3+json'
        }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const release = JSON.parse(body);
            const asset = (release.assets || []).find(a =>
              /^MinGit-.*-64-bit\.zip$/i.test(a.name) &&
              !/busybox/i.test(a.name)
            );
            if (asset && asset.browser_download_url) {
              return resolve(asset.browser_download_url);
            }
            reject(new Error('MinGit asset not found in latest release'));
          } catch (e) {
            reject(new Error('Failed to parse GitHub release: ' + e.message));
          }
        });
      }).on('error', reject);
    });
  }

  // ── Package management ─────────────────────────────────────

  /** Run a tlmgr command and return { stdout, stderr } */
  async _runTlmgr (args) {
    const tlmgr = path.join(this.texBinDir,
      process.platform === 'win32' ? 'tlmgr.bat' : 'tlmgr');
    const env = { ...process.env, PATH: this.toolPATH };
    const cmd = `"${tlmgr}" ${args.join(' ')}`;
    return execP(cmd, { timeout: 300_000, env });
  }

  /**
   * Detect the installed TeX Live year and configure a working repository.
   * During the annual TL freeze/release transition, some CTAN mirrors may
   * be out of sync, so we try multiple mirrors until one succeeds.
   */
  async _configureTlmgrRepo () {
    // Detect TL version from the pdflatex banner
    let tlYear = 0;
    try {
      const bin = path.join(this.texBinDir,
        process.platform === 'win32' ? 'pdflatex.exe' : 'pdflatex');
      const { stdout } = await execP(`"${bin}" --version`, { timeout: 10_000 });
      const m = stdout.match(/TeX Live (\d{4})/);
      if (m) tlYear = parseInt(m[1], 10);
    } catch { /* fallback below */ }

    this.log(`TeX Live ${tlYear || '?'} detected — finding a compatible mirror…`);

    // Ordered list of mirrors to try.  Some may be stale during the annual
    // TeX Live transition period (roughly March–April each year).
    const mirrors = [
      'https://mirror.ctan.org/systems/texlive/tlnet',
      'https://ftp.tu-chemnitz.de/pub/tex/systems/texlive/tlnet',
      'https://ftp.fau.de/ctan/systems/texlive/tlnet',
      'https://mirror.ox.ac.uk/sites/ctan.org/systems/texlive/tlnet',
      'https://ftp.math.utah.edu/pub/tex/systems/texlive/tlnet',
    ];

    for (const repo of mirrors) {
      try {
        // Test by setting the repo (tlmgr validates it immediately)
        await this._runTlmgr(['option', 'repository', repo]);
        this.log(`Repository set: ${repo}`);
        return;  // success — stop trying
      } catch (err) {
        const msg = (err.stderr || err.message || '');
        if (/do not include|Cross release/i.test(msg)) {
          this.log(`Mirror ${repo} has wrong TL version, trying next…`, 'warn');
          continue;
        }
        this.log(`Mirror ${repo} failed: ${msg.substring(0, 120)}`, 'warn');
      }
    }

    this.log('Could not configure a working TeX repository — package installation may fail', 'error');
  }

  /**
   * Install one or more TeX Live packages via tlmgr.
   * @returns {number} count of packages actually installed
   */
  async installPackages (names) {
    if (!names.length) return 0;
    let installed = 0;
    for (const pkg of names) {
      this._emit('pkg', `Installing LaTeX package: ${pkg}…`);
      try {
        const { stdout, stderr } = await this._runTlmgr(['install', pkg]);
        const combined = (stdout || '') + (stderr || '');
        if (/not present in repository/i.test(combined)) {
          this.log(`Package "${pkg}" not in repository — skipping`, 'warn');
        } else if (/do not include the version|Cross release/i.test(combined)) {
          this.log(`tlmgr version mismatch for ${pkg}: ${combined.trim()}`, 'warn');
        } else {
          this.log(`Installed ${pkg} ✓`);
          installed++;
        }
      } catch (err) {
        const msg = (err.stderr || err.message || '').trim();
        if (/not present in repository/i.test(msg)) {
          this.log(`Package "${pkg}" not in repository — skipping`, 'warn');
        } else {
          this.log(`tlmgr install ${pkg} failed: ${msg}`, 'error');
        }
      }
    }
    return installed;
  }

  /**
   * Parse a pdflatex log for missing .sty / .cls files,
   * map them to TeX Live package names, and install them.
   * @returns {string[]} package names that were installed
   */
  async autoInstallFromLog (logOutput) {
    const missing = this._parseMissingFiles(logOutput);
    if (!missing.length) return [];

    // Resolve file names → TeX Live package names
    const pkgs = [...new Set(missing.map(f => this._fileToPackage(f)))];

    this.log(`Auto-installing ${pkgs.length} missing package(s): ${pkgs.join(', ')}`);
    let installed = await this.installPackages(pkgs);

    // For any that failed, try `tlmgr search --file` to discover the real package
    if (installed < pkgs.length) {
      for (const file of missing) {
        const resolved = await this._searchPackageForFile(file);
        if (resolved && !pkgs.includes(resolved)) {
          this.log(`Resolved ${file} → ${resolved} (via search)`);
          installed += await this.installPackages([resolved]);
        }
      }
    }

    return installed > 0 ? pkgs : [];
  }

  /**
   * Map a missing filename to a TeX Live package name.
   * Handles dotted names like `tikzfill.image.sty`.
   */
  _fileToPackage (filename) {
    // 1. Exact match in the hardcoded map
    if (PACKAGE_MAP[filename]) return PACKAGE_MAP[filename];

    // 2. Strip the extension
    const stem = filename.replace(/\.(sty|cls|def|clo|fd|bst|cbx|bbx|lbx|cfg)$/, '');

    // 3. If the stem still has dots (e.g. tikzfill.image → tikzfill), try the
    //    first component — many TeX Live packages use dotted sub-file names.
    if (stem.includes('.')) {
      return stem.split('.')[0];
    }

    return stem;
  }

  /**
   * Ask tlmgr to search for the file in the repository.
   * Returns the owning package name, or null.
   */
  async _searchPackageForFile (filename) {
    try {
      const { stdout } = await this._runTlmgr([
        'search', '--file', '--global', filename
      ]);
      // Output lines like: "tcolorbox:\n\ttexmf-dist/tex/latex/tcolorbox/tcolorbox.sty"
      const m = stdout.match(/^(\S+):$/m);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  /** @private  Extract missing-file names from pdflatex output */
  _parseMissingFiles (log) {
    const files = new Set();
    const patterns = [
      /! LaTeX Error: File `([^']+\.\w+)' not found/g,
      /! I can't find file `([^']+)'/g,
      /`([^']+\.(?:sty|cls))' not found/gi,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(log)) !== null) {
        const name = m[1].trim();
        if (name && !name.includes('/') && !name.includes('\\')) {
          files.add(name);
        }
      }
    }
    return [...files];
  }

  // ── Download (follows redirects) ──────────────────────────

  _download (url, destPath, label) {
    return new Promise((resolve, reject) => {
      const follow = (u, redirects = 0) => {
        if (redirects > 10) return reject(new Error('Too many redirects'));
        const lib = u.startsWith('https') ? https : http;
        lib.get(u, { headers: { 'User-Agent': 'Soil-Editor/1.0' } }, (res) => {
          // Follow 3xx redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return follow(res.headers.location, redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} downloading ${label}`));
          }

          const total    = parseInt(res.headers['content-length'], 10) || 0;
          let   received = 0;
          const file     = fs.createWriteStream(destPath);

          res.on('data', (chunk) => {
            received += chunk.length;
            if (total > 0) {
              const pct  = Math.round((received / total) * 100);
              const mb   = (received / 1048576).toFixed(1);
              const tmb  = (total / 1048576).toFixed(1);
              this._emit('download', `${label}: ${mb} / ${tmb} MB (${pct}%)`, pct);
            }
          });

          res.pipe(file);
          file.on('finish', () => { file.close(resolve); });
          file.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
        }).on('error', reject);
      };

      follow(url);
    });
  }

  // ── Extraction ─────────────────────────────────────────────

  async _extract (archive, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    const isZip = archive.endsWith('.zip');
    const flags = isZip ? '-xf' : '-xzf';

    try {
      // Windows 10+ ships bsdtar; macOS/Linux have GNU tar
      await execP(`tar ${flags} "${archive}" -C "${destDir}"`, { timeout: 600_000 });
    } catch (tarErr) {
      // Fallback for Windows: PowerShell Expand-Archive (zip only)
      if (process.platform === 'win32' && isZip) {
        await execP(
          `powershell -NoProfile -Command "Expand-Archive -Path '${archive}' -DestinationPath '${destDir}' -Force"`,
          { timeout: 600_000 }
        );
      } else {
        throw tarErr;
      }
    }
  }
}

module.exports = { ToolManager };
