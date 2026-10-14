'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/core');
const executable = process.env.NVC_BATCH_TEST || '/opt/homebrew/bin/nvc';
async function fixture(t, source) {
  try { await fs.access(executable); } catch { t.skip('No batch NVC installed.'); return; }
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nvc-run-all-')));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  await fs.writeFile(path.join(root,'tb.vhd'),source);
  return {executable,projectDir:root,config:{sources:['tb.vhd'],top:'tb',stopTime:'all'}};
}
test('real Run All reaches natural end beyond the numeric limit', {timeout:15000}, async t => {
  const options=await fixture(t,'entity tb is end; architecture sim of tb is begin process begin wait for 12 ns; report "NATURAL_END"; wait; end process; end;');
  if(!options)return;
  const numeric=await core.runSimulation({...options,config:{...options.config,stopTime:'5ns'}});
  assert.doesNotMatch(numeric.output,/NATURAL_END/);
  const all=await core.runSimulation(options);
  assert.match(all.output,/12ns.*NATURAL_END/);assert.ok((await fs.stat(all.wavePath)).size>0);
});
test('real Run All finish terminates a periodic clock at the testbench duration', {timeout:15000}, async t => {
  const options=await fixture(t,`library ieee; use ieee.std_logic_1164.all;
entity tb is end; architecture sim of tb is signal clk:std_logic:='0'; begin
clk <= not clk after 5 ns;
process begin wait for 12 ns; report "CLOCK_FINISH"; std.env.finish; wait; end process; end;`);
  if(!options)return;
  const result=await core.runSimulation(options);
  assert.match(result.output,/12ns.*CLOCK_FINISH/);assert.match(result.output,/12ns.*FINISH called/);
});
test('real Run All endless clock can be cancelled and preserves previous successful waveform', {timeout:15000}, async t => {
  const options=await fixture(t,`library ieee; use ieee.std_logic_1164.all;
entity tb is end; architecture sim of tb is signal clk:std_logic:='0'; begin
clk <= not clk after 5 ns;
process begin report "CLOCK_STARTED"; wait; end process; end;`);
  if(!options)return;
  const prior=await core.runSimulation({...options,config:{...options.config,stopTime:'5ns'}});
  const priorBytes=await fs.readFile(prior.wavePath), marker=path.join(options.projectDir,'.nvc-build','.nvc-runner.json');
  const priorMarker=await fs.readFile(marker,'utf8'), controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),3000);t.after(()=>clearTimeout(timeout));
  let started=false;
  await assert.rejects(core.runSimulation({...options,signal:controller.signal,onOutput:text=>{
    if(text.includes('CLOCK_STARTED')){started=true;controller.abort();}
  }}),error=>error.name==='AbortError'&&error.stage==='simulation');
  assert.equal(started,true);assert.deepEqual(await fs.readFile(prior.wavePath),priorBytes);
  assert.equal(await fs.readFile(marker,'utf8'),priorMarker);
  const next=await core.runSimulation({...options,config:{...options.config,stopTime:'5ns'}});assert.ok(next.wavePath);
});


test('generated periodic stimulus still finishes at its numeric duration in all mode', {timeout:15000}, async t => {
  const tb=require('../src/testbench');
  const design='library ieee; use ieee.std_logic_1164.all; entity probe is port(clk:in std_logic); end; architecture rtl of probe is begin end;';
  const model=tb.instantiateEntity(tb.parseEntities(design)[0]);
  const code=tb.generateTestbench(model,{name:'tb',architecture:'rtl',duration:'30ns',inputs:{clk:{mode:'clock',value:'0',start:'0ns',period:'10ns'}}});
  const options=await fixture(t,code);if(!options)return;
  await fs.writeFile(path.join(options.projectDir,'probe.vhd'),design);options.config.sources=['probe.vhd','tb.vhd'];
  const result=await core.runSimulation(options);
  assert.match(result.output,/30ns.*STIMULUS_DONE: no output assertions configured/);
  assert.match(result.output,/30ns.*FINISH called/);
  assert.doesNotMatch(result.output,/TB_PASS/);
});
