'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const IGNORED = new Set(['.nvc-build', '.git', 'node_modules', 'build', 'dist', 'out', '.vscode-test']);
function within(root, target) { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function validateConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('vhdl.sim.json 必须是 JSON 对象。');
  const allowed = new Set(['sources', 'top', 'standard', 'stopTime', 'libraryPaths', 'dumpArrays']);
  for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`未知配置字段：${key}`);
  if (!Array.isArray(data.sources) || !data.sources.length) throw new Error('sources 必须包含按编译顺序排列的 VHDL 文件。');
  for (const source of data.sources) {
    if (typeof source !== 'string' || !source || path.isAbsolute(source) || source.split(/[\\/]/).includes('..') || !/\.vhdl?$/i.test(source) || source.includes('\0')) throw new Error(`无效的工作区相对源文件：${source}`);
    if (source.split(/[\\/]/).some(part => IGNORED.has(part))) throw new Error('源文件不能位于生成目录。');
  }
  if (new Set(data.sources).size !== data.sources.length) throw new Error('sources 不能重复。');
  if (typeof data.top !== 'string' || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/i.test(data.top)) throw new Error('top 必须是有效的 VHDL 基本实体名称。');
  const standard = data.standard ?? '2008';
  if (!['1993', '2002', '2008'].includes(standard)) throw new Error('standard 只能是 1993、2002 或 2008。');
  const stopTime = data.stopTime ?? '1us';
  if (typeof stopTime !== 'string' || !/^[1-9][0-9]*(fs|ps|ns|us|ms|sec)$/.test(stopTime)) throw new Error('stopTime 必须是正整数加单位 fs/ps/ns/us/ms/sec，例如 1us。');
  const libraryPaths = data.libraryPaths ?? [];
  if (!Array.isArray(libraryPaths) || libraryPaths.some(p => typeof p !== 'string' || !p || p.includes('\0'))) throw new Error('libraryPaths 必须是有效目录路径数组。');
  if (data.dumpArrays !== undefined && (!Number.isSafeInteger(data.dumpArrays) || data.dumpArrays < 0 || data.dumpArrays > 1000000)) throw new Error('dumpArrays 必须是 0 到 1000000 的整数，0 表示关闭。');
  return { sources: [...data.sources], top: data.top, standard, stopTime, libraryPaths: [...libraryPaths], ...(data.dumpArrays === undefined ? {} : { dumpArrays: data.dumpArrays }) };
}
async function safeDirectory(root, directory) {
  try {
    const info = await fs.lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || !within(root, await fs.realpath(directory))) throw new Error('构建目录必须是工作区内的真实目录，不能是符号链接。');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function resolveProject(projectDir, data) {
  const config = validateConfig(data);
  const root = await fs.realpath(projectDir);
  const sources = [];
  for (const source of config.sources) {
    const real = await fs.realpath(path.resolve(root, source));
    if (!within(root, real)) throw new Error(`源文件超出工作区：${source}`);
    if (within(path.join(root, '.nvc-build'), real)) throw new Error('源文件不能位于专用构建目录。');
    if (!(await fs.stat(real)).isFile()) throw new Error(`源文件不是普通文件：${source}`);
    if (sources.includes(real)) throw new Error(`源文件重复指向同一文件：${source}`);
    sources.push(real);
  }
  const libraryPaths = [];
  for (const directory of config.libraryPaths) {
    const real = await fs.realpath(path.resolve(root, directory));
    if (!(await fs.stat(real)).isDirectory()) throw new Error(`库路径不是目录：${directory}`);
    libraryPaths.push(real);
  }
  const buildDir = path.join(root, '.nvc-build');
  await safeDirectory(root, buildDir);
  await safeDirectory(root, path.join(buildDir, 'work'));
  return { ...config, projectDir: root, sources, libraryPaths, buildDir };
}
async function discoverSources(projectDir) {
  const root = await fs.realpath(projectDir); const found = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory() && !IGNORED.has(entry.name)) await visit(target);
      else if (entry.isFile() && /\.vhdl?$/i.test(entry.name)) found.push(path.relative(root, target).split(path.sep).join('/'));
    }
  }
  await visit(root); return found.sort();
}
function buildStageArgs(config, buildDir, wavePath) {
  const common = [`--std=${config.standard}`, `--work=work:${path.join(buildDir, 'work')}`, ...config.libraryPaths.flatMap(p => ['-L', p])];
  return [
    { stage: 'analysis', args: [...common, '-a', ...config.sources] },
    { stage: 'elaboration', args: [...common, '-e', config.top] },
    { stage: 'simulation', args: [...common, '-r', config.top, `--stop-time=${config.stopTime}`, `--wave=${wavePath}`, ...(config.dumpArrays ? [`--dump-arrays=${config.dumpArrays}`] : [])] }
  ];
}
function abortError() { const error = new Error('仿真已取消。'); error.name = 'AbortError'; return error; }
function executeStage(executable, args, cwd, signal, onOutput) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    let output = ''; let timer; let child;
    const cancel = () => { child.kill('SIGTERM'); timer = setTimeout(() => child.kill('SIGKILL'), 1500); timer.unref(); };
    try { child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { reject(error); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding('utf8'); stream.on('data', text => { output += text; onOutput?.(text); }); }
    child.once('error', error => { signal?.removeEventListener('abort', cancel); clearTimeout(timer); error.output = output; reject(error); });
    child.once('close', (code, terminatedBy) => {
      signal?.removeEventListener('abort', cancel); clearTimeout(timer);
      if (signal?.aborted) { const error = abortError(); error.output = output; reject(error); }
      else if (code !== 0) { const error = new Error(`NVC 退出码 ${code ?? terminatedBy}。请查看“NVC 仿真”输出与问题面板。`); error.output = output; error.exitCode = code; reject(error); }
      else resolve(output);
    });
    if (signal?.aborted) cancel();
  });
}
async function cleanOwnedWave(buildDir) {
  const marker = path.join(buildDir, '.nvc-runner.json');
  try {
    if ((await fs.lstat(marker)).isSymbolicLink()) throw new Error('构建记录不能是符号链接。');
    const previous = JSON.parse(await fs.readFile(marker, 'utf8'));
    if (typeof previous.wave === 'string' && /^nvc-runner-[a-f0-9-]{36}\.fst$/.test(previous.wave)) await fs.unlink(path.join(buildDir, previous.wave)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function runSimulation({ executable, executableArgs = [], projectDir, config, signal, onOutput, onStage }) {
  if (signal?.aborted) throw abortError();
  const resolved = await resolveProject(projectDir, config);
  await fs.mkdir(resolved.buildDir, { recursive: true });
  const wavePath = path.join(resolved.buildDir, `nvc-runner-${randomUUID()}.fst`);
  const marker = path.join(resolved.buildDir, '.nvc-runner.json');
  try { if ((await fs.lstat(marker)).isSymbolicLink()) throw new Error('构建记录不能是符号链接。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let output = '';
  for (const { stage, args } of buildStageArgs(resolved, resolved.buildDir, wavePath)) {
    if (signal?.aborted) throw abortError();
    onStage?.(stage, args);
    try { output += await executeStage(executable, [...executableArgs, ...args], resolved.projectDir, signal, onOutput); }
    catch (error) { error.stage = stage; error.output = output + (error.output ?? ''); throw error; }
  }
  if (signal?.aborted) throw abortError();
  let stat; try { stat = await fs.lstat(wavePath); } catch { throw new Error('NVC 未生成本次运行的新波形。请检查测试平台与 NVC 输出。'); }
  if (!stat.isFile() || stat.size === 0) throw new Error('本次波形为空或不是普通文件。请检查测试平台与 NVC 输出。');
  // Keep the last successful result accessible when analysis or simulation fails.
  await cleanOwnedWave(resolved.buildDir);
  const temporary = path.join(resolved.buildDir, `.result-${randomUUID()}.tmp`);
  try { await fs.writeFile(temporary, JSON.stringify({ wave: path.basename(wavePath) }), { flag: 'wx' }); await fs.rename(temporary, marker); } finally { await fs.rm(temporary, { force: true }); }
  return { wavePath, output, projectDir: resolved.projectDir };
}
function parseDiagnostics(output, projectDir) {
  const results = []; let pending;
  for (const raw of output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const message = raw.match(/^\s*\*\*\s*(Error|Fatal|Failure|Warning):\s*(.+)$/i);
    if (message) { pending = { severity: message[1].toLowerCase() === 'warning' ? 'warning' : 'error', message: message[2] }; continue; }
    // Runtime diagnostics prefix their source location with a process/procedure frame.
    const locationText = raw.replace(/^\s*(?:Process|Procedure)\s+.+?\s+at\s+/i, '');
    const location = locationText.match(/^\s*(?:(?:-->|>)\s*)?(.+?\.vhdl?):(\d+)(?::(\d+))?(?::\s*(?:(error|warning|fatal|failure):\s*)?(.*))?\s*$/i);
    if (!location) continue;
    const [, file, line, column, severity, inline] = location;
    const detail = inline?.trim() ? { message: inline.trim(), severity: severity?.toLowerCase() === 'warning' ? 'warning' : 'error' } : pending;
    if (detail) results.push({ filePath: path.resolve(projectDir, file.trim()), line: Math.max(0, Number(line) - 1), column: Math.max(0, Number(column ?? 1) - 1), ...detail });
    pending = undefined;
  }
  return results;
}
async function resolveNvc(override, environment = process.env) {
  const paths = (environment.PATH ?? '').split(path.delimiter).filter(Boolean).map(p => path.join(p, process.platform === 'win32' ? 'nvc.exe' : 'nvc'));
  const candidates = override ? [override] : [...paths, '/opt/homebrew/bin/nvc', '/usr/local/bin/nvc'];
  for (const candidate of candidates) {
    try { const real = await fs.realpath(candidate); const info = await fs.stat(real); if (info.isFile()) { await fs.access(real, constants.X_OK); return real; } } catch { /* Try the next executable. */ }
  }
  throw new Error('找不到 NVC。请先安装 NVC，或在设置 nvcRunner.nvcPath 填入其可执行文件完整路径。');
}
module.exports = { validateConfig, resolveProject, discoverSources, buildStageArgs, runSimulation, parseDiagnostics, resolveNvc, within };
