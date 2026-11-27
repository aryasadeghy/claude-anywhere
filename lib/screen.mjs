// This PC's screen, for Claude and for the person: Desktop's computer use, and a remote desktop
// pane that only runs while it is open. Windows only for now - a Mac would need screencapture,
// a helper for input and its own permission prompts, which nothing here can grant itself.
//
// The work is done by one PowerShell process (lib/screen-helper.cs, compiled with Add-Type: no
// npm dependency, nothing installed), started the first time something needs the screen and
// stopped when nothing has for a minute. It talks line-delimited JSON over its stdin/stdout and
// dies with the server: its stdin is the server's, so even a server killed outright takes it down.
//
// While anyone controls the PC - a person in the pane, or Claude - the helper keeps a small
// always-on-top banner on the PC itself with a Stop, for whoever is sitting in front of it.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptHandshake, encodeFrame, decodeFrame } from './terminal.mjs';

export const supported = () => process.platform === 'win32';
export const NOT_HERE = 'Remote desktop and computer use work on Windows only for now.';
// 'stop': the banner's Stop was pressed; 'settings': a switch changed.
export const events = new EventEmitter();

// ---------- the two switches, off until someone turns them on ----------
let dataDir = path.join(os.tmpdir(), 'claude-anywhere-screen');
let settings = null;
const DEFAULTS = { remoteDesktop: false, computerUse: false };
export function configure(o = {}) { if (o.dataDir) { dataDir = o.dataDir; settings = null; } }
const settingsFile = () => path.join(dataDir, 'screen.json');
export function getSettings() {
  if (!settings) { try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { settings = { ...DEFAULTS }; } }
  return { ...settings };
}
export function setSettings(patch = {}) {
  const s = getSettings();
  for (const k of Object.keys(DEFAULTS)) if (typeof patch[k] === 'boolean') s[k] = patch[k];
  settings = s;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  // Turned off is off now, not when the pane is next opened.
  if (!s.remoteDesktop) for (const v of viewers) v.end({ t: 'off' });
  if (!s.computerUse) { claude.clear(); syncBanner(); }
  events.emit('settings', s);
  return { ...s };
}

// ---------- geometry: a screenshot's pixels and the screen's ----------
// What Claude gets: at most WXGA, the size the computer-use models are trained to read - a 4K
// screen sent whole costs four times the tokens and its coordinates come back no better.
export const CLAUDE_MAX = { w: 1280, h: 800 };
export const fitScale = (w, h, maxW = CLAUDE_MAX.w, maxH = CLAUDE_MAX.h) => Math.min(1, maxW / w, maxH / h);
// A view is a display (its place on the virtual screen, in physical pixels) and the scale its
// picture was sent at; a point in the picture is a point on the screen, and back.
export function toScreen(x, y, view) {
  const s = view.scale || 1;
  const px = Math.round(Number(x) / s), py = Math.round(Number(y) / s);
  if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('A coordinate is not a number.');
  if (px < 0 || py < 0 || px >= view.w || py >= view.h) throw new Error(`(${x}, ${y}) is outside the screenshot, which is ${Math.round(view.w * s)}×${Math.round(view.h * s)}.`);
  return { x: view.x + px, y: view.y + py };
}
export const fromScreen = (sx, sy, view) => ({ x: Math.round((sx - view.x) * (view.scale || 1)), y: Math.round((sy - view.y) * (view.scale || 1)) });
// Display 1 is the main one, then left to right: the order a person counts them in.
export function orderDisplays(list = []) {
  return [...list].sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || a.x - b.x || a.y - b.y).map((d, i) => ({ ...d, id: i + 1, label: `Display ${i + 1}${d.primary ? ' (main)' : ''} · ${d.w}×${d.h}` }));
}

