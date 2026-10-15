'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let extension={};try{extension=require('../src/extension');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nvc adapter ')));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'tb.vhd'),'entity tb is end;');return root;}
function fake(root,onOutput=()=>{}){const commands=new Map(),errors=[],calls=[],diagnostics=new Map();const folder={name:'project',uri:{fsPath:root,scheme:'file'}};const vscode={
 Uri:{file:fsPath=>({fsPath,scheme:'file',toString(){return fsPath;}})},ViewColumn:{Beside:2},ProgressLocation:{Notification:1},StatusBarAlignment:{Left:1},DiagnosticSeverity:{Error:0,Warning:1},Range:class{constructor(...args){this.args=args;}},Diagnostic:class{constructor(range,message,severity){Object.assign(this,{range,message,severity});}},
 workspace:{isTrusted:true,workspaceFolders:[folder],textDocuments:[],getWorkspaceFolder:uri=>uri.fsPath.startsWith(root+path.sep)||uri.fsPath===root?folder:undefined,getConfiguration:()=>({get:()=>process.execPath})},
 window:{activeTextEditor:{document:{uri:{fsPath:path.join(root,'tb.vhd'),scheme:'file'}}},createOutputChannel:()=>({append:s=>{calls.push(['output',s]);onOutput(s);},appendLine:s=>{calls.push(['output',s]);onOutput(s);},show(){},dispose(){}}),createStatusBarItem:()=>({show(){},dispose(){}}),showErrorMessage:async message=>errors.push(message),showInformationMessage:async()=>undefined,showQuickPick:async()=>undefined,showInputBox:async()=>undefined,withProgress:async(_,callback)=>callback({report(){}},{isCancellationRequested:false,onCancellationRequested:()=>({dispose(){}})})},
 languages:{createDiagnosticCollection:()=>({set:(uri,value)=>diagnostics.set(uri.fsPath,value),delete:uri=>diagnostics.delete(uri.fsPath),dispose(){}})},commands:{registerCommand:(id,callback)=>{commands.set(id,callback);return{dispose(){}};},executeCommand:async(...args)=>calls.push(args)},extensions:{getExtension:()=>({activate:async()=>calls.push(['activateSurfer'])})}};return{vscode,commands,errors,calls,diagnostics,folder};}
