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
async function snapshot(id) {
  if (loading) return;
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
  else if (message.command === 'open-data') inject_message(JSON.stringify({ [message.kind === 'command_file' ? 'LoadCommandFromData' : 'LoadStateFromData']: message.bytes }));
  else if (message.command === 'load') sequence = sequence.then(async () => {
    loading = true;
    inject_message(JSON.stringify({ LoadWaveformFileFromUrl: [message.url, message.keep ? 'KeepAvailable' : 'Clear'] }));
    // The title changes only once the requested file has finished loading.
    const deadline = Date.now() + 30000;
    do {
      await new Promise(resolve => setTimeout(resolve, 80));
      if (Date.now() > deadline) throw new Error('波形加载超时，请关闭波形窗口后重试。');
    } while (!document.title.includes(message.name) || !(await waves_loaded()));
    if (message.restore) {
      inject_message(JSON.stringify({ LoadStateFromData: Array.from(new TextEncoder().encode(message.restore)) }));
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    loading = false; host.postMessage({ command: 'loaded', id: message.id }); await snapshot();
  }).catch(window.on_surfer_error);
});
try {
  await init({ module_or_path: wasm });
  host.postMessage({ command: 'ready' });
  setInterval(() => snapshot().catch(window.on_surfer_error), 1000);
} catch (error) { window.on_surfer_error(error); }
