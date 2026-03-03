// ─────────────────────────────────────────────────────────────
//  Soil — Synchronization Engine
//  chokidar (file watcher) + simple-git + semaphore locking
// ─────────────────────────────────────────────────────────────
const chokidar  = require('chokidar');
const simpleGit = require('simple-git');
const path      = require('path');
const dns       = require('dns');
const { promisify } = require('util');

const dnsResolve = promisify(dns.resolve);

const DEBOUNCE_MS       = 3000;   // group saves within 3 s
const NETWORK_CHECK_HOST = 'git.overleaf.com';

const NETWORK_POLL_MS = 10000;  // check connectivity every 10 s

class SyncEngine {
  /**
   * @param {string} projectDir  – absolute path to the git repo
   * @param {Function} log       – (msg, level) logger forwarded to renderer
   * @param {string}  [gitBinary] – path to a custom git binary (bundled MinGit)
   */
  constructor (projectDir, log, gitBinary) {
    this.dir    = projectDir;
    this.git    = gitBinary
      ? simpleGit({ baseDir: projectDir, binary: gitBinary })
      : simpleGit(projectDir);
    this.log    = log || (() => {});
    this.watcher = null;
    this._onNotify   = null;   // callback when files change (gutter refresh)
    this._onNetwork  = null;   // callback when online status changes
    this._networkTimer = null;

    // ── Semaphore ──
    this._syncing = false;

    // ── Last known status ──
    this._lastStatus = {
      active : false,
      syncing: false,
      online : null,
      lastSync : null,
      error  : null
    };
  }

  /** Register a callback for file-change notifications */
  setNotifyCallback (cb) { this._onNotify = cb; }

  /** Register a callback for network-status changes: cb(online: boolean) */
  setNetworkCallback (cb) { this._onNetwork = cb; }

  // ── Public API ──────────────────────────────────────────────

  /** Start the file watcher */
  start () {
    if (this.watcher) return;

    this._lastStatus.active = true;

    this.watcher = chokidar.watch(this.dir, {
      ignored: [
        /(^|[\\/\\])\../,           // dotfiles / .git
        '**/node_modules/**',
        '**/*.aux', '**/*.log', '**/*.fls', '**/*.fdb_latexmk',
        '**/*.synctex.gz', '**/*.synctex(busy)', '**/*.pdf',
        '**/*.out', '**/*.toc', '**/*.bbl', '**/*.blg', '**/*.nav',
        '**/*.snm', '**/*.vrb'
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500 }
    });

    const onChange = (evtPath) => {
      this.log(`File changed: ${path.relative(this.dir, evtPath)}`);
      if (this._onNotify) this._onNotify(evtPath);
    };

    this.watcher
      .on('change', onChange)
      .on('add',    onChange)
      .on('unlink', onChange);

    this.log('File watcher initialised');

    // Start continuous network monitoring
    this._startNetworkMonitor();
  }

