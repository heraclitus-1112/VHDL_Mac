'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { filterArchitectures } = require('../src/selected-source');
const file = (text, filename = 'test.vhd') => ({ filename, buffer: Buffer.from(text) });
const entity = 'entity Bench is end entity;\n';
const arch = (name, body = '', top = 'Bench') => `architecture ${name} of ${top} is begin ${body} end architecture ${name};\n`;
function blank(text) { return Buffer.from(text).map(byte => byte === 10 || byte === 13 ? byte : 32); }

test('keeps selected top and unrelated units and blanks only excluded architecture bytes', () => {
  const prefix = entity + arch('RTL', '', 'Other');
  const removed = 'library ieee; use ieee.std_logic_1164.all;\n' + arch('TB2', 'bad: entity work.Missing(RTL);');
  const suffix = 'library work;\n' + arch('TB1');
  const input = file(prefix + removed + suffix);
  const original = Buffer.from(input.buffer);
  const result = filterArchitectures([input], 'bench', 'tb1');
  assert.deepEqual(result.files[0].buffer, Buffer.concat([Buffer.from(prefix), blank(removed.trimEnd()), Buffer.from('\n' + suffix)]));
  assert.deepEqual(result.excluded, [{ filename: 'test.vhd', entity: 'bench', architecture: 'tb2' }]);
  assert.deepEqual(input.buffer, original);
});

test('supports either declaration order and architectures in separate files', () => {
  for (const reversed of [false, true]) {
    const sources = [file(entity + arch('TB1'), 'one.vhd'), file(arch('TB2'), 'two.vhd')];
    if (reversed) sources.reverse();
    const result = filterArchitectures(sources, 'Bench', 'TB1');
    assert.equal(result.excluded.length, 1);
    assert.equal(result.files.find(f => f.filename === 'two.vhd').buffer.toString().trim(), '');
  }
});

test('does not filter without an explicit architecture', () => {
  const sources = [file('not parsed')];
  const result = filterArchitectures(sources, 'Bench');
  assert.deepEqual(result.files, sources);
  assert.deepEqual(result.excluded, []);
});

test('handles nested bodies and ignores fake unit text in comments and literals', () => {
  const selected = `architecture TB1 of Bench is
    type Rec is record a: integer; end record;
    type Obj is protected procedure f; end protected;
    type Obj is protected body
      procedure f is begin if true then null; end if; end procedure;
    end protected body;
    function f return integer is
      function g return integer is begin return 1; end;
    begin return g; end function;
    procedure p is begin for i in 0 to 1 loop case i is when others => null; end case; end loop; end;
  begin
    g1: if true generate
      b1: block begin
        p1: process is variable c: character := ';'; begin
          report "end architecture TB1; architecture fake of Bench is";
          -- end; architecture TB2 of Bench is
          /* end architecture; */
          if f = 1 then null; elsif false then null; end if;
          wait;
        end process p1;
      end block b1;
    else generate
    end generate g1;
  end TB1;\n`;
  const result = filterArchitectures([file(entity + selected + arch('TB2'))], 'Bench', 'TB1');
  assert.ok(result.files[0].buffer.toString().includes(selected));
  assert.equal(result.excluded.length, 1);
});

test('preserves CRLF, UTF8 and Latin1 bytes and original buffer identity contents', () => {
  for (const encoding of ['utf8', 'latin1']) {
    const keep = Buffer.from(entity + '-- caf\u00e9 \u4e2d\u6587\r\n' + arch('TB1'), encoding);
    const remove = Buffer.from(arch('TB2', '-- caf\u00e9\r\n').replaceAll('\n', '\r\n'), encoding);
    const input = { filename: 'bytes.vhd', buffer: Buffer.concat([keep, remove]) };
    const saved = Buffer.from(input.buffer);
    const result = filterArchitectures([input], 'BENCH', 'TB1');
    assert.deepEqual(result.files[0].buffer.subarray(0, keep.length), keep);
    assert.deepEqual(result.files[0].buffer.subarray(keep.length), blank(remove));
    assert.deepEqual(input.buffer, saved);
  }
});

test('retains the transitive explicit dependency closure including unrelated units', () => {
  const text = entity + arch('TB1', 'u: entity work.Bench(TB2);') +
    arch('TB2', 'u: entity work.Bench(TB3);') + arch('TB3') + arch('TB4') +
    arch('Other', 'u: entity work.Bench(TB5);', 'Other') + arch('TB5');
  const result = filterArchitectures([file(text)], 'Bench', 'TB1');
  assert.deepEqual(result.excluded.map(x => x.architecture), ['tb4']);
});