// ---------- key names ----------
// Claude names keys the way xdotool does ("Return", "ctrl+s", "Page_Down", "super"); the pane
// sends a browser's KeyboardEvent. Both become Windows virtual-key codes here.
const VK = {
  enter: 0x0d, return: 0x0d, kpenter: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20, backspace: 0x08,
  delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d, home: 0x24, end: 0x23,
  pageup: 0x21, prior: 0x21, pgup: 0x21, pagedown: 0x22, next: 0x22, pgdn: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, arrowleft: 0x25, arrowup: 0x26, arrowright: 0x27, arrowdown: 0x28,
  shift: 0x10, lshift: 0xa0, rshift: 0xa1, shiftl: 0xa0, shiftr: 0xa1,
  ctrl: 0x11, control: 0x11, lctrl: 0xa2, rctrl: 0xa3, controll: 0xa2, controlr: 0xa3,
  // Claude often says cmd out of Mac habit; on Windows the shortcut it means is Ctrl's.
  cmd: 0x11, command: 0x11,
  alt: 0x12, option: 0x12, lalt: 0xa4, ralt: 0xa5, altl: 0xa4, altr: 0xa5, altgr: 0xa5,
  super: 0x5b, win: 0x5b, windows: 0x5b, meta: 0x5b, lwin: 0x5b, rwin: 0x5c, superl: 0x5b, superr: 0x5c, metal: 0x5b, metar: 0x5c,
  menu: 0x5d, apps: 0x5d, contextmenu: 0x5d,
  capslock: 0x14, numlock: 0x90, scrolllock: 0x91, printscreen: 0x2c, print: 0x2c, prtsc: 0x2c, pause: 0x13, break: 0x13,
  volumemute: 0xad, audiomute: 0xad, volumedown: 0xae, audiolowervolume: 0xae, volumeup: 0xaf, audioraisevolume: 0xaf,
  medianext: 0xb0, audionext: 0xb0, mediaprev: 0xb1, audioprev: 0xb1, mediastop: 0xb2, audiostop: 0xb2, mediaplaypause: 0xb3, audioplay: 0xb3, audiopause: 0xb3,
  kpmultiply: 0x6a, kpadd: 0x6b, kpsubtract: 0x6d, kpdecimal: 0x6e, kpdivide: 0x6f,
  semicolon: 0xba, ';': 0xba, equal: 0xbb, equals: 0xbb, '=': 0xbb, plus: 0xbb, comma: 0xbc, ',': 0xbc, minus: 0xbd, '-': 0xbd,
  period: 0xbe, '.': 0xbe, slash: 0xbf, '/': 0xbf, grave: 0xc0, backquote: 0xc0, '`': 0xc0,
  bracketleft: 0xdb, '[': 0xdb, backslash: 0xdc, '\\': 0xdc, bracketright: 0xdd, ']': 0xdd, apostrophe: 0xde, quote: 0xde, "'": 0xde,
};
for (let i = 1; i <= 24; i++) VK['f' + i] = 0x6f + i;
for (let i = 0; i <= 9; i++) { VK[String(i)] = 0x30 + i; VK['kp' + i] = 0x60 + i; VK['numpad' + i] = 0x60 + i; }
for (let c = 97; c <= 122; c++) VK[String.fromCharCode(c)] = c - 32;
export const MODIFIER_VKS = new Set([0x10, 0x11, 0x12, 0x5b, 0x5c, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]);

export function vkOf(name) {
  const raw = String(name);
  if (raw.length === 1 && VK[raw.toLowerCase()] !== undefined) return VK[raw.toLowerCase()];
  const n = raw.toLowerCase().replace(/[\s_-]/g, '');
  if (VK[n] !== undefined) return VK[n];
  // "Control_L", "Super_R", "KP_Enter": the side or the pad, then the key.
  const side = /^(.*?)(l|r)$/.exec(n);
  if (side && VK[side[1]] !== undefined) return VK[side[1] + side[2]] ?? VK[side[1]];
  if (/^0x[0-9a-f]{1,2}$/.test(n)) return parseInt(n, 16);
  throw new Error(`Unknown key "${name}". Use names like Return, Tab, Escape, BackSpace, Delete, Home, End, Page_Up, Up, F5, ctrl, alt, shift, super, a, 1.`);
}
// "ctrl+shift+t", "alt+Tab", "ctrl+a Delete" (one combo after another), "ctrl++".
export function parseKeys(spec) {
  const combos = String(spec || '').trim().split(/\s+/).filter(Boolean);
  if (!combos.length) throw new Error('No key given.');
  return combos.map((c) => {
    const parts = c === '+' ? ['+'] : c.endsWith('++') ? [...c.slice(0, -2).split('+'), '+'] : c.split('+');
    return parts.filter((p) => p !== '').map((p) => (p === '+' ? VK.plus : vkOf(p)));
  });
}
// The Ctrl+Alt+Del a person may reach for: Windows takes it only from a keyboard at the PC.
export const isSecureAttention = (vks) => vks.includes(0x2e) && vks.some((v) => [0x11, 0xa2, 0xa3].includes(v)) && vks.some((v) => [0x12, 0xa4, 0xa5].includes(v));