function init(state){assert.equal(typeof extension.createExtension,'function');return extension.createExtension(state.vscode,{subscriptions:[]});}
test('testbench generation command checks workspace trust before opening UI',async t=>{const root=await fixture(t);const s=fake(root);s.vscode.workspace.isTrusted=false;init(s);assert.equal(typeof s.commands.get('nvcRunner.generateTestbench'),'function');await s.commands.get('nvcRunner.generateTestbench')();assert.match(s.errors[0],/Trust/);assert.deepEqual(await fs.readdir(root),['tb.vhd']);});
test('untrusted run stops before saving dirty documents',async t=>{const root=await fixture(t);const s=fake(root);s.vscode.workspace.isTrusted=false;let saved=false;s.vscode.workspace.textDocuments=[{isDirty:true,uri:{fsPath:path.join(root,'tb.vhd'),scheme:'file'},save:async()=>{saved=true;return true;}}];init(s);await s.commands.get('nvcRunner.run')();assert.equal(saved,false);assert.match(s.errors[0],/Trust/);});
test('run lock is acquired before saving and only saves selected project files',async t=>{const root=await fixture(t);const s=fake(root);let release;let saved=0,outsideSaved=false;const wait=new Promise(resolve=>release=resolve);s.vscode.workspace.textDocuments=[{isDirty:true,uri:{fsPath:path.join(root,'tb.vhd'),scheme:'file'},save:async()=>{saved++;await wait;return false;}},{isDirty:true,uri:{fsPath:'/outside/other.vhd',scheme:'file'},save:async()=>{outsideSaved=true;return true;}}];init(s);const first=s.commands.get('nvcRunner.run')();while(saved===0)await new Promise(resolve=>setImmediate(resolve));await s.commands.get('nvcRunner.run')();release();await first;assert.equal(saved,1);assert.equal(outsideSaved,false);assert.ok(s.errors.some(message=>/already running/.test(message)));assert.ok(s.errors.some(message=>/Cannot save/.test(message)));});
test('configuration wizard cancellation leaves project unchanged',async t=>{const root=await fixture(t);const s=fake(root);init(s);await s.commands.get('nvcRunner.configure')();await assert.rejects(fs.stat(path.join(root,'vhdl.sim.json')));assert.deepEqual(await fs.readdir(root),['tb.vhd']);});
test('configuration wizard records explicit order and confirmed fields',async t=>{const root=await fixture(t);await fs.writeFile(path.join(root,'logic.vhdl'),'');const s=fake(root);const picks=[['logic.vhdl','tb.vhd'],'logic.vhdl','tb.vhd',{id:'default'},'2008',{id:'time'}];const inputs=['tb','1us'];s.vscode.window.showQuickPick=async()=>picks.shift();s.vscode.window.showInputBox=async()=>inputs.shift();init(s);await s.commands.get('nvcRunner.configure')();const config=JSON.parse(await fs.readFile(path.join(root,'vhdl.sim.json'),'utf8'));assert.deepEqual(config,{sources:['logic.vhdl','tb.vhd'],top:'tb',standard:'2008',stopTime:'1us',libraryPaths:[]});});
test('saved configuration releases project lock while success notification remains open',async t=>{const root=await fixture(t);const s=fake(root);const picks=[['tb.vhd'],'tb.vhd',{id:'default'},'2008',{id:'time'}];const inputs=['tb','1us'];s.vscode.window.showQuickPick=async()=>picks.shift();s.vscode.window.showInputBox=async()=>inputs.shift();let releaseMessage,notificationShown=false;const pendingMessage=new Promise(resolve=>releaseMessage=resolve);s.vscode.window.showInformationMessage=async message=>{if(message.includes('configuration saved')){notificationShown=true;await pendingMessage;}};init(s);const configuring=s.commands.get('nvcRunner.configure')();try{while(!notificationShown)await new Promise(resolve=>setImmediate(resolve));await s.commands.get('nvcRunner.run')();assert.equal(s.errors.some(message=>/already running or being configured/.test(message)),false,'saved configuration must not block a new run');assert.ok(s.calls.some(([kind,text])=>kind==='output'&&text.includes('Project: ')),'run should reach the NVC stage');}finally{releaseMessage();await configuring;}});
test('config symlink cannot overwrite VHDL source',async t=>{const root=await fixture(t);await fs.symlink(path.join(root,'tb.vhd'),path.join(root,'vhdl.sim.json'));const s=fake(root);init(s);await s.commands.get('nvcRunner.run')();assert.match(s.errors[0],/symbolic link/);assert.equal(await fs.readFile(path.join(root,'tb.vhd'),'utf8'),'entity tb is end;');});
test('dirty file symlink outside workspace is never saved',async t=>{const root=await fixture(t);const outside=await fs.mkdtemp(path.join(os.tmpdir(),'outside save '));t.after(()=>fs.rm(outside,{recursive:true,force:true}));const target=path.join(outside,'external.vhd');await fs.writeFile(target,'unchanged');await fs.symlink(target,path.join(root,'linked.vhd'));const s=fake(root);let saved=false;s.vscode.workspace.textDocuments=[{isDirty:true,uri:{fsPath:path.join(root,'linked.vhd'),scheme:'file'},save:async()=>{saved=true;return true;}}];init(s);await s.commands.get('nvcRunner.run')();assert.equal(saved,false);assert.match(s.errors[0],/workspace/);});


