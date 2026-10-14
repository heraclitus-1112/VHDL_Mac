'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const tb = require('./testbench');
const core = require('./core');
function validation(callback) { return value => { try { callback(value); return undefined; } catch (error) { return error.message; } }; }
function html(text) { return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
async function createTestbench(root, name, code) {
  if (!tb.identifier(name)) throw new Error('Invalid testbench entity name.');
  const filename = path.join(root, `${name}.vhd`);
  try { await fs.writeFile(filename, code, { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`${name}.vhd already exists. Use a different name.`); throw error; }
  return filename;
}
async function generateWizard(vscode, root, uri) {
  if (!uri || uri.scheme !== 'file' || !/\.vhdl?$/i.test(uri.fsPath)) throw new Error('Open or right-click the .vhd/.vhdl file for the design under test first.');
  const source = await fs.realpath(uri.fsPath);
  if (!core.within(root, source) || core.within(path.join(root, '.nvc-build'), source)) throw new Error('The design under test must be within the project and outside the build directory.');
  const document = await vscode.workspace.openTextDocument(uri);
  const entities = tb.parseEntities(document.getText());
  const entity = entities.length === 1 ? entities[0] : (await vscode.window.showQuickPick(entities.map(item => ({ label: item.name, entity: item })), { title: 'Select the entity under test', ignoreFocusOut: true }))?.entity;
  if (!entity) return;
  const overrides = {}, genericValues = {};
  for (const item of entity.generics) {
    const input = await vscode.window.showInputBox({ title: `Generic ${item.name} (${item.type})`, value: item.defaultValue ?? '', ignoreFocusOut: true, validateInput: validation(value => {
      const number = tb.integerExpression(value, genericValues);
      if (item.type.toLowerCase() === 'positive' && number < 1 || item.type.toLowerCase() === 'natural' && number < 0) throw new Error('The value is outside the generic range.');
    }) });
    if (input === undefined) return;
    overrides[item.name] = input; genericValues[item.name.toLowerCase()] = tb.integerExpression(input, genericValues);
  }
  const model = tb.instantiateEntity(entity, overrides);
  let architecture = model.architectures[0];
  if (model.architectures.length > 1) architecture = await vscode.window.showQuickPick(model.architectures, { title: 'Select the architecture under test', ignoreFocusOut: true });
  if (model.architectures.length > 1 && !architecture) return;
  const durationText = await vscode.window.showInputBox({ title: 'Test end time', value: '1us', prompt: 'All input changes must precede this time; the generated testbench calls finish at this time.', ignoreFocusOut: true, validateInput: validation(value => { if (!tb.timeFs(value)) throw new Error('The end time must be greater than zero.'); }) });
  if (durationText === undefined) return;
  const durationFs = tb.timeFs(durationText), duration = tb.timeLiteral(durationFs).replace(' ', '');
  const inputs = {};
  const inputPorts = model.ports.filter(port => port.mode === 'in');
  for (const [index, port] of inputPorts.entries()) {
    const clockName = /^(clk|clock|.*_clk)$/i.test(port.name);
    const choices = port.kind === 'std_logic' ? (clockName ? ['Periodic clock', 'Fixed value', 'Timed changes'] : ['Fixed value', 'Timed changes', 'Periodic clock']) : ['Fixed value', 'Timed changes'];
    const mode = await vscode.window.showQuickPick(choices, { title: `Input ${index + 1}/${inputPorts.length}: ${port.name} (${port.type})`, placeHolder: 'Configure each port; values remain unchanged until the next scheduled change.', ignoreFocusOut: true });
    if (!mode) return;
    if (mode === 'Timed changes') {
      const resetDefault = /^(rst|reset|.*_rst)$/i.test(port.name) && port.kind === 'std_logic' && durationFs > tb.timeFs('20ns') ? '0ns=1;20ns=0' : `0ns=${tb.defaultValue(port)}`;
      const value = await vscode.window.showInputBox({ title: `${port.name}: Time → value`, value: resetDefault, prompt: 'Example: 0ns=0;20ns=1;100ns=0. Vector example: 0ns=x"00";20ns=x"A5".', ignoreFocusOut: true, validateInput: validation(text => tb.parseEvents(port, text, durationFs)) });
      if (value === undefined) return; inputs[port.name] = { mode: 'events', value };
    } else {
      const value = await vscode.window.showInputBox({ title: `${port.name}: ${mode === 'Periodic clock' ? 'Initial clock value (0 or 1)' : 'Fixed input value'}`, value: tb.defaultValue(port), prompt: 'Logic: 0/1; vectors: decimal, "0101", or x"A5"; Boolean: true/false.', ignoreFocusOut: true, validateInput: validation(text => { tb.formatValue(port, text); if (mode === 'Periodic clock' && !/^'?([01])'?$/.test(text)) throw new Error('The initial clock value must be 0 or 1.'); }) });
      if (value === undefined) return;
      if (mode === 'Fixed value') inputs[port.name] = { mode: 'fixed', value };
      else {
        const start = await vscode.window.showInputBox({ title: `${port.name}: Clock start time`, value: '0ns', prompt: 'Keep the initial value until the start time, then toggle every half-period.', ignoreFocusOut: true, validateInput: validation(text => { if (tb.timeFs(text) >= durationFs) throw new Error('The start time must precede the end time.'); }) });
        if (start === undefined) return;
        const period = await vscode.window.showInputBox({ title: `${port.name}: Full clock period`, value: '10ns', ignoreFocusOut: true, validateInput: validation(text => { const p = tb.timeFs(text); if (!p || p % 2n || p / 2n >= durationFs - tb.timeFs(start)) throw new Error('The period must have an integer half-period in fs and allow at least one transition before the end time.'); }) });
        if (period === undefined) return; inputs[port.name] = { mode: 'clock', value, start, period };
      }
    }
  }
  const name = await vscode.window.showInputBox({ title: 'New testbench entity and filename', value: `tb_${model.name}`, prompt: 'Create the file in the project root; use a different name if the file already exists.', ignoreFocusOut: true, validateInput: async value => {
    if (!tb.identifier(value) || value.toLowerCase() === model.name.toLowerCase()) return 'Enter a valid name that differs from the entity under test.';
    try { await fs.lstat(path.join(root, `${value}.vhd`)); return 'The file already exists. Use a different name.'; } catch (error) { return error.code === 'ENOENT' ? undefined : error.message; }
  } });
  if (name === undefined) return;
  const code = tb.generateTestbench(model, { name, architecture, duration, inputs });
  const preview = vscode.window.createWebviewPanel('nvcTestbenchPreview', 'Testbench Generation Preview', vscode.ViewColumn.Active, {});
  preview.webview.html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>body{padding:20px;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background)}pre{white-space:pre-wrap;font-family:var(--vscode-editor-font-family)}</style><h2>${html(name)}.vhd</h2><p>Configured ${inputPorts.length} input ports. Add assertions to check outputs against the required behavior.</p><pre>${html(code)}</pre></html>`;
  let filename;
  try {
    if (await vscode.window.showInformationMessage(`Create ${name}.vhd? Input stimuli end at ${duration}; output assertions are not inferred automatically.`, { modal: true }, 'Create') !== 'Create') return;
    filename = await createTestbench(root, name, code);
  } finally { preview.dispose(); }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(filename)));
  return { filename, name, source, duration };
}
async function setSimulationTarget(vscode, root, result) {
  const filename = path.join(root, 'vhdl.sim.json');
  if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.fsPath === filename)) throw new Error('vhdl.sim.json has unsaved changes. Save it before using "Configure VHDL Simulation".');
  let config, snapshot;
  try {
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('vhdl.sim.json must be a regular file.');
    snapshot = await fs.readFile(filename, 'utf8');
    config = core.validateConfig(JSON.parse(snapshot));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = path.relative(root, result.source), generated = path.relative(root, result.filename);
  if (!config) {
    const candidates = (await core.discoverSources(root)).filter(item => item !== generated);
    const chosen = await vscode.window.showQuickPick(candidates.map(item => ({ label: item, picked: item === source })), { title: 'Select the design under test and its dependencies', canPickMany: true, ignoreFocusOut: true });
    if (!chosen) return;
    const remaining = chosen.map(item => item.label), ordered = [];
    if (!remaining.includes(source)) throw new Error('The source file for the design under test must be included.');
    while (remaining.length) {
      const next = await vscode.window.showQuickPick(remaining, { title: `Confirm source file order ${ordered.length + 1}/${chosen.length}`, placeHolder: 'Select dependencies first, then the design under test; the new testbench is added last.', ignoreFocusOut: true });
      if (next === undefined) return; ordered.push(next); remaining.splice(remaining.indexOf(next), 1);
    }
    config = { sources: ordered, top: result.name, standard: '2008', stopTime: result.duration, libraryPaths: [] };
  }
  const retained = [], missing = [];
  for (const item of config.sources.filter(item => item !== generated)) {
    try { await fs.lstat(path.join(root, item)); retained.push(item); }
    catch (error) { if (error.code === 'ENOENT') missing.push(item); else throw error; }
  }
  config = { ...config, sources: retained };
  if (!config.sources.includes(source)) config.sources.push(source);
  config.sources.push(generated); config.top = result.name; config.standard = '2008';
  if (tb.timeFs(config.stopTime) < tb.timeFs(result.duration)) config.stopTime = result.duration;
  core.validateConfig(config); await core.resolveProject(root, config);
  const cleanup = missing.length ? `\nDeleted source files will be removed from the configuration: ${missing.join(', ')}. If these dependencies are still needed, cancel and reconfigure.` : '';
  if (await vscode.window.showInformationMessage(`Set simulation top to ${config.top}, using VHDL-2008 with a stop time of ${config.stopTime}?\nCompilation order: ${config.sources.join(' → ')}\nExisting library paths are preserved.${cleanup}`, { modal: true }, 'Apply') !== 'Apply') return;
  // Recheck after user interaction; never replace a symlink or dirty editor buffer.
  try { const info = await fs.lstat(filename); if (!info.isFile() || info.isSymbolicLink()) throw new Error('vhdl.sim.json must be a regular file.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.fsPath === filename)) throw new Error('The configuration has unsaved changes; the update was stopped.');
  let current;
  try { current = await fs.readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current !== snapshot) throw new Error('The configuration file changed during confirmation; the update was stopped. Reconfigure and try again.');
  const temporary = path.join(root, `.vhdl-sim-${randomUUID()}.tmp`);
  try { await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temporary, filename); }
  finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return config;
}
module.exports = { generateWizard, createTestbench, setSimulationTarget };