const CODE_VK = {
  Enter: 0x0d, NumpadEnter: 0x0d, Backspace: 0x08, Tab: 0x09, Escape: 0x1b, Space: 0x20, Delete: 0x2e, Insert: 0x2d, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3, AltLeft: 0xa4, AltRight: 0xa5, MetaLeft: 0x5b, MetaRight: 0x5c, OSLeft: 0x5b, OSRight: 0x5c, ContextMenu: 0x5d,
  CapsLock: 0x14, NumLock: 0x90, ScrollLock: 0x91, PrintScreen: 0x2c, Pause: 0x13,
  Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde, IntlBackslash: 0xe2,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
};
// By where the key is (code) before what it says (key): a shortcut is a place on the keyboard,
// whatever the layout. keyCode is the last resort - it differs between browsers for punctuation.
export function vkFromBrowser({ key, code, keyCode } = {}) {
  if (code) {
    if (CODE_VK[code] !== undefined) return CODE_VK[code];
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) return m[1].charCodeAt(0);
    if ((m = /^Digit(\d)$/.exec(code))) return 0x30 + Number(m[1]);
    if ((m = /^Numpad(\d)$/.exec(code))) return 0x60 + Number(m[1]);
    if ((m = /^F(\d{1,2})$/.exec(code))) return 0x6f + Number(m[1]);
  }
  if (key) { try { return vkOf(key === ' ' ? 'space' : key); } catch {} }
  const k = Number(keyCode) | 0;
  return k > 0 && k < 256 ? k : 0;
}

// ---------- the helper process ----------
const IDLE_MS = Number(process.env.CLAUDE_ANYWHERE_SCREEN_IDLE_MS) || 60000;
const PS1 = `param([string]$cs, [string]$dll)
$ErrorActionPreference = 'Stop'
$refs = 'System.Drawing', 'System.Windows.Forms', 'System.Web.Extensions'
if (Test-Path -LiteralPath $dll) { Add-Type -LiteralPath $dll }
else {
  $src = [IO.File]::ReadAllText($cs)
  try { Add-Type -TypeDefinition $src -ReferencedAssemblies $refs -OutputAssembly $dll -OutputType Library; Add-Type -LiteralPath $dll }
  catch { Add-Type -TypeDefinition $src -ReferencedAssemblies $refs }
}
[CaScreen.Helper]::Run($env:CA_SCREEN_CONFINE)
`;
let child = null, starting = null, seq = 0, lastUse = 0, idleTimer = null;
const pending = new Map();
export const running = () => !!child;
export const helperPid = () => child?.pid || 0;
// Tests only: every input must land on the window with this title (see Guard in the helper).
const confineTo = () => process.env.CLAUDE_ANYWHERE_SCREEN_CONFINE || '';

