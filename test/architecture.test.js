'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/core');
const source = 'entity tb is end; architecture first of tb is signal value:integer:=1; begin process begin wait for 2 ns; report "ARCH_FIRST"; wait; end process; end; architecture second of tb is signal value:integer:=2; begin process begin wait for 2 ns; report "ARCH_SECOND"; wait; end process; end;';
test('optional architecture config validates identifiers and retains legacy shape', () => {
 const old = core.validateConfig({sources:['tb.vhd'],top:'tb'});
 assert.equal(Object.hasOwn(old,'architecture'),false);
 assert.equal(core.validateConfig({...old,architecture:'Test_1'}).architecture,'Test_1');
 for(const architecture of ['',null,3,'sim(foo)','bad name','sim;exit']) assert.throws(()=>core.validateConfig({...old,architecture}));
});
test('architecture discovery ignores comments, strings and unrelated entities across sources', () => {
 const {parseArchitectures}=require('../src/architecture');
 assert.deepEqual(parseArchitectures('-- architecture fake of tb is\nreport "architecture bogus of tb is"; architecture FIRST of TB is begin end; architecture rtl of dut is begin end; architecture second of tb is begin end;', 'tb'),['FIRST','second']);
});
test('real batch target explicitly selects either architecture in timed and all modes', {timeout:15000}, async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nvc-arch-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'tb.vhd'),source);
 const options={executable:'/opt/homebrew/bin/nvc',projectDir:root};
 for(const architecture of ['first','second','first']) for(const stopTime of ['5ns','all']) {
  const result=await core.runSimulation({...options,config:{sources:['tb.vhd'],top:'tb',architecture,stopTime}});
  assert.match(result.output,new RegExp('ARCH_'+architecture.toUpperCase()));
  assert.doesNotMatch(result.output,new RegExp('ARCH_'+(architecture==='first'?'SECOND':'FIRST')));
 }
 const prior=await fs.readFile(path.join(root,'.nvc-build/.nvc-runner.json'),'utf8');
 await assert.rejects(core.runSimulation({...options,config:{sources:['tb.vhd'],top:'tb',architecture:'missing',stopTime:'all'}}));
 assert.equal(await fs.readFile(path.join(root,'.nvc-build/.nvc-runner.json'),'utf8'),prior);
});
test('real interactive target loads the selected architecture', {timeout:15000}, async t => {
 const {InteractiveSession}=require('../src/interactive');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nvc-arch-interactive-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.writeFile(path.join(root,'tb.vhd'),source);
 for(const [architecture,expected] of [['first','1'],['second','2']]) {
  let session;
  try {
   session=await InteractiveSession.start({executable:path.join(os.homedir(),'.local/share/vhdl-mac/nvc-interactive-livewave/bin/nvc'),projectDir:root,config:{sources:['tb.vhd'],top:'tb',architecture}});
   await session.run('1ns');assert.equal(await session.examine('/value'),expected);
  } finally {session?.close();}
 }
});

test('zero discovered architectures still offers manual entry in the wizard',async()=>{
 const {chooseArchitecture}=require('../src/architecture');let asked=false;
 const vscode={workspace:{textDocuments:[]},window:{showQuickPick:async items=>{asked=true;return items.find(item=>item.id==='manual');},showInputBox:async()=> 'manual_arch'}};
 assert.deepEqual(await chooseArchitecture(vscode,[],'tb',undefined,false),{architecture:'manual_arch'});assert.equal(asked,true);
});

test('architecture discovery excludes VHDL block comments and quoted comment markers',()=>{
 const {parseArchitectures}=require('../src/architecture');
 assert.deepEqual(parseArchitectures('/* architecture phantom of tb is */ report "/*"; architecture real of tb is begin end;', 'tb'),['real']);
});
test('architecture reader bounds source size and reports oversized files',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nvc-arch-size-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'large.vhd');await fs.writeFile(file,' '.repeat(4*1024*1024+1));
 await assert.rejects(require('../src/architecture').readArchitectures({workspace:{textDocuments:[]}},[file],'tb'));
});