test('retains architecture dependencies in explicit configuration specifications', () => {
  const text = entity + `architecture TB1 of Bench is
    component C end component;
    for u: C use entity work.Bench(TB2);
    begin u: C; end architecture;\n` + arch('TB2') + arch('TB3');
  assert.deepEqual(filterArchitectures([file(text)], 'Bench', 'TB1').excluded.map(x => x.architecture), ['tb3']);
});

test('rejects missing and duplicate selections', () => {
  assert.throws(() => filterArchitectures([file(entity + arch('TB2'))], 'Bench', 'TB1'), /selected.*TB1.*not found/i);
  assert.throws(() => filterArchitectures([file(entity + arch('TB1') + arch('tb1'))], 'Bench', 'TB1'), /duplicate.*TB1/i);
});

test('refuses ambiguous same-top default and component bindings', () => {
  for (const body of ['u: entity work.Bench;', 'u: Bench;', 'u: component Bench;',
    'u: Bench port map();', 'for all: C use entity work.Bench;']) {
    assert.throws(() => filterArchitectures([file(entity + arch('TB1', body) + arch('TB2'))], 'Bench', 'TB1'), /ambiguous.*Bench.*explicit/i);
  }
});

test('refuses configuration bindings to the top when dependencies cannot be resolved safely', () => {
  const text = entity + arch('TB1', 'u: configuration work.unknown;') + arch('TB2');
  assert.throws(() => filterArchitectures([file(text)], 'Bench', 'TB1'), /configuration.*explicit|unsupported.*configuration/i);
});

test('reports unsafe boundaries and unterminated lexical constructs with source location', () => {
  for (const text of [entity + 'architecture TB1 of Bench is begin process begin end architecture;',
    entity + 'architecture TB1 of Bench is begin',
    entity + arch('TB1') + '/* unfinished', entity + arch('TB1', 'report "unfinished;'),
    entity + arch('TB1') + 'nonsense']) {
    assert.throws(() => filterArchitectures([file(text, 'broken.vhd')], 'Bench', 'TB1'), /broken\.vhd.*(boundary|unterminated|unsupported|expected)/i);
  }
});

test('bounds source size and token work', () => {
  assert.throws(() => filterArchitectures([file(' '.repeat(4 * 1024 * 1024 + 1))], 'Bench', 'TB1'), /limit|large/i);
  const source = file(' '.repeat(4 * 1024 * 1024));
  assert.throws(() => filterArchitectures(Array(5).fill(source), 'Bench', 'TB1'), /limit|large/i);
  assert.throws(() => filterArchitectures([file(';'.repeat(600000))], 'Bench', 'TB1'), /limit/i);
});

test('excludes the removed architecture context prefix and keeps the next unit context', () => {
  const kept = entity + arch('TB1');
  const removed = 'library ieee;\nuse ieee.std_logic_1164.all;\n' + arch('TB2');
  for (const suffix of ['', 'library work;\n' + arch('RTL', '', 'Other')]) {
    const result = filterArchitectures([file(kept + removed + suffix)], 'Bench', 'TB1');
    assert.deepEqual(result.files[0].buffer, Buffer.concat([Buffer.from(kept), blank(removed), Buffer.from(suffix)]));
  }
});

