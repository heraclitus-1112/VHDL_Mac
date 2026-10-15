'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { filterArchitectures } = require('./selected-source');
const FILE_LIMIT = 4 * 1024 * 1024;
function checkCancelled(signal) {
  if (signal?.aborted) { const error = new Error('Simulation cancelled.'); error.name = 'AbortError'; throw error; }
}
async function readSource(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    if ((await handle.stat()).size > FILE_LIMIT) throw new Error(`Selected compilation source limit is 4 MiB per file: ${filename}`);
    const buffer = Buffer.alloc(FILE_LIMIT + 1); let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break; length += result.bytesRead;
    }
    if (length > FILE_LIMIT) throw new Error(`Selected compilation source limit is 4 MiB per file: ${filename}`);
    return Buffer.from(buffer.subarray(0, length));
  } finally { await handle.close(); }
}
async function prepareCompilation(resolved, runDir, signal, onOutput) {
  if (!resolved.architecture) return { ...resolved, mapText: text => text };
  checkCancelled(signal);
  const files = []; let total = 0;
  for (const filename of resolved.sources) {
    checkCancelled(signal); const buffer = await readSource(filename); total += buffer.length;
    if (total > 16 * 1024 * 1024) throw new Error('Selected compilation source limit is 16 MiB total. Narrow the source selection.');
    files.push({ filename, buffer });
  }
  const filtered = filterArchitectures(files, resolved.top, resolved.architecture);
  const sourceDir = path.join(runDir, 'sources');
  await fs.mkdir(sourceDir); const mapping = [];
  for (let index = 0; index < filtered.files.length; index++) {
    checkCancelled(signal);
    const file = filtered.files[index], directory = path.join(sourceDir, String(index));
    await fs.mkdir(directory);
    const shadow = path.join(directory, path.basename(file.filename));
    await fs.writeFile(shadow, file.buffer, {flag:'wx'}); mapping.push([shadow, file.filename]);
  }
  checkCancelled(signal);
  onOutput?.(`Selected compilation: ${resolved.top}(${resolved.architecture}); excluded alternative TB architectures: ${filtered.excluded.map(item=>item.architecture).join(', ') || 'none'}。\n`);
  const mapText = text => { for (const [shadow, original] of mapping) text = text.split(shadow).join(original); return text; };
  return { ...resolved, sources: mapping.map(([shadow])=>shadow), mapText };
}
function createLineMapper(mapText = text=>text, emit = ()=>{}) {
  let pending = '';
  return {
    write(text) {
      pending += text; let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0,newline+1);pending=pending.slice(newline+1);emit(mapText(line));
      }
    },
    end() { if (pending) { const tail=pending;pending='';emit(mapText(tail)); } }
  };
}
async function cleanCompilation(runDir, onWarning, whole = false) {
  const directories = whole ? [runDir] : [path.join(runDir,'sources'),path.join(runDir,'work')];
  for (const directory of directories) try { await fs.rm(directory,{recursive:true,force:true}); }
  catch (error) { onWarning?.(`Warning: Failed to clean compilation scratch (${directory}): ${error.message}\n`); }
}
module.exports={prepareCompilation,createLineMapper,cleanCompilation};
