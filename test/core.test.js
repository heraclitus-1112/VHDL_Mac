'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let core = {}; try { core = require('../src/core'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const config = { sources: ['counter with spaces.vhd', 'tb.vhdl'], top: 'tb_counter' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nvc project spaces '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, config.sources[0]), 'entity counter is end;');
  await fs.writeFile(path.join(root, config.sources[1]), 'entity tb_counter is end;');
  return await fs.realpath(root);
}
async function simulator(root, mode = 'ok') {
  const script = path.join(root, 'fake nvc.cjs');
  await fs.writeFile(script, `const fs = require('node:fs'); const args = process.argv.slice(2); const stage = args.find(a => ['-a','-e','-r'].includes(a)); fs.appendFileSync('calls.jsonl', JSON.stringify(args)+'\\n'); console.log('stage '+stage); if (${JSON.stringify(mode)} === 'fail' && stage === '-a') { console.error('** Error: syntax error\\n   counter with spaces.vhd:3:7'); process.exit(1); } if (${JSON.stringify(mode)} === 'slow') {setInterval(()=>{},1000);} else if(stage === '-r' && ${JSON.stringify(mode)} !== 'missing') { const wave = args.find(a=>a.startsWith('--wave=')); fs.writeFileSync(wave.slice(7), 'fresh-wave'); }`);
  return { executable: process.execPath, executableArgs: [script], projectDir: root, config };
}
test('validate ordered config and defaults without mutating input', () => {
  assert.equal(typeof core.validateConfig, 'function');
  const result = core.validateConfig(config);
  assert.deepEqual(result.sources, config.sources); assert.equal(result.standard, '2008'); assert.equal(result.stopTime, '1us'); assert.deepEqual(result.libraryPaths, []); assert.equal(config.standard, undefined);
});
test('reject invalid config and injection-like values', () => {
  assert.equal(typeof core.validateConfig, 'function');
  for (const change of [{sources:[]},{sources:['../outside.vhd']},{sources:['/outside.vhd']},{sources:['x.vhd','x.vhd']},{sources:['note.txt']},{top:'tb; touch nope'},{top:'-r'},{standard:'2019'},{stopTime:'0ns'},{stopTime:'1ns;rm'},{stopTime:'1.2ns'},{libraryPaths:'x'}]) assert.throws(()=>core.validateConfig({...config,...change}));
});
test('resolve real source and library dirs in project with spaces', async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root,'lib dir'));
  assert.equal(typeof core.resolveProject, 'function');
  const result = await core.resolveProject(root,{...config,libraryPaths:['lib dir']});
  assert.equal(result.sources[0], await fs.realpath(path.join(root,config.sources[0]))); assert.equal(result.libraryPaths[0],path.join(root,'lib dir'));
});
test('reject missing sources, source symlink escape, and build symlink', async t => {
  const root = await fixture(t); const outside = await fs.mkdtemp(path.join(os.tmpdir(),'nvc outside ')); t.after(()=>fs.rm(outside,{recursive:true,force:true})); await fs.writeFile(path.join(outside,'escape.vhd'),'outside');
  assert.equal(typeof core.resolveProject, 'function');
  await assert.rejects(core.resolveProject(root,{...config,sources:['missing.vhd']}));
  await fs.symlink(path.join(outside,'escape.vhd'),path.join(root,'escape.vhd'));
  await assert.rejects(core.resolveProject(root,{...config,sources:['escape.vhd']}), /workspace/);
  await fs.symlink(outside,path.join(root,'.nvc-build'));
  await assert.rejects(core.resolveProject(root,config), /build/);
});
test('discover VHDL files ignoring generated directories and symlink escapes', async t => {
  const root = await fixture(t); for(const dir of ['.nvc-build','.git','node_modules','build','dist']){await fs.mkdir(path.join(root,dir));await fs.writeFile(path.join(root,dir,'hidden.vhd'),'');} await fs.mkdir(path.join(root,'rtl')); await fs.writeFile(path.join(root,'rtl','UPPER.VHD'),'');
  assert.equal(typeof core.discoverSources, 'function');
  assert.deepEqual(await core.discoverSources(root),[...config.sources,'rtl/UPPER.VHD'].sort());
});
test('run stages in order with consistent context, fresh unique waves and preserve other files', async t => {
  const root = await fixture(t); const opts = await simulator(root); assert.equal(typeof core.runSimulation,'function');
  await fs.mkdir(path.join(root,'.nvc-build')); await fs.writeFile(path.join(root,'.nvc-build','user.fst'),'user');
  const output=[]; const a=await core.runSimulation({...opts,onOutput:s=>output.push(s)}); const b=await core.runSimulation(opts);
  assert.notEqual(a.wavePath,b.wavePath); assert.equal(await fs.readFile(b.wavePath,'utf8'),'fresh-wave'); assert.equal(await fs.readFile(path.join(root,'.nvc-build','user.fst'),'utf8'),'user'); await assert.rejects(fs.stat(a.wavePath));
  const calls=(await fs.readFile(path.join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(args=>args.find(a=>['-a','-e','-r'].includes(a))),['-a','-e','-r','-a','-e','-r']);
  for(const args of calls){assert.ok(args.includes('--std=2008'));assert.ok(args.some(a=>a.startsWith('--work=work:')));}
  assert.ok(calls[0].includes(path.join(root,config.sources[0]))); assert.ok(output.join('').includes('stage -r'));
});
test('analysis failure stops later stages, rejects this run and preserves last successful waveform', async t => {
  const root = await fixture(t); const ok=await simulator(root); assert.equal(typeof core.runSimulation,'function'); const prior=await core.runSimulation(ok); const failed=await simulator(root,'fail');
  await assert.rejects(core.runSimulation(failed),error=>error.stage==='analysis'&&error.output.includes('syntax error'));
  const calls=(await fs.readFile(path.join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,4);assert.equal(await fs.readFile(prior.wavePath,'utf8'),'fresh-wave');
});
test('missing new waveform rejects even if an unrelated old waveform exists',async t=>{
  const root=await fixture(t);await fs.mkdir(path.join(root,'.nvc-build'));await fs.writeFile(path.join(root,'.nvc-build','old.fst'),'old');const opts=await simulator(root,'missing');assert.equal(typeof core.runSimulation,'function');await assert.rejects(core.runSimulation(opts),/waveform/);
});
test('cancellation terminates the running child and stops further stages',async t=>{
  const root=await fixture(t);const opts=await simulator(root,'slow');assert.equal(typeof core.runSimulation,'function');const controller=new AbortController();let started=false;
  const pending=core.runSimulation({...opts,signal:controller.signal,onOutput:s=>{if(!started&&s.includes('stage')){started=true;controller.abort();}}});await assert.rejects(pending,error=>error.name==='AbortError'); const calls=(await fs.readFile(path.join(root,'calls.jsonl'),'utf8')).trim().split('\n');assert.equal(calls.length,1);
});
test('parse inline and separated NVC diagnostic messages with paths containing spaces',()=>{
  assert.equal(typeof core.parseDiagnostics,'function');
  const result=core.parseDiagnostics('** Error: cannot find name\n   rtl/counter with spaces.vhd:12:4\n** Warning: unused signal\n  tb.vhdl:9:1\nother.vhd:2:8: error: bad token','/project');
  assert.equal(result.length,3);assert.equal(result[0].filePath,'/project/rtl/counter with spaces.vhd');assert.equal(result[0].line,11);assert.equal(result[0].column,3);assert.equal(result[0].message,'cannot find name');assert.equal(result[1].severity,'warning');assert.equal(result[2].message,'bad token');
});
test('explicit executable override wins and missing executable gives actionable error',async t=>{ const root=await fixture(t);assert.equal(typeof core.resolveNvc,'function');assert.equal(await core.resolveNvc(process.execPath),await fs.realpath(process.execPath));await assert.rejects(core.resolveNvc(path.join(root,'absent')),/nvcRunner.nvcPath/);});
test('parse actual NVC 1.23 arrow location without column',()=>{
  const result=core.parseDiagnostics('** Error: unexpected is while parsing concurrent procedure call statement, expecting one of ( or ;\n   > /project/broken.vhd:8\n   |\n 8 |   this is invalid vhdl;\n   |        ^^ this token was unexpected','/project');
  assert.deepEqual(result,[{filePath:'/project/broken.vhd',line:7,column:0,severity:'error',message:'unexpected is while parsing concurrent procedure call statement, expecting one of ( or ;'}]);
});
test('reject source alias into dedicated build directory',async t=>{const root=await fixture(t);await fs.mkdir(path.join(root,'.nvc-build'));await fs.writeFile(path.join(root,'.nvc-build','user.vhd'),'source');await fs.symlink(path.join(root,'.nvc-build','user.vhd'),path.join(root,'alias.vhd'));await assert.rejects(core.resolveProject(root,{...config,sources:['alias.vhd']}),/build/);});
test('all three stages have identical library paths and declared stop time',()=>{const args=core.buildStageArgs({sources:['/p/a.vhd'],top:'tb',standard:'1993',stopTime:'2ms',libraryPaths:['/lib with spaces']},'/p/.nvc-build','/p/.nvc-build/new.fst');for(const stage of args){assert.deepEqual(stage.args.slice(0,4),['--std=1993','--work=work:/p/.nvc-build/work','-L','/lib with spaces']);}assert.ok(args[2].args.includes('--stop-time=2ms'));});
test('runtime assertion failure maps process frame to source Problems',()=>{
  const diagnostics=core.parseDiagnostics('** Failure: 1ns+0: SPEC_RUNTIME_FAILURE\n   Process :tb_fail:_p0 at /project/tb_fail.vhd:1','/project');
  assert.deepEqual(diagnostics,[{filePath:'/project/tb_fail.vhd',line:0,column:0,severity:'error',message:'1ns+0: SPEC_RUNTIME_FAILURE'}]);
});
test('runtime Error and Warning procedure frames extract only source paths',()=>{
  const diagnostics=core.parseDiagnostics('** Error: 2ns+0: assertion error\n   Process :tb:_p0 at /project/path with spaces/tb.vhd:12\n** Warning: 3ns+0: warning message\n   Procedure :work.pkg.check at /project/pkg.vhdl:5:3','/project');
  assert.deepEqual(diagnostics,[{filePath:'/project/path with spaces/tb.vhd',line:11,column:0,severity:'error',message:'2ns+0: assertion error'},{filePath:'/project/pkg.vhdl',line:4,column:2,severity:'warning',message:'3ns+0: warning message'}]);
});
test('runtime warning with successful child exit does not stop simulation',async t=>{
  const root=await fixture(t);const options=await simulator(root);const script=options.executableArgs[0];const original=await fs.readFile(script,'utf8');await fs.writeFile(script,original+"\nif(stage === '-r') console.warn('** Warning: 1ns+0: expected warning\\n   Process :tb_counter:_p0 at '+process.cwd()+'/tb.vhdl:4');\n");
  const result=await core.runSimulation(options);assert.equal(await fs.readFile(result.wavePath,'utf8'),'fresh-wave');const diagnostics=core.parseDiagnostics(result.output,root);assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].severity,'warning');assert.equal(diagnostics[0].filePath,path.join(root,'tb.vhdl'));assert.equal(diagnostics[0].line,3);
});

