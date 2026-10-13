'use strict';
const moveCommand = 'workbench.action.moveEditorToNewWindow';
async function openWaveform(vscode, uri, mode, onWarning) {
  let separate = mode !== 'beside';
  if (separate && !(await vscode.commands.getCommands(true)).includes(moveCommand)) {
    onWarning('当前 VS Code 不支持独立编辑器窗口，已在旁边打开波形。');
    separate = false;
  }
  const open = column => vscode.commands.executeCommand('vscode.openWith', uri, 'surfer.waveformViewer', { viewColumn: column, preserveFocus: false, preview: false });
  await open(separate ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside);
  if (separate) {
    try { await vscode.commands.executeCommand(moveCommand, uri); }
    catch (error) {
      onWarning(`独立波形窗口未能打开，已改为并排显示：${error.message}`);
      await open(vscode.ViewColumn.Beside);
    }
  }
}
module.exports = { openWaveform };