function lines(onLine) {
  let parts = [];
  return (chunk) => {
    let start = 0, i;
    while ((i = chunk.indexOf(10, start)) !== -1) {
      parts.push(chunk.subarray(start, i));
      const s = Buffer.concat(parts).toString('utf8').trim();
      parts = []; start = i + 1;
      if (s) onLine(s);
    }
    if (start < chunk.length) parts.push(chunk.subarray(start));
  };
}
async function start() {
  if (!supported()) throw new Error(NOT_HERE);
  const src = fs.readFileSync(new URL('./screen-helper.cs', import.meta.url), 'utf8');
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 12);
  // Compiled once per version of the source and kept: Add-Type takes seconds, loading a DLL does not.
  const dir = path.join(dataDir, 'helper');
  fs.mkdirSync(dir, { recursive: true });
  const cs = path.join(dir, `screen-${hash}.cs`), dll = path.join(dir, `screen-${hash}.dll`), ps1 = path.join(dir, 'screen.ps1');
  if (!fs.existsSync(cs)) fs.writeFileSync(cs, src);
  fs.writeFileSync(ps1, PS1);
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const c = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, cs, dll], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, CA_SCREEN_CONFINE: confineTo() } });
  let err = '';
  c.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  c.stdin.on('error', () => {});
  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The screen helper did not start in time.' + (err ? ' ' + err.trim().split('\n').pop() : ''))), 60000);
    c.stdout.on('data', lines((s) => {
      let m; try { m = JSON.parse(s); } catch { return; }
      if (m.ev === 'ready') { clearTimeout(t); resolve(m); return; }
      if (m.ev === 'stop') { onBannerStop(); return; }
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m);
    }));
    c.on('exit', (code) => { clearTimeout(t); reject(new Error(`The screen helper stopped (${code}).` + (err ? ' ' + err.trim().split('\n').slice(-3).join(' ') : ''))); });
  });
  c.on('exit', () => {
    if (child === c) { child = null; bannerShown = false; }
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('The screen helper stopped.')); }
    pending.clear();
  });
  child = c;
  try { await ready; } catch (e) { try { c.kill(); } catch {} if (child === c) child = null; throw e; }
  clearInterval(idleTimer);
  idleTimer = setInterval(() => { if (!viewers.size && !claudeActive() && Date.now() - lastUse > IDLE_MS) stopHelper(); }, 10000);
  idleTimer.unref();
}
async function ensure() {
  if (child && !starting) return child;
  if (!starting) starting = start().finally(() => { starting = null; });
  await starting;
  return child;
}
export async function call(cmd, args = {}, timeoutMs = 20000) {
  lastUse = Date.now();
  const c = await ensure();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(cmd + ' timed out')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { c.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n'); } catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
  });
}
export function stopHelper() {
  const c = child; if (!c) return;
  child = null; bannerShown = false; clearInterval(idleTimer);
  try { c.stdin.end(); } catch {}
  setTimeout(() => { try { c.kill(); } catch {} }, 2000).unref();
}
process.on('exit', () => { try { child?.kill(); } catch {} });

// ---------- what the helper can do, in the server's terms ----------
let displayCache = { at: 0, list: [] };
export async function displays() {
  if (Date.now() - displayCache.at < 5000 && displayCache.list.length) return displayCache.list;
  const { displays: list } = await call('displays');
  displayCache = { at: Date.now(), list: orderDisplays(list) };
  return displayCache.list;
}
export const windows = async () => (await call('windows')).windows || [];
export const windowAt = async (x, y) => (await call('at', { x, y })).window || null;
export const foreground = async () => (await call('foreground')).window || null;
export async function grab(display, { maxW, maxH, quality = 70, key, cursor = false, show, region } = {}) {
  const r = region || display;
  const out = await call('grab', { x: r.x, y: r.y, w: r.w, h: r.h, maxW: maxW || r.w, maxH: maxH || r.h, quality, key, cursor, ...(show ? { show } : {}) }, 30000);
  return out.same ? { same: true } : { ...out, jpeg: Buffer.from(out.jpeg, 'base64') };
}
export const mouse = (args) => call('mouse', args);
export const drag = (args) => call('drag', args);
export const scroll = (args) => call('scroll', args);
export const keys = (vks, action = 'press') => call('keys', { vks, action });
export const typeText = (text) => call('text', { text }, 120000);
export const focus = (hwnd) => call('focus', { hwnd });
export const open = (name) => call('open', { name });

// ---------- who is controlling: the banner on the PC ----------
const viewers = new Set();
const claude = new Map(); // sessionId -> until (ms): Claude acted on the PC, and may again in a moment
const CLAUDE_HOLD_MS = 60000;
let bannerShown = false, bannerTimer = null;
const claudeActive = () => { const now = Date.now(); for (const [k, until] of claude) if (until <= now) claude.delete(k); return claude.size > 0; };
export function claudeActed(sessionId) { claude.set(sessionId || '', Date.now() + CLAUDE_HOLD_MS); syncBanner(); }
export function claudeDone(sessionId) { if (claude.delete(sessionId || '')) syncBanner(); }
export const controlledBy = () => ({ people: viewers.size, claude: claudeActive() });
function syncBanner() {
  clearTimeout(bannerTimer);
  const on = viewers.size > 0 || claudeActive();
  if (on && claude.size) { bannerTimer = setTimeout(syncBanner, Math.max(1000, Math.min(...claude.values()) - Date.now() + 50)); bannerTimer.unref?.(); }
  if (on === bannerShown) return;
  if (!on && !child) { bannerShown = false; return; }
  bannerShown = on;
  call('banner', { on, text: 'This PC is being controlled from claude-anywhere', button: 'Stop' }).catch(() => { bannerShown = false; });
}
// The person at the PC pressed Stop: every remote view ends, and so does Claude's control.
function onBannerStop() {
  bannerShown = false;
  for (const v of viewers) v.end({ t: 'stopped', text: 'Someone at the PC pressed Stop on its banner.' });
  const who = [...claude.keys()];
  claude.clear();
  events.emit('stop', { sessions: who });
}

