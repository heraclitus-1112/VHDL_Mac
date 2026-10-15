'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const core=require('../src/core');
const batch='/opt/homebrew/bin/nvc',interactive=path.join(os.homedir(),'.local/share/vhdl-mac/nvc-interactive-livewave/bin/nvc');
const source=`entity dut is end; architecture rtl of dut is begin end;
entity tb is end;
architecture good of tb is signal value:integer:=1; begin
 u: entity work.dut(rtl);
 process begin wait for 2 ns; report "SELECTED_GOOD"; wait; end process;
end;
architecture unfinished of tb is begin
 u: entity work.dut(missing);
end;
`;
async function fixture(t,text=source){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nvc selected source ')));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,'tb.vhd'),text);return {root,options:{executable:batch,projectDir:root,config:{sources:['tb.vhd'],top:'tb',architecture:'good',stopTime:'all'}}};}
test('selected architecture runs despite an unfinished alternative; default and selected bad still fail',async t=>{
 const {root,options}=await fixture(t),original=await fs.readFile(path.join(root,'tb.vhd'));let observed;
 const good=await core.runSimulation({...options,onStage:(stage,args)=>{if(stage==='analysis')observed=args;}});assert.match(good.output,/SELECTED_GOOD/);assert.ok((await fs.stat(good.wavePath)).size>0);
 const marker=await fs.readFile(path.join(root,'.nvc-build/.nvc-runner.json'),'utf8');
 await assert.rejects(core.runSimulation({...options,config:{...options.config,architecture:undefined}}),e=>/missing/i.test(e.output));
 await assert.rejects(core.runSimulation({...options,config:{...options.config,architecture:'unfinished'}}),e=>e.output.includes(path.join(root,'tb.vhd')+':8')&&!/selected-.*sources/.test(e.output));
 assert.equal(await fs.readFile(path.join(root,'.nvc-build/.nvc-runner.json'),'utf8'),marker);
 assert.deepEqual(await fs.readFile(path.join(root,'tb.vhd')),original);assert.ok(observed.some(a=>a.includes('sources')));
 assert.ok(!(await fs.readdir(path.join(root,'.nvc-build'))).some(n=>n.startsWith('selected-')));
});
test('compile and runtime source locations point to original lines, including paths split between chunks',async t=>{
 const text=source.replace('report "SELECTED_GOOD"','assert false report "SELECTED_FAILURE" severity failure');
 const {root,options}=await fixture(t,text);const seen=[];
 await assert.rejects(core.runSimulation({...options,onOutput:s=>seen.push(s)}),error=>{
  const filename=path.join(root,'tb.vhd');assert.match(error.output,/SELECTED_FAILURE/);assert.ok(error.output.includes(filename+':5'));
  assert.ok(core.parseDiagnostics(error.output,root).some(d=>d.filePath===filename&&d.line===4));return true;
 });
 assert.ok(seen.join('').includes(path.join(root,'tb.vhd')+':5'));
 const {createLineMapper}=require('../src/compilation');let output='';const shadow='/tmp/owned sources/tb.vhd',real='/project/course/tb.vhd';
 const m=createLineMapper(s=>s.split(shadow).join(real),s=>output+=s);m.write('  > /tmp/owned sour');m.write('ces/tb.vhd:5\nlast');m.end();assert.equal(output,'  > /project/course/tb.vhd:5\nlast');
});
test('selected compile uses fresh libraries rather than stale units from a previous selection',async t=>{
 const {root,options}=await fixture(t,source.replace('missing','rtl'));await core.runSimulation({...options,config:{...options.config,architecture:'unfinished'}});
 await fs.writeFile(path.join(root,'tb.vhd'),source);await core.runSimulation(options);
 await assert.rejects(core.runSimulation({...options,config:{...options.config,architecture:'unfinished'}}),e=>/missing/i.test(e.output));
});
test('interactive selection retains live source shadows until the child closes and then cleans scratch',async t=>{
 const {InteractiveSession}=require('../src/interactive');const {root,options}=await fixture(t);let session;const output=[];
 try{
  session=await InteractiveSession.start({...options,executable:interactive,onOutput:s=>output.push(s)});
  assert.ok((await fs.readdir(session.buildDir)).includes('sources'));
  await session.run('3ns');assert.match(output.join(''),/SELECTED_GOOD/);assert.ok(output.join('').includes(path.join(root,'tb.vhd')+':5'));
  assert.equal(await session.examine('/value'),'1');session.close();await new Promise(resolve=>session.child.once('close',resolve));await session.cleanupDone;
  await assert.rejects(fs.access(path.join(session.buildDir,'sources')),{code:'ENOENT'});
  assert.ok((await fs.stat(session.lastWavePath)).size>0);
 }finally{session?.close();}
});
test('cancelled selected compilation preserves prior wave and removes owned compile scratch',async t=>{
 const {root,options}=await fixture(t);const good=await core.runSimulation(options);const bytes=await fs.readFile(good.wavePath);
 await fs.writeFile(path.join(root,'tb.vhd'),source.replace('wait for 2 ns; report "SELECTED_GOOD"; wait;','report "CLOCK_RUNNING"; loop wait for 1 ns; end loop;'));
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),3000);t.after(()=>clearTimeout(timeout));
 await assert.rejects(core.runSimulation({...options,signal:controller.signal,onOutput:s=>{if(s.includes('CLOCK_RUNNING'))controller.abort();}}),e=>e.name==='AbortError');
 assert.deepEqual(await fs.readFile(good.wavePath),bytes);assert.ok(!(await fs.readdir(path.join(root,'.nvc-build'))).some(n=>n.startsWith('selected-')));
});

test('many small sources retain actual content rather than a 4 MiB backing buffer per file',async t=>{
 const {execFile}=require('node:child_process'),{promisify}=require('node:util');const {root}=await fixture(t);
 const files=['tb.vhd'];for(let i=0;i<63;i++){const filename=`unit${i}.vhd`;files.push(filename);await fs.writeFile(path.join(root,filename),`entity unit${i} is end;`);}
 const scratch=path.join(root,'scratch');await fs.mkdir(scratch);
 const script=`const {prepareCompilation}=require(process.argv[1]);const path=require('node:path');global.gc();const before=process.memoryUsage().arrayBuffers;prepareCompilation({top:'tb',architecture:'good',sources:JSON.parse(process.argv[3]).map(f=>path.join(process.argv[2],f))},path.join(process.argv[2],'scratch'),undefined,()=>{global.gc();const growth=process.memoryUsage().arrayBuffers-before;if(growth>16*1024*1024)throw Error('Retained source buffers exceed 16 MiB: '+growth);}).catch(e=>{console.error(e.message);process.exitCode=1;});`;
 await promisify(execFile)(process.execPath,['--expose-gc','-e',script,require.resolve('../src/compilation'),root,JSON.stringify(files)]);
});
