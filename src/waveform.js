'use strict';
const moveCommand = 'workbench.action.moveEditorToNewWindow';
async function openWaveform(vscode, uri, mode, onWarning) {
  let separate = mode !== 'beside';
  if (separate && !(await vscode.commands.getCommands(true)).includes(moveCommand)) {
    onWarning('This version of VS Code does not support separate editor windows. The waveform has been opened beside the code.');
    separate = false;
  }
  const open = column => vscode.commands.executeCommand('vscode.openWith', uri, 'surfer.waveformViewer', { viewColumn: column, preserveFocus: false, preview: false });
  await open(separate ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside);
  if (separate) {
    try { await vscode.commands.executeCommand(moveCommand, uri); }
    catch (error) {
      onWarning(`Could not open a separate waveform window. The waveform is shown beside the code: ${error.message}`);
      await open(vscode.ViewColumn.Beside);
    }
  }
}
module.exports = { openWaveform };
