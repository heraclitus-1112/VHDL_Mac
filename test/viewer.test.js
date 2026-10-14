'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {SurferViewer}=require('../src/viewer');
function fixture(root){const messages=[],calls=[],stored=new Map();let provider;const panel={viewColumn:2,webview:{options:{},html:'',asWebviewUri:u=>({toString:()=>`https://test/${u.fsPath}`}),postMessage:async m=>{messages.push(m);if(m.command==='snapshot')queueMicrotask(()=>panel.receive({command:'state',id:m.id,state:'saved-layout'}));return true;},onDidReceiveMessage:fn=>{panel.receive=fn;return{dispose(){}};}},onDidDispose:fn=>{panel.close=fn;return{dispose(){}};},reveal:()=>calls.push(['reveal'])};const vscode={Uri:{file:fsPath=>({fsPath,scheme:'file',toString:()=>fsPath}),joinPath:(uri,...parts)=>({fsPath:path.join(uri.fsPath,...parts)})},ViewColumn:{Active:-1,Beside:-2},extensions:{getExtension:()=>({extensionUri:{fsPath:root},packageJSON:{version:'0.7.1001488'}})},window:{registerCustomEditorProvider:(_,p)=>{provider=p;return{dispose(){}};}},commands:{getCommands:async()=>['workbench.action.moveEditorToNewWindow'],executeCommand:async(...args)=>{calls.push(args);if(args[0]==='vscode.openWith')await provider.resolveCustomEditor({uri:args[1]},panel);}}};const context={extensionUri:{fsPath:root},subscriptions:[],workspaceState:{get:key=>stored.get(key),update:async(key,value)=>stored.set(key,value)}};return{vscode,context,panel,messages,calls,stored};}
test('same project reuses one editor/window and switches new waves with preserved view',async t=>{const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'viewer ')));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'.nvc-build'));await fs.mkdir(path.join(root,'surfer'));await fs.writeFile(path.join(root,'surfer/surfer.js'),'');const first=path.join(root,'.nvc-build/first.fst'),second=path.join(root,'.nvc-build/second.fst');await fs.writeFile(first,'wave1');await fs.writeFile(second,'wave2');const f=fixture(root),viewer=new SurferViewer(f.vscode,f.context,()=>{});await viewer.show({projectDir:root,wavePath:first},'newWindow',true);await f.panel.receive({command:'ready'});await f.panel.receive({command:'loaded'});await f.panel.receive({command:'state',state:'saved-layout'});await viewer.show({projectDir:root,wavePath:second},'newWindow',true);assert.equal(f.calls.filter(c=>c[0]==='vscode.openWith').length,1);assert.equal(f.calls.filter(c=>c[0]==='workbench.action.moveEditorToNewWindow').length,1);assert.equal(f.messages.filter(m=>m.command==='load').at(-1).keep,true);assert.match(f.messages.filter(m=>m.command==='load').at(-1).url,/second\.fst/);assert.ok([...f.stored.values()].some(value=>value.state==='saved-layout'));});
test('viewer marker rejects a symlink before overwriting it',async t=>{const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'viewer ')));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'.nvc-build'));const wave=path.join(root,'.nvc-build/a.fst');await fs.writeFile(wave,'wave');await fs.symlink(wave,path.join(root,'.nvc-build/waveform.nvcwave'));const f=fixture(root),viewer=new SurferViewer(f.vscode,f.context,()=>{});await assert.rejects(viewer.show({projectDir:root,wavePath:wave},'newWindow',true),/symbolic link/);assert.equal(await fs.readFile(wave,'utf8'),'wave');});
async function project(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'viewer ')));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'.nvc-build'));await fs.mkdir(path.join(root,'surfer'));await fs.writeFile(path.join(root,'surfer/surfer.js'),'');await fs.writeFile(path.join(root,'.nvc-build/a.fst'),'wave');return root;}
test('restore only state from the matching Surfer version and honour reset preference',async t=>{const root=await project(t),f=fixture(root),viewer=new SurferViewer(f.vscode,f.context,()=>{});f.stored.set(viewer.stateKey(root),{version:'0.7.1001488',state:'layout'});await viewer.show({projectDir:root,wavePath:path.join(root,'.nvc-build/a.fst')});await f.panel.receive({command:'ready'});assert.equal(f.messages.find(m=>m.command==='load').restore,'layout');await f.panel.receive({command:'loaded'});await viewer.show({projectDir:root,wavePath:path.join(root,'.nvc-build/a.fst')},'newWindow',false);assert.equal(f.messages.filter(m=>m.command==='load').at(-1).keep,false);assert.equal(f.messages.filter(m=>m.command==='load').at(-1).restore,undefined);f.panel.close();f.stored.set(viewer.stateKey(root),{version:'old',state:'obsolete'});await viewer.show({projectDir:root,wavePath:path.join(root,'.nvc-build/a.fst')});await f.panel.receive({command:'ready'});assert.equal(f.messages.filter(m=>m.command==='load').at(-1).restore,undefined);});
test('native save, command and waveform dialogs preserve the official message protocol',async t=>{const root=await project(t),f=fixture(root),viewer=new SurferViewer(f.vscode,f.context,()=>{}),saved=[];f.vscode.window.showSaveDialog=async()=>f.vscode.Uri.file(path.join(root,'state.ron'));f.vscode.workspace={fs:{writeFile:async(uri,data)=>saved.push([uri.fsPath,data.toString()]),readFile:async()=>Buffer.from('zoom_fit')}};const filters=[];f.vscode.window.showOpenDialog=async options=>{filters.push(options.filters);return[f.vscode.Uri.file(path.join(root,'external.sucl'))];};await viewer.show({projectDir:root,wavePath:path.join(root,'.nvc-build/a.fst')});await f.panel.receive({command:'vscodeSaveStateFromWasm',data:'actual RON'});assert.equal(saved[0][1],'actual RON');await f.panel.receive({command:'open-dialog',kind:'command_file'});assert.equal(f.messages.at(-1).kind,'command_file');assert.deepEqual(filters[0],{'Surfer commands':['sucl']});await f.panel.receive({command:'open-dialog',kind:'waveform_clear'});assert.equal(f.calls.at(-1)[2],'surfer.waveformViewer');});
test('interactive waves in a nested directory resolve through the stable project marker',async t=>{const root=await project(t),f=fixture(root),viewer=new SurferViewer(f.vscode,f.context,()=>{}),wave=path.join(root,'.nvc-build/interactive-test/segment.vcd');await fs.mkdir(path.dirname(wave));await fs.writeFile(wave,'wave');await viewer.show({projectDir:root,wavePath:wave});await f.panel.receive({command:'ready'});assert.match(f.messages.find(m=>m.command==='load').url,/interactive-test\/segment.vcd/);});


