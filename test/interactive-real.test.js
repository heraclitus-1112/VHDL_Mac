'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { InteractiveSession } = require('../src/interactive');
const executable = process.env.NVC_INTERACTIVE_TEST ?? path.join(os.homedir(), '.local/share/vhdl-mac/nvc-interactive-livewave/bin/nvc');

const source = `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity probe is end entity;
architecture sim of probe is
 signal clk : std_logic := '0';
 signal enable : std_logic := '0';
 signal count : integer := 0;
 signal bus_in : std_logic_vector(3 downto 0) := "0000";
begin
 clk <= not clk after 5 ns;
 process(clk) begin
   if rising_edge(clk) and enable = '1' then count <= count + 1; end if;
 end process;
end architecture;
`;

test('real persistent NVC retains counter, supports force/release, refreshes native waveform and pauses', { timeout: 20000 }, async t => {
  try { await fs.access(executable); } catch { t.skip('Install the isolated Tcl/live-wave NVC to run this acceptance test.'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nvc-interactive-test-'));
  let session; const waves = [], waveContents = [], output = [];
  try {
    await fs.writeFile(path.join(root, 'probe.vhd'), source);
    session = await InteractiveSession.start({ executable, projectDir: root, config: { sources: ['probe.vhd'], top: 'probe' },
      onOutput: text => output.push(text), onWave: async result => { waves.push(result); waveContents.push(await fs.readFile(result.wavePath, 'utf8')); } });
    const pid = session.child.pid;
    assert.deepEqual(await session.signals(), ['/clk', '/enable', '/count', '/bus_in']);
    assert.equal((await session.describe('/enable')).type, 'STD_LOGIC');
    assert.equal((await session.run('6ns')).now, '5000000');
    assert.equal(await session.examine('/count'), '0');
    await session.force('/enable', "'1'"); await session.force('/bus_in', '"1010"');
    assert.equal((await session.run('20ns')).now, '25000000');
    assert.equal(await session.examine('/count'), '2'); assert.equal(await session.examine('/bus_in'), '"1010"');
    await session.release('/enable'); await session.run('10ns');
    assert.equal(await session.examine('/count'), '2'); assert.equal(session.child.pid, pid);
    assert.equal(session.waveSupported, true);
    assert.equal(waves.length, 3); assert.notEqual(waves[0].wavePath, waves[1].wavePath);
    const first = waveContents[0], last = waveContents[2];
    assert.match(first, /#5000000/); assert.doesNotMatch(first, /#35000000/); assert.match(last, /#35000000/);
    await assert.rejects(fs.access(waves[0].wavePath), { code: 'ENOENT' });
    session.onWave = () => session.pause();
    await session.continue('10ns'); assert.equal(session.continuing, false);
    assert.equal(session.now, '45000000');
    assert.equal(session.statusSupported, true);
    assert.ok(!output.join('').includes('Failure'));
  } finally { session?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('small segment with pending event does not falsely end the session', { timeout: 20000 }, async t => {
  try { await fs.access(executable); } catch { t.skip('No interactive NVC installed.'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nvc-small-segment-')); let session;
  try {
    await fs.writeFile(path.join(root, 'probe.vhd'), source);
    session = await InteractiveSession.start({ executable, projectDir: root, config: { sources: ['probe.vhd'], top: 'probe' } });
    assert.equal((await session.run('1ns')).finished, false);
    assert.equal(session.pendingEvents, true); assert.equal(session.nextTime, '5000000');
    await session.run('6ns'); assert.equal(session.now, '5000000');
  } finally { session?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('pure combinational zero-time simulation supports force/release and valid waveform snapshots', { timeout: 20000 }, async t => {
  try { await fs.access(executable); } catch { t.skip('No interactive NVC installed.'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nvc-combinational-'));
  let session; const snapshots = [];
  try {
    await fs.writeFile(path.join(root, 'probe.vhd'), `library ieee;
use ieee.std_logic_1164.all;
entity probe is end entity;
architecture sim of probe is
 signal a : std_logic := '0';
 signal y : std_logic;
begin
 y <= not a;
end architecture;
`);
    session = await InteractiveSession.start({ executable, projectDir: root, config: { sources: ['probe.vhd'], top: 'probe' },
      onWave: async result => { snapshots.push(await fs.readFile(result.wavePath, 'utf8')); } });
    let result = await session.run('1ns');
    assert.equal(result.now, '0'); assert.equal(result.finished, false);
    assert.equal(await session.examine('/y'), "'1'"); assert.equal(session.pendingEvents, false);
    await session.force('/a', "'1'"); result = await session.run('1ns');
    assert.equal(result.now, '0'); assert.equal(result.finished, false); assert.equal(await session.examine('/y'), "'0'");
    await session.release('/a'); result = await session.run('1ns');
    assert.equal(result.now, '0'); assert.equal(result.finished, false); assert.equal(await session.examine('/y'), "'1'");
    assert.equal(snapshots.length, 3);
    for (const snapshot of snapshots) {
      assert.match(snapshot, /\$enddefinitions\s+\$end/);
      assert.match(snapshot, /\$var\s+(?:wire|logic)\s+1\s+\S+\s+y\s+\$end/);
      assert.match(snapshot, /#0\b/);
    }
    const identifier = snapshots[0].match(/\$var\s+(?:wire|logic)\s+1\s+(\S+)\s+y\s+\$end/)[1];
    const finalValue = snapshot => snapshot.split(/\r?\n/).filter(line => line === `0${identifier}` || line === `1${identifier}`).at(-1);
    assert.equal(finalValue(snapshots[0]), `1${identifier}`);
    assert.equal(finalValue(snapshots[1]), `0${identifier}`);
    assert.equal(finalValue(snapshots[2]), `1${identifier}`);
  } finally { session?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('real testbench finish prevents misleading further progress', { timeout: 20000 }, async t => {
  try { await fs.access(executable); } catch { t.skip('No interactive NVC installed.'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nvc-finish-test-')); let session;
  try {
    await fs.writeFile(path.join(root, 'probe.vhd'), source.replace(' clk <= not clk after 5 ns;', ' clk <= not clk after 5 ns;\n process begin wait for 12 ns; std.env.finish; end process;'));
    session = await InteractiveSession.start({ executable, projectDir: root, config: { sources: ['probe.vhd'], top: 'probe' } });
    const result = await session.run('20ns'); assert.equal(result.now, '12000000');
    // NVC can return from run normally after finish rather than exiting.
    assert.equal(result.finished, true);
    await assert.rejects(session.run('20ns'), /finish\/stop|closed/);
  } finally { session?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('real assertion failure is reported despite Tcl run returning normally', { timeout: 20000 }, async t => {
  try { await fs.access(executable); } catch { t.skip('No interactive NVC installed.'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nvc-failure-test-')); let session;
  try {
    await fs.writeFile(path.join(root, 'probe.vhd'), source.replace(' clk <= not clk after 5 ns;', ' clk <= not clk after 5 ns;\n process begin wait for 12 ns; assert false report "EXPECTED_FAILURE" severity failure; wait; end process;'));
    session = await InteractiveSession.start({ executable, projectDir: root, config: { sources: ['probe.vhd'], top: 'probe' } });
    await assert.rejects(session.run('20ns'), /simulation error/);
    assert.equal(session.finished, true);
  } finally { session?.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('official Tcl NVC remains usable but explicitly reports no live waveform capability', { timeout: 20000 }, async t => {
  const official = path.join(os.homedir(), '.local/share/vhdl-mac/nvc-interactive/bin/nvc');
  try { await fs.access(official); } catch { t.skip('No official Tcl NVC installed.'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nvc-no-wave-test-')); let session;
  try {
    await fs.writeFile(path.join(root, 'probe.vhd'), source);
    session = await InteractiveSession.start({ executable: official, projectDir: root, config: { sources: ['probe.vhd'], top: 'probe' } });
    assert.equal(session.waveSupported, false); assert.equal((await session.run('6ns')).now, '5000000');
  } finally { session?.close(); await fs.rm(root, { recursive: true, force: true }); }
});
