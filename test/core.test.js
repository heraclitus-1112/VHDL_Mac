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
  await assert.rejects(core.resolveProject(root,{...config,sources:['escape.vhd']}), /workspace|工作区/);
  await fs.symlink(outside,path.join(root,'.nvc-build'));
  await assert.rejects(core.resolveProject(root,config), /build|构建/);
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
test('analysis failure stops later stages and cannot return previous waveform', async t => {
  const root = await fixture(t); const ok=await simulator(root); assert.equal(typeof core.runSimulation,'function'); const prior=await core.runSimulation(ok); const failed=await simulator(root,'fail');
  await assert.rejects(core.runSimulation(failed),error=>error.stage==='analysis'&&error.output.includes('syntax error'));
  const calls=(await fs.readFile(path.join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,4);await assert.rejects(fs.stat(prior.wavePath));
});
test('missing new waveform rejects even if an unrelated old waveform exists',async t=>{
  const root=await fixture(t);await fs.mkdir(path.join(root,'.nvc-build'));await fs.writeFile(path.join(root,'.nvc-build','old.fst'),'old');const opts=await simulator(root,'missing');assert.equal(typeof core.runSimulation,'function');await assert.rejects(core.runSimulation(opts),/波形|wave/);
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
test('reject source alias into dedicated build directory',async t=>{const root=await fixture(t);await fs.mkdir(path.join(root,'.nvc-build'));await fs.writeFile(path.join(root,'.nvc-build','user.vhd'),'source');await fs.symlink(path.join(root,'.nvc-build','user.vhd'),path.join(root,'alias.vhd'));await assert.rejects(core.resolveProject(root,{...config,sources:['alias.vhd']}),/构建/);});
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
