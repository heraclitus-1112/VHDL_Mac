'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.join(__dirname, '..');
const han = /\p{Script=Han}/u;
test('English edition ships English interface strings, documentation and example sources', async () => {
  const files = ['package.json', 'README.md'];
  async function visit(relative) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const filename = path.join(relative, entry.name);
      assert.ok(!han.test(filename), `English edition has a non-English filename: ${filename}`);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile() && /\.(js|json|md|tcl|sh|patch|vhd|vhdl)$/i.test(filename)) files.push(filename);
    }
  }
  for (const directory of ['src', 'media', 'schemas', 'docs', 'examples', 'tools', 'test']) await visit(directory);
  for (const filename of files) assert.ok(!han.test(await fs.readFile(path.join(root, filename), 'utf8')), `English edition contains untranslated text: ${filename}`);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.contributes.commands.find(command => command.command === 'nvcRunner.run').title, 'NVC: Run VHDL Simulation');
  assert.equal(manifest.contributes.commands.find(command => command.command === 'nvcRunner.runAll')?.title, 'NVC: Run All');
});