function wizard(state, mode, inputs = ['tb']) {
  const picks = [['tb.vhd'], 'tb.vhd', '2008'];
  state.vscode.window.showQuickPick = async (items, options) => {
    if (options.title.includes('Testbench architecture')) return items.find(item=>item.id==='default');
    if (picks.length) return picks.shift();
    assert.equal(options.title, 'Select simulation run mode');
    assert.ok(items.some(item => item.id === 'all'));
    assert.ok(items.some(item => item.id === 'time'));
    return mode === undefined ? undefined : {...items.find(item => item.id === mode), label:'locale-independent label'};
  };
  state.vscode.window.showInputBox = async () => inputs.shift();
}
test('new configuration defaults to all and uses stable mode identifiers', async t => {
  const root = await fixture(t), s = fake(root); wizard(s,'all');
  const pick = s.vscode.window.showQuickPick;
  s.vscode.window.showQuickPick = async (items, options) => {
    if (options.title === 'Select simulation run mode') { assert.equal(items.find(item => item.picked).id,'all'); assert.equal(items[0].id,'all'); }
    return pick(items, options);
  };
  init(s); await s.commands.get('nvcRunner.configure')();
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'vhdl.sim.json'),'utf8')).stopTime,'all');
  assert.deepEqual(s.errors,[]);
});
test('reconfiguration retains numeric or all mode and numeric value', async t => {
  for (const savedStopTime of ['7us','all',undefined]) {
    const stopTime = savedStopTime ?? '1us';
    const root = await fixture(t), s = fake(root);
    await fs.writeFile(path.join(root,'vhdl.sim.json'),JSON.stringify({sources:['tb.vhd'],top:'tb',stopTime:savedStopTime}));
    wizard(s,stopTime === 'all' ? 'all' : 'time', ['tb',stopTime]);
    const pick = s.vscode.window.showQuickPick;
    s.vscode.window.showQuickPick = async (items, options) => {
      if(options.title === 'Select simulation run mode') { assert.equal(items.find(item => item.picked).id,stopTime === 'all' ? 'all' : 'time'); assert.equal(items[0].id,stopTime === 'all' ? 'all' : 'time'); }
      return pick(items,options);
    };
    const input = s.vscode.window.showInputBox;
    s.vscode.window.showInputBox = async options => {
      if(options.title === 'Simulation stop time') assert.equal(options.value,stopTime);
      return input(options);
    };
    s.vscode.window.showInformationMessage = async () => 'Replace';
    init(s); await s.commands.get('nvcRunner.configure')();
    assert.equal(JSON.parse(await fs.readFile(path.join(root,'vhdl.sim.json'),'utf8')).stopTime,stopTime);
    assert.deepEqual(s.errors,[]);
  }
});
test('cancelling mode selection or numeric duration preserves existing config', async t => {
  for (const mode of [undefined,'time']) {
    const root = await fixture(t), s = fake(root), filename = path.join(root,'vhdl.sim.json');
    const original = JSON.stringify({sources:['tb.vhd'],top:'tb',stopTime:'2us'});
    await fs.writeFile(filename,original); wizard(s,mode,['tb',undefined]); init(s);
    await s.commands.get('nvcRunner.configure')(); assert.equal(await fs.readFile(filename,'utf8'),original);
    assert.deepEqual(s.errors,[]);
  }
});
test('Run All adapter temporarily overrides saved numeric config and subsequent Run stays numeric', {timeout:15000}, async t => {
  const executable = process.env.NVC_BATCH_TEST || '/opt/homebrew/bin/nvc';
  try {await fs.access(executable);} catch {t.skip('No batch NVC installed.');return;}
  const root=await fixture(t), s=fake(root), filename=path.join(root,'vhdl.sim.json');
  await fs.writeFile(path.join(root,'tb.vhd'), 'entity tb is end; architecture sim of tb is begin process begin wait for 12 ns; report "AFTER_LIMIT"; wait; end process; end;');
  const original=JSON.stringify({sources:['tb.vhd'],top:'tb',stopTime:'5ns'}); await fs.writeFile(filename,original);
  s.vscode.workspace.getConfiguration=()=>({get:(key,fallback)=>key==='nvcPath'?executable:key==='waveformWindow'?'beside':fallback});
  const instance=init(s);t.after(()=>instance.dispose());assert.equal(typeof s.commands.get('nvcRunner.runAll'),'function');
  const all = await s.commands.get('nvcRunner.runAll')(); assert.ok(all,s.errors.join(' ')); assert.match(all.output,/12ns.*AFTER_LIMIT/);
  assert.equal(await fs.readFile(filename,'utf8'),original);
  const numeric = await s.commands.get('nvcRunner.run')(); assert.ok(numeric,s.errors.join(' ')); assert.doesNotMatch(numeric.output,/AFTER_LIMIT/);
  assert.equal(await fs.readFile(filename,'utf8'),original);
  assert.ok(s.calls.some(([kind,text])=>kind==='output'&&/Run mode: Run All/.test(text)));
  assert.ok(s.calls.some(([kind,text])=>kind==='output'&&/Run mode: Run until specified time \(5ns\)/.test(text)));
  assert.equal(s.calls.filter(([kind])=>kind==='vscode.openWith').length,2);
});
test('Run All contribution appears in command palette and VHDL editor overflow and explorer', () => {
  const manifest = require('../package.json');
  assert.equal(manifest.contributes.commands.find(item=>item.command==='nvcRunner.runAll')?.title,'NVC: Run All');
  for (const menu of ['editor/title','explorer/context']) {
    const item=manifest.contributes.menus[menu].find(item=>item.command==='nvcRunner.runAll');
    assert.ok(item); assert.match(item.when,/resourceExtname == \.vhd/);
    if(menu==='editor/title') assert.notEqual(item.group,'navigation');
  }
});

