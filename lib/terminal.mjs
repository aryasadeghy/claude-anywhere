// A terminal pane like Desktop's: PowerShell (or Git Bash, $SHELL elsewhere) in a real pty,
// several tabs per session, streamed to the page over a WebSocket authenticated the same way
// every other /api request is. Everything here runs on this computer - the pane shows whatever
// this process could run from a terminal of its own.
//
// A PTY is a native module, and not every machine this app ships to can load one (an
// architecture without a prebuild, a sandboxed runner, node-gyp unavailable for a source
// build): node-pty is imported lazily, inside a try, so a machine that cannot load it still
// gets a working app - the pane falls back to a plain pipe (spawn, no real terminal: no
// resize, no colour, line-buffered) instead of the server refusing to start.
//
// Knowing whether a command is still running, without asking the shell to tell us in so many
// words, is done the way VS Code's own terminal does it: the shell's prompt itself is made to
// print an invisible marker (a private OSC escape, swallowed by xterm.js same as any control
// sequence) carrying the exit code of whatever just finished, right before it redraws the
// prompt. That one hook serves two things at once - the running dot on a tab nobody is
// driving by hand, and knowing precisely where a command Claude or "Run in terminal" asked
// for ends, so its output can be captured and nothing else.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';

// ---------- the pty, loaded once, and only if it can be ----------
let pty = null, ptyError = '', ptyTried = false;
async function loadPty() {
  if (ptyTried) return pty;
  ptyTried = true;
  try { pty = await import('@lydell/node-pty'); }
  catch (e) { ptyError = String(e?.message || e).split('\n')[0]; pty = null; }
  return pty;
}
export const status = () => ({ pty: !!pty, tried: ptyTried, error: ptyError });

