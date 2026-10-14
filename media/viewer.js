const host = acquireVsCodeApi();
window.__surfer_host_api = host;
window.surfer_notify_host = json => host.postMessage(JSON.parse(json));
window.vscode_show_open_dialog = kind => host.postMessage({ command: 'open-dialog', kind });
window.on_surfer_error = message => {
  document.getElementById('error_container').style.display = 'block';
  document.getElementById('error_message').textContent = String(message);
  host.postMessage({ command: 'error', message: String(message) });
};
let loading = true, previousState, sequence = Promise.resolve();
for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => host.postMessage({ command: 'control', action: button.dataset.action }));
function restoreState(bytes) {
  // RON's backend IDs are cache hints belonging to the old file, not identities.
  // ScopeId/VarId both support None, which makes Surfer resolve the stored path.
  const text = new TextDecoder().decode(Uint8Array.from(bytes));
  const portable = text.replace(/"(?:\\.|[^"\\])*"|\bid:\s*Wellen\(\(\d+\)\)/g, token => token.startsWith('"') ? token : 'id: None');
  inject_message(JSON.stringify({ LoadStateFromData: Array.from(new TextEncoder().encode(portable)) }));
}
async function rebindScope() {
  const state = await get_state();
  const match = state?.match(/active_scope:\s*Some\(WaveScope\(\(\s*strs:\s*\[([\s\S]*?)\],/);
  let strs;
  if (match) try { strs = JSON.parse(`[${match[1].replace(/,\s*$/, '')}]`); } catch { /* Reset an unrecognized scope safely. */ }
  inject_message(JSON.stringify({ SetActiveScope: null }));
  await get_state();
  if (Array.isArray(strs) && strs.every(name => typeof name === 'string')) {
    inject_message(JSON.stringify({ SetActiveScope: { WaveScope: { strs, id: 'None' } } }));
    await get_state();
  }
}
async function snapshot(id) {
  if (loading) return;
  // State restoration retains unresolved paths as placeholders. Surfer processes
  // injected messages before get_state's query, so save only a cleaned layout.
  // Repeating this also covers late/manual state restoration without dropping
  // valid signals, formats, markers, or viewports.
  inject_message(JSON.stringify('RemovePlaceholders'));
  const state = await get_state();
  if (state && (id || state !== previousState)) { previousState = state; host.postMessage({ command: 'state', state, id }); }
}
window.addEventListener('message', event => {
  const message = event.data;
  if (message.command === 'session') {
    document.body.classList.toggle('interactive', !!message.session);
    document.getElementById('time').textContent = message.session ? `${message.session.nowText} · ${message.session.state}` : '';
    for (const button of document.querySelectorAll('[data-action]')) button.disabled = message.session?.running && !['pause','stop'].includes(button.dataset.action);
    window.dispatchEvent(new Event('resize'));
  }
  else if (message.command === 'snapshot') snapshot(message.id).catch(window.on_surfer_error);
  else if (message.command === 'open-data') {
    if (message.kind === 'command_file') inject_message(JSON.stringify({ LoadCommandFromData: message.bytes }));
    else {
      loading = true;
      sequence = sequence.then(async () => {
        restoreState(message.bytes);
        await new Promise(resolve => setTimeout(resolve, 200));
        await rebindScope(); loading = false; await snapshot();
      }).catch(window.on_surfer_error);
    }
  }
  else if (message.command === 'load') sequence = sequence.then(async () => {
    loading = true;
    if (message.keep) await rebindScope();
    inject_message(JSON.stringify({ LoadWaveformFileFromUrl: [message.url, message.keep ? 'KeepAvailable' : 'Clear'] }));
    // The title changes only once the requested file has finished loading.
    const deadline = Date.now() + 30000;
    do {
      await new Promise(resolve => setTimeout(resolve, 80));
      if (Date.now() > deadline) throw new Error('波形加载超时，请关闭波形窗口后重试。');
    } while (!document.title.includes(message.name) || !(await waves_loaded()));
    if (message.restore) {
      restoreState(new TextEncoder().encode(message.restore));
      await new Promise(resolve => setTimeout(resolve, 200));
      await rebindScope();
    }
    loading = false; await snapshot(); host.postMessage({ command: 'loaded', id: message.id });
  }).catch(window.on_surfer_error);
});
try {
  await init({ module_or_path: wasm });
  host.postMessage({ command: 'ready' });
  setInterval(() => snapshot().catch(window.on_surfer_error), 1000);
} catch (error) { window.on_surfer_error(error); }
