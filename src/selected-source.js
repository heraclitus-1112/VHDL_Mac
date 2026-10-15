'use strict';

// This reader only establishes byte ranges and explicit dependencies. NVC still
// validates every retained unit. Unsupported structure fails closed.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FILE_TOKENS = 250000;
const MAX_TOTAL_TOKENS = 800000;
const MAX_WORK = 4000000;
const IDENTIFIER = /^[a-z][a-z0-9_]*$/i;

function sourceError(filename, position, message) {
  throw new Error(`${filename} at byte ${position}: ${message}. Split architectures into separate source files or use NVC-default selection.`);
}

function tokenize(file, budget) {
  const text = file.buffer.toString('latin1');
  const tokens = [];
  const fail = (i, message) => sourceError(file.filename, i, message);
  const add = (start, end, kind = 'symbol') => {
    if (tokens.length >= MAX_FILE_TOKENS || ++budget.tokens > MAX_TOTAL_TOKENS) fail(start, 'Source token limit exceeded');
    tokens.push({ value: text.slice(start, end).toLowerCase(), start, end, kind });
  };
  let i = 0;
  while (i < text.length) {
    const start = i;
    const c = text[i];
    if (/\s/.test(c) || (i === 0 && text.slice(0, 3) === '\xef\xbb\xbf')) {
      i += i === 0 && text.slice(0, 3) === '\xef\xbb\xbf' ? 3 : 1;
    } else if (c === '-' && text[i + 1] === '-') {
      i += 2;
      while (i < text.length && text[i] !== '\r' && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '/' && text[i + 1] === '*') fail(i, 'Unsupported nested block comment');
        i++;
      }
      if (i === text.length) fail(start, 'Unterminated block comment');
      i += 2;
    } else if (c === '"') {
      i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\r' || text[i] === '\n') fail(start, 'Unterminated string literal');
        if (text[i++] === '"') {
          if (text[i] === '"') i++;
          else { closed = true; break; }
        }
      }
      if (!closed) fail(start, 'Unterminated string literal');
      add(start, i, 'literal');
    } else if (c === "'" && text[i + 2] === "'" && text[i + 1] !== '\r' && text[i + 1] !== '\n') {
      i += 3;
      add(start, i, 'literal');
    } else if (c === '\\') {
      fail(start, 'Unsupported extended identifier; use basic identifiers for selected architecture compilation');
    } else if (/[a-z]/i.test(c)) {
      i++;
      while (i < text.length && /[a-z0-9_]/i.test(text[i])) i++;
      add(start, i, 'identifier');
    } else if (c.charCodeAt(0) >= 128) {
      fail(start, 'Unsupported non-ASCII source token');
    } else {
      add(start, ++i);
    }
  }
  return tokens;
}