test('Run All reuses trust, save and project lock protection', async t => {
  const root=await fixture(t), s=fake(root);init(s);
  const runAll=s.commands.get('nvcRunner.runAll');assert.equal(typeof runAll,'function');
  let saved=0,release;const pending=new Promise(resolve=>release=resolve);
  s.vscode.workspace.textDocuments=[{isDirty:true,uri:{fsPath:path.join(root,'tb.vhd'),scheme:'file'},save:async()=>{saved++;await pending;return false;}}];
  s.vscode.workspace.isTrusted=false;await runAll();assert.equal(saved,0);assert.match(s.errors[0],/Trust/);
  s.vscode.workspace.isTrusted=true;const first=runAll();while(!saved)await new Promise(resolve=>setImmediate(resolve));
  await s.commands.get('nvcRunner.run')();release();await first;
  assert.equal(saved,1);assert.ok(s.errors.some(message=>/already/.test(message)));assert.ok(s.errors.some(message=>/save/.test(message)));
});
test('Run All cancellation through registered command releases project lock and preserves displayed wave', {timeout:15000}, async t => {
  const executable=process.env.NVC_BATCH_TEST||'/opt/homebrew/bin/nvc';
  try{await fs.access(executable);}catch{t.skip('No batch NVC installed.');return;}
  let cancellationEnabled=false,cancelRequested=false,cancelling;
  const root=await fixture(t),s=fake(root,text=>{
    if(cancellationEnabled&&text.includes('ADAPTER_CLOCK')&&!cancelRequested){
      cancelRequested=true;cancelling=s.commands.get('nvcRunner.cancel')();
    }
  });
  await fs.writeFile(path.join(root,'tb.vhd'),`library ieee; use ieee.std_logic_1164.all; entity tb is end;
architecture sim of tb is signal clk:std_logic:='0'; begin clk<=not clk after 5 ns;
process begin report "ADAPTER_CLOCK"; wait; end process; end;`);
  await fs.writeFile(path.join(root,'vhdl.sim.json'),JSON.stringify({sources:['tb.vhd'],top:'tb',stopTime:'5ns'}));
  s.vscode.workspace.getConfiguration=()=>({get:(key,fallback)=>key==='nvcPath'?executable:key==='waveformWindow'?'beside':fallback});
  const instance=init(s);t.after(()=>instance.dispose());assert.equal(typeof s.commands.get('nvcRunner.runAll'),'function');
  const prior=await s.commands.get('nvcRunner.run')();assert.ok(prior,s.errors.join(' '));
  const marker=path.join(root,'.nvc-build','waveform.nvcwave'), previous=await fs.readFile(marker,'utf8');
  cancellationEnabled=true;
  await s.commands.get('nvcRunner.runAll')();await cancelling;
  assert.equal(cancelRequested,true);assert.deepEqual(s.errors,[]);assert.equal(await fs.readFile(marker,'utf8'),previous);
  assert.ok((await fs.stat(prior.wavePath)).size>0);
  cancellationEnabled=false;const next=await s.commands.get('nvcRunner.run')();assert.ok(next,s.errors.join(' '));
});