test('NVC accepts excluded architecture context at EOF and original course buffers stay unchanged', t => {
  const nvc = '/opt/homebrew/bin/nvc';
  if (!fs.existsSync(nvc)) return t.skip('NVC is not installed');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-selected-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = file(entity + arch('TB1') + 'library ieee;\nuse ieee.std_logic_1164.all;\n' + arch('TB2', 'u: entity work.Missing(RTL);'));
  const result = filterArchitectures([input], 'Bench', 'TB1');
  fs.writeFileSync(path.join(root, 'filtered.vhd'), result.files[0].buffer);
  const analysis = spawnSync(nvc, ['--std=2008', '-a', 'filtered.vhd'], { cwd: root, encoding: 'utf8' });
  assert.equal(analysis.status, 0, analysis.stdout + analysis.stderr);
  const courseRoot = '/Users/macbookair/exoC04/Exo2';
  if (!fs.existsSync(path.join(courseRoot, 'serialor_tb.vhd'))) return;
  const course = ['serialor.vhd', 'serialor_tb.vhd'].map(filename => ({ filename, buffer: fs.readFileSync(path.join(courseRoot, filename)) }));
  const filtered = filterArchitectures(course, 'SerialOR_TB', 'TB1');
  assert.deepEqual(filtered.excluded.map(x => x.architecture), ['tb2']);
  for (const source of filtered.files) fs.writeFileSync(path.join(root, source.filename), source.buffer);
  const actualAnalysis = spawnSync(nvc, ['--std=2008', '-a', 'serialor.vhd', 'serialor_tb.vhd'], { cwd: root, encoding: 'utf8' });
  assert.equal(actualAnalysis.status, 0, actualAnalysis.stdout + actualAnalysis.stderr);
  const elaborate = spawnSync(nvc, ['--std=2008', '-e', 'SerialOR_TB(TB1)'], { cwd: root, encoding: 'utf8' });
  assert.equal(elaborate.status, 0, elaborate.stdout + elaborate.stderr);
  for (const source of course) assert.deepEqual(fs.readFileSync(path.join(courseRoot, source.filename)), source.buffer);
});

test('does not interpret named entity terminators as self-instantiations', () => {
  const input = file('entity Bench is end entity Bench;\n' + arch('TB1') + arch('TB2'));
  assert.deepEqual(filterArchitectures([input], 'Bench', 'TB1').excluded.map(x => x.architecture), ['tb2']);
});

test('keeps unrelated configuration declarations with named terminators', () => {
  const unrelated = `configuration C of Other is for RTL end for; end configuration C;\n`;
  const input = file(entity + arch('TB1') + arch('TB2') + unrelated);
  assert.ok(filterArchitectures([input], 'Bench', 'TB1').files[0].buffer.toString().includes(unrelated));
});

test('refuses selected component names whose final identifier is the configured top', () => {
  for (const body of ['u: work.components.Bench;',
    'u: component work.components.Bench;',
    'u: work.components.Bench port map();',
    'u: component components.Bench generic map();']) {
    assert.throws(() => filterArchitectures([file(entity + arch('TB1', body) + arch('TB2'))], 'Bench', 'TB1'), /ambiguous.*Bench.*explicit/i);
  }
});

test('keeps other qualified component names and explicit entity references unchanged', () => {
  for (const body of ['u: work.components.Other;', 'u: component components.Other;',
    'u: entity work.Other(RTL);']) {
    const result = filterArchitectures([file(entity + arch('TB1', body) + arch('TB2'))], 'Bench', 'TB1');
    assert.equal(result.excluded.length, 1);
    assert.ok(result.files[0].buffer.toString().includes(body));
  }
});

test('refuses aliases of a same-top component when binding cannot be resolved safely', () => {
  const text = entity + `architecture TB1 of Bench is
    alias LocalComponent is work.components.Bench;
    begin u: LocalComponent; end architecture;\n` + arch('TB2');
  assert.throws(() => filterArchitectures([file(text)], 'Bench', 'TB1'), /ambiguous.*Bench.*explicit/i);
});

test('refuses package component default binding that would silently change the simulated leaf', t => {
  const nvc = '/opt/homebrew/bin/nvc';
  if (!fs.existsSync(nvc)) return t.skip('NVC is not installed');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const text = `package components is
    component Bench generic (Leaf: boolean := false); end component;
    end package;
    entity Bench is generic (Leaf: boolean := false); end entity Bench;
    architecture TB1 of Bench is begin
      g: if not Leaf generate
        u: work.components.Bench generic map (true);
      end generate;
      p: process begin
        if Leaf then report "LEAF_TB1"; end if;
        wait;
      end process;
    end architecture;
    architecture TB2 of Bench is begin
      p: process begin report "LEAF_TB2"; wait; end process;
    end architecture;\n`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-component-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'original.vhd'), text);
  const run = spawnSync(nvc, ['--std=2008', '-a', 'original.vhd', '-e', 'Bench(TB1)', '-r'], {
    cwd: root, encoding: 'utf8', timeout: 10000
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout + run.stderr, /LEAF_TB2/);
  assert.doesNotMatch(run.stdout + run.stderr, /LEAF_TB1/);
  assert.throws(() => filterArchitectures([file(text)], 'Bench', 'TB1'), /ambiguous.*Bench.*explicit/i);
});