// ---------- which shell, and the invisible hook that reports when it is done ----------
// Not auto-detected from where Git happens to be installed - "configured" means Claude Code's
// own setting for it (CLAUDE_CODE_GIT_BASH_PATH), the same variable the Bash tool already
// honours, so the terminal pane and Claude's own shell agree on which one is "the" shell here.
function loginShell() {
  if (process.platform === 'win32') {
    const gb = process.env.CLAUDE_CODE_GIT_BASH_PATH;
    if (gb && fs.existsSync(gb)) return { file: gb, name: 'Git Bash', integration: 'bash' };
    return { file: 'powershell.exe', name: 'PowerShell', integration: 'pwsh' };
  }
  const sh = process.env.SHELL || '/bin/bash';
  const base = path.basename(sh);
  return { file: sh, name: base, integration: /zsh/.test(base) ? 'zsh' : /bash/.test(base) ? 'bash' : '' };
}
// The OSC number is ours alone (iTerm2 uses 1337, VS Code 633; this is neither), so xterm.js
// drops it as an unrecognised control sequence instead of printing it.
const MARK = '7001';
const MARK_RE = new RegExp('\\x1b\\]' + MARK + ';(-?\\d+)\\x07');
let integrationDir = '';
function scratchDir() {
  if (!integrationDir) { integrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-terminal-')); }
  return integrationDir;
}
// bash and Git Bash (also bash): --rcfile replaces .bashrc, so this sources it back itself,
// then has PROMPT_COMMAND (bash's "about to show a prompt" hook) print the marker first - so
// it carries $? before anything else in the chain can reset it.
function bashRcFile() {
  const p = path.join(scratchDir(), 'bashrc');
  if (!fs.existsSync(p)) fs.writeFileSync(p,
    '[ -f ~/.bashrc ] && . ~/.bashrc\n' +
    '[ -f ~/.bash_profile ] && . ~/.bash_profile\n' +
    '__ca_mark() { printf "\\033]' + MARK + ';%s\\007" "$?"; }\n' +
    'PROMPT_COMMAND="__ca_mark${PROMPT_COMMAND:+; $PROMPT_COMMAND}"\n');
  return p;
}
// zsh has no --rcfile, but ZDOTDIR says where it looks for its own; precmd_functions is an
// array zsh already calls into before every prompt, with nothing to redefine.
function zshDotDir() {
  const d = path.join(scratchDir(), 'zdotdir');
  fs.mkdirSync(d, { recursive: true });
  const real = process.env.ZDOTDIR || os.homedir();
  const p = path.join(d, '.zshrc');
  if (!fs.existsSync(p)) fs.writeFileSync(p,
    '[ -f "' + real + '/.zshrc" ] && . "' + real + '/.zshrc"\n' +
    '__ca_mark() { printf "\\033]' + MARK + ';%s\\007" "$?"; }\n' +
    'precmd_functions+=(__ca_mark)\n');
  return d;
}
// PowerShell's `prompt` function is called to draw every prompt, which is the same moment -
// so redefining it (keeping whatever the profile already set, if anything) is the whole hook.
// Passed to -Command rather than written to a .ps1 and run with -File: a machine left at the
// factory execution policy (Restricted) refuses a script file outright, and the person would
// see that error dumped into their own terminal before anything else ran in it. -Command is
// not "running a script" as that policy means it, so this needs none of its exceptions.
const PS_SCRIPT =
  '$Global:__caOrigPrompt = $null; ' +
  'if (Test-Path Function:\\prompt) { $Global:__caOrigPrompt = $function:prompt }; ' +
  'function prompt { ' +
  '$ec = 0; ' +
  'if ($null -ne $LASTEXITCODE) { $ec = $LASTEXITCODE } elseif (-not $?) { $ec = 1 }; ' +
  'Write-Host -NoNewline ([char]27 + "]' + MARK + ';" + $ec + [char]7); ' +
  'if ($Global:__caOrigPrompt) { & $Global:__caOrigPrompt } else { "PS " + $(Get-Location) + "> " } }';
function spawnPlan(shell) {
  if (shell.integration === 'bash') return { file: shell.file, args: ['--rcfile', bashRcFile(), '-i'] };
  if (shell.integration === 'zsh') return { file: shell.file, args: ['-i'], env: { ZDOTDIR: zshDotDir() } };
  if (shell.integration === 'pwsh') return { file: shell.file, args: ['-NoLogo', '-NoExit', '-Command', PS_SCRIPT] };
  return { file: shell.file, args: [] }; // an unknown shell still runs; only the running dot is approximate
}

// ---------- tabs ----------
const tabsBySession = new Map(); // sessionId -> Map(tabId -> Tab)
const MAX_BUF = 400000; // scrollback kept per tab, in characters - generous for a read_terminal call, bounded for memory

class Tab {
  constructor(sessionId, cwd) {
    this.id = crypto.randomUUID();
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.title = '';
    this.cols = 80; this.rows = 24;
    this.alive = false;
    this.running = false;
    this.crashed = false;
    this.exitCode = null;
    this.startedAt = Date.now();
    this.buf = '';   // scrollback shown to a reconnecting socket and to read_terminal
    this.scan = '';  // a short tail kept only to catch a marker split across two chunks
    this.sockets = new Set(); // send(ev) functions, one per open websocket
    this.proc = null;
    this.usesPty = false;
    this.closedByUser = false;
    this.pending = null; // { buf, resolve } while runCommand awaits the next marker
  }
  broadcast(ev) { for (const send of this.sockets) { try { send(ev); } catch {} } }
  appendBuf(s) { this.buf += s; if (this.buf.length > MAX_BUF) this.buf = this.buf.slice(-MAX_BUF); }
}

function tabInfo(t) {
  return { id: t.id, sessionId: t.sessionId, title: t.title, cwd: t.cwd, alive: t.alive, running: t.running, crashed: t.crashed, exitCode: t.exitCode, usesPty: t.usesPty, startedAt: t.startedAt };
}
export function listTabs(sessionId) { return [...(tabsBySession.get(sessionId)?.values() || [])].map(tabInfo); }
export function getTab(sessionId, tabId) { return tabsBySession.get(sessionId)?.get(tabId) || null; }

// ANSI gone, and a redrawn line (progress bars, "\r" without "\n") collapsed to what it last
// said - the point is text Claude or a person reads, not the bytes a real terminal paints.
export function stripAnsi(s) {
  const out = String(s)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b./g, '');
  return out.split('\n').map((line) => (line.includes('\r') ? line.split('\r').pop() : line)).join('\n');
}