test('Run All runtime failure reports diagnostics and preserves the previous viewer result', {timeout:15000}, async t => {
  const executable=process.env.NVC_BATCH_TEST||'/opt/homebrew/bin/nvc';
  try{await fs.access(executable);}catch{t.skip('No batch NVC installed.');return;}
  const root=await fixture(t),s=fake(root),source=path.join(root,'tb.vhd');
  await fs.writeFile(source,'entity tb is end; architecture sim of tb is begin process begin wait for 5 ns; wait; end process; end;');
  await fs.writeFile(path.join(root,'vhdl.sim.json'),JSON.stringify({sources:['tb.vhd'],top:'tb',stopTime:'5ns'}));
  s.vscode.workspace.getConfiguration=()=>({get:(key,fallback)=>key==='nvcPath'?executable:key==='waveformWindow'?'beside':fallback});
  const instance=init(s);t.after(()=>instance.dispose());
  assert.equal(typeof s.commands.get('nvcRunner.runAll'),'function');
  const prior=await s.commands.get('nvcRunner.run')();assert.ok(prior,s.errors.join(' '));
  const marker=path.join(root,'.nvc-build','waveform.nvcwave'),previous=await fs.readFile(marker,'utf8');
  await fs.writeFile(source,'entity tb is end; architecture sim of tb is begin process begin wait for 12 ns; assert false report "RUN_ALL_FAILURE" severity failure; wait; end process; end;');
  assert.equal(await s.commands.get('nvcRunner.runAll')(),undefined);
  assert.match(s.errors[0],/exited with code/);assert.ok(s.diagnostics.get(source).some(item=>item.message.includes('RUN_ALL_FAILURE')));
  assert.equal(await fs.readFile(marker,'utf8'),previous);assert.ok((await fs.stat(prior.wavePath)).size>0);
  assert.equal(s.calls.filter(([kind])=>kind==='vscode.openWith').length,1);
});

test('Run All cancelled during Surfer activation preserves last displayed wave and records', {timeout:15000}, async t=>{
  const executable=process.env.NVC_BATCH_TEST||'/opt/homebrew/bin/nvc';
  try{await fs.access(executable);}catch{t.skip('No batch NVC installed.');return;}
  const root=await fixture(t),s=fake(root);
  await fs.writeFile(path.join(root,'tb.vhd'),'entity tb is end; architecture sim of tb is begin process begin wait for 12 ns; report "END_REPORT"; wait; end process; end;');
  await fs.writeFile(path.join(root,'vhdl.sim.json'),JSON.stringify({sources:['tb.vhd'],top:'tb',stopTime:'5ns'}));
  s.vscode.workspace.getConfiguration=()=>({get:(key,fallback)=>key==='nvcPath'?executable:key==='waveformWindow'?'beside':fallback});
  const instance=init(s);t.after(()=>instance.dispose());
  const prior=await s.commands.get('nvcRunner.run')();assert.ok(prior,s.errors.join(' '));
  const viewerMarker=path.join(root,'.nvc-build','waveform.nvcwave'),resultMarker=path.join(root,'.nvc-build','.nvc-runner.json');
  const viewerSnapshot=await fs.readFile(viewerMarker,'utf8'),resultSnapshot=await fs.readFile(resultMarker,'utf8');
  s.vscode.extensions.getExtension=()=>({activate:async()=>{await new Promise(resolve=>setImmediate(resolve));await s.commands.get('nvcRunner.cancel')();}});
  assert.equal(await s.commands.get('nvcRunner.runAll')(),undefined);
  assert.ok((await fs.stat(prior.wavePath)).size>0);
  assert.equal(await fs.readFile(viewerMarker,'utf8'),viewerSnapshot);assert.equal(await fs.readFile(resultMarker,'utf8'),resultSnapshot);
  assert.deepEqual(s.errors,[]);assert.equal(s.calls.filter(([kind])=>kind==='vscode.openWith').length,1);
  s.vscode.extensions.getExtension=()=>({activate:async()=>{}});
  const next=await s.commands.get('nvcRunner.run')();assert.ok(next,s.errors.join(' '));
});
test('Run All viewer open failure preserves the last successful FST and result record', {timeout:15000}, async t=>{
  const executable=process.env.NVC_BATCH_TEST||'/opt/homebrew/bin/nvc';
  try{await fs.access(executable);}catch{t.skip('No batch NVC installed.');return;}
  const root=await fixture(t),s=fake(root);
  await fs.writeFile(path.join(root,'tb.vhd'),'entity tb is end; architecture sim of tb is begin process begin wait for 12 ns; wait; end process; end;');
  await fs.writeFile(path.join(root,'vhdl.sim.json'),JSON.stringify({sources:['tb.vhd'],top:'tb',stopTime:'5ns'}));
  s.vscode.workspace.getConfiguration=()=>({get:(key,fallback)=>key==='nvcPath'?executable:key==='waveformWindow'?'beside':fallback});
  const instance=init(s);t.after(()=>instance.dispose());const prior=await s.commands.get('nvcRunner.run')();assert.ok(prior,s.errors.join(' '));
  const marker=path.join(root,'.nvc-build','.nvc-runner.json'),snapshot=await fs.readFile(marker,'utf8');
  const viewerMarker=path.join(root,'.nvc-build','waveform.nvcwave'),viewerSnapshot=await fs.readFile(viewerMarker,'utf8');
  s.vscode.commands.executeCommand=async()=>{throw new Error('viewer open failed');};
  assert.equal(await s.commands.get('nvcRunner.runAll')(),undefined);assert.match(s.errors[0],/viewer open failed/);
  assert.ok((await fs.stat(prior.wavePath)).size>0);assert.equal(await fs.readFile(marker,'utf8'),snapshot);
  assert.equal(await fs.readFile(viewerMarker,'utf8'),viewerSnapshot);
});