  /** Stop watcher & clean timers */
  stop () {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this._networkTimer) {
      clearInterval(this._networkTimer);
      this._networkTimer = null;
    }
    this._lastStatus.active = false;
    this.log('Sync engine stopped');
  }

  /** Return summary object for the renderer */
  getStatus () {
    return { ...this._lastStatus };
  }

  // ── Git query methods ──────────────────────────────────────

  /** List files that differ from the last commit */
  async getChangedFiles () {
    try {
      const status = await this.git.status();
      return status.files.map(f => ({
        path  : f.path,
        status: f.working_dir === '?' ? 'new'
              : f.working_dir === 'D' ? 'deleted'
              : 'modified'
      }));
    } catch { return []; }
  }

  /** Return diff hunks for one file (working-tree vs HEAD) */
  async getFileDiff (relPath) {
    try {
      const raw = await this.git.diff(['--unified=0', 'HEAD', '--', relPath]);
      return this._parseHunks(raw);
    } catch { return []; }   // untracked or no HEAD yet
  }

  /** Check if local branch is ahead of remote (has unpushed commits) */
  async hasUnpushedCommits () {
    try {
      const log = await this.git.log(['@{u}..HEAD']);
      return { unpushed: log.total > 0, count: log.total };
    } catch {
      // No upstream set or no remote — check if there are any local commits at all
      try {
        const status = await this.git.status();
        return { unpushed: status.ahead > 0, count: status.ahead };
      } catch { return { unpushed: false, count: 0 }; }
    }
  }

  /** Stage+commit locally only (no network, no push) */
  async commitLocally () {
    if (this._syncing) return { ok: false, error: 'Sync already in progress' };
    this._syncing = true;
    try {
      await this.git.add('.');
      const status = await this.git.status();
      if (status.files.length === 0) return { ok: true, nothingToCommit: true };
      const ts = new Date().toISOString();
      await this.git.commit(`Soil offline commit ${ts}`);
      this.log(`Committed ${status.files.length} file(s) locally`);
      return { ok: true, committed: status.files.length };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      this._syncing = false;
    }
  }

  // ── Push + Commit ──────────────────────────────────────────

  async commitAndPush () {
    if (this._syncing) return { ok: false, error: 'Sync already in progress' };
    this._syncing = true;
    this._lastStatus.syncing = true;
    this._lastStatus.error   = null;

    try {
      // 1. Stage
      this.log('Staging changes…');
      await this.git.add('.');

      // 2. Commit
      const status = await this.git.status();
      if (status.files.length === 0) {
        this.log('Nothing to commit');
        return { ok: true, nothingToCommit: true };
      }
      const ts = new Date().toISOString();
      await this.git.commit(`Soil sync ${ts}`);
      this.log(`Committed ${status.files.length} file(s)`);

      // 3. Network check
      const online = await this._checkNetwork();
      this._lastStatus.online = online;
      if (!online) {
        this.log('Offline — committed locally', 'warn');
        return { ok: true, offline: true };
      }

      // 4. Stash any new dirty-tree changes (build artifacts written after commit)
      //    Keep retrying because the compiler may still be writing files
      let stashed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const preStatus = await this.git.status();
          if (preStatus.files.length === 0) break;
          // Stage + commit stragglers first so stash is clean
          await this.git.add('.');
          await this.git.commit(`Soil auto-stage build artifacts`);
          this.log(`Auto-committed ${preStatus.files.length} leftover file(s)`);
        } catch { /* nothing to commit — good */ }
      }

      // 5. Pull with rebase (linear history)
      this.log('Pulling with rebase…');
      try {
        await this.git.pull(['--rebase']);
        this.log('Pull succeeded');
      } catch (pullErr) {
        this.log(`Rebase conflict: ${pullErr.message}`, 'error');
        try { await this.git.rebase(['--abort']); } catch (_) {}
        return { ok: false, error: `Conflict: ${pullErr.message}` };
      }

      // 6. Push
      this.log('Pushing to remote…');
      await this.git.push();
      this.log('Push complete ✓');

      this._lastStatus.lastSync = new Date().toISOString();
      return { ok: true };

    } catch (err) {
      this.log(`Push+Commit error: ${err.message}`, 'error');
      this._lastStatus.error = err.message;
      return { ok: false, error: err.message };
    } finally {
      this._syncing = false;
      this._lastStatus.syncing = false;
    }
  }

  /** Pull-only from remote (git pull --rebase) */
  async pull () {
    if (this._syncing) return { ok: false, error: 'Sync already in progress' };
    this._syncing = true;
    this._lastStatus.syncing = true;

    try {
      const online = await this._checkNetwork();
      if (!online) return { ok: false, error: 'Offline — cannot pull' };

      // Stash dirty tree before rebase (build artifacts may be present)
      let stashed = false;
      try {
        const st = await this.git.status();
        if (st.files.length > 0) {
          await this.git.stash(['push', '-u', '-m', 'soil-pre-pull']);
          stashed = true;
        }
      } catch { /* no-op */ }

      this.log('Pulling from remote…');
      await this.git.pull(['--rebase']);
      this.log('Pull complete ✓');

      if (stashed) {
        try { await this.git.stash(['pop']); } catch (_) {}
      }
      return { ok: true };
    } catch (err) {
      this.log(`Pull error: ${err.message}`, 'error');
      try { await this.git.rebase(['--abort']); } catch (_) {}
      return { ok: false, error: err.message };
    } finally {
      this._syncing = false;
      this._lastStatus.syncing = false;
    }
  }

  /** Backward-compat alias */
  async syncNow () { return this.commitAndPush(); }

  // ── Internal helpers ───────────────────────────────────────

  /** Parse @@ hunks from `git diff --unified=0` output */
  _parseHunks (diffOutput) {
    const hunks = [];
    const re = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g;
    let m;
    while ((m = re.exec(diffOutput)) !== null) {
      const oldCount = m[2] !== undefined ? parseInt(m[2]) : 1;
      const newStart = parseInt(m[3]);
      const newCount = m[4] !== undefined ? parseInt(m[4]) : 1;

      if (newCount === 0) {
        hunks.push({ startLine: newStart, endLine: newStart, type: 'deleted' });
      } else if (oldCount === 0) {
        hunks.push({ startLine: newStart, endLine: newStart + newCount - 1, type: 'added' });
      } else {
        hunks.push({ startLine: newStart, endLine: newStart + newCount - 1, type: 'modified' });
      }
    }
    return hunks;
  }

  /** Quick DNS probe to determine connectivity */
  async _checkNetwork () {
    try {
      await dnsResolve(NETWORK_CHECK_HOST);
      return true;
    } catch { return false; }
  }

  /** Continuous background network polling */
  _startNetworkMonitor () {
    if (this._networkTimer) return;
    // Do an immediate check
    this._pollNetwork();
    this._networkTimer = setInterval(() => this._pollNetwork(), NETWORK_POLL_MS);
  }

  async _pollNetwork () {
    const nowOnline = await this._checkNetwork();
    const wasOnline = this._lastStatus.online;
    this._lastStatus.online = nowOnline;
    if (wasOnline !== null && nowOnline !== wasOnline && this._onNetwork) {
      this._onNetwork(nowOnline);
    }
  }
}

module.exports = { SyncEngine };
