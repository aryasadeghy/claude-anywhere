// "!" in the box: a shell command run on this machine, in the session's folder, the way
// Desktop's own terminal integration does ("Run a shell command in the terminal and send the
// output to Claude"). One at a time per session - Desktop's own wording for the second attempt
// is "A shell command is already running" - streamed to whichever page is watching, killable,
// and capped at ten minutes so a forgotten `tail -f` does not run until the machine reboots.

import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CAP_MS = 10 * 60 * 1000;
const MAX_BUFFER = 256 * 1024; // kept for a page that opens the stream after the command started

export const runs = new Map();        // runId -> { sessionId, proc, buffer, done, exitCode, listeners, command, cwd }
const bySession = new Map();          // sessionId -> runId, so a second "!" is refused, not stacked

// Claude Code runs bash on Windows when Git Bash is installed, and falls back to PowerShell
// only when it is not (sdk.mjs's own description: "bash on POSIX, PowerShell on Windows
// without Git Bash"). The CLI's own search for the binary is in the native binary, not the
// JS half, so this mirrors the common install locations rather than reading it from there.
function gitBash() {
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  for (const r of roots) { const p = path.join(r, 'Git', 'bin', 'bash.exe'); if (fs.existsSync(p)) return p; }
  return null;
}
function shellFor() {
  if (process.platform === 'win32') {
    const bash = gitBash();
    if (bash) return { file: bash, args: ['-lc'] };
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'] };
  }
  return { file: process.env.SHELL || '/bin/sh', args: ['-lc'] };
}

export function isRunning(sessionId) {
  const id = bySession.get(sessionId);
  const r = id && runs.get(id);
  return !!(r && !r.done);
}

export function start(sessionId, cwd, command) {
  if (isRunning(sessionId)) throw Object.assign(new Error('A shell command is already running'), { status: 409 });
  const { file, args } = shellFor();
  const proc = spawn(file, [...args, command], { cwd, windowsHide: true, env: process.env });
  const id = randomUUID();
  const r = { sessionId, proc, buffer: '', done: false, exitCode: null, listeners: new Set(), command, cwd, startedAt: Date.now() };
  runs.set(id, r); bySession.set(sessionId, id);
  // Newline-delimited JSON, not SSE: an EventSource cannot carry the Authorization header, and
  // widening the query-token exception (server.mjs) to one more path was more than this needed -
  // a plain fetch() reader sends the header like every other request this app makes.
  const append = (chunk) => {
    r.buffer = (r.buffer + chunk).slice(-MAX_BUFFER);
    for (const res of r.listeners) res.write(JSON.stringify({ t: 'chunk', text: chunk }) + '\n');
  };
  proc.stdout.on('data', (d) => append(d.toString('utf8')));
  proc.stderr.on('data', (d) => append(d.toString('utf8')));
  const finish = (exitCode) => {
    if (r.done) return;
    clearTimeout(cap);
    r.done = true; r.exitCode = exitCode;
    for (const res of r.listeners) { res.write(JSON.stringify({ t: 'done', exitCode }) + '\n'); res.end(); }
    r.listeners.clear();
    if (bySession.get(sessionId) === id) bySession.delete(sessionId);
    // Kept a while so a page that asks right after it ended still reads the tail.
    setTimeout(() => runs.delete(id), 5 * 60 * 1000);
  };
  proc.on('close', (code) => finish(code ?? 0));
  proc.on('error', (e) => { append('\n' + (e.message || String(e)) + '\n'); finish(1); });
  const cap = setTimeout(() => kill(id, true), CAP_MS);
  return { id, startedAt: r.startedAt };
}

// bash's own children (anything the command itself started) outlive a plain kill() on
// Windows - taskkill /T walks the process tree instead of just the shell wrapping it.
function kill(id, timedOut = false) {
  const r = runs.get(id); if (!r || r.done) return false;
  if (timedOut) r.buffer += '\n[stopped: ran past the 10-minute limit]\n';
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(r.proc.pid), '/T', '/F'], () => {});
  else { try { r.proc.kill('SIGTERM'); } catch {} setTimeout(() => { try { r.proc.kill('SIGKILL'); } catch {} }, 3000); }
  return true;
}
export { kill };

export function get(id) { return runs.get(id); }