test('array dumping is validated and included only in the simulation command',()=>{
  const c=core.validateConfig({...config,dumpArrays:1024});
  const args=core.buildStageArgs(c,'/tmp/build','/tmp/build/current.fst');
  assert.ok(args[2].args.includes('--dump-arrays=1024'));
  assert.ok(args.slice(0,2).every(stage=>!stage.args.some(arg=>arg.startsWith('--dump-arrays'))));
  for(const value of [-1,1.5,1000001,'1024'])assert.throws(()=>core.validateConfig({...config,dumpArrays:value}));
});


test('all stop time is accepted literally and omits only the stop-time argument', () => {
  const input = {...config, stopTime:'all', dumpArrays:1024};
  const validated = core.validateConfig(input);
  assert.equal(validated.stopTime, 'all');
  const allArgs = core.buildStageArgs(validated, '/tmp/build', '/tmp/current.fst');
  const timedArgs = core.buildStageArgs({...validated, stopTime:'2us'}, '/tmp/build', '/tmp/current.fst');
  assert.deepEqual(allArgs, timedArgs.map(stage => ({...stage, args:stage.args.filter(arg => !arg.startsWith('--stop-time='))})));
  assert.deepEqual(input, {...config, stopTime:'all', dumpArrays:1024});
  for (const value of ['ALL',' all','all ','all;rm','infinite',1]) assert.throws(() => core.validateConfig({...config,stopTime:value}));
});
test('schema accepts all and numeric durations while retaining omitted-field compatibility', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(__dirname,'../schemas/config.schema.json'),'utf8'));
  const field = schema.properties.stopTime;
  assert.equal(field.type,'string'); assert.equal(field.default,'1us');
  for (const value of ['all','1us','10sec']) assert.ok(new RegExp(field.pattern).test(value), value);
  for (const value of ['ALL','0ns','all;rm','1.2ns']) assert.ok(!new RegExp(field.pattern).test(value), value);
});