function parseUnits(file, tokens, budget) {
  const v = i => tokens[i]?.value;
  const fail = (i, message) => sourceError(file.filename, tokens[i]?.start ?? file.buffer.length, message);
  const tick = () => { if (++budget.work > MAX_WORK) fail(0, 'Structural work limit exceeded'); };
  const scan = (from, choices) => {
    let depth = 0;
    for (let j = from; j < tokens.length; j++) {
      tick();
      const value = v(j);
      if (value === '(') depth++;
      else if (value === ')') { if (--depth < 0) fail(j, 'Uncertain parenthesis boundary'); }
      else if (depth === 0 && choices.includes(value)) return j;
    }
    fail(from, 'Unterminated declaration or statement boundary');
  };
  const name = i => {
    if (tokens[i]?.kind !== 'identifier') fail(i, 'Expected basic design-unit identifier');
    return v(i);
  };
  const units = [];
  let i = 0;
  let contextStart;
  while (i < tokens.length) {
    tick();
    const kind = v(i);
    // Context clauses are part of the following unit range. An excluded unit
    // must not leave a dangling context clause or attach it to another unit.
    if (kind === 'library' || kind === 'use' || (kind === 'context' && v(i + 2) !== 'is')) {
      contextStart ??= tokens[i].start;
      i = scan(i + 1, [';']) + 1;
      continue;
    }
    let cursor = i + 1;
    let unitKind = kind;
    if (kind === 'package' && v(cursor) === 'body') { unitKind = 'package body'; cursor++; }
    if (!['entity', 'architecture', 'package', 'configuration', 'context'].includes(kind)) fail(i, 'Unsupported or malformed design-unit boundary');
    const unitName = name(cursor++);
    let entity;
    if (kind === 'architecture' || kind === 'configuration') {
      if (v(cursor++) !== 'of') fail(cursor - 1, 'Expected of in design-unit header');
      entity = name(cursor++);
    }
    if (v(cursor++) !== 'is') fail(cursor - 1, 'Expected is in design-unit header');
    // Package instantiations have no end clause.
    if (kind === 'package' && v(cursor) === 'new') {
      const end = scan(cursor + 1, [';']);
      units.push({ kind: unitKind, name: unitName, start: contextStart ?? tokens[i].start, end: tokens[end].end, first: i, last: end, tokens, file });
      contextStart = undefined;
      i = end + 1;
      continue;
    }
    const stack = [{ kind: unitKind, name: unitName }];
    const generateOpenings = new Map();
    let closed = false;
    for (let j = cursor; j < tokens.length; j++) {
      tick();
      const value = v(j);
      if (value === 'end') {
        let k = j + 1;
        const words = [];
        while (k < tokens.length && v(k) !== ';' && words.length < 4) words.push(v(k++));
        if (v(k) !== ';') fail(j, 'Uncertain end boundary (expected semicolon)');
        const current = stack[stack.length - 1];
        const parts = current.kind.split(' ');
        let rest = words;
        if (words[0] === parts[0]) {
          rest = words.slice(1);
          if ((current.kind === 'package body' || current.kind === 'protected body') && rest[0] === 'body') rest = rest.slice(1);
        } else if (words.length && words[0] !== current.name) {
          fail(j, `Uncertain end boundary: expected end ${current.kind}${current.name ? ' ' + current.name : ''}`);
        }
        if (rest.length > 1 || (rest.length === 1 && rest[0] !== current.name)) fail(j, 'Uncertain end-name boundary');
        stack.pop();
        if (stack.length === 0) {
          units.push({ kind: unitKind, name: unitName, entity, start: contextStart ?? tokens[i].start, end: tokens[k].end, first: i, last: k, tokens, file });
          contextStart = undefined;
          i = k + 1;
          closed = true;
          break;
        }
        j = k;
        continue;
      }
      let opening;
      let openingName = v(j - 1) === ':' ? v(j - 2) : undefined;
      if (value === 'function' || value === 'procedure') {
        const end = scan(j + 1, ['is', ';']);
        if (v(end) === 'is' && v(end + 1) !== 'new') {
          opening = value;
          openingName = v(j + 1);
        }
        j = end;
      } else if (value === 'if' || value === 'case') {
        const end = scan(j + 1, value === 'if' ? ['then', 'generate', ';'] : ['is', 'generate', ';']);
        if (v(end) === 'generate') generateOpenings.set(end, openingName);
        else if (v(end) === ';') fail(j, `Unsupported ${value} boundary`);
        else opening = value;
      } else if (value === 'for' && kind !== 'configuration') {
        const end = scan(j + 1, ['loop', 'generate', 'use', ';']);
        if (v(end) === 'generate') generateOpenings.set(end, openingName);
      } else if (value === 'generate') {
        if (generateOpenings.has(j)) { opening = 'generate'; openingName = generateOpenings.get(j); }
        else if (stack[stack.length - 1].kind !== 'generate') fail(j, 'Unsupported generate boundary');
      } else if (['process', 'block', 'loop', 'record'].includes(value)) {
        opening = value;
      } else if (value === 'protected') {
        opening = v(j + 1) === 'body' ? 'protected body' : 'protected';
        if (v(j + 1) === 'body') j++;
      } else if (value === 'component' && v(j - 1) !== ':') {
        opening = 'component'; openingName = name(j + 1);
      } else if (value === 'package') {
        let k = j + 1;
        const body = v(k) === 'body';
        if (body) k++;
        const nestedName = name(k++);
        if (v(k) !== 'is') fail(j, 'Unsupported nested package boundary');
        if (v(k + 1) !== 'new') { opening = body ? 'package body' : 'package'; openingName = nestedName; }
      } else if (value === 'for' && kind === 'configuration') {
        opening = 'for';
      }
      if (opening) {
        if (stack.length >= 512) fail(j, 'Structural nesting limit exceeded');
        stack.push({ kind: opening, name: openingName });
      }
    }
    if (!closed) fail(i, `Unterminated ${unitKind} boundary`);
  }
  if (contextStart !== undefined) sourceError(file.filename, contextStart, 'Unterminated context clause boundary (expected a design unit)');
  return units;
}

