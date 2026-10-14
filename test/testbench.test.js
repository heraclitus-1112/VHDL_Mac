'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tb = require('../src/testbench');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const core=require('../src/core');
const source = `library ieee; use ieee.std_logic_1164.all;
-- entity fake is port(x: in integer); end;
entity Demo is generic(WIDTH: positive := 4); port(
clk, rst: in std_logic; data: in unsigned(WIDTH-1 downto 0);
valid: in boolean; n: in integer range -2 to 2; q: out unsigned(WIDTH-1 downto 0)); end Demo;
architecture rtl of Demo is begin end;`;
test('parse real entities, shared ports and generic dependent subtypes',()=>{
 const entities=tb.parseEntities(source);assert.equal(entities.length,1);
 const model=tb.instantiateEntity(entities[0],{WIDTH:'8'});
 assert.deepEqual(model.ports.map(p=>p.name),['clk','rst','data','valid','n','q']);
 assert.equal(model.ports[2].width,8);assert.equal(model.ports[2].type,'unsigned(7 downto 0)');assert.deepEqual(model.architectures,['rtl']);
});
test('validate values by type, signedness and range',()=>{
 const m=tb.instantiateEntity(tb.parseEntities(source)[0],{WIDTH:'4'});
 assert.equal(tb.formatValue(m.ports[2],'x"A"'),'"1010"');
 assert.equal(tb.formatValue(m.ports[3],'true'),'true');
 assert.throws(()=>tb.formatValue(m.ports[2],'16'),/bit width/);
 assert.throws(()=>tb.formatValue(m.ports[4],'3'),/range/);
 assert.throws(()=>tb.formatValue(m.ports[0],'0; finish'),/value/);
});
test('time sequences are monotonic, start at zero and stay within duration',()=>{
 const p=tb.instantiateEntity(tb.parseEntities(source)[0],{WIDTH:'4'}).ports[0];
 assert.equal(tb.timeFs('20 ns'),20000000n);
 assert.equal(tb.parseEvents(p,'0ns=0;20ns=1;100ns=0',tb.timeFs('1us')).length,3);
 for(const input of ['10ns=1','0ns=0;0ns=1','0ns=0;2us=1'])assert.throws(()=>tb.parseEvents(p,input,tb.timeFs('1us')));
});
test('reject unsupported interfaces instead of emitting wrong VHDL',()=>{
 assert.throws(()=>tb.instantiateEntity(tb.parseEntities('entity e is port(io: inout std_logic); end;')[0],{}),/inout/);
 assert.throws(()=>tb.instantiateEntity(tb.parseEntities('entity e is port(x: in custom_type); end;')[0],{}),/type/);
 assert.throws(()=>tb.parseEntities('entity e is generic(type T); end;'),/generic/);
});
test('generate distinct drivers, explicit associations and honest completion message',()=>{
 const m=tb.instantiateEntity(tb.parseEntities(source)[0],{WIDTH:'4'});
 const code=tb.generateTestbench(m,{name:'tb_demo',architecture:'rtl',duration:'200ns',inputs:{
 clk:{mode:'clock',value:'0',period:'10ns',start:'0ns'},rst:{mode:'events',value:'0ns=1;20ns=0'},
 data:{mode:'events',value:'0ns=x"0";30ns=x"A"'},valid:{mode:'fixed',value:'true'},n:{mode:'fixed',value:'-2'}}});
 assert.match(code,/clk => tb_clk/);assert.match(code,/WIDTH => 4/);assert.match(code,/wait for 5 ns/);
 assert.doesNotMatch(code,/TB_PASS/);assert.match(code,/-- Stimuli complete; no output assertions configured/);assert.doesNotMatch(code,/tb_q <=/);
 assert.throws(()=>tb.generateTestbench(m,{name:'tb_demo',duration:'1ns',inputs:{}}),/input/);
});
test('real NVC runs generated counter stimuli and generic bus values',async t=>{
 let executable;try{executable=await core.resolveNvc('');}catch{t.skip('NVC is not installed');return;}
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'generated NVC project ')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const counter=await fs.readFile(path.resolve(__dirname,'../examples/counter/counter.vhd'),'utf8');
 const model=tb.instantiateEntity(tb.parseEntities(counter)[0]);
 let code=tb.generateTestbench(model,{name:'tb_generated',architecture:'rtl',duration:'300ns',inputs:{clk:{mode:'clock',value:'0',start:'0ns',period:'10ns'},rst:{mode:'events',value:'0ns=1;20ns=0'},en:{mode:'events',value:'0ns=0;20ns=1;100ns=0;130ns=1'}}});
 code=code.replace('end architecture sim;',`check_values:process begin wait for 21 ns;assert tb_count=0 severity failure;wait for 80 ns;assert tb_count=8 severity failure;wait for 20 ns;assert tb_count=8 severity failure;wait for 30 ns;assert tb_count=10 severity failure;wait;end process;end architecture sim;`);
 await fs.writeFile(path.join(root,'counter.vhd'),counter);await fs.writeFile(path.join(root,'tb_generated.vhd'),code);
 const result=await core.runSimulation({executable,projectDir:root,config:{sources:['counter.vhd','tb_generated.vhd'],top:'tb_generated',standard:'2008',stopTime:'300ns',libraryPaths:[]}});
 assert.ok((await fs.stat(result.wavePath)).size>0);assert.match(result.output,/STIMULUS_DONE: no output assertions configured/);assert.doesNotMatch(result.output,/TB_PASS/);
 const bus=`library ieee;use ieee.std_logic_1164.all;use ieee.numeric_std.all;entity bus_design is generic(WIDTH:positive:=8);port(data:in unsigned(WIDTH-1 downto 0);s:in signed(WIDTH-1 downto 0);b:in boolean;n:in positive;q:out unsigned(WIDTH-1 downto 0));end;architecture rtl of bus_design is begin q<=data;end;`;
 let busCode=tb.generateTestbench(tb.instantiateEntity(tb.parseEntities(bus)[0]),{name:'tb_bus',architecture:'rtl',duration:'100ns',inputs:{data:{mode:'events',value:'0ns=x"00";20ns=x"A5"'},s:{mode:'fixed',value:'-4'},b:{mode:'fixed',value:'true'},n:{mode:'fixed',value:'1'}}});
 busCode=busCode.replace('end architecture sim;',`check_values:process begin wait for 21 ns;assert tb_q=165 severity failure;assert tb_s=-4 severity failure;assert tb_b and tb_n=1 severity failure;wait;end process;end architecture sim;`);
 await fs.writeFile(path.join(root,'bus.vhd'),bus);await fs.writeFile(path.join(root,'tb_bus.vhd'),busCode);
 await core.runSimulation({executable,projectDir:root,config:{sources:['bus.vhd','tb_bus.vhd'],top:'tb_bus',standard:'2008',stopTime:'100ns',libraryPaths:[]}});
});