test('failed reuse restores the viewer marker and prior entry and reloads the previous wave',async t=>{
 const root=await project(t),f=fixture(root),viewer=new SurferViewer(f.vscode,f.context,()=>{});t.after(()=>viewer.dispose());
 const first=path.join(root,'.nvc-build/a.fst'),second=path.join(root,'.nvc-build/b.fst'),marker=path.join(root,'.nvc-build/waveform.nvcwave');
 await fs.writeFile(second,'new-wave');await viewer.show({projectDir:root,wavePath:first},'beside');
 await f.panel.receive({command:'ready'});await f.panel.receive({command:'loaded'});const snapshot=await fs.readFile(marker,'utf8');
 const postMessage=f.panel.webview.postMessage;
 f.panel.webview.postMessage=async message=>{if(message.command==='load'&&message.url.endsWith('b.fst'))throw new Error('load delivery failed');return postMessage(message);};
 await assert.rejects(viewer.show({projectDir:root,wavePath:second},'beside'),/load delivery failed/);
 assert.equal(await fs.readFile(marker,'utf8'),snapshot);assert.equal(viewer.entries.get(marker).wave,first);
 assert.match(f.messages.filter(message=>message.command==='load').at(-1).url,/a\.fst$/);
 assert.equal(f.messages.filter(message=>message.command==='load').at(-1).restore,'saved-layout');
});
test('cancellation during existing viewer load restores prior marker and sends old wave again',async t=>{
 const root=await project(t),f=fixture(root),viewer=new SurferViewer(f.vscode,f.context,()=>{});t.after(()=>viewer.dispose());
 const first=path.join(root,'.nvc-build/a.fst'),second=path.join(root,'.nvc-build/b.fst'),marker=path.join(root,'.nvc-build/waveform.nvcwave');
 await fs.writeFile(second,'new-wave');await viewer.show({projectDir:root,wavePath:first},'beside');
 await f.panel.receive({command:'ready'});await f.panel.receive({command:'loaded'});const snapshot=await fs.readFile(marker,'utf8'),controller=new AbortController();
 const postMessage=f.panel.webview.postMessage;
 f.panel.webview.postMessage=async message=>{const result=await postMessage(message);if(message.command==='load'&&message.url.endsWith('b.fst'))controller.abort();return result;};
 await assert.rejects(viewer.show({projectDir:root,wavePath:second},'beside',true,controller.signal),error=>error.name==='AbortError');
 assert.equal(await fs.readFile(marker,'utf8'),snapshot);assert.equal(viewer.entries.get(marker).wave,first);
 assert.match(f.messages.filter(message=>message.command==='load').at(-1).url,/a\.fst$/);
 assert.equal(f.messages.filter(message=>message.command==='load').at(-1).restore,'saved-layout');
});

