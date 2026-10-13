'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { within } = require('./core');
const viewType = 'nvcRunner.waveformViewer';
class SurferViewer {
  constructor(vscode, context, warning = () => {}) {
    Object.assign(this, { vscode, context, warning }); this.entries = new Map(); this.pending = new Map(); this.sessions = new Map();
    if (vscode.window.registerCustomEditorProvider) context.subscriptions.push(vscode.window.registerCustomEditorProvider(viewType, this, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
  }
  openCustomDocument(uri) { return { uri, dispose() {} }; }
  stateKey(root) { return `surfer-layout:${root}`; }
  async show({ projectDir, wavePath }, mode = 'newWindow', preserve = true) {
    const root = await fs.realpath(projectDir), build = path.join(root, '.nvc-build');
    if (await fs.realpath(build) !== build) throw new Error('波形目录不能是符号链接。');
    const wave = await fs.realpath(wavePath);
    if (!within(build, wave) || !(await fs.stat(wave)).isFile()) throw new Error('波形必须是当前项目构建目录内的文件。');
    const marker = path.join(build, 'waveform.nvcwave');
    try { const info = await fs.lstat(marker); if (info.isSymbolicLink() || !info.isFile()) throw new Error('波形窗口记录不能是符号链接或目录。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path.join(build, `.viewer-${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, JSON.stringify({ wave: path.relative(build, wave), preserve }), { flag: 'wx' }); await fs.rename(temporary, marker); } finally { await fs.rm(temporary, { force: true }); }
    const old = this.entries.get(marker);
    if (old) {
      if (old.loaded) await this.snapshot(old);
      old.wave = wave; old.preserve = preserve; old.panel.reveal(undefined, false);
      if (old.ready) await this.load(old);
      return;
    }
    const uri = this.vscode.Uri.file(marker);
    let separate = mode !== 'beside';
    if (separate && !(await this.vscode.commands.getCommands(true)).includes('workbench.action.moveEditorToNewWindow')) { this.warning('当前 VS Code 不支持独立编辑器窗口，已并排显示。'); separate = false; }
    await this.vscode.commands.executeCommand('vscode.openWith', uri, viewType, { viewColumn: separate ? this.vscode.ViewColumn.Active : this.vscode.ViewColumn.Beside, preview: false });
    if (separate) try { await this.vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow', uri); } catch (error) { this.warning(`独立窗口打开失败：${error.message}`); }
  }
  async resolveCustomEditor(document, panel) {
    const marker = document.uri.fsPath, root = path.dirname(path.dirname(marker));
    const info = await fs.lstat(marker);
    if (info.isSymbolicLink() || path.basename(marker) !== 'waveform.nvcwave') throw new Error('无效的波形窗口记录。');
    const data = JSON.parse(await fs.readFile(marker, 'utf8'));
    if (typeof data.wave !== 'string' || path.isAbsolute(data.wave) || data.wave.split(/[\\/]/).includes('..') || !/\.(fst|vcd)$/i.test(data.wave)) throw new Error('无效的波形文件名。');
    const wave = await fs.realpath(path.join(path.dirname(marker), data.wave));
    if (!within(path.dirname(marker), wave)) throw new Error('波形实际路径超出项目构建目录。');
    const surfer = this.vscode.extensions.getExtension('surfer-project.surfer');
    if (!surfer) throw new Error('请安装官方 Surfer 扩展。');
    const assets = path.join(surfer.extensionUri.fsPath, 'surfer');
    const js = await fs.readFile(path.join(assets, 'surfer.js'), 'utf8');
    if (js && (!js.includes('function get_state') || !js.includes('function waves_loaded'))) throw new Error('当前 Surfer 版本不支持保留视图接口，请改用官方 Surfer 打开波形。');
    const entry = { panel, marker, root, wave, version: surfer.packageJSON.version, preserve: data.preserve !== false, ready: false, loaded: false };
    this.entries.set(marker, entry); panel.title = `波形 · ${path.basename(root)}`;
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.vscode.Uri.file(assets), this.vscode.Uri.file(path.dirname(marker))] };
    panel.webview.onDidReceiveMessage(async message => {
      try {
        if (message.command === 'ready') { entry.ready = true; await this.load(entry); }
        else if (message.command === 'loaded' && (!message.id || message.id === entry.loadId)) { entry.loaded = true; await this.setSession(root, this.sessions.get(root)); }
        else if (message.command === 'control' && ['step','continue','pause','force','release','inspect','stop'].includes(message.action)) await this.onControl?.(root, message.action);
        else if (message.command === 'state' && typeof message.state === 'string' && Buffer.byteLength(message.state) <= 8 * 1024 * 1024) {
          await this.context.workspaceState?.update(this.stateKey(root), { version: entry.version, state: message.state });
          this.pending.get(message.id)?.();
        } else if (message.command === 'error') this.warning(`Surfer：${String(message.message).slice(0, 2000)}`);
        else if (message.command === 'vscodeSaveStateFromWasm' && typeof message.data === 'string') {
          const target = await this.vscode.window.showSaveDialog({ defaultUri: this.vscode.Uri.file(path.join(root, 'waveform.ron')) });
          if (target) await this.vscode.workspace.fs.writeFile(target, Buffer.from(message.data));
        } else if (message.command === 'open-dialog') {
          const filters = message.kind === 'command_file' ? { 'Surfer 命令': ['sucl'] } : message.kind === 'state_file' ? { 'Surfer 状态': ['ron'] } : { '波形': ['fst','vcd'] };
          const files = await this.vscode.window.showOpenDialog({ canSelectMany: false, filters });
          if (files?.[0]) {
            if (['command_file','state_file'].includes(message.kind)) await panel.webview.postMessage({ command: 'open-data', kind: message.kind, bytes: Array.from(await this.vscode.workspace.fs.readFile(files[0])) });
            else await this.vscode.commands.executeCommand('vscode.openWith', files[0], 'surfer.waveformViewer', { viewColumn: this.vscode.ViewColumn.Active, preview: false });
          }
        }
      } catch (error) { this.warning(error.message); }
    });
    panel.onDidDispose(() => { this.entries.delete(marker); });
    const uri = filename => panel.webview.asWebviewUri(this.vscode.Uri.file(path.join(assets, filename))).toString();
    // Assets stay owned by the official extension. No network scripts or redistribution.
    panel.webview.html = await this.html(uri('surfer.js'), uri('surfer_bg.wasm'));
  }
  async load(entry) {
    const stored = this.context.workspaceState?.get(this.stateKey(entry.root));
    const restore = !entry.loaded && entry.preserve && stored?.version === entry.version ? stored.state : undefined;
    if (!entry.loaded && stored && stored.version !== entry.version) this.warning('Surfer 版本已变化，本次重新建立波形布局。');
    const keep = entry.loaded && entry.preserve;
    entry.loaded = false;
    entry.loadId = randomUUID();
    await entry.panel.webview.postMessage({ command: 'load', id: entry.loadId, url: entry.panel.webview.asWebviewUri(this.vscode.Uri.file(entry.wave)).toString(), name: path.basename(entry.wave), keep, restore });
  }
  async setSession(root, session) {
    if (session) this.sessions.set(root, session); else this.sessions.delete(root);
    const entry = this.entries.get(path.join(root, '.nvc-build/waveform.nvcwave'));
    if (entry?.ready) await entry.panel.webview.postMessage({ command: 'session', session });
  }
  async waitLoaded(root) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const entry = this.entries.get(path.join(root, '.nvc-build/waveform.nvcwave'));
      if (!entry || entry.loaded) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('波形显示超时，交互运行已暂停。请检查 Surfer 窗口。');
  }
  async snapshot(entry) {
    const id = randomUUID();
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(); }, 1500);
      this.pending.set(id, () => { clearTimeout(timer); this.pending.delete(id); resolve(); });
      entry.panel.webview.postMessage({ command: 'snapshot', id }).catch(() => { clearTimeout(timer); this.pending.delete(id); resolve(); });
    });
  }
  async html(js, wasm) {
    const bridge = await fs.readFile(path.join(__dirname, '../media/viewer.js'), 'utf8');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Surfer</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#404040}canvas{position:absolute;inset:0;width:100%;height:100%}body.interactive canvas{top:42px;height:calc(100% - 42px)}#controls{display:none;position:absolute;top:0;left:0;right:0;height:42px;align-items:center;gap:6px;padding:0 8px;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font:12px sans-serif}body.interactive #controls{display:flex}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:5px 8px;cursor:pointer}#error_container{position:absolute;inset:0;padding:20px;color:white;background:#300;display:none;overflow:auto;white-space:pre-wrap}</style></head><body><div id="controls"><span id="time"></span><button data-action="step">运行一段</button><button data-action="continue">继续</button><button data-action="pause">暂停</button><button data-action="force">强制输入</button><button data-action="release">解除强制</button><button data-action="inspect">读信号</button><button data-action="stop">结束会话</button></div><canvas id="the_canvas_id"></canvas><div id="loading_text" style="display:none"></div><div id="error_container"><pre id="error_message"></pre></div><script type="module">import init, {inject_message,get_state,waves_loaded} from ${JSON.stringify(js)};const wasm=${JSON.stringify(wasm)};${bridge}</script></body></html>`;
  }
  dispose() { for (const resolve of this.pending.values()) resolve(); this.pending.clear(); }
}
module.exports = { SurferViewer, viewType };