test('Run All cancellation while awaiting viewer open retains the previous successful file', {timeout:15000}, async t=>{
  const executable=process.env.NVC_BATCH_TEST||'/opt/homebrew/bin/nvc';
  try{await fs.access(executable);}catch{t.skip('No batch NVC installed.');return;}
  const root=await fixture(t),s=fake(root);
  await fs.writeFile(path.join(root,'tb.vhd'),'entity tb is end; architecture sim of tb is begin process begin wait for 12 ns; wait; end process; end;');
  await fs.writeFile(path.join(root,'vhdl.sim.json'),JSON.stringify({sources:['tb.vhd'],top:'tb',stopTime:'5ns'}));
  s.vscode.workspace.getConfiguration=()=>({get:(key,fallback)=>key==='nvcPath'?executable:key==='waveformWindow'?'beside':fallback});
  const instance=init(s);t.after(()=>instance.dispose());const prior=await s.commands.get('nvcRunner.run')();assert.ok(prior,s.errors.join(' '));
  const marker=path.join(root,'.nvc-build','.nvc-runner.json'),snapshot=await fs.readFile(marker,'utf8');
  const viewerMarker=path.join(root,'.nvc-build','waveform.nvcwave'),viewerSnapshot=await fs.readFile(viewerMarker,'utf8');
  s.vscode.commands.executeCommand=async()=>{await new Promise(resolve=>setImmediate(resolve));await s.commands.get('nvcRunner.cancel')();};
  assert.equal(await s.commands.get('nvcRunner.runAll')(),undefined);
  assert.ok((await fs.stat(prior.wavePath)).size>0);assert.equal(await fs.readFile(marker,'utf8'),snapshot);assert.deepEqual(s.errors,[]);
  assert.equal(await fs.readFile(viewerMarker,'utf8'),viewerSnapshot);
});

