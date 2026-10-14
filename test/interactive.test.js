'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { InteractiveSession, durationParts, quoteTcl } = require('../src/interactive');

test('duration rejects command injection and non-positive segments', () => {
  assert.deepEqual(durationParts('100ns'), ['100', 'ns']);
  for (const value of ['0ns', '-1ns', '1 ns', '1ns;exit', '1.5ns', undefined]) assert.throws(() => durationParts(value));
});
test('Tcl strings encode substitution characters as data', () => {
  const input = '/sig]; exit; puts $env(HOME)\n{';
  const quoted = quoteTcl(input);
  assert.equal(Buffer.from(quoted.match(/\{([^}]+)\}/)[1], 'base64').toString(), input);
  assert.ok(!quoted.includes('$env')); assert.throws(() => quoteTcl('x\0y'));
});
test('protocol separates normal simulator output from ordered responses and actual time', async () => {
  const output = [], times = [];
  const session = new InteractiveSession({ onOutput: value => output.push(value), onTime: value => times.push(value) });
  session.child = { stdin: { write: () => {} } };
  session.acceptOutput('__NVC_READY__|0\n'); await session.ready;
  const result = session.command('run 6 ns');
  session.acceptOutput('ordinary report\n__NVC_RESP');
  session.acceptOutput('ONSE__|0|5000000|Mg==\n');
  assert.equal(await result, '2'); assert.equal(session.now, '5000000');
  assert.deepEqual(output, ['ordinary report\n']); assert.deepEqual(times, ['5000000']);
});
test('only one command executes at once and closure rejects outstanding work', async () => {
  const session = new InteractiveSession({}); session.child = { stdin: { write: () => {} } };
  const result = session.command('first');
  await assert.rejects(session.command('second'), /not completed/);
  session.terminated(new Error('process exited'));
  await assert.rejects(result, /process exited/);
  await assert.rejects(session.command('third'), /closed/);
});
test('pause stops continuous run at segment boundary and prohibits mutation while continuing', async () => {
  const session = new InteractiveSession({}); let segments = 0;
  session.advance = async () => { ++segments; await assert.rejects(session.force('/enable', "'1'"), /Pause/); session.pause(); return { now: '5000000' }; };
  assert.deepEqual(await session.continue('6ns'), { now: '5000000' });
  assert.equal(segments, 1); assert.equal(session.busy, false); assert.equal(session.continuing, false);
});