test('rollback restores the captured layout even when normal layout preservation is disabled',async t=>{
 const root=await project(t),f=fixture(root),viewer=new SurferViewer(f.vscode,f.context,()=>{});t.after(()=>viewer.dispose());
 const first=path.join(root,'.nvc-build/a.fst'),second=path.join(root,'.nvc-build/b.fst'),marker=path.join(root,'.nvc-build/waveform.nvcwave');
 await fs.writeFile(second,'new-wave');await viewer.show({projectDir:root,wavePath:first},'beside',false);
 await f.panel.receive({command:'ready'});await f.panel.receive({command:'loaded'});
 const snapshot=await fs.readFile(marker,'utf8'),postMessage=f.panel.webview.postMessage;
 f.panel.webview.postMessage=async message=>{if(message.command==='load'&&message.url.endsWith('b.fst'))throw new Error('handoff refused');return postMessage(message);};
 await assert.rejects(viewer.show({projectDir:root,wavePath:second},'beside',false),/handoff refused/);
 const restored=f.messages.filter(message=>message.command==='load').at(-1);
 assert.equal(restored.restore,'saved-layout');assert.equal(await fs.readFile(marker,'utf8'),snapshot);assert.equal(viewer.entries.get(marker).preserve,false);
});
test('rollback uses the captured old layout even if new renderer state overwrites workspace storage',async t=>{
 const root=await project(t),f=fixture(root),viewer=new SurferViewer(f.vscode,f.context,()=>{});t.after(()=>viewer.dispose());
 const first=path.join(root,'.nvc-build/a.fst'),second=path.join(root,'.nvc-build/b.fst');
 await fs.writeFile(second,'new-wave');await viewer.show({projectDir:root,wavePath:first},'beside');
 await f.panel.receive({command:'ready'});await f.panel.receive({command:'loaded'});
 const postMessage=f.panel.webview.postMessage;
 f.panel.webview.postMessage=async message=>{
  if(message.command==='load'&&message.url.endsWith('b.fst')){await f.panel.receive({command:'state',state:'new-layout'});throw new Error('late renderer failure');}
  return postMessage(message);
 };
 await assert.rejects(viewer.show({projectDir:root,wavePath:second},'beside'),/late renderer failure/);
 assert.equal(f.messages.filter(message=>message.command==='load').at(-1).restore,'saved-layout');
});
test('viewer temporary cleanup failure preserves accepted rollback receipt and primary errors',async t=>{
 const root=await project(t),f=fixture(root),warnings=[],viewer=new SurferViewer(f.vscode,f.context,message=>warnings.push(message));t.after(()=>viewer.dispose());
 const first=path.join(root,'.nvc-build/a.fst'),second=path.join(root,'.nvc-build/b.fst'),marker=path.join(root,'.nvc-build/waveform.nvcwave');
 await fs.writeFile(second,'new-wave');
 const rm=fs.rm;t.after(()=>{fs.rm=rm;});
 fs.rm=async(filename,...args)=>{if(path.dirname(filename)===path.join(root,'.nvc-build')&&path.basename(filename).startsWith('.viewer-'))throw Object.assign(new Error('EACCES viewer temporary cleanup'),{code:'EACCES'});return rm(filename,...args);};
 const rollback=await viewer.show({projectDir:root,wavePath:first},'beside');assert.equal(typeof rollback,'function');
 assert.equal(JSON.parse(await fs.readFile(marker,'utf8')).wave,'a.fst');assert.ok(warnings.some(message=>/clean up.*EACCES viewer temporary cleanup/.test(message)));
 await f.panel.receive({command:'ready'});await f.panel.receive({command:'loaded'});const snapshot=await fs.readFile(marker,'utf8');
 const primary=new Error('primary delivery failure'),postMessage=f.panel.webview.postMessage;
 f.panel.webview.postMessage=async message=>{if(message.command==='load'&&message.url.endsWith('b.fst'))throw primary;return postMessage(message);};
 await assert.rejects(viewer.show({projectDir:root,wavePath:second},'beside'),error=>error===primary);
 assert.equal(await fs.readFile(marker,'utf8'),snapshot);assert.equal(viewer.entries.get(marker).wave,first);
});
