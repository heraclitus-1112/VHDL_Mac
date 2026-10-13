'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const tb = require('./testbench');
const core = require('./core');
function validation(callback) { return value => { try { callback(value); return undefined; } catch (error) { return error.message; } }; }
function html(text) { return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
async function createTestbench(root, name, code) {
  if (!tb.identifier(name)) throw new Error('测试实体名称无效。');
  const filename = path.join(root, `${name}.vhd`);
  try { await fs.writeFile(filename, code, { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`${name}.vhd 已存在，请使用新名字。`); throw error; }
  return filename;
}
async function generateWizard(vscode, root, uri) {
  if (!uri || uri.scheme !== 'file' || !/\.vhdl?$/i.test(uri.fsPath)) throw new Error('请先打开或右键选择被测设计的 .vhd/.vhdl 文件。');
  const source = await fs.realpath(uri.fsPath);
  if (!core.within(root, source) || core.within(path.join(root, '.nvc-build'), source)) throw new Error('被测文件必须位于项目内，且不能是构建文件。');
  const document = await vscode.workspace.openTextDocument(uri);
  const entities = tb.parseEntities(document.getText());
  const entity = entities.length === 1 ? entities[0] : (await vscode.window.showQuickPick(entities.map(item => ({ label: item.name, entity: item })), { title: '选择被测实体', ignoreFocusOut: true }))?.entity;
  if (!entity) return;
  const overrides = {}, genericValues = {};
  for (const item of entity.generics) {
    const input = await vscode.window.showInputBox({ title: `泛型 ${item.name} (${item.type})`, value: item.defaultValue ?? '', ignoreFocusOut: true, validateInput: validation(value => {
      const number = tb.integerExpression(value, genericValues);
      if (item.type.toLowerCase() === 'positive' && number < 1 || item.type.toLowerCase() === 'natural' && number < 0) throw new Error('数值超出泛型范围。');
    }) });
    if (input === undefined) return;
    overrides[item.name] = input; genericValues[item.name.toLowerCase()] = tb.integerExpression(input, genericValues);
  }
  const model = tb.instantiateEntity(entity, overrides);
  let architecture = model.architectures[0];
  if (model.architectures.length > 1) architecture = await vscode.window.showQuickPick(model.architectures, { title: '选择被测 architecture', ignoreFocusOut: true });
  if (model.architectures.length > 1 && !architecture) return;
  const durationText = await vscode.window.showInputBox({ title: '测试结束时间', value: '1us', prompt: '所有输入变化需早于此时间；结束时生成 finish。', ignoreFocusOut: true, validateInput: validation(value => { if (!tb.timeFs(value)) throw new Error('结束时间必须大于零。'); }) });
  if (durationText === undefined) return;
  const durationFs = tb.timeFs(durationText), duration = tb.timeLiteral(durationFs).replace(' ', '');
  const inputs = {};
  const inputPorts = model.ports.filter(port => port.mode === 'in');
  for (const [index, port] of inputPorts.entries()) {
    const clockName = /^(clk|clock|.*_clk)$/i.test(port.name);
    const choices = port.kind === 'std_logic' ? (clockName ? ['周期时钟', '固定值', '定时变化'] : ['固定值', '定时变化', '周期时钟']) : ['固定值', '定时变化'];
    const mode = await vscode.window.showQuickPick(choices, { title: `输入 ${index + 1}/${inputPorts.length}：${port.name} (${port.type})`, placeHolder: '逐个端口设置；未安排新变化时保持原值。', ignoreFocusOut: true });
    if (!mode) return;
    if (mode === '定时变化') {
      const resetDefault = /^(rst|reset|.*_rst)$/i.test(port.name) && port.kind === 'std_logic' && durationFs > tb.timeFs('20ns') ? '0ns=1;20ns=0' : `0ns=${tb.defaultValue(port)}`;
      const value = await vscode.window.showInputBox({ title: `${port.name}：时间 → 值`, value: resetDefault, prompt: '例如 0ns=0;20ns=1;100ns=0。向量示例 0ns=x"00";20ns=x"A5"。', ignoreFocusOut: true, validateInput: validation(text => tb.parseEvents(port, text, durationFs)) });
      if (value === undefined) return; inputs[port.name] = { mode: 'events', value };
    } else {
      const value = await vscode.window.showInputBox({ title: `${port.name}：${mode === '周期时钟' ? '时钟初值（0 或 1）' : '固定输入值'}`, value: tb.defaultValue(port), prompt: '逻辑：0/1；向量：十进制、"0101"、x"A5"；布尔：true/false。', ignoreFocusOut: true, validateInput: validation(text => { tb.formatValue(port, text); if (mode === '周期时钟' && !/^'?([01])'?$/.test(text)) throw new Error('时钟初值必须为 0 或 1。'); }) });
      if (value === undefined) return;
      if (mode === '固定值') inputs[port.name] = { mode: 'fixed', value };
      else {
        const start = await vscode.window.showInputBox({ title: `${port.name}：时钟开始时间`, value: '0ns', prompt: '开始前保持初值，开始后每半周期翻转。', ignoreFocusOut: true, validateInput: validation(text => { if (tb.timeFs(text) >= durationFs) throw new Error('开始时间必须早于结束时间。'); }) });
        if (start === undefined) return;
        const period = await vscode.window.showInputBox({ title: `${port.name}：完整时钟周期`, value: '10ns', ignoreFocusOut: true, validateInput: validation(text => { const p = tb.timeFs(text); if (!p || p % 2n || p / 2n >= durationFs - tb.timeFs(start)) throw new Error('周期需可分为整 fs 半周期，且结束前至少有一次翻转。'); }) });
        if (period === undefined) return; inputs[port.name] = { mode: 'clock', value, start, period };
      }
    }
  }
  const name = await vscode.window.showInputBox({ title: '新测试平台实体与文件名', value: `tb_${model.name}`, prompt: '创建在项目根目录；已有文件请换一个名字。', ignoreFocusOut: true, validateInput: async value => {
    if (!tb.identifier(value) || value.toLowerCase() === model.name.toLowerCase()) return '请输入有效且不同于被测实体的名称。';
    try { await fs.lstat(path.join(root, `${value}.vhd`)); return '文件已存在，请换一个名字。'; } catch (error) { return error.code === 'ENOENT' ? undefined : error.message; }
  } });
  if (name === undefined) return;
  const code = tb.generateTestbench(model, { name, architecture, duration, inputs });
  const preview = vscode.window.createWebviewPanel('nvcTestbenchPreview', 'Testbench 生成预览', vscode.ViewColumn.Active, {});
  preview.webview.html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>body{padding:20px;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background)}pre{white-space:pre-wrap;font-family:var(--vscode-editor-font-family)}</style><h2>${html(name)}.vhd</h2><p>已设置 ${inputPorts.length} 个输入端口。输出检查需要按功能要求添加 assert。</p><pre>${html(code)}</pre></html>`;
  let filename;
  try {
    if (await vscode.window.showInformationMessage(`创建 ${name}.vhd？输入激励结束于 ${duration}，没有自动推断输出断言。`, { modal: true }, '创建') !== '创建') return;
    filename = await createTestbench(root, name, code);
  } finally { preview.dispose(); }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(filename)));
  return { filename, name, source, duration };
}
async function setSimulationTarget(vscode, root, result) {
  const filename = path.join(root, 'vhdl.sim.json');
  if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.fsPath === filename)) throw new Error('vhdl.sim.json 有未保存修改，请先保存后使用“配置 VHDL 仿真”。');
  let config, snapshot;
  try {
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('vhdl.sim.json 必须是普通文件。');
    snapshot = await fs.readFile(filename, 'utf8');
    config = core.validateConfig(JSON.parse(snapshot));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const source = path.relative(root, result.source), generated = path.relative(root, result.filename);
  if (!config) {
    const candidates = (await core.discoverSources(root)).filter(item => item !== generated);
    const chosen = await vscode.window.showQuickPick(candidates.map(item => ({ label: item, picked: item === source })), { title: '选择被测设计及其依赖文件', canPickMany: true, ignoreFocusOut: true });
    if (!chosen) return;
    const remaining = chosen.map(item => item.label), ordered = [];
    if (!remaining.includes(source)) throw new Error('必须包含被测设计源文件。');
    while (remaining.length) {
      const next = await vscode.window.showQuickPick(remaining, { title: `确认源文件顺序 ${ordered.length + 1}/${chosen.length}`, placeHolder: '先选依赖文件，最后选被测设计；新 testbench 自动排最后。', ignoreFocusOut: true });
      if (next === undefined) return; ordered.push(next); remaining.splice(remaining.indexOf(next), 1);
    }
    config = { sources: ordered, top: result.name, standard: '2008', stopTime: result.duration, libraryPaths: [] };
  }
  config = { ...config, sources: [...config.sources.filter(item => item !== generated)] };
  if (!config.sources.includes(source)) config.sources.push(source);
  config.sources.push(generated); config.top = result.name; config.standard = '2008';
  if (tb.timeFs(config.stopTime) < tb.timeFs(result.duration)) config.stopTime = result.duration;
  core.validateConfig(config); await core.resolveProject(root, config);
  if (await vscode.window.showInformationMessage(`设置顶层 ${config.top}，VHDL-2008，上限 ${config.stopTime}？\n编译顺序：${config.sources.join(' → ')}\n已有库目录保持。`, { modal: true }, '设置') !== '设置') return;
  // Recheck after user interaction; never replace a symlink or dirty editor buffer.
  try { const info = await fs.lstat(filename); if (!info.isFile() || info.isSymbolicLink()) throw new Error('vhdl.sim.json 必须是普通文件。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.fsPath === filename)) throw new Error('配置存在未保存修改，已停止更新。');
  let current;
  try { current = await fs.readFile(filename, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current !== snapshot) throw new Error('确认期间配置文件发生变化，已停止更新，请重新配置。');
  const temporary = path.join(root, `.vhdl-sim-${randomUUID()}.tmp`);
  try { await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temporary, filename); }
  finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return config;
}
module.exports = { generateWizard, createTestbench, setSimulationTarget };
