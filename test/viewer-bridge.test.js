'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

// Run the shipped webview bridge. Browser-only WASM and VS Code transport are
// represented at their message boundary so restoration ordering is exercised.
async function bridge(t) {
  const source = await fs.readFile(path.join(__dirname, '../media/viewer.js'), 'utf8');
  const state = { items: [], cursor: 0, zoom: 1, markers: [], radix: 'binary' };
  const messages = [], handlers = new Map(), document = { title: '', querySelectorAll: () => [], getElementById: () => ({ style: {} }) };
  let loaded = false, pendingState; const restoredStates = [];
  const host = { postMessage: message => messages.push(message) };
  const applyPending = () => { if (pendingState) { Object.assign(state, pendingState); pendingState = undefined; } };
  const inject = json => {
    const message = JSON.parse(json);
    if (message.LoadWaveformFileFromUrl) {
      document.title = message.LoadWaveformFileFromUrl[0].split('/').at(-1) + ' - Surfer'; loaded = true;
      if (message.LoadWaveformFileFromUrl[1] === 'Clear') state.items = [];
      else state.items = state.items.filter(item => item.available);
    } else if (message.LoadStateFromData) {
      const text = Buffer.from(message.LoadStateFromData).toString(); restoredStates.push(text);
      try { pendingState = JSON.parse(text); } catch { pendingState = { items: [] }; }
    }
    else if (message === 'RemovePlaceholders') { applyPending(); state.items = state.items.filter(item => item.available); }
  };
  const context = vm.createContext({
    acquireVsCodeApi: () => host, window: { addEventListener: (type, handler) => handlers.set(type, handler) },
    document, inject_message: inject, get_state: async () => { applyPending(); return JSON.stringify(state); },
    waves_loaded: async () => loaded, TextEncoder, TextDecoder, Uint8Array, Date,
    setTimeout: callback => setTimeout(() => { applyPending(); callback(); }, 0), setInterval: () => 0,
    init: async () => {}, wasm: 'test-wasm'
  });
  await vm.runInContext(`(async () => {${source}\n})()`, context);
  async function load(restore) {
    const before = messages.length;
    handlers.get('message')({ data: { command: 'load', id: 'new', name: 'new.fst', url: 'https://test/new.fst', keep: false, restore } });
    const deadline = Date.now() + 2000;
    while (!messages.slice(before).some(message => message.command === 'state')) {
      const error = messages.slice(before).find(message => message.command === 'error');
      if (error) throw new Error(error.message);
      if (Date.now() > deadline) throw new Error('bridge did not finish loading');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  return { state, messages, handlers, load, restoredStates };
}
test('restoring a layout drops unavailable references before saving, without losing valid view settings', async t => {
  const b = await bridge(t);
  const layout = { items: [{ name: 'old.dut.a', available: false }, { name: 'tb_b', available: true }, { name: 'tb_a', available: true }], cursor: 25, zoom: 4, markers: [30], radix: 'hex' };
  await b.load(JSON.stringify(layout));
  assert.deepEqual(b.state.items.map(item => item.name), ['tb_b', 'tb_a']);
  assert.equal(b.state.cursor, 25); assert.equal(b.state.zoom, 4); assert.deepEqual(b.state.markers, [30]); assert.equal(b.state.radix, 'hex');
  const saved = JSON.parse(b.messages.filter(message => message.command === 'state').at(-1).state);
  assert.ok(saved.items.every(item => item.available), 'persist only the cleaned layout so reopening cannot restore missing references');
});
test('restored RON resolves scopes and variables by path instead of reusing foreign backend IDs', async t => {
  const b = await bridge(t);
  const ron = '(active_scope: Some(WaveScope((strs: ["old_top"], id: Wellen((2))))), variable_ref: (path: (strs: ["tb_current"], id: Wellen((2))), name: "tb_a", id: Wellen((9))), cursor: Some((1, [25])), manual_name: "id: Wellen((88))")';
  await b.load(ron);
  assert.equal(b.restoredStates[0], ron.replaceAll('id: Wellen((2))', 'id: None').replace('id: Wellen((9))', 'id: None'));
  assert.match(b.restoredStates[0], /strs: \["tb_current"\]/);
  assert.match(b.restoredStates[0], /cursor: Some\(\(1, \[25\]\)\)/);
});
test('manual state restoration is cleaned before its next saved snapshot', async t => {
  const b = await bridge(t); await b.load();
  const layout = { items: [{ name: 'missing.cout', available: false }, { name: 'tb_sum', available: true }], cursor: 40, zoom: 3 };
  b.handlers.get('message')({ data: { command: 'open-data', kind: 'state_file', bytes: Array.from(Buffer.from(JSON.stringify(layout))) } });
  const deadline = Date.now() + 2000;
  while (!b.messages.some(message => message.command === 'state' && message.state.includes('tb_sum'))) {
    if (Date.now() > deadline) throw new Error('manual restore did not complete');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  b.handlers.get('message')({ data: { command: 'snapshot', id: 'manual' } });
  await new Promise(resolve => setTimeout(resolve, 5));
  const saved = JSON.parse(b.messages.find(message => message.id === 'manual').state);
  assert.deepEqual(saved.items.map(item => item.name), ['tb_sum']);
  assert.equal(saved.cursor, 40); assert.equal(saved.zoom, 3);
});