// ---------- a websocket, the way lib/browser.mjs and lib/terminal.mjs speak it ----------
export function serveSocket(req, socket, head, { onMessage, onClose }) {
  acceptHandshake(req, socket);
  if (head?.length) socket.unshift(head);
  let open = true, incoming = Buffer.alloc(0), chain = Promise.resolve();
  const ws = {
    get open() { return open; },
    get backlog() { return socket.writableLength; },
    send: (ev) => { if (open) try { socket.write(encodeFrame(JSON.stringify(ev))); } catch {} },
    frame: (buf) => { if (open) try { socket.write(encodeFrame(buf, 2)); } catch {} },
    end: (ev) => { if (!open) return; if (ev) ws.send(ev); try { socket.end(encodeFrame(Buffer.alloc(0), 8)); } catch {} cleanup(); },
  };
  socket.on('data', (chunk) => {
    incoming = Buffer.concat([incoming, chunk]);
    let f;
    while ((f = decodeFrame(incoming))) {
      incoming = Buffer.from(f.rest);
      if (f.opcode === 8) { ws.end(); return; }
      if (f.opcode === 9) { try { socket.write(encodeFrame(f.payload, 10)); } catch {} continue; }
      if (f.opcode !== 1) continue;
      let m; try { m = JSON.parse(f.payload.toString('utf8')); } catch { continue; }
      // In order: a click is a press and a release, and they must not cross.
      chain = chain.then(() => onMessage(m)).catch(() => {});
    }
  });
  const cleanup = () => { if (!open) return; open = false; try { onClose?.(); } catch {} };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
  return ws;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the remote desktop pane: pictures out, pointer and keys in ----------
let viewerSeq = 0;
export function handleUpgrade(req, socket, head) {
  const v = { id: ++viewerSeq, size: null, display: null, list: [], held: new Set(), buttons: new Set(), paused: false, ws: null, end: () => {} };
  const ws = serveSocket(req, socket, head, {
    onMessage: (m) => onInput(v, m),
    onClose: () => {
      viewers.delete(v);
      // Whatever this view held down is let go: a closed tab must not leave Ctrl pressed on the PC.
      for (const vk of [...v.held].reverse()) keys([vk], 'up').catch(() => {});
      for (const b of v.buttons) mouse({ action: 'up', button: b }).catch(() => {});
      syncBanner();
    },
  });
  v.ws = ws; v.end = (ev) => ws.end(ev);
  if (!supported()) return ws.end({ t: 'error', text: NOT_HERE });
  if (!getSettings().remoteDesktop) return ws.end({ t: 'off' });
  viewers.add(v);
  syncBanner();
  (async () => {
    try {
      v.list = await displays();
      v.display = v.list[0];
      ws.send({ t: 'displays', list: v.list, id: v.display?.id });
      ws.send({ t: 'size', w: v.display.w, h: v.display.h });
    } catch (e) { return ws.end({ t: 'error', text: e.message }); }
    frames(v);
  })();
  return ws;
}
// As fast as the link takes them and only when something changed: about ten a second while
// the screen moves, a few a second while it sits still, and lighter pictures when frames back up.
async function frames(v) {
  let quality = 70, still = 0;
  while (v.ws.open) {
    if (!v.size || v.paused || !v.display) { await sleep(150); continue; }
    if (v.ws.backlog > 384 * 1024) { quality = Math.max(35, quality - 10); await sleep(60); continue; }
    const d = v.display, t0 = Date.now();
    const maxW = Math.min(d.w, Math.max(320, v.size.pw || 1280), 2560), maxH = Math.min(d.h, Math.max(200, v.size.ph || 800), 1600);
    let r;
    try { r = await grab(d, { maxW, maxH, quality, cursor: true, key: `v${v.id}:${d.id}:${maxW}x${maxH}` }); }
    catch (e) { v.ws.send({ t: 'note', text: e.message }); await sleep(1000); continue; }
    if (!v.ws.open) break;
    if (r.same) still++;
    else { still = 0; v.ws.frame(r.jpeg); if (v.ws.backlog < 64 * 1024) quality = Math.min(80, quality + 2); }
    await sleep(Math.max(10, (still > 30 ? 400 : still > 8 ? 200 : 90) - (Date.now() - t0)));
  }
}
const SPECIAL = {
  win: [[0x5b]], alttab: [[0xa4, 0x09]], taskmgr: [[0xa2, 0xa0, 0x1b]], escape: [[0x1b]],
  showdesktop: [[0x5b, 0x44]], lock: [[0x5b, 0x4c]],
};
async function onInput(v, m) {
  const d = v.display;
  const at = (x, y) => ({ x: d.x + Math.max(0, Math.min(d.w - 1, Math.round(+x || 0))), y: d.y + Math.max(0, Math.min(d.h - 1, Math.round(+y || 0))) });
  switch (m.t) {
    case 'size': v.size = { w: +m.w || 0, h: +m.h || 0, pw: +m.pw || 0, ph: +m.ph || 0 }; v.paused = false; break;
    case 'pause': v.paused = true; break;
    case 'display': {
      const next = v.list.find((x) => x.id === Number(m.id));
      if (next) { v.display = next; v.ws.send({ t: 'size', w: next.w, h: next.h }); }
      break;
    }
    case 'mouse': {
      if (!d) return;
      const button = ['left', 'right', 'middle'].includes(m.button) ? m.button : 'left';
      const action = ['move', 'down', 'up', 'click'].includes(m.type) ? m.type : 'move';
      if (action === 'down') v.buttons.add(button); else if (action === 'up') v.buttons.delete(button);
      await mouse({ action, button, count: m.count | 0 || 1, ...at(m.x, m.y) }).catch((e) => v.ws.send({ t: 'note', text: e.message }));
      break;
    }
    case 'wheel': {
      if (!d) return;
      // A browser's wheel step is about 100 pixels, Windows' notch is 120 units: down is negative.
      const dy = Math.max(-2400, Math.min(2400, Math.round(-(+m.dy || 0) * 1.2))), dx = Math.max(-2400, Math.min(2400, Math.round((+m.dx || 0) * 1.2)));
      if (dy || dx) await scroll({ ...at(m.x, m.y), dy, dx }).catch((e) => v.ws.send({ t: 'note', text: e.message }));
      break;
    }
    case 'key': {
      const vk = vkFromBrowser(m);
      if (!vk) return;
      if (m.type === 'down') {
        // Plain typing goes as the characters themselves, so a phone's keyboard and a layout
        // other than the PC's still type what was meant.
        if (m.text && !m.ctrl && !m.alt && !m.meta && !MODIFIER_VKS.has(vk)) return typeText(m.text).catch((e) => v.ws.send({ t: 'note', text: e.message }));
        if (isSecureAttention([...v.held, vk])) return v.ws.send({ t: 'note', text: CAD });
        v.held.add(vk);
        await keys([vk], 'down').catch((e) => v.ws.send({ t: 'note', text: e.message }));
      } else if (v.held.delete(vk)) await keys([vk], 'up').catch(() => {});
      break;
    }
    case 'text': if (m.text) await typeText(String(m.text)).catch((e) => v.ws.send({ t: 'note', text: e.message })); break;
    case 'special': {
      if (m.name === 'ctrlaltdel') return v.ws.send({ t: 'note', text: CAD });
      for (const combo of SPECIAL[m.name] || []) await keys(combo, 'press').catch((e) => v.ws.send({ t: 'note', text: e.message }));
      break;
    }
  }
}
export const CAD = 'Ctrl+Alt+Del cannot be sent: Windows takes it only from a keyboard at the PC itself.';