function dependencies(unit, top) {
  const { tokens, first, last, file } = unit;
  const v = i => tokens[i]?.value;
  const needed = new Set();
  const ambiguous = i => sourceError(file.filename, tokens[i].start, `Ambiguous ${top} dependency; specify an explicit entity work.${top}(architecture) binding`);
  if (unit.kind === 'configuration' && unit.entity === top) ambiguous(first);
  const finalSelectedIdentifier = from => {
    if (tokens[from]?.kind !== 'identifier') return undefined;
    let end = from;
    while (end + 2 <= last && v(end + 1) === '.' && tokens[end + 2]?.kind === 'identifier') end += 2;
    return v(end);
  };
  let aliasDeclaration = false;
  for (let i = first; i <= last; i++) {
    if (v(i - 1) === 'end') continue;
    if (v(i) === 'alias') aliasDeclaration = true;
    if (v(i) === ';') aliasDeclaration = false;
    if (aliasDeclaration && v(i) === 'is' && finalSelectedIdentifier(i + 1) === top) ambiguous(i);
    if (v(i) === 'configuration' && i !== first) sourceError(file.filename, tokens[i].start, 'Unsupported configuration dependency; use an explicit entity architecture binding');
    if (v(i) === 'entity' && i !== first) {
      let k = i + 1;
      let library;
      if (v(k + 1) === '.') { library = v(k); k += 2; }
      if (v(k) !== top || (library && library !== 'work')) continue;
      if (v(k + 1) !== '(' || tokens[k + 2]?.kind !== 'identifier' || v(k + 3) !== ')') ambiguous(i);
      needed.add(v(k + 2));
    }
    // A selected component name still default-binds by its final identifier.
    // Package qualification and optional 'component' do not make that binding
    // explicit. Resolving component configuration scopes is beyond this reader.
    if (v(i) === ':') {
      const from = v(i + 1) === 'component' ? i + 2 : i + 1;
      if (finalSelectedIdentifier(from) === top) ambiguous(i);
    }
  }
  return needed;
}

function filterArchitectures(files, top, architecture) {
  if (!architecture) return { files, excluded: [] };
  if (!IDENTIFIER.test(top) || !IDENTIFIER.test(architecture)) throw new Error('Selected top and architecture require basic VHDL identifiers');
  const normalizedTop = top.toLowerCase();
  const selected = architecture.toLowerCase();
  let bytes = 0;
  for (const file of files) {
    if (!Buffer.isBuffer(file.buffer)) throw new Error(`Expected a source Buffer for ${file.filename}`);
    bytes += file.buffer.length;
    if (file.buffer.length > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES) sourceError(file.filename, 0, 'Source byte size limit exceeded');
  }
  const budget = { tokens: 0, work: 0 };
  const units = files.flatMap(file => parseUnits(file, tokenize(file, budget), budget));
  const candidates = units.filter(unit => unit.kind === 'architecture' && unit.entity === normalizedTop);
  const byName = new Map();
  for (const unit of candidates) {
    if (byName.has(unit.name)) throw new Error(`Duplicate architecture ${unit.name} of ${top}; remove the duplicate declaration`);
    byName.set(unit.name, unit);
  }
  if (!byName.has(selected)) throw new Error(`Selected architecture ${architecture} of ${top} not found`);
  const candidateSet = new Set(candidates);
  const retained = new Set(units.filter(unit => !candidateSet.has(unit) || unit.name === selected));
  const queue = [...retained];
  // Dependencies in already excluded units intentionally do not participate.
  for (let i = 0; i < queue.length; i++) {
    for (const dependency of dependencies(queue[i], normalizedTop)) {
      const unit = byName.get(dependency);
      // A missing explicit dependency stays intact for NVC's semantic diagnostic.
      if (unit && !retained.has(unit)) { retained.add(unit); queue.push(unit); }
    }
  }
  const excluded = [];
  const spans = new Map();
  for (const unit of candidates) {
    if (retained.has(unit)) continue;
    excluded.push({ filename: unit.file.filename, entity: unit.entity, architecture: unit.name });
    if (!spans.has(unit.file)) spans.set(unit.file, []);
    spans.get(unit.file).push(unit);
  }
  return {
    files: files.map(file => {
      if (!spans.has(file)) return file;
      const buffer = Buffer.from(file.buffer);
      for (const { start, end } of spans.get(file)) {
        for (let i = start; i < end; i++) if (buffer[i] !== 10 && buffer[i] !== 13) buffer[i] = 32;
      }
      return { ...file, buffer };
    }),
    excluded
  };
}

module.exports = { filterArchitectures };
