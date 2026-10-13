'use strict';

// A deliberately bounded interface reader, not a general VHDL compiler.
const units = { fs: 1n, ps: 1000n, ns: 1000000n, us: 1000000000n, ms: 1000000000000n, sec: 1000000000000000n };
const reserved = new Set('entity architecture signal process begin end in out inout buffer port generic map is of constant variable wait report assert finish library use type subtype component package configuration function procedure range to downto true false null open all'.split(' '));
function identifier(value) { return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/i.test(value) && !reserved.has(value.toLowerCase()); }
function lex(source) {
  const pattern = /\s+|--[^\n]*|"(?:[^"]|"")*"|'[^'\n]'|[a-z][a-z0-9_]*|\d+|:=|=>|\*\*|./giy;
  const result = []; let match;
  while ((match = pattern.exec(source))) if (!/^\s|^--/.test(match[0])) result.push(match[0]);
  return result;
}
function group(tokens, start) {
  if (tokens[start] !== '(') throw new Error('接口声明需要括号。');
  let depth = 1, end = start + 1;
  for (; end < tokens.length; end++) { if (tokens[end] === '(') depth++; if (tokens[end] === ')' && --depth === 0) break; }
  if (depth) throw new Error('接口声明括号未闭合。');
  return { body: tokens.slice(start + 1, end), end };
}
function split(tokens, separator) {
  const parts = []; let depth = 0, start = 0;
  tokens.forEach((token, index) => { if (token === '(') depth++; if (token === ')') depth--; if (token === separator && depth === 0) { parts.push(tokens.slice(start, index)); start = index + 1; } });
  if (start < tokens.length) parts.push(tokens.slice(start)); return parts;
}
function declarations(tokens, generic) {
  return split(tokens, ';').flatMap(declaration => {
    if (['constant', 'signal'].includes(declaration[0]?.toLowerCase())) declaration = declaration.slice(1);
    const colon = declaration.indexOf(':');
    if (colon < 1) throw new Error(generic ? '暂不支持这种泛型声明。' : '无法解析端口声明。');
    const names = split(declaration.slice(0, colon), ',').map(part => { if (part.length !== 1 || !identifier(part[0])) throw new Error('仅支持基本端口/泛型名称。'); return part[0]; });
    let tail = declaration.slice(colon + 1), mode = 'in';
    if (['in', 'out', 'inout', 'buffer', 'linkage'].includes(tail[0]?.toLowerCase())) mode = tail.shift().toLowerCase();
    const assign = tail.indexOf(':=');
    const type = (assign < 0 ? tail : tail.slice(0, assign)).join(' ');
    const defaultValue = assign < 0 ? undefined : tail.slice(assign + 1).join(' ');
    if (generic && !/^(integer|natural|positive)$/i.test(type)) throw new Error(`泛型 ${names[0]}：首版仅支持简单整数泛型。`);
    return names.map(name => ({ name, mode, type, defaultValue }));
  });
}
function parseEntities(source) {
  const tokens = lex(source), entities = [];
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokens[i].toLowerCase() !== 'entity' || !identifier(tokens[i + 1]) || tokens[i + 2].toLowerCase() !== 'is') continue;
    const entity = { name: tokens[i + 1], generics: [], ports: [], architectures: [] }; i += 3;
    for (; i < tokens.length; i++) {
      const token = tokens[i].toLowerCase();
      if (token === 'end') break;
      if (token === ';') continue;
      if (token !== 'generic' && token !== 'port') throw new Error(`实体 ${entity.name}：仅支持 generic/port 接口声明。`);
      const section = group(tokens, i + 1);
      entity[token === 'generic' ? 'generics' : 'ports'] = declarations(section.body, token === 'generic');
      i = section.end;
    }
    if (i === tokens.length) throw new Error(`实体 ${entity.name} 缺少 end。`);
    entities.push(entity);
  }
  if (!entities.length) throw new Error('当前文件没有可识别的 entity 声明。');
  for (let i = 0; i < tokens.length - 4; i++) if (tokens[i].toLowerCase() === 'architecture' && tokens[i + 2].toLowerCase() === 'of' && tokens[i + 4].toLowerCase() === 'is') {
    const entity = entities.find(item => item.name.toLowerCase() === tokens[i + 3].toLowerCase());
    if (entity) entity.architectures.push(tokens[i + 1]);
  }
  return entities;
}
function integerExpression(text, values) {
  const tokens = lex(text); let index = 0;
  function primary() {
    const token = tokens[index++]; let value;
    if (token === '(') { value = sum(); if (tokens[index++] !== ')') throw new Error('表达式括号不匹配'); }
    else if (token === '+' || token === '-') value = (token === '-' ? -1 : 1) * primary();
    else if (/^\d+$/.test(token ?? '')) value = Number(token);
    else if (token && Object.hasOwn(values, token.toLowerCase())) value = values[token.toLowerCase()];
    else throw new Error(`不支持的整数表达式：${text}`);
    return value;
  }
  function product() { let value = primary(); while (['*', '/'].includes(tokens[index])) { const op = tokens[index++], rhs = primary(); value = op === '*' ? value * rhs : Math.trunc(value / rhs); } return value; }
  function sum() { let value = product(); while (['+', '-'].includes(tokens[index])) { const op = tokens[index++], rhs = product(); value = op === '+' ? value + rhs : value - rhs; } return value; }
  const value = sum();
  if (index !== tokens.length || !Number.isSafeInteger(value) || Math.abs(value) > 2147483647) throw new Error(`无效或超出范围的整数表达式：${text}`);
  return value;
}
function instantiateEntity(entity, overrides = {}) {
  const values = {}, generics = entity.generics.map(item => {
    const text = overrides[item.name] ?? overrides[item.name.toLowerCase()] ?? item.defaultValue;
    if (text === undefined) throw new Error(`请设置泛型 ${item.name}。`);
    const value = integerExpression(String(text), values);
    if ((item.type.toLowerCase() === 'positive' && value < 1) || (item.type.toLowerCase() === 'natural' && value < 0)) throw new Error(`泛型 ${item.name} 超出 ${item.type} 范围。`);
    values[item.name.toLowerCase()] = value; return { ...item, value };
  });
  const ports = entity.ports.map(port => {
    if (!['in', 'out'].includes(port.mode)) throw new Error(`端口 ${port.name}：暂不支持 ${port.mode}。`);
    const type = port.type.toLowerCase(); let match;
    if (['std_logic', 'boolean'].includes(type)) return { ...port, type, kind: type };
    if ((match = /^(std_logic_vector|unsigned|signed)\s*\(\s*(.+?)\s+(downto|to)\s+(.+?)\s*\)$/.exec(type))) {
      const left = integerExpression(match[2], values), right = integerExpression(match[4], values);
      const width = match[3] === 'downto' ? left - right + 1 : right - left + 1;
      if (left < 0 || right < 0 || width < 1 || width > 65536) throw new Error(`端口 ${port.name}：位宽范围不支持。`);
      return { ...port, kind: match[1], width, type: `${match[1]}(${left} ${match[3]} ${right})` };
    }
    if ((match = /^(integer|natural|positive)(?:\s+range\s+(.+?)\s+to\s+(.+))?$/.exec(type))) {
      const min = match[2] ? integerExpression(match[2], values) : match[1] === 'positive' ? 1 : match[1] === 'natural' ? 0 : -2147483647;
      const max = match[3] ? integerExpression(match[3], values) : 2147483647;
      if (min > max || (match[1] !== 'integer' && min < (match[1] === 'positive' ? 1 : 0))) throw new Error(`端口 ${port.name}：整数范围无效。`);
      return { ...port, kind: 'integer', min, max, type: match[2] ? `${match[1]} range ${min} to ${max}` : match[1] };
    }
    throw new Error(`端口 ${port.name}：暂不支持类型 ${port.type}。`);
  });
  return { ...entity, generics, ports };
}
function timeFs(text) {
  const match = /^\s*(\d+)\s*(fs|ps|ns|us|ms|sec)\s*$/i.exec(text);
  if (!match) throw new Error('时间格式应为非负整数加单位，例如 20ns。');
  const value = BigInt(match[1]) * units[match[2].toLowerCase()];
  if (value > 9223372036854775807n) throw new Error('时间超出仿真范围。'); return value;
}
function timeLiteral(value) { for (const unit of ['sec', 'ms', 'us', 'ns', 'ps', 'fs']) if (value % units[unit] === 0n) return `${value / units[unit]} ${unit}`; }
function defaultValue(port) { return port.kind === 'boolean' ? 'false' : port.kind === 'integer' ? String(Math.max(port.min, Math.min(0, port.max))) : '0'; }
function formatValue(port, input) {
  const text = String(input).trim();
  if (port.kind === 'std_logic') { const match = /^'?([01uxzwlh-])'?$/i.exec(text); if (!match) throw new Error(`${port.name} 的值应为 0/1/U/X/Z/W/L/H/-。`); return `'${match[1].toUpperCase()}'`; }
  if (port.kind === 'boolean') { if (!/^(true|false)$/i.test(text)) throw new Error(`${port.name} 的值应为 true/false。`); return text.toLowerCase(); }
  if (port.kind === 'integer') { if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < port.min || Number(text) > port.max) throw new Error(`${port.name} 超出范围 ${port.min}..${port.max}。`); return String(Number(text)); }
  let bits, match;
  if ((match = /^(?:"([01uxz-]+)"|0b([01]+))$/i.exec(text))) bits = (match[1] ?? match[2]).toUpperCase();
  else if ((match = /^(?:x"([0-9a-f]+)"|0x([0-9a-f]+))$/i.exec(text))) bits = [...(match[1] ?? match[2])].map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
  else {
    if (!/^-?\d+$/.test(text)) throw new Error(`${port.name} 的值应为十进制、"0101" 或 x"A5"。`);
    let number = BigInt(text), width = BigInt(port.width);
    const min = port.kind === 'signed' ? -(1n << (width - 1n)) : 0n, max = port.kind === 'signed' ? (1n << (width - 1n)) - 1n : (1n << width) - 1n;
    if (number < min || number > max) throw new Error(`${port.name} 的数值超出 ${port.width} 位宽。`);
    if (number < 0n) number += 1n << width; bits = number.toString(2).padStart(port.width, '0');
  }
  if (bits.length !== port.width) throw new Error(`${port.name} 需要精确 ${port.width} 位宽，实际 ${bits.length} 位。`);
  return `"${bits}"`;
}
function parseEvents(port, text, duration) {
  const events = text.split(';').map(item => { const pieces = item.split('='); if (pieces.length !== 2) throw new Error('时序格式：0ns=0;20ns=1。'); return { time: timeFs(pieces[0]), value: formatValue(port, pieces[1]) }; });
  if (!events.length || events[0].time !== 0n) throw new Error(`${port.name} 必须从 0ns 初值开始。`);
  events.forEach((event, index) => { if (event.time >= duration || (index && event.time <= events[index - 1].time)) throw new Error(`${port.name} 时间必须严格递增且早于结束时间。`); }); return events;
}
function generateTestbench(model, options) {
  if (!identifier(options.name) || options.name.toLowerCase() === model.name.toLowerCase()) throw new Error('测试实体名称无效或与被测实体重复。');
  if (options.architecture && !model.architectures.includes(options.architecture)) throw new Error('请选择文件中已有的 architecture。');
  const duration = timeFs(options.duration); if (!duration) throw new Error('结束时间必须大于零。');
  const declarations = model.ports.map(port => `  signal tb_${port.name} : ${port.type};`);
  const drivers = model.ports.filter(port => port.mode === 'in').map(port => {
    const input = options.inputs[port.name]; if (!input) throw new Error(`请配置输入 ${port.name}。`);
    if (input.mode === 'fixed') return `  tb_${port.name} <= ${formatValue(port, input.value)};`;
    const lines = [`  drive_${port.name} : process`, '  begin'];
    if (input.mode === 'events') {
      let previous = 0n;
      for (const event of parseEvents(port, input.value, duration)) { if (event.time > previous) lines.push(`    wait for ${timeLiteral(event.time - previous)};`); lines.push(`    tb_${port.name} <= ${event.value};`); previous = event.time; }
      lines.push('    wait;');
    } else if (input.mode === 'clock') {
      if (port.kind !== 'std_logic' || !/^'?([01])'?$/.test(input.value)) throw new Error('周期时钟需要 std_logic 端口和 0/1 初值。');
      const period = timeFs(input.period), start = timeFs(input.start);
      if (!period || period % 2n || start >= duration || period / 2n >= duration - start) throw new Error('时钟周期需可分为整数 fs 半周期，且结束前至少有一次翻转。');
      lines.push(`    tb_${port.name} <= ${formatValue(port, input.value)};`);
      if (start) lines.push(`    wait for ${timeLiteral(start)};`);
      lines.push('    loop', `      wait for ${timeLiteral(period / 2n)};`, `      tb_${port.name} <= not tb_${port.name};`, '    end loop;');
    } else throw new Error(`输入 ${port.name} 模式无效。`);
    lines.push(`  end process drive_${port.name};`); return lines.join('\n');
  });
  const genericMap = model.generics.length ? `\n    generic map (${model.generics.map(item => `${item.name} => ${item.value}`).join(', ')})` : '';
  const portMap = model.ports.length ? `\n    port map (${model.ports.map(port => `${port.name} => tb_${port.name}`).join(', ')})` : '';
  return `library ieee;\nuse ieee.std_logic_1164.all;\nuse ieee.numeric_std.all;\nuse std.env.all;\n\n-- 自动生成输入激励；请按功能要求添加 assert 检查。\nentity ${options.name} is\nend entity ${options.name};\n\narchitecture sim of ${options.name} is\n${declarations.join('\n')}\nbegin\n  dut : entity work.${model.name}${options.architecture ? `(${options.architecture})` : ''}${genericMap}${portMap};\n\n${drivers.join('\n\n')}\n\n  stop_simulation : process\n  begin\n    wait for ${timeLiteral(duration)};\n    -- 激励结束，未设置输出检查\n    report "STIMULUS_DONE: no output assertions configured" severity note;\n    finish;\n    wait;\n  end process stop_simulation;\nend architecture sim;\n`;
}
module.exports = { parseEntities, instantiateEntity, integerExpression, timeFs, timeLiteral, formatValue, defaultValue, parseEvents, generateTestbench, identifier };