function onOutput(tab, chunk) {
  tab.appendBuf(chunk);
  tab.broadcast({ t: 'data', d: chunk });
  if (tab.pending) tab.pending.buf += chunk;
  tab.scan += chunk;
  let m;
  while ((m = MARK_RE.exec(tab.scan))) {
    tab.scan = tab.scan.slice(m.index + m[0].length);
    const wasRunning = tab.running;
    tab.running = false; tab.lastExit = Number(m[1]);
    if (wasRunning) tab.broadcast({ t: 'state', running: false, alive: tab.alive });
    if (tab.pending) {
      const p = tab.pending; tab.pending = null;
      const idx = p.buf.indexOf('\x1b]' + MARK + ';');
      p.resolve({ output: stripAnsi(idx >= 0 ? p.buf.slice(0, idx) : p.buf), exitCode: tab.lastExit });
    }
  }
  if (tab.scan.length > 256) tab.scan = tab.scan.slice(-256); // only ever needs to bridge one split marker
}
function onExit(tab, code, signal) {
  tab.alive = false; tab.running = false; tab.exitCode = code;
  tab.crashed = !tab.closedByUser;
  tab.broadcast({ t: 'exit', code, signal: signal || null, crashed: tab.crashed });
  if (tab.pending) { const p = tab.pending; tab.pending = null; p.resolve({ output: stripAnsi(p.buf), exitCode: code, exited: true }); }
}

async function spawnShell(tab) {
  const shell = loginShell();
  if (!tab.title) tab.title = shell.name;
  const plan = spawnPlan(shell);
  const env = { ...process.env, TERM: 'xterm-256color', ...(plan.env || {}) };
  tab.closedByUser = false; tab.crashed = false; tab.exitCode = null; tab.scan = '';
  const P = await loadPty();
  if (P) {
    try {
      const p = P.spawn(plan.file, plan.args, { name: 'xterm-256color', cols: tab.cols, rows: tab.rows, cwd: tab.cwd, env });
      tab.usesPty = true; tab.proc = p; tab.alive = true;
      p.onData((d) => onOutput(tab, d));
      p.onExit(({ exitCode, signal }) => onExit(tab, exitCode, signal));
      return;
    } catch (e) { ptyError = ptyError || String(e?.message || e); } // fall through to the pipe
  }
  // No real terminal: a plain pipe to the same shell. It still runs commands and the
  // shell-integration hook above still works (it is just printf writing bytes to stdout),
  // so the running dot and output capture work the same - only resize and colour do not.
  const child = spawnChild(plan.file, plan.args, { cwd: tab.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  tab.usesPty = false; tab.proc = child; tab.alive = true;
  child.stdout.on('data', (d) => onOutput(tab, d.toString('utf8')));
  child.stderr.on('data', (d) => onOutput(tab, d.toString('utf8')));
  child.on('exit', (code, signal) => onExit(tab, code, signal));
  child.on('error', (e) => { onOutput(tab, '\r\n[could not start ' + plan.file + ': ' + (e?.message || e) + ']\r\n'); onExit(tab, 1, null); });
}

export async function createTab(sessionId, { cwd, cols, rows, title } = {}) {
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const tab = new Tab(sessionId, dir);
  if (cols) tab.cols = cols; if (rows) tab.rows = rows; if (title) tab.title = title;
  if (!tabsBySession.has(sessionId)) tabsBySession.set(sessionId, new Map());
  tabsBySession.get(sessionId).set(tab.id, tab);
  await spawnShell(tab);
  return tabInfo(tab);
}
function killProc(tab) { try { if (tab.usesPty) tab.proc.kill(); else tab.proc.kill(); } catch {} }
export function closeTab(sessionId, tabId) {
  const tab = getTab(sessionId, tabId); if (!tab) return false;
  tab.closedByUser = true;
  killProc(tab);
  tabsBySession.get(sessionId).delete(tabId);
  return true;
}
export async function restartTab(sessionId, tabId) {
  const tab = getTab(sessionId, tabId); if (!tab) return null;
  tab.closedByUser = true; killProc(tab);
  tab.buf = ''; tab.pending = null;
  await spawnShell(tab);
  tab.broadcast({ t: 'restarted' });
  return tabInfo(tab);
}
export function resizeTab(sessionId, tabId, cols, rows) {
  const tab = getTab(sessionId, tabId); if (!tab || !tab.alive || !cols || !rows) return false;
  tab.cols = cols; tab.rows = rows;
  if (tab.usesPty) { try { tab.proc.resize(cols, rows); } catch {} }
  return true;
}
export function writeToTab(tab, data) {
  if (!tab?.alive) return false;
  if (!tab.running && /[\r\n]/.test(data)) { tab.running = true; tab.broadcast({ t: 'state', running: true, alive: true }); }
  if (tab.usesPty) tab.proc.write(data); else tab.proc.stdin.write(data);
  return true;
}
// Everything a client or Claude needs to know a tab has left: the Files package's "Open in
// terminal" and the composer's "!" ask for this by folder, with no tab in mind yet.
export function readBuffer(tab, maxChars = 8000) {
  const s = stripAnsi(tab.buf);
  return s.length > maxChars ? '…' + s.slice(-maxChars) : s;
}
// One command, run and waited for: used by both "Run in terminal" (the person's ! and the
// Files/composer helpers) and Claude's own run_in_terminal tool, so the two ways of asking
// for this capture output exactly the same way.
export function runCommand(tab, command, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    if (!tab?.alive) return resolve({ output: '', exitCode: null, error: 'This terminal is not running. Restart it first.' });
    if (tab.pending) return resolve({ output: '', exitCode: null, error: 'Another command is already running in this tab.' });
    const entry = { buf: '', resolve: finish };
    let timer;
    function finish(r) { clearTimeout(timer); resolve(r); }
    timer = setTimeout(() => {
      if (tab.pending !== entry) return; // already resolved by a marker in the meantime
      tab.pending = null;
      finish({ output: stripAnsi(entry.buf), exitCode: null, timedOut: true });
    }, Math.max(1000, timeoutMs));
    tab.pending = entry;
    writeToTab(tab, command + '\r');
  });
}