test('rejected result handoff preserves prior waveform and successful result record',async t=>{
  const root=await fixture(t),options=await simulator(root),prior=await core.runSimulation(options);
  const marker=path.join(root,'.nvc-build','.nvc-runner.json'),snapshot=await fs.readFile(marker,'utf8');
  let handedOff=false;
  await assert.rejects(core.runSimulation({...options,onResult:async result=>{
    handedOff=true;assert.ok((await fs.stat(result.wavePath)).size>0);assert.ok((await fs.stat(prior.wavePath)).size>0);
    throw new Error('viewer refused result');
  }}),/viewer refused result/);
  assert.equal(handedOff,true);assert.ok((await fs.stat(prior.wavePath)).size>0);
  assert.equal(await fs.readFile(marker,'utf8'),snapshot);
});
test('cancellation during async result handoff preserves prior waveform and record',async t=>{
  const root=await fixture(t),options=await simulator(root),prior=await core.runSimulation(options);
  const marker=path.join(root,'.nvc-build','.nvc-runner.json'),snapshot=await fs.readFile(marker,'utf8'),controller=new AbortController();
  let handedOff=false;
  await assert.rejects(core.runSimulation({...options,signal:controller.signal,onResult:async()=>{
    handedOff=true;await new Promise(resolve=>setImmediate(resolve));controller.abort();
  }}),error=>error.name==='AbortError');
  assert.equal(handedOff,true);assert.ok((await fs.stat(prior.wavePath)).size>0);
  assert.equal(await fs.readFile(marker,'utf8'),snapshot);
});