test('failed core commit rolls back the viewer handoff and keeps the old successful wave', {timeout:15000}, async t=>{
 const executable=process.env.NVC_BATCH_TEST||'/opt/homebrew/bin/nvc';
 try{await fs.access(executable);}catch{t.skip('No batch NVC installed.');return;}
 const root=await fixture(t),s=fake(root);
 await fs.writeFile(path.join(root,'tb.vhd'),'entity tb is end; architecture sim of tb is begin process begin wait for 12 ns; wait; end process; end;');
 await fs.writeFile(path.join(root,'vhdl.sim.json'),JSON.stringify({sources:['tb.vhd'],top:'tb',stopTime:'5ns'}));
 s.vscode.workspace.getConfiguration=()=>({get:(key,fallback)=>key==='nvcPath'?executable:key==='waveformWindow'?'beside':fallback});
 const instance=init(s);t.after(()=>instance.dispose());const prior=await s.commands.get('nvcRunner.run')();assert.ok(prior,s.errors.join(' '));
 const marker=path.join(root,'.nvc-build','.nvc-runner.json'),snapshot=await fs.readFile(marker,'utf8');
 const viewerMarker=path.join(root,'.nvc-build','waveform.nvcwave'),viewerSnapshot=await fs.readFile(viewerMarker,'utf8');
 const rename=fs.rename;t.after(()=>{fs.rename=rename;});
 fs.rename=async(from,to)=>{if(to===marker&&path.basename(from).startsWith('.result-'))throw new Error('commit refused');return rename(from,to);};
 assert.equal(await s.commands.get('nvcRunner.runAll')(),undefined);assert.match(s.errors[0],/commit refused/);
 assert.ok((await fs.stat(prior.wavePath)).size>0);assert.equal(await fs.readFile(marker,'utf8'),snapshot);
 assert.equal(await fs.readFile(viewerMarker,'utf8'),viewerSnapshot);
});

test('Run All accepted viewer and markers stay successful when old FST cleanup is denied', {timeout:15000}, async t=>{
 const executable=process.env.NVC_BATCH_TEST||'/opt/homebrew/bin/nvc';
 try{await fs.access(executable);}catch{t.skip('No batch NVC installed.');return;}
 const root=await fixture(t),s=fake(root);
 await fs.writeFile(path.join(root,'tb.vhd'),'entity tb is end; architecture sim of tb is begin process begin wait for 12 ns; wait; end process; end;');
 await fs.writeFile(path.join(root,'vhdl.sim.json'),JSON.stringify({sources:['tb.vhd'],top:'tb',stopTime:'5ns'}));
 s.vscode.workspace.getConfiguration=()=>({get:(key,fallback)=>key==='nvcPath'?executable:key==='waveformWindow'?'beside':fallback});
 const instance=init(s);t.after(()=>instance.dispose());const prior=await s.commands.get('nvcRunner.run')();assert.ok(prior,s.errors.join(' '));
 const unlink=fs.unlink;t.after(()=>{fs.unlink=unlink;});
 fs.unlink=async filename=>{if(filename===prior.wavePath)throw Object.assign(new Error('EACCES old FST retained'),{code:'EACCES'});return unlink(filename);};
 const result=await s.commands.get('nvcRunner.runAll')();assert.ok(result,s.errors.join(' '));assert.deepEqual(s.errors,[]);
 assert.ok((await fs.stat(prior.wavePath)).size>0);assert.ok((await fs.stat(result.wavePath)).size>0);
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'.nvc-build','.nvc-runner.json'),'utf8')).wave,path.basename(result.wavePath));
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'.nvc-build','waveform.nvcwave'),'utf8')).wave,path.basename(result.wavePath));
 assert.ok(s.calls.some(([kind,text])=>kind==='output'&&/Warning.*EACCES old FST retained/.test(text)));
});