// ---------- a websocket, hand-rolled: one more dependency to read and send frames was a
// harder sell than the fifty-odd lines it actually takes for what this needs (text frames,
// server never fragments, client's are small JSON) ----------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function acceptHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
}
function encodeFrame(data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
// A browser always masks what it sends us; decodes one frame off the front of `buf`, or
// returns null when there is not a whole one yet (the rest arrives in a later TCP chunk).
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b1 = buf[1];
  const masked = !!(b1 & 0x80);
  let len = b1 & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  let payload = buf.subarray(off, off + len);
  if (masked) {
    const mask = buf.subarray(off - 4, off), out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
    payload = out;
  }
  return { opcode: buf[0] & 0x0f, payload, rest: buf.subarray(off + len) };
}
export function handleUpgrade(req, socket, head, { sessionId, tabId }) {
  acceptHandshake(req, socket);
  if (head?.length) socket.unshift(head);
  const tab = getTab(sessionId, tabId);
  if (!tab) { socket.end(encodeFrame(JSON.stringify({ t: 'error', text: 'No such terminal tab.' }))); return; }
  const send = (ev) => { try { socket.write(encodeFrame(JSON.stringify(ev))); } catch {} };
  tab.sockets.add(send);
  send({ t: 'snapshot', data: tab.buf, tab: tabInfo(tab) });
  let incoming = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    incoming = Buffer.concat([incoming, chunk]);
    let frame;
    while ((frame = decodeFrame(incoming))) {
      incoming = Buffer.from(frame.rest);
      if (frame.opcode === 8) { socket.end(); return; }
      if (frame.opcode === 9) { socket.write(encodeFrame(frame.payload, 10)); continue; }
      if (frame.opcode !== 1) continue;
      let msg; try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
      if (msg.t === 'input') writeToTab(tab, String(msg.d ?? ''));
      else if (msg.t === 'resize') resizeTab(sessionId, tabId, Number(msg.cols), Number(msg.rows));
    }
  });
  const cleanup = () => tab.sockets.delete(send);
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}
