'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { resolveProject } = require('./core');

function durationParts(duration) {
  const match = typeof duration === 'string' && duration.match(/^([1-9][0-9]*)(fs|ps|ns|us|ms|sec)$/);
  if (!match) throw new Error('运行时长必须是正整数加单位，例如 100ns 或 1us。');
  return [match[1], match[2]];
}
function quoteTcl(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('信号路径和值必须是有效文本。');
  return `[encoding convertfrom utf-8 [binary decode base64 {${Buffer.from(value).toString('base64')}}]]`;
}
function aborted() { const error = new Error('交互会话启动已取消。'); error.name = 'AbortError'; return error; }
function stage(executable, args, cwd, onOutput, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted()); return; }
    const child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let killTimer;
    const cancel = () => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1500); killTimer.unref(); };
    signal?.addEventListener('abort', cancel, { once: true });
    const cleanup = () => { signal?.removeEventListener('abort', cancel); clearTimeout(killTimer); };
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; onOutput?.(chunk.toString()); });
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      if (signal?.aborted) reject(aborted());
      else if (code === 0) resolve();
      else { const error = new Error(`交互仿真编译失败，NVC 退出码 ${code}。`); error.output = output; reject(error); }
    });
    if (signal?.aborted) cancel();
  });
}

class InteractiveSession {
  static async start(options) {
    if (options.signal?.aborted) throw aborted();
    const resolved = await resolveProject(options.projectDir, options.config);
    await fs.mkdir(resolved.buildDir, { recursive: true });
    const buildDir = await fs.mkdtemp(path.join(resolved.buildDir, 'interactive-'));
    const common = [`--std=${resolved.standard}`, `--work=work:${path.join(buildDir, 'work')}`, ...resolved.libraryPaths.flatMap(p => ['-L', p])];
    await stage(options.executable, [...common, '-a', ...resolved.sources], resolved.projectDir, options.onOutput, options.signal);
    await stage(options.executable, [...common, '-e', resolved.top], resolved.projectDir, options.onOutput, options.signal);
    const session = new InteractiveSession({ ...options, projectDir: resolved.projectDir, buildDir });
    session.child = spawn(options.executable, [...common, '--do', resolved.top, path.join(__dirname, '../media/session.tcl')], {
      cwd: resolved.projectDir, shell: false, stdio: ['pipe', 'pipe', 'pipe']
    });
    session.attach();
    const cancel = () => session.close();
    options.signal?.addEventListener('abort', cancel, { once: true });
    session.child.once('close', () => options.signal?.removeEventListener('abort', cancel));
    if (options.signal?.aborted) cancel();
    try {
      let readyTimer;
      try {
        await Promise.race([session.ready, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('NVC 未启动 Tcl 交互接口。请检查交互版 NVC 路径。')), 10000); })]);
      } finally { clearTimeout(readyTimer); }
      session.waveSupported = (await session.command('expr {[llength [info commands wave]] > 0}')) === '1';
      session.statusSupported = (await session.command('expr {[llength [info commands simstatus]] > 0}')) === '1';
      if (session.waveSupported && options.wave !== false) {
        session.wavePath = path.join(buildDir, 'current.vcd');
        await session.command(`wave ${quoteTcl(session.wavePath)}`);
      }
      return session;
    } catch (error) { session.close(); throw error; }
  }
  constructor(options) {
    Object.assign(this, options);
    this.now = '0'; this.busy = false; this.continuing = false; this.finished = false; this.closed = false; this.intentionalClose = false;
    this.waveSupported = false; this.pauseRequested = false; this.stdoutBuffer = ''; this.stderrTail = ''; this.pending = undefined;
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    // Avoid an unhandled rejection if spawn fails before the caller awaits ready.
    this.ready.catch(() => {});
  }
  attach() {
    this.child.stdout.setEncoding('utf8'); this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', text => this.acceptOutput(text));
    this.child.stderr.on('data', text => {
      this.reportOutput(text);
    });
    this.child.once('error', error => this.terminated(error));
    this.child.once('close', (code, signal) => {
      const message = this.closed ? '交互会话已关闭。' : `交互会话已结束（${code ?? signal}）。`;
      this.terminated(this.failure ?? new Error(message));
      this.onExit?.({ code, signal, intentional: this.intentionalClose });
    });
  }
  reportOutput(text) {
    this.onOutput?.(text); this.stderrTail = (this.stderrTail + text).slice(-16384);
    if (/\*\*\s*(?:Failure|Fatal|Error):/i.test(this.stderrTail)) {
      this.finished = true; this.failure = new Error('NVC 报告仿真错误。请查看输出与问题面板。');
    } else if (/\b(?:FINISH|STOP) called\b/.test(this.stderrTail)) this.finished = true;
  }
  acceptOutput(text) {
    this.stdoutBuffer += text;
    let newline;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, ''); this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      const ready = line.match(/^__NVC_READY__\|(\d+)$/);
      if (ready) { this.now = ready[1]; this.readyResolve(); continue; }
      const result = line.match(/^__NVC_RESPONSE__\|([01])\|(\d+)\|(.*)$/);
      if (!result) { this.reportOutput(line + '\n'); continue; }
      this.now = result[2]; this.onTime?.(this.now);
      const pending = this.pending; this.pending = undefined;
      if (!pending) continue;
      const value = Buffer.from(result[3], 'base64').toString('utf8');
      if (result[1] === '1') pending.reject(new Error(value)); else pending.resolve(value);
    }
  }
  terminated(error) {
    this.closed = true; this.pauseRequested = true; this.readyReject(error);
    const pending = this.pending; this.pending = undefined; pending?.reject(error);
  }
  command(script) {
    if (this.closed) return Promise.reject(new Error('交互会话已关闭。请重新启动。'));
    if (this.pending) return Promise.reject(new Error('当前指令尚未完成。'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.child.stdin.write(Buffer.from(script).toString('base64') + '\n', error => {
        if (error && this.pending) { this.pending = undefined; reject(error); }
      });
    });
  }
  checkIdle() {
    if (this.closed) throw new Error('交互会话已关闭。请重新启动。');
    if (this.busy || this.continuing) throw new Error('会话正在运行。请先暂停；暂停在当前分段结束时生效。');
  }
  async advance(duration) {
    if (this.finished) throw this.failure ?? new Error('测试平台已经 finish/stop，不能继续推进。请重新启动会话。');
    const [amount, unit] = durationParts(duration); const before = this.now;
    await this.command(`run ${amount} ${unit}`);
    // stderr may be delivered in the next I/O callback after the command reply.
    await new Promise(resolve => setImmediate(resolve));
    if (this.statusSupported) {
      const fields = (await this.command('set s [simstatus]; list [dict get $s stopped] [dict get $s pending] [dict get $s exitStatus] [dict get $s nextTime]')).split(/\s+/);
      this.finished = this.finished || fields[0] === '1'; this.pendingEvents = fields[1] === '1'; this.nextTime = fields[3];
      if (fields[2] !== '0') { this.finished = true; this.failure ??= new Error(`NVC 仿真错误，退出状态 ${fields[2]}。请查看输出与问题面板。`); }
    }
    if (this.wavePath) {
      const wavePath = path.join(this.buildDir, `segment-${randomUUID()}.vcd`);
      await fs.copyFile(this.wavePath, wavePath);
      if ((await fs.stat(wavePath)).size > 0) await this.onWave?.({ wavePath, projectDir: this.projectDir, now: this.now });
      if (this.lastWavePath) await fs.unlink(this.lastWavePath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      this.lastWavePath = wavePath;
    }
    if (this.failure) throw this.failure;
    // No scheduled future event is different from std.env.finish: a force can
    // still schedule events in a combinational design. Stop automatic repetition
    // when time does not advance, but leave that session available for mutation.
    return { now: this.now, finished: this.finished, idle: this.now === before, waveSupported: this.waveSupported };
  }
  async run(duration) {
    this.checkIdle(); durationParts(duration); this.busy = true;
    try { return await this.advance(duration); } finally { this.busy = false; }
  }
  async continue(duration = '1us') {
    this.checkIdle(); durationParts(duration); this.continuing = true; this.pauseRequested = false;
    try {
      let result;
      while (!this.pauseRequested && !this.closed && !this.finished) {
        this.busy = true;
        try { result = await this.advance(duration); } finally { this.busy = false; }
        if (result.idle) this.pauseRequested = true;
        await new Promise(resolve => setImmediate(resolve));
      }
      return result ?? { now: this.now, finished: this.finished };
    } finally { this.continuing = false; this.busy = false; }
  }
  pause() { this.pauseRequested = true; }
  async signals() {
    this.checkIdle();
    const encoded = await this.command('set encoded {}; foreach sig [find signals -r /*] {lappend encoded [binary encode base64 -maxlen 0 [encoding convertto utf-8 $sig]]}; join $encoded "\\n"');
    return encoded ? encoded.split('\n').map(line => Buffer.from(line, 'base64').toString('utf8')) : [];
  }
  async describe(signal) {
    this.checkIdle();
    const encoded = await this.command(`set encoded {}; dict for {k v} [describe ${quoteTcl(signal)}] {lappend encoded [binary encode base64 -maxlen 0 [encoding convertto utf-8 $k]] [binary encode base64 -maxlen 0 [encoding convertto utf-8 $v]]}; join $encoded "\\n"`);
    const parts = encoded.split('\n').map(line => Buffer.from(line, 'base64').toString('utf8')); const result = {};
    for (let i = 0; i < parts.length; i += 2) result[parts[i]] = parts[i + 1];
    return result;
  }
  async examine(signal) { this.checkIdle(); return this.command(`examine ${quoteTcl(signal)}`); }
  async force(signal, value) { this.checkIdle(); return this.command(`force ${quoteTcl(signal)} ${quoteTcl(value)}`); }
  async release(signal) { this.checkIdle(); return this.command(`noforce ${quoteTcl(signal)}`); }
  close() {
    if (this.closed) return;
    this.closed = true; this.intentionalClose = true; this.pauseRequested = true; this.readyReject(new Error('交互会话已关闭。'));
    this.pending?.reject(new Error('交互会话已关闭。')); this.pending = undefined;
    this.child?.stdin.end(); this.child?.kill('SIGTERM');
    const timer = setTimeout(() => this.child?.kill('SIGKILL'), 1500); timer.unref();
    this.child?.once('close', () => clearTimeout(timer));
  }
}
module.exports = { InteractiveSession, startSession: options => InteractiveSession.start(options), durationParts, quoteTcl };