test('architecture selection command persists a named choice then restores NVC default',async t=>{
 const root=await fixture(t),s=fake(root),filename=path.join(root,'vhdl.sim.json');
 await fs.writeFile(path.join(root,'tb.vhd'),'entity tb is end; architecture FIRST of tb is begin end; architecture second of tb is begin end;');
 const original={sources:['tb.vhd'],top:'tb',stopTime:'all',libraryPaths:[],dumpArrays:8};await fs.writeFile(filename,JSON.stringify(original));
 s.vscode.window.showQuickPick=async items=>({...items.find(item=>item.architecture==='FIRST'),label:'translated label'});
 init(s);assert.equal(typeof s.commands.get('nvcRunner.selectArchitecture'),'function');
 await s.commands.get('nvcRunner.selectArchitecture')();assert.deepEqual(JSON.parse(await fs.readFile(filename,'utf8')),{...coreConfig(original),architecture:'FIRST'});
 s.vscode.window.showQuickPick=async items=>items.find(item=>item.id==='default');await s.commands.get('nvcRunner.selectArchitecture')();
 assert.deepEqual(JSON.parse(await fs.readFile(filename,'utf8')),coreConfig(original));assert.deepEqual(s.errors,[]);
});
function coreConfig(value){return require('../src/core').validateConfig(value);}
test('architecture selection cancellation, dirty config and external edits never overwrite config',async t=>{
 for(const action of ['cancel','dirty','changed','symlink','trust']) {
  const root=await fixture(t),s=fake(root),filename=path.join(root,'vhdl.sim.json');
  const original=JSON.stringify({sources:['tb.vhd'],top:'tb',architecture:'sim'});await fs.writeFile(filename,original);
  s.vscode.window.showQuickPick=async items=>{
   if(action==='cancel')return;
   if(action==='dirty')s.vscode.workspace.textDocuments=[{isDirty:true,uri:{fsPath:filename}}];
   if(action==='changed')await fs.writeFile(filename,original+'\n');
   if(action==='symlink'){await fs.unlink(filename);await fs.symlink(path.join(root,'tb.vhd'),filename);}
   if(action==='trust')s.vscode.workspace.isTrusted=false;
   return items.find(item=>item.id==='default');
  };
  init(s);assert.equal(typeof s.commands.get('nvcRunner.selectArchitecture'),'function');await s.commands.get('nvcRunner.selectArchitecture')();
  if(action==='symlink'){assert.equal((await fs.lstat(filename)).isSymbolicLink(),true);assert.equal(await fs.readFile(path.join(root,'tb.vhd'),'utf8'),'entity tb is end;');}
  else assert.equal(await fs.readFile(filename,'utf8'),original+(action==='changed'?'\n':''));
  assert.equal(s.errors.length,action==='cancel'?0:1);
 }
});
test('configuration wizard selects an architecture of the confirmed top',async t=>{
 const root=await fixture(t),s=fake(root);await fs.writeFile(path.join(root,'tb.vhd'),'entity tb is end; architecture first of tb is begin end; architecture second of tb is begin end;');
 wizard(s,'all');const pick=s.vscode.window.showQuickPick;
 s.vscode.window.showQuickPick=async(items,options)=> options.title.includes('Testbench architecture')?items.find(item=>item.architecture==='first'):pick(items,options);
 init(s);await s.commands.get('nvcRunner.configure')();assert.deepEqual(s.errors,[]);assert.equal(JSON.parse(await fs.readFile(path.join(root,'vhdl.sim.json'),'utf8')).architecture,'first');
});
test('architecture selection uses unsaved source declarations and rejects untrusted projects',async t=>{
 const root=await fixture(t),s=fake(root);await fs.writeFile(path.join(root,'vhdl.sim.json'),JSON.stringify({sources:['tb.vhd'],top:'tb'}));
 s.vscode.workspace.textDocuments=[{isDirty:true,uri:{fsPath:path.join(root,'tb.vhd')},getText:()=> 'architecture unsaved of tb is begin end;'}];
 let asked=false;s.vscode.window.showQuickPick=async items=>{asked=true;return items.find(item=>item.architecture==='unsaved');};
 init(s);await s.commands.get('nvcRunner.selectArchitecture')();assert.equal(JSON.parse(await fs.readFile(path.join(root,'vhdl.sim.json'),'utf8')).architecture,'unsaved');
 asked=false;s.vscode.workspace.isTrusted=false;await s.commands.get('nvcRunner.selectArchitecture')();assert.equal(asked,false);assert.equal(s.errors.length,1);
});

test('architecture selection releases project lock before its success notification closes',async t=>{
 const root=await fixture(t),s=fake(root);await fs.writeFile(path.join(root,'vhdl.sim.json'),JSON.stringify({sources:['tb.vhd'],top:'tb'}));
 s.vscode.window.showQuickPick=async items=>items.find(item=>item.id==='default');
 let shown=false,release;const pending=new Promise(resolve=>release=resolve);
 s.vscode.window.showInformationMessage=async()=>{shown=true;await pending;};init(s);
 const selection=s.commands.get('nvcRunner.selectArchitecture')();
 try{while(!shown)await new Promise(resolve=>setImmediate(resolve));await s.commands.get('nvcRunner.run')();assert.ok(!s.errors.some(message=>/already running or being configured/.test(message)));assert.ok(s.calls.some(([kind,text])=>kind==='output'&&text.includes('Project: ')));}finally{release();await selection;}
});
