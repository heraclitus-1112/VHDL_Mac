'use strict';
const fs = require('node:fs/promises');
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/i.test(value);
// Read declarations only; semantic validity and binding remain NVC's responsibility.
function parseArchitectures(source, top) {
  const masked = source.replace(/\/\*[\s\S]*?\*\/|--[^\r\n]*|"(?:[^"]|"")*"|\\[^\\\r\n]*\\|'[^'\r\n]'/g, ' ');
  const declarations = masked.matchAll(/\barchitecture\s+([a-z][a-z0-9_]*)\s+of\s+([a-z][a-z0-9_]*)\s+is\b/gi);
  const names = [];
  for (const [, name, entity] of declarations) if (entity.toLowerCase() === top.toLowerCase() && identifier(name) && !names.some(item => item.toLowerCase() === name.toLowerCase())) names.push(name);
  return names;
}
async function readArchitectures(vscode, sources, top) {
  const names = []; let total = 0;
  const limit = 4 * 1024 * 1024;
  const oversized = () => new Error('architecture 扫描上限为单文件 4 MiB、总计 16 MiB，请缩小源文件范围。');
  for (const filename of sources) {
    const document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === filename);
    let source, bytes;
    if (document) { source = document.getText(); bytes = Buffer.byteLength(source); }
    else {
      const handle = await fs.open(filename, 'r');
      try {
        if ((await handle.stat()).size > limit) throw oversized();
        const buffer = Buffer.alloc(limit + 1); bytes = 0;
        while (bytes < buffer.length) {
          const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
          if (!result.bytesRead) break; bytes += result.bytesRead;
        }
        source = buffer.subarray(0, bytes).toString('utf8');
      } finally { await handle.close(); }
    }
    total += bytes;
    if (bytes > limit || total > 4 * limit) throw oversized();
    for (const name of parseArchitectures(source, top)) if (!names.some(item => item.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names;
}
async function chooseArchitecture(vscode, sources, top, current, always = true) {
  const names = await readArchitectures(vscode, sources, top);
  if (!always && !current && names.length === 1) return { architecture: names[0] };
  const choices = names.map(name => ({ label: name, id: 'architecture', architecture: name, picked: name.toLowerCase() === current?.toLowerCase() }));
  if (current && !names.some(name => name.toLowerCase() === current.toLowerCase())) choices.push({label: current, id: 'architecture', architecture: current, description: '当前配置（源文件中未识别到）', picked: true});
  choices.push({label: 'NVC 默认选择', id: 'default', description: '不固定 architecture', picked: !current});
  choices.sort((a,b) => Number(!!b.picked) - Number(!!a.picked));
  choices.push({label: '手动输入 architecture 名称…', id: 'manual'});
  const choice = await vscode.window.showQuickPick(choices, {title: `选择 ${top} 的 Testbench architecture`, ignoreFocusOut: true});
  if (!choice) return;
  if (choice.id === 'default') return {};
  if (choice.id !== 'manual') return {architecture: choice.architecture};
  const name = await vscode.window.showInputBox({title: '输入 Testbench architecture 名称', value: current ?? '', ignoreFocusOut: true, validateInput: value => identifier(value) ? undefined : '请输入有效的 VHDL 基本名称'});
  if (name === undefined) return;
  if (!identifier(name)) throw new Error('architecture 必须是有效的 VHDL 基本名称。');
  return {architecture: name};
}
module.exports = {parseArchitectures, readArchitectures, chooseArchitecture};
