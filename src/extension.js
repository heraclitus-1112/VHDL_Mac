'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const core = require('./core');
const generator = require('./generate');
const { SurferViewer } = require('./viewer');
const { InteractiveSession, durationParts } = require('./interactive');
const os = require('node:os');
let activeInstance;
function createExtension(vscode, context) {
  const locks = new Map();
  const sessions = new Map();
  const output = vscode.window.createOutputChannel('NVC 仿真');
  const viewer = new SurferViewer(vscode, context, message => output.appendLine(message));
  context.subscriptions.push(viewer);
  const diagnostics = vscode.languages.createDiagnosticCollection('nvc');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.text = '$(play) NVC 仿真'; status.tooltip = '运行当前项目 VHDL 测试平台'; status.command = 'nvcRunner.run'; status.show();
  context.subscriptions.push(output, diagnostics, status);
  async function selectFolder(uri) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) throw new Error('请先打开包含 VHDL 源文件的文件夹。');
    const selectedUri = uri?.fsPath ? uri : vscode.window.activeTextEditor?.document.uri;
    const activeFolder = selectedUri && vscode.workspace.getWorkspaceFolder(selectedUri);
    if (activeFolder) return activeFolder;
    if (folders.length === 1) return folders[0];
    const choice = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { title: '选择 VHDL 仿真工作区' });
    return choice?.folder;
  }
  function checkTrust() { if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区，NVC 才能保存文件和执行仿真。'); }
  async function withProject(uri, running, action) {
    try {
      checkTrust();
      const folder = await selectFolder(uri); if (!folder) return;
      if (folder.uri.scheme !== 'file') throw new Error('NVC Runner 需要本地文件工作区。');
      const root = await fs.realpath(folder.uri.fsPath);
      checkTrust();
      // Map reservation occurs synchronously before the first save/configuration await.
      if (locks.has(root)) throw new Error('这个项目正在运行或配置，请等待完成，或取消当前仿真。');
      if (sessions.has(root)) throw new Error('这个项目已有交互仿真会话，请先运行“NVC: 结束交互仿真”再重新编译。');
      const entry = { controller: new AbortController(), running };
      locks.set(root, entry);
      try { return await action(folder, root, entry.controller); }
      finally { locks.delete(root); }
    } catch (error) {
      if (error.name === 'AbortError') output.appendLine('仿真已取消。');
      else { output.appendLine(error.message); await vscode.window.showErrorMessage(error.message); }
    }
  }
  async function configPath(root) {
    const filename = path.join(root, 'vhdl.sim.json');
    try { const info = await fs.lstat(filename); if (info.isSymbolicLink() || !info.isFile()) throw new Error('vhdl.sim.json 必须是普通配置文件，不能是符号链接或目录。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return filename;
  }
  async function saveProjectDocuments(folder, root) {
    for (const document of vscode.workspace.textDocuments) {
      if (!document.isDirty || document.uri.scheme !== 'file') continue;
      const selected = vscode.workspace.getWorkspaceFolder(document.uri);
      if (selected?.uri.fsPath !== folder.uri.fsPath) continue;
      let real;
      try { real = await fs.realpath(document.uri.fsPath); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        real = path.join(await fs.realpath(path.dirname(document.uri.fsPath)), path.basename(document.uri.fsPath));
      }
      if (!core.within(root, real)) throw new Error(`文件实际路径超出工作区，已停止保存：${document.uri.fsPath}`);
      checkTrust();
      if (!(await document.save())) throw new Error(`无法保存 ${document.uri.fsPath}，已停止仿真。`);
    }
  }
  function updateDiagnostics(text, root) {
    for (const [filename] of diagnosticFiles) if (core.within(root, filename)) { diagnostics.delete(vscode.Uri.file(filename)); diagnosticFiles.delete(filename); }
    const grouped = new Map();
    for (const parsed of core.parseDiagnostics(text, root)) {
      const items = grouped.get(parsed.filePath) ?? [];
      const range = new vscode.Range(parsed.line, parsed.column, parsed.line, parsed.column + 1);
      const item = new vscode.Diagnostic(range, parsed.message, parsed.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
      item.source = 'NVC'; items.push(item); grouped.set(parsed.filePath, items);
    }
    for (const [filename, items] of grouped) { diagnostics.set(vscode.Uri.file(filename), items); diagnosticFiles.set(filename, true); }
  }
  const diagnosticFiles = new Map();
  async function configure(uri) {
    const saved = await withProject(uri, false, async (_, root) => {
      const filename = await configPath(root);
      const sources = await core.discoverSources(root);
      if (!sources.length) throw new Error('工作区没有 .vhd/.vhdl 源文件。请先创建设计和测试平台。');
      const selected = await vscode.window.showQuickPick(sources, { title: '选择参与仿真的源文件', canPickMany: true, ignoreFocusOut: true });
      if (!selected) return;
      if (!selected.length) throw new Error('至少需要选择一个 VHDL 源文件。');
      const remaining = [...selected]; const ordered = [];
      while (remaining.length) {
        const next = await vscode.window.showQuickPick(remaining, { title: `编译顺序 ${ordered.length + 1}/${selected.length}：选择下一个源文件`, placeHolder: '先选 package/设计依赖，最后选测试平台', ignoreFocusOut: true });
        if (next === undefined) return;
        ordered.push(next); remaining.splice(remaining.indexOf(next), 1);
      }
      const top = await vscode.window.showInputBox({ title: '确认顶层测试平台实体名称', value: path.basename(ordered.at(-1)).replace(/\.vhdl?$/i, ''), ignoreFocusOut: true, validateInput: value => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/i.test(value) ? undefined : '请输入有效的 VHDL 基本实体名称' });
      if (top === undefined) return;
      const standard = await vscode.window.showQuickPick(['2008', '2002', '1993'], { title: '选择 VHDL 标准', ignoreFocusOut: true }); if (!standard) return;
      const stopTime = await vscode.window.showInputBox({ title: '仿真停止时间', value: '1us', ignoreFocusOut: true, validateInput: value => /^[1-9][0-9]*(fs|ps|ns|us|ms|sec)$/.test(value) ? undefined : '正整数加 fs/ps/ns/us/ms/sec，例如 1us' });
      if (stopTime === undefined) return;
      const config = core.validateConfig({ sources: ordered, top, standard, stopTime, libraryPaths: [] });
      await core.resolveProject(root, config);
      try {
        await fs.stat(filename);
        const choice = await vscode.window.showInformationMessage('替换当前 vhdl.sim.json 配置？', { modal: true }, '替换');
        if (choice !== '替换') return;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      checkTrust(); await configPath(root);
      const temporary = path.join(root, `.vhdl-sim-${randomUUID()}.tmp`);
      try { await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' }); await fs.rename(temporary, filename); }
      finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      output.appendLine(`已保存配置：${filename}`);
      return true;
    });
    if (saved) await vscode.window.showInformationMessage('VHDL 仿真配置已保存，点击播放按钮即可运行。');
  }
  async function run(uri) {
    return withProject(uri, true, async (folder, root, controller) => {
      // Reject unsafe configuration before saving (it may alias a user's VHDL source).
      const filename = await configPath(root);
      await saveProjectDocuments(folder, root);
      let config;
      try { config = JSON.parse(await fs.readFile(filename, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error('缺少 vhdl.sim.json。请运行“NVC: 配置 VHDL 仿真”创建编译顺序和测试平台配置。');
        if (error instanceof SyntaxError) throw new Error(`vhdl.sim.json JSON 格式错误：${error.message}`);
        throw error;
      }
      core.validateConfig(config);
      const executable = await core.resolveNvc(vscode.workspace.getConfiguration('nvcRunner', folder.uri).get('nvcPath', ''));
      const surfer = vscode.extensions.getExtension('surfer-project.surfer');
      if (!surfer) throw new Error('缺少官方 Surfer 扩展，请安装 surfer-project.surfer 后重试。');
      output.show(true); output.appendLine(`\n项目：${root}\nNVC：${executable}`);
      return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'NVC VHDL 仿真', cancellable: true }, async (progress, token) => {
        const disposable = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try {
          checkTrust();
          const result = await core.runSimulation({ executable, projectDir: root, config, signal: controller.signal, onOutput: text => output.append(text), onStage: (stage, args) => { progress.report({ message: { analysis: '分析源文件', elaboration: '展开测试平台', simulation: '运行仿真' }[stage] }); output.appendLine(`\n${executable} ${args.map(arg => JSON.stringify(arg)).join(' ')}`); } });
          updateDiagnostics(result.output, root);
          await surfer.activate();
          if (controller.signal.aborted) { const error = new Error('仿真已取消。'); error.name = 'AbortError'; throw error; }
          const windowMode = vscode.workspace.getConfiguration('nvcRunner', folder.uri).get('waveformWindow', 'newWindow');
          await viewer.show(result, windowMode, vscode.workspace.getConfiguration('nvcRunner', folder.uri).get('preserveWaveformLayout', true));
          output.appendLine(`\n本次波形：${result.wavePath}`);
          return result;
        } catch (error) { if (error.output !== undefined) updateDiagnostics(error.output, root); throw error; }
        finally { disposable.dispose(); }
      });
    });
  }
  async function cancel(uri) {
    const folder = await selectFolder(uri); if (!folder) return;
    const root = await fs.realpath(folder.uri.fsPath);
    const entry = locks.get(root);
    if (entry?.running) entry.controller.abort();
    else await vscode.window.showInformationMessage('当前项目没有正在运行的 NVC 仿真。');
  }
  async function generate(uri) {
    const sourceUri = uri?.fsPath ? uri : vscode.window.activeTextEditor?.document.uri;
    const generated = await withProject(sourceUri, false, (_, root) => generator.generateWizard(vscode, root, sourceUri));
    if (!generated) return;
    output.appendLine(`已生成测试平台：${generated.filename}`);
    const choice = await vscode.window.showQuickPick(['设为仿真顶层', '仅生成文件'], { title: 'Testbench 已生成：下一步', ignoreFocusOut: true });
    if (choice === '设为仿真顶层') {
      const configured = await withProject(vscode.Uri.file(generated.source), false, (_, root) => generator.setSimulationTarget(vscode, root, generated));
      if (configured) { output.appendLine(`已设置仿真顶层：${configured.top}`); await vscode.window.showInformationMessage('测试平台与配置已就绪，点击播放按钮运行。输入激励的功能正确性请通过 assert 检查。'); }
    }
    return generated;
  }
  function sessionState(root) {
    const session = sessions.get(root);
    if (!session) return viewer.setSession(root, undefined);
    const now = BigInt(session.now), ns = now / 1000000n, fraction = (now % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
    const running = session.busy || session.continuing;
    return viewer.setSession(root, { nowText: `${ns}${fraction ? `.${fraction}` : ''} ns`, running, state: session.finished ? '测试平台已结束' : running ? '运行中（段末暂停）' : '已暂停' });
  }
  async function startInteractive(uri) {
    return withProject(uri, true, async (folder, root, controller) => {
      const filename = await configPath(root); await saveProjectDocuments(folder, root);
      const config = core.validateConfig(JSON.parse(await fs.readFile(filename, 'utf8')));
      const settings = vscode.workspace.getConfiguration('nvcRunner', folder.uri);
      const executable = await core.resolveNvc(settings.get('interactiveNvcPath', '') || path.join(os.homedir(), '.local/share/vhdl-mac/nvc-interactive-livewave/bin/nvc'));
      output.show(true); output.appendLine(`\n启动交互仿真：${root}\nNVC：${executable}`);
      let session, sessionOutput = '';
      session = await InteractiveSession.start({ executable, projectDir: root, config, signal: controller.signal,
        onOutput: text => { output.append(text); sessionOutput = (sessionOutput + text).slice(-1048576); updateDiagnostics(sessionOutput, root); },
        onTime: () => sessionState(root),
        onWave: async result => { await viewer.show(result, settings.get('waveformWindow', 'newWindow'), settings.get('preserveWaveformLayout', true)); await viewer.waitLoaded(root); },
        onExit: () => { if (sessions.get(root) === session) { sessions.delete(root); sessionState(root); } }
      });
      if (!session.waveSupported) { session.close(); throw new Error('当前交互 NVC 缺少原生波形快照支持。请按 tools/build-nvc-interactive.sh 安装交互版本，或使用普通仿真。'); }
      if (config.dumpArrays) output.appendLine('dumpArrays 当前只应用于普通批仿真，交互会话暂不支持嵌套数组波形。');
      sessions.set(root, session); await sessionState(root);
      try { await session.run('100ns'); await sessionState(root); }
      catch (error) { session.close(); sessions.delete(root); await sessionState(root); throw error; }
      output.appendLine('交互会话已启动。波形窗口上方可运行一段、继续、暂停、强制/解除输入。');
      return session;
    });
  }
  async function controlInteractive(root, action) {
    try {
      checkTrust();
      const session = sessions.get(root); if (!session) throw new Error('请先运行“NVC: 启动交互仿真”。');
      if (action === 'pause') { session.pause(); output.appendLine('已请求暂停，将在当前运行段结束后生效。'); return; }
      if (action === 'stop') { session.close(); sessions.delete(root); await sessionState(root); output.appendLine('交互会话已结束。'); return; }
      if (action === 'step' || action === 'continue') {
        session.checkIdle();
        const duration = await vscode.window.showInputBox({ title: action === 'step' ? '推进仿真时间' : '连续运行：每段时长', value: '100ns', prompt: '正整数加单位，例如 100ns。连续运行可在段末暂停。', ignoreFocusOut: true, validateInput: value => { try { durationParts(value); } catch (error) { return error.message; } } });
        if (duration === undefined) return;
        const running = action === 'step' ? session.run(duration) : session.continue(duration);
        await sessionState(root);
        try {
          const result = await running;
          if (result?.idle) {
            const message = session.pendingEvents ? `运行段小于下一事件间隔，已暂停。下个事件在 ${session.nextTime} fs，请选择更长的运行时长。` : '当前没有新的定时事件，已暂停。可强制输入后再运行。';
            output.appendLine(message); await vscode.window.showInformationMessage(message);
          }
        } finally { await sessionState(root); }
        return;
      }
      session.checkIdle();
      const signals = await session.signals();
      const signal = await vscode.window.showQuickPick(signals, { title: { force: '选择要强制的信号', release: '选择要解除强制的信号', inspect: '选择要读取的信号' }[action], ignoreFocusOut: true });
      if (!signal) return;
      if (action === 'force') {
        const description = await session.describe(signal), current = await session.examine(signal);
        const value = await vscode.window.showInputBox({ title: `强制 ${signal} (${description.type})`, value: current, prompt: "逻辑值：'0'、'1'；向量：\"0101\"。强制持续到解除或结束会话。", ignoreFocusOut: true });
        if (value === undefined) return;
        await session.force(signal, value); output.appendLine(`强制 ${signal} = ${value}；再运行一段以观察电路响应。`);
      } else if (action === 'release') { await session.release(signal); output.appendLine(`已解除 ${signal} 的强制；再运行一段观察响应。`); }
      else { const value = await session.examine(signal); output.appendLine(`${signal} = ${value}（${session.now} fs）`); await vscode.window.showInformationMessage(`${signal} = ${value}`); }
    } catch (error) { output.appendLine(error.message); await vscode.window.showErrorMessage(error.message); }
  }
  viewer.onControl = controlInteractive;
  async function controlFromCommand(uri, action) { const folder = await selectFolder(uri); if (folder) await controlInteractive(await fs.realpath(folder.uri.fsPath), action); }
  context.subscriptions.push(vscode.commands.registerCommand('nvcRunner.configure', configure), vscode.commands.registerCommand('nvcRunner.run', run), vscode.commands.registerCommand('nvcRunner.cancel', cancel), vscode.commands.registerCommand('nvcRunner.generateTestbench', generate));
  context.subscriptions.push(vscode.commands.registerCommand('nvcRunner.startInteractive', startInteractive));
  for (const [command, action] of Object.entries({ stepInteractive: 'step', continueInteractive: 'continue', pauseInteractive: 'pause', forceSignal: 'force', releaseSignal: 'release', examineSignal: 'inspect', stopInteractive: 'stop' })) context.subscriptions.push(vscode.commands.registerCommand(`nvcRunner.${command}`, uri => controlFromCommand(uri, action)));
  return { dispose() { for (const entry of locks.values()) entry.controller.abort(); for (const session of sessions.values()) session.close(); }, run, configure, cancel, generate, startInteractive, controlInteractive };
}
function activate(context) { activeInstance = createExtension(require('vscode'), context); context.subscriptions.push(activeInstance); }
function deactivate() { activeInstance?.dispose(); activeInstance = undefined; }
module.exports = { activate, deactivate, createExtension };