test('cancellation while preparing result publication cannot delete the previous waveform',async t=>{
  const root=await fixture(t),options=await simulator(root),prior=await core.runSimulation(options);
  const marker=path.join(root,'.nvc-build','.nvc-runner.json'),snapshot=await fs.readFile(marker,'utf8'),controller=new AbortController();
  const writeFile=fs.writeFile;let intercepted=false;
  t.after(()=>{fs.writeFile=writeFile;});
  fs.writeFile=async(filename,...args)=>{
    const result=await writeFile(filename,...args);
    if(path.dirname(filename)===path.join(root,'.nvc-build')&&path.basename(filename).startsWith('.result-')){intercepted=true;controller.abort();}
    return result;
  };
  await assert.rejects(core.runSimulation({...options,signal:controller.signal}),error=>error.name==='AbortError');
  assert.equal(intercepted,true);assert.ok((await fs.stat(prior.wavePath)).size>0);
  assert.equal(await fs.readFile(marker,'utf8'),snapshot);
});

test('result handoff rollback is called if cancellation occurs before the commit',async t=>{
 const root=await fixture(t),options=await simulator(root),prior=await core.runSimulation(options),controller=new AbortController();
 let restored=false;
 await assert.rejects(core.runSimulation({...options,signal:controller.signal,onResult:async()=>{
  controller.abort();return async()=>{restored=true;};
 }}),error=>error.name==='AbortError');
 assert.equal(restored,true);assert.ok((await fs.stat(prior.wavePath)).size>0);
});

test('postcommit old-wave cleanup failure warns while returning the accepted result',async t=>{
 const root=await fixture(t),options=await simulator(root),prior=await core.runSimulation(options),output=[];
 const unlink=fs.unlink;t.after(()=>{fs.unlink=unlink;});
 fs.unlink=async filename=>{if(filename===prior.wavePath)throw Object.assign(new Error('old wave cleanup refused'),{code:'EACCES'});return unlink(filename);};
 const result=await core.runSimulation({...options,onOutput:text=>output.push(text)});
 assert.notEqual(result.wavePath,prior.wavePath);assert.ok((await fs.stat(result.wavePath)).size>0);assert.ok((await fs.stat(prior.wavePath)).size>0);
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'.nvc-build','.nvc-runner.json'),'utf8')).wave,path.basename(result.wavePath));
 assert.match(output.join(''),/Warning.*old wave cleanup refused/);assert.match(result.output,/Warning.*old wave cleanup refused/);
});
test('postcommit temporary cleanup failure cannot reject the accepted result',async t=>{
 const root=await fixture(t),options=await simulator(root),output=[],rm=fs.rm;t.after(()=>{fs.rm=rm;});
 fs.rm=async(filename,...args)=>{if(path.basename(filename).startsWith('.result-'))throw new Error('temporary cleanup refused');return rm(filename,...args);};
 const result=await core.runSimulation({...options,onOutput:text=>output.push(text)});
 assert.ok((await fs.stat(result.wavePath)).size>0);
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'.nvc-build','.nvc-runner.json'),'utf8')).wave,path.basename(result.wavePath));
 assert.match(output.join(''),/Warning.*temporary cleanup refused/);
});
test('precommit errors and AbortError remain primary when temporary cleanup also fails',async t=>{
 for(const mode of ['diagnostic','abort']){
  const root=await fixture(t),options=await simulator(root),controller=new AbortController(),output=[];
  const rm=fs.rm;t.after(()=>{fs.rm=rm;});
  fs.rm=async(filename,...args)=>{if(path.dirname(filename)===path.join(root,'.nvc-build')&&path.basename(filename).startsWith('.result-'))throw new Error('secondary cleanup refused');return rm(filename,...args);};
  const primary=Object.assign(new Error('primary viewer error'),{output:'original diagnostics'});
  await assert.rejects(core.runSimulation({...options,signal:controller.signal,onOutput:text=>output.push(text),onResult:async()=>{
   if(mode==='abort')controller.abort();else throw primary;
  }}),error=>mode==='abort'?error.name==='AbortError':error===primary&&error.output==='original diagnostics');
  assert.match(output.join(''),/Warning.*secondary cleanup refused/);fs.rm=rm;
 }
});
