'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const core = require('./core');
const generator = require('./generate');
const { chooseArchitecture } = require('./architecture');
const { SurferViewer } = require('./viewer');
const { InteractiveSession, durationParts } = require('./interactive');
const os = require('node:os');
let activeInstance;
function createExtension(vscode, context) {
  const locks = new Map();
  const sessions = new Map();
  const output = vscode.window.createOutputChannel('NVC Simulation');
  const viewer = new SurferViewer(vscode, context, message => output.appendLine(message));
  context.subscriptions.push(viewer);
  const diagnostics = vscode.languages.createDiagnosticCollection('nvc');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.text = '$(play) NVC Simulation'; status.tooltip = 'Run the VHDL testbench for the current project'; status.command = 'nvcRunner.run'; status.show();
  context.subscriptions.push(output, diagnostics, status);
  async function selectFolder(uri) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) throw new Error('Open a folder containing VHDL source files first.');
    const selectedUri = uri?.fsPath ? uri : vscode.window.activeTextEditor?.document.uri;
    const activeFolder = selectedUri && vscode.workspace.getWorkspaceFolder(selectedUri);
    if (activeFolder) return activeFolder;
    if (folders.length === 1) return folders[0];
    const choice = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { title: 'Select a VHDL simulation workspace' });
    return choice?.folder;
  }
  function checkTrust() { if (!vscode.workspace.isTrusted) throw new Error('Trust the current workspace before NVC can save files and run simulations.'); }
  async function withProject(uri, running, action) {
    try {
      checkTrust();
      const folder = await selectFolder(uri); if (!folder) return;
      if (folder.uri.scheme !== 'file') throw new Error('NVC Runner requires a workspace on the local file system.');
      const root = await fs.realpath(folder.uri.fsPath);
      checkTrust();
      // Map reservation occurs synchronously before the first save/configuration await.
      if (locks.has(root)) throw new Error('This project is already running or being configured. Wait for it to finish, or cancel the current simulation.');
      if (sessions.has(root)) throw new Error('This project already has an interactive simulation session. Run "NVC: End Interactive Simulation" before recompiling.');
      const entry = { controller: new AbortController(), running };
      locks.set(root, entry);
      try { return await action(folder, root, entry.controller); }
      finally { locks.delete(root); }
    } catch (error) {
      if (error.name === 'AbortError') output.appendLine('Simulation cancelled.');
      else { output.appendLine(error.message); await vscode.window.showErrorMessage(error.message); }
    }
  }
  async function configPath(root) {
    const filename = path.join(root, 'vhdl.sim.json');
    try { const info = await fs.lstat(filename); if (info.isSymbolicLink() || !info.isFile()) throw new Error('vhdl.sim.json must be a regular configuration file, not a symbolic link or directory.'); }
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
      if (!core.within(root, real)) throw new Error(`The resolved file path is outside the workspace. Saving stopped: ${document.uri.fsPath}`);
      checkTrust();
      if (!(await document.save())) throw new Error(`Cannot save ${document.uri.fsPath}. Simulation stopped.`);
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
      let previousStopTime, previous;
      try {
        previous = JSON.parse(await fs.readFile(filename, 'utf8'));
        const value = previous?.stopTime ?? '1us';
        if (value === 'all' || typeof value === 'string' && /^[1-9][0-9]*(fs|ps|ns|us|ms|sec)$/.test(value)) previousStopTime = value;
      } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      const sources = await core.discoverSources(root);
      if (!sources.length) throw new Error('The workspace has no .vhd/.vhdl source files. Create a design and testbench first.');
      const selected = await vscode.window.showQuickPick(sources, { title: 'Select source files for simulation', canPickMany: true, ignoreFocusOut: true });
      if (!selected) return;
      if (!selected.length) throw new Error('Select at least one VHDL source file.');
      const remaining = [...selected]; const ordered = [];
      while (remaining.length) {
        const next = await vscode.window.showQuickPick(remaining, { title: `Compilation order ${ordered.length + 1}/${selected.length}: Select the next source file`, placeHolder: 'Select packages and design dependencies first, then the testbench', ignoreFocusOut: true });
        if (next === undefined) return;
        ordered.push(next); remaining.splice(remaining.indexOf(next), 1);
      }
      const top = await vscode.window.showInputBox({ title: 'Confirm the top-level testbench entity name', value: path.basename(ordered.at(-1)).replace(/\.vhdl?$/i, ''), ignoreFocusOut: true, validateInput: value => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/i.test(value) ? undefined : 'Enter a valid VHDL basic entity name' });
      if (top === undefined) return;
      const resolved = await core.resolveProject(root, { sources: ordered, top });
      const selectedArchitecture = await chooseArchitecture(vscode, resolved.sources, top, previous?.top?.toLowerCase() === top.toLowerCase() ? previous.architecture : undefined, false);
      if (!selectedArchitecture) return;
      const standard = await vscode.window.showQuickPick(['2008', '2002', '1993'], { title: 'Select the VHDL standard', ignoreFocusOut: true }); if (!standard) return;
      const defaultMode = previousStopTime === undefined || previousStopTime === 'all' ? 'all' : 'time';
      const modes = [
        { id: 'all', label: 'Run All', description: 'Run until finish, a terminating failure, or no future events', picked: defaultMode === 'all' },
        { id: 'time', label: 'Run until specified time', description: 'Use a positive integer time limit', picked: defaultMode === 'time' }
      ];
      // The current mode is first so the single-choice picker initially selects it.
      modes.sort((a, b) => Number(b.picked) - Number(a.picked));
      const mode = await vscode.window.showQuickPick(modes, { title: 'Select simulation run mode', ignoreFocusOut: true });
      if (!mode) return;
      let stopTime = 'all';
      if (mode.id === 'time') {
        stopTime = await vscode.window.showInputBox({ title: 'Simulation stop time', value: previousStopTime && previousStopTime !== 'all' ? previousStopTime : '1us', ignoreFocusOut: true, validateInput: value => /^[1-9][0-9]*(fs|ps|ns|us|ms|sec)$/.test(value) ? undefined : 'A positive integer followed by fs/ps/ns/us/ms/sec, for example 1us' });
        if (stopTime === undefined) return;
      }
      const config = core.validateConfig({ sources: ordered, top, ...selectedArchitecture, standard, stopTime, libraryPaths: [] });
      await core.resolveProject(root, config);
      try {
        await fs.stat(filename);
        const choice = await vscode.window.showInformationMessage('Replace the current vhdl.sim.json configuration?', { modal: true }, 'Replace');
        if (choice !== 'Replace') return;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      checkTrust(); await configPath(root);
      const temporary = path.join(root, `.vhdl-sim-${randomUUID()}.tmp`);
      try { await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' }); await fs.rename(temporary, filename); }
      finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      output.appendLine(`Configuration saved: ${filename}`);
      return true;
    });
    if (saved) await vscode.window.showInformationMessage('VHDL simulation configuration saved. Click the play button to run.');
  }
  async function selectArchitecture(uri) {
    const saved = await withProject(uri, false, async (_, root) => {
      const filename = await configPath(root);
      const dirtyConfig = () => vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.fsPath === filename);
      if (dirtyConfig()) throw new Error('vhdl.sim.json has unsaved changes. Save it before selecting an architecture.');
      let snapshot;
      try { snapshot = await fs.readFile(filename, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') throw new Error('Run NVC: Configure VHDL Simulation before selecting an architecture.'); throw error; }
      const config = core.validateConfig(JSON.parse(snapshot));
      const resolved = await core.resolveProject(root, config);
      const choice = await chooseArchitecture(vscode, resolved.sources, config.top, config.architecture);
      if (!choice) return;
      const next = { ...config }; delete next.architecture;
      if (choice.architecture !== undefined) next.architecture = choice.architecture;
      core.validateConfig(next);
      checkTrust(); await configPath(root);
      if (dirtyConfig()) throw new Error('The configuration has unsaved changes. Update stopped.');
      if (await fs.readFile(filename, 'utf8') !== snapshot) throw new Error('The configuration changed during selection. Update stopped; please try again.');
      const temporary = path.join(root, `.vhdl-sim-${randomUUID()}.tmp`);
      try { await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' }); await fs.rename(temporary, filename); }
      finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      output.appendLine(`Simulation top: ${core.designTarget(next)}${next.architecture ? '' : ' (NVC default architecture)'}`);
      return next;
    });
    if (saved) await vscode.window.showInformationMessage(`Selected ${core.designTarget(saved)}. Click Play to run.`);
    return saved;
  }
  async function run(uri, stopTimeOverride) {
    return withProject(uri, true, async (folder, root, controller) => {
      // Reject unsafe configuration before saving (it may alias a user's VHDL source).
      const filename = await configPath(root);
      await saveProjectDocuments(folder, root);
      let config;
      try { config = JSON.parse(await fs.readFile(filename, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') throw new Error('vhdl.sim.json is missing. Run "NVC: Configure VHDL Simulation" to set the compilation order and testbench.');
        if (error instanceof SyntaxError) throw new Error(`Invalid JSON in vhdl.sim.json: ${error.message}`);
        throw error;
      }
      config = core.validateConfig(config);
      if (stopTimeOverride === 'all') config = { ...config, stopTime: 'all' };
      const executable = await core.resolveNvc(vscode.workspace.getConfiguration('nvcRunner', folder.uri).get('nvcPath', ''));
      const surfer = vscode.extensions.getExtension('surfer-project.surfer');
      if (!surfer) throw new Error('The official Surfer extension is missing. Install surfer-project.surfer and try again.');
      output.show(true); output.appendLine(`\nProject: ${root}\nNVC: ${executable}\nSimulation top: ${core.designTarget(config)}`);
      output.appendLine(config.stopTime === 'all' ? 'Run mode: Run All' : `Run mode: Run until specified time (${config.stopTime})`);
      return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'NVC VHDL Simulation', cancellable: true }, async (progress, token) => {
        const disposable = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) controller.abort();
        try {
          checkTrust();
          const result = await core.runSimulation({ executable, projectDir: root, config, signal: controller.signal, onOutput: text => output.append(text), onStage: (stage, args) => { progress.report({ message: { analysis: 'Analyzing source files', elaboration: 'Elaborating the testbench', simulation: 'Running simulation' }[stage] }); output.appendLine(`\n${executable} ${args.map(arg => JSON.stringify(arg)).join(' ')}`); }, onResult: async pending => {
            updateDiagnostics(pending.output, root);
            await surfer.activate();
            if (controller.signal.aborted) { const error = new Error('Simulation cancelled.'); error.name = 'AbortError'; throw error; }
            const windowMode = vscode.workspace.getConfiguration('nvcRunner', folder.uri).get('waveformWindow', 'newWindow');
            return viewer.show(pending, windowMode, vscode.workspace.getConfiguration('nvcRunner', folder.uri).get('preserveWaveformLayout', true), controller.signal);
          } });
          output.appendLine(`\nWaveform: ${result.wavePath}`);
          return result;
        } catch (error) { if (error.output !== undefined) updateDiagnostics(error.output, root); throw error; }
        finally { disposable.dispose(); }
      });
    });
  }
  function runAll(uri) { return run(uri, 'all'); }
  async function cancel(uri) {
    const folder = await selectFolder(uri); if (!folder) return;
    const root = await fs.realpath(folder.uri.fsPath);
    const entry = locks.get(root);
    if (entry?.running) entry.controller.abort();
    else await vscode.window.showInformationMessage('No NVC simulation is running for the current project.');
  }
  async function generate(uri) {
    const sourceUri = uri?.fsPath ? uri : vscode.window.activeTextEditor?.document.uri;
    const generated = await withProject(sourceUri, false, (_, root) => generator.generateWizard(vscode, root, sourceUri));
    if (!generated) return;
    output.appendLine(`Testbench created: ${generated.filename}`);
    const choice = await vscode.window.showQuickPick(['Set simulation top', 'Create file only'], { title: 'Testbench created: Next step', ignoreFocusOut: true });
    if (choice === 'Set simulation top') {
      const configured = await withProject(vscode.Uri.file(generated.source), false, (_, root) => generator.setSimulationTarget(vscode, root, generated));
      if (configured) { output.appendLine(`Simulation top set: ${configured.top}`); await vscode.window.showInformationMessage('The testbench and configuration are ready. Click the play button to run. Use assertions to check that the input stimuli produce the expected behavior.'); }
    }
    return generated;
  }
  function sessionState(root) {
    const session = sessions.get(root);
    if (!session) return viewer.setSession(root, undefined);
    const now = BigInt(session.now), ns = now / 1000000n, fraction = (now % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
    const running = session.busy || session.continuing;
    return viewer.setSession(root, { nowText: `${ns}${fraction ? `.${fraction}` : ''} ns`, running, state: session.finished ? 'Testbench finished' : running ? 'Running (pause takes effect after the current segment)' : 'Paused' });
  }
  async function startInteractive(uri) {
    return withProject(uri, true, async (folder, root, controller) => {
      const filename = await configPath(root); await saveProjectDocuments(folder, root);
      const config = core.validateConfig(JSON.parse(await fs.readFile(filename, 'utf8')));
      const settings = vscode.workspace.getConfiguration('nvcRunner', folder.uri);
      const executable = await core.resolveNvc(settings.get('interactiveNvcPath', '') || path.join(os.homedir(), '.local/share/vhdl-mac/nvc-interactive-livewave/bin/nvc'));
      output.show(true); output.appendLine(`\nStarting interactive simulation: ${root}\nNVC: ${executable}\nSimulation top: ${core.designTarget(config)}`);
      let session, sessionOutput = '';
      session = await InteractiveSession.start({ executable, projectDir: root, config, signal: controller.signal,
        onOutput: text => { output.append(text); sessionOutput = (sessionOutput + text).slice(-1048576); updateDiagnostics(sessionOutput, root); },
        onTime: () => sessionState(root),
        onWave: async result => {
          const rollback = await viewer.show(result, settings.get('waveformWindow', 'newWindow'), settings.get('preserveWaveformLayout', true), controller.signal);
          try {
            await viewer.waitLoaded(root);
            if (controller.signal.aborted) { const error = new Error('Simulation cancelled.'); error.name = 'AbortError'; throw error; }
          }
          catch (error) {
            try { await rollback?.(); } catch (restoreError) { output.appendLine(`Warning: Failed to restore the previous interactive waveform: ${restoreError.message}`); }
            throw error;
          }
        },
        onExit: () => { if (sessions.get(root) === session) { sessions.delete(root); sessionState(root); } }
      });
      if (!session.waveSupported) { session.close(); throw new Error('This interactive NVC build lacks native waveform snapshot support. Install the interactive build using tools/build-nvc-interactive.sh, or use batch simulation.'); }
      if (config.dumpArrays) output.appendLine('dumpArrays currently applies only to batch simulation. Interactive sessions do not yet support nested array waveforms.');
      sessions.set(root, session); await sessionState(root);
      try { await session.run('100ns'); await sessionState(root); }
      catch (error) { session.close(); sessions.delete(root); await sessionState(root); throw error; }
      output.appendLine('Interactive session started. Use the controls above the waveform to run a segment, continue, pause, force inputs, or release forced inputs.');
      return session;
    });
  }
  async function controlInteractive(root, action) {
    try {
      checkTrust();
      const session = sessions.get(root); if (!session) throw new Error('Run "NVC: Start Interactive Simulation" first.');
      if (action === 'pause') { session.pause(); output.appendLine('Pause requested. It will take effect after the current segment.'); return; }
      if (action === 'stop') { session.close(); sessions.delete(root); await sessionState(root); output.appendLine('Interactive session ended.'); return; }
      if (action === 'step' || action === 'continue') {
        session.checkIdle();
        const duration = await vscode.window.showInputBox({ title: action === 'step' ? 'Advance simulation time' : 'Continuous run: Segment duration', value: '100ns', prompt: 'A positive integer followed by a time unit, for example 100ns. Continuous runs can pause after a segment.', ignoreFocusOut: true, validateInput: value => { try { durationParts(value); } catch (error) { return error.message; } } });
        if (duration === undefined) return;
        const running = action === 'step' ? session.run(duration) : session.continue(duration);
        await sessionState(root);
        try {
          const result = await running;
          if (result?.idle) {
            const message = session.pendingEvents ? `Paused because the segment is shorter than the interval to the next event. The next event is at ${session.nextTime} fs. Choose a longer segment duration.` : 'Paused because there are no new timed events. Force an input, then run again.';
            output.appendLine(message); await vscode.window.showInformationMessage(message);
          }
        } finally { await sessionState(root); }
        return;
      }
      session.checkIdle();
      const signals = await session.signals();
      const signal = await vscode.window.showQuickPick(signals, { title: { force: 'Select a signal to force', release: 'Select a signal to release', inspect: 'Select a signal to read' }[action], ignoreFocusOut: true });
      if (!signal) return;
      if (action === 'force') {
        const description = await session.describe(signal), current = await session.examine(signal);
        const value = await vscode.window.showInputBox({ title: `Force ${signal} (${description.type})`, value: current, prompt: "Logic values: '0', '1'; vectors: \"0101\". Forced values remain active until released or the session ends.", ignoreFocusOut: true });
        if (value === undefined) return;
        await session.force(signal, value); output.appendLine(`Force ${signal} = ${value}; run another segment to observe the circuit response.`);
      } else if (action === 'release') { await session.release(signal); output.appendLine(`Released ${signal}; run another segment to observe the response.`); }
      else { const value = await session.examine(signal); output.appendLine(`${signal} = ${value} (${session.now} fs)`); await vscode.window.showInformationMessage(`${signal} = ${value}`); }
    } catch (error) { output.appendLine(error.message); await vscode.window.showErrorMessage(error.message); }
  }
  viewer.onControl = controlInteractive;
  async function controlFromCommand(uri, action) { const folder = await selectFolder(uri); if (folder) await controlInteractive(await fs.realpath(folder.uri.fsPath), action); }
  context.subscriptions.push(vscode.commands.registerCommand('nvcRunner.configure', configure), vscode.commands.registerCommand('nvcRunner.selectArchitecture', selectArchitecture), vscode.commands.registerCommand('nvcRunner.run', run), vscode.commands.registerCommand('nvcRunner.runAll', runAll), vscode.commands.registerCommand('nvcRunner.cancel', cancel), vscode.commands.registerCommand('nvcRunner.generateTestbench', generate));
  context.subscriptions.push(vscode.commands.registerCommand('nvcRunner.startInteractive', startInteractive));
  for (const [command, action] of Object.entries({ stepInteractive: 'step', continueInteractive: 'continue', pauseInteractive: 'pause', forceSignal: 'force', releaseSignal: 'release', examineSignal: 'inspect', stopInteractive: 'stop' })) context.subscriptions.push(vscode.commands.registerCommand(`nvcRunner.${command}`, uri => controlFromCommand(uri, action)));
  return { dispose() { for (const entry of locks.values()) entry.controller.abort(); for (const session of sessions.values()) session.close(); }, run, runAll, configure, cancel, generate, startInteractive, controlInteractive };
}
function activate(context) { activeInstance = createExtension(require('vscode'), context); context.subscriptions.push(activeInstance); }
function deactivate() { activeInstance?.dispose(); activeInstance = undefined; }
module.exports = { activate, deactivate, createExtension };
