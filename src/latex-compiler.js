// ─────────────────────────────────────────────────────────────
//  Soil — LaTeX Compiler (pdflatex via child_process)
//  Uses ToolManager for bundled TinyTeX + auto-package install.
// ─────────────────────────────────────────────────────────────
const { execFile } = require('child_process');
const path = require('path');
const fs   = require('fs');

class LatexCompiler {
  /**
   * @param {string}  projectDir  – absolute path to the project
   * @param {Function} log        – (msg, level) logger
   * @param {import('./tool-manager').ToolManager} toolManager
   */
  constructor (projectDir, log, toolManager) {
    this.dir   = projectDir;
    this.log   = log || (() => {});
    this.tools = toolManager;
    this._proc = null;
  }

  /** Resolve a TeX binary inside the bundled TinyTeX */
  _bin (name) {
    const ext = process.platform === 'win32' ? '.exe' : '';
    return path.join(this.tools.texBinDir, `${name}${ext}`);
  }

  /**
   * Compile a .tex file.
   * On first failure, auto-installs any missing packages and retries once.
   */
  async compile (mainTex = 'main.tex') {
    if (this._proc) {
      this.log('Compilation already running — killing previous', 'warn');
      this._proc.kill();
    }

    const MAX_INSTALL_ROUNDS = 5;       // safety cap
    let result = await this._doCompile(mainTex);

    // Loop: install missing packages → retry, until no new packages are found
    for (let round = 1; round <= MAX_INSTALL_ROUNDS; round++) {
      if (result.ok || !result.log) break;

      const installed = await this.tools.autoInstallFromLog(result.log);
      if (installed.length === 0) break;   // nothing new to install

      this.log(`Installed ${installed.length} package(s) (round ${round}) — retrying compilation…`);
      result = await this._doCompile(mainTex);
    }

    return result;
  }

  /** @private  Run the actual pdflatex passes */
  async _doCompile (mainTex) {
    const pdflatex = this._bin('pdflatex');
    const bibtex   = this._bin('bibtex');
    const args = [
      '-interaction=nonstopmode',
      '-file-line-error',
      '-synctex=1',
      mainTex
    ];

    this.log(`Compiling: pdflatex ${args.join(' ')}`);

    const env = { ...process.env, PATH: this.tools.toolPATH };
    const execOpts = {
      cwd       : this.dir,
      timeout   : 120_000,
      maxBuffer : 5 * 1024 * 1024,
      env
    };

    let allOutput = '';

    const runOnce = (bin, runArgs) => new Promise((res) => {
      this._proc = execFile(bin, runArgs, execOpts, (err, stdout, stderr) => {
        this._proc = null;
        const out = (stdout || '') + '\n' + (stderr || '');
        allOutput += out;
        res({ err, output: out });
      });
    });

    const pdfName = mainTex.replace(/\.tex$/i, '.pdf');
    const pdfPath = path.join(this.dir, pdfName);

    // --- Pass 1 ---
    const pass1 = await runOnce(pdflatex, args);

    // If pass 1 errored and no PDF exists → likely missing package, return early
    if (pass1.err && !fs.existsSync(pdfPath)) {
      this.log(`Compilation failed (pass 1): ${pass1.err.message}`, 'error');
      const issues = this._parseLogIssues(allOutput, mainTex);
      return { ok: false, log: allOutput, error: pass1.err.message, ...issues };
    }

    // Check if bibtex is needed (look for \citation or \bibdata in .aux)
    const auxFile = path.join(this.dir, mainTex.replace(/\.tex$/i, '.aux'));
    let needsBibtex = false;
    try {
      const auxContent = fs.readFileSync(auxFile, 'utf8');
      needsBibtex = auxContent.includes('\\citation') || auxContent.includes('\\bibdata');
    } catch { /* skip */ }

    if (needsBibtex) {
      this.log('Running bibtex…');
      await runOnce(bibtex, [mainTex.replace(/\.tex$/i, '')]);
    }

    // --- Pass 2 ---
    this.log('Pass 2…');
    await runOnce(pdflatex, args);

    // Check if another pass is needed ("Rerun" in log)
    const logFile = path.join(this.dir, mainTex.replace(/\.tex$/i, '.log'));
    let needsRerun = false;
    try {
      const logContent = fs.readFileSync(logFile, 'utf8');
      needsRerun = /rerun/i.test(logContent);
    } catch { /* ignore */ }

    if (needsRerun) {
      this.log('Pass 3 (references changed)…');
      await runOnce(pdflatex, args);
    }

    const issues = this._parseLogIssues(allOutput, mainTex);

    if (fs.existsSync(pdfPath)) {
      const hadErrors = issues.errors && issues.errors.length > 0;
      this.log(hadErrors ? 'Compilation finished with errors' : 'Compilation succeeded ✓');
      return { ok: true, pdf: pdfPath, log: allOutput, ...issues };
    }

    this.log('Compilation finished but PDF not found', 'warn');
    return { ok: false, log: allOutput, error: 'PDF not generated', ...issues };
  }

  /**
   * Parse pdflatex log output for errors and warnings with line numbers.
   * @returns {{ errors: Array<{file,line,message}>, warnings: Array<{file,line,message}> }}
   */
  _parseLogIssues (logText, mainTex) {
    const errors   = [];
    const warnings = [];
    if (!logText) return { errors, warnings };

    for (const line of logText.split('\n')) {
      // file:line: ...Error...
      const errMatch = line.match(/^\.\/(.+?):(\d+):\s+(.+Error.+)$/i);
      if (errMatch) {
        errors.push({ file: errMatch[1], line: parseInt(errMatch[2]), message: errMatch[3].trim() });
        continue;
      }

      // file:line: Emergency stop / Fatal error
      const fatalMatch = line.match(/^\.\/(.+?):(\d+):\s+(Emergency stop|Fatal error)/i);
      if (fatalMatch) {
        errors.push({ file: fatalMatch[1], line: parseInt(fatalMatch[2]), message: fatalMatch[3].trim() });
        continue;
      }

      // LaTeX Warning: ... on input line N.
      const warnMatch = line.match(/LaTeX Warning:\s+(.+?)(?:on input line (\d+))?/i);
      if (warnMatch) {
        warnings.push({ file: mainTex, line: warnMatch[2] ? parseInt(warnMatch[2]) : null, message: warnMatch[1].trim() });
        continue;
      }

      // Underfull / Overfull box warnings
      const boxMatch = line.match(/((?:Under|Over)full \\[hv]box .+?) (?:in paragraph )?at lines? (\d+)/i);
      if (boxMatch) {
        warnings.push({ file: mainTex, line: parseInt(boxMatch[2]), message: boxMatch[1].trim() });
      }
    }

    return { errors, warnings };
  }

  /** Kill any running compilation */
  dispose () {
    if (this._proc) {
      this._proc.kill();
      this._proc = null;
    }
  }
}

module.exports = { LatexCompiler };
