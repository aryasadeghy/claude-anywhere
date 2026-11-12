// The Browser pane's real browser: a headless Chrome or Edge on the computer that runs the
// server, driven over the Chrome DevTools Protocol and streamed to the pane as pictures.
// Desktop's pane is a Chromium tab of its own window; ours has to reach a phone or another
// computer too, so the page cannot hold the browser - it holds a view of one.
//
// One browser process, started on first use and closed when nothing has looked at it for a
// while; one browser context per app session, so each session keeps its own sign-ins (their
// cookies are written out when the browser closes and put back when the context opens);
// a tab is a page target, attached with flatten so one pipe carries every tab.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptHandshake, encodeFrame, decodeFrame } from './terminal.mjs';

// ---------- the pipe: --remote-debugging-pipe speaks NUL-terminated JSON on fds 3 (in) and 4 (out) ----------
// Bytes, not strings, until a whole message is there: a chunk can end in the middle of a
// multi-byte character, and decoding it early turns that character into two replacement marks.
export function pipeFramer(onMessage) {
  let parts = [];
  return (chunk) => {
    let start = 0, i;
    while ((i = chunk.indexOf(0, start)) !== -1) {
      parts.push(chunk.subarray(start, i));
      const text = Buffer.concat(parts).toString('utf8');
      parts = []; start = i + 1;
      if (!text) continue;
      let msg; try { msg = JSON.parse(text); } catch { continue; }
      onMessage(msg);
    }
    if (start < chunk.length) parts.push(chunk.subarray(start));
  };
}
export const encodeCommand = (obj) => Buffer.from(JSON.stringify(obj) + '\0', 'utf8');

function connect(child) {
  const pending = new Map(), ev = new EventEmitter();
  let seq = 0;
  const out = child.stdio[3], inp = child.stdio[4];
  out.on('error', () => {}); inp.on('error', () => {});
  inp.on('data', pipeFramer((m) => {
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message + (m.error.data ? ': ' + m.error.data : ''))); else p.resolve(m.result || {});
    } else if (m.method) ev.emit('event', m.method, m.params || {}, m.sessionId);
  }));
  // A page stuck in a long script never answers; nothing here may wait on it forever.
  const send = (method, params = {}, sessionId, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(method + ' timed out')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { out.write(encodeCommand({ id, method, params, ...(sessionId ? { sessionId } : {}) })); } catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
  });
  const fail = (e) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); };
  return { send, ev, fail };
}

// ---------- finding a browser ----------
const OFF = /^(off|0|no|none|false)$/i;
function onPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const n of names) for (const d of dirs) { const p = path.join(d, n); try { if (fs.statSync(p).isFile()) return p; } catch {} }
  return null;
}
let found;
export function findBrowser() {
  if (found !== undefined) return found;
  const want = process.env.CLAUDE_ANYWHERE_BROWSER || '';
  if (OFF.test(want)) return (found = null);
  if (want) return (found = fs.existsSync(want) ? want : null);
  let list = [];
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    list = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe', 'Chromium\\Application\\chrome.exe'].flatMap((rel) => roots.map((r) => path.join(r, rel)));
  } else if (process.platform === 'darwin') {
    const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Chromium.app/Contents/MacOS/Chromium'];
    list = apps.flatMap((a) => ['/Applications/' + a, path.join(os.homedir(), 'Applications', a)]);
  } else {
    return (found = onPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']));
  }
  return (found = list.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null);
}
export const available = () => !!findBrowser();
export const browserName = () => { const p = findBrowser() || ''; return /edge/i.test(p) ? 'Microsoft Edge' : /chromium/i.test(p) ? 'Chromium' : p ? 'Google Chrome' : ''; };

// ---------- configuration from the server ----------
let dataDir = path.join(os.tmpdir(), 'claude-anywhere-browser');
let filesPrefix = '', fileKey = () => '';
const IDLE_MS = Number(process.env.CLAUDE_ANYWHERE_BROWSER_IDLE_MS) || 10 * 60 * 1000;
export function configure(o) { if (o.dataDir) dataDir = o.dataDir; if (o.filesPrefix) filesPrefix = o.filesPrefix; if (o.fileKey) fileKey = o.fileKey; }
export const events = new EventEmitter(); // 'tab' { key, id, url } - a page opened a tab of its own

// What a tab's address is, in the pane's own terms: a port of this computer, a project file
// (served by our /files route, which is how the browser reads one), or anywhere else.
export function specOf(url) {
  let u; try { u = new URL(url); } catch { return { kind: 'blank' }; }
  if (!url || url === 'about:blank') return { kind: 'blank' };
  if (filesPrefix && url.startsWith(filesPrefix)) {
    const m = /^[^/]+(\/.*)$/.exec(url.slice(filesPrefix.length).split(/[?#]/)[0]);
    if (m) { let p = decodeURIComponent(m[1]); if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1).replace(/\//g, '\\'); return { kind: 'file', file: p }; }
  }
  if (/^https?:$/.test(u.protocol) && isLocalHost(u.hostname)) return { kind: 'server', port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search + u.hash };
  return { kind: 'web', url };
}
export function urlOf(spec) {
  if (!spec) return 'about:blank';
  if (spec.kind === 'server') return 'http://localhost:' + spec.port + (spec.path || '/');
  if (spec.kind === 'file') return filesPrefix + fileKey() + '/' + String(spec.file).replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  if (spec.kind === 'web' && /^https?:\/\//i.test(spec.url || '')) return spec.url;
  return 'about:blank';
}
const isLocalHost = (h) => /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1\]|::1)$/i.test(h) || /\.localhost$/i.test(h);
// What Claude may open or act on without asking: this computer's own pages, never the web.
export function isLocalUrl(url) {
  if (!url || url === 'about:blank') return true;
  if (/^\d{1,5}(\/|$)/.test(url)) return true; // "5173/path"
  try { const u = new URL(/^([a-z][a-z0-9+.-]*:\/\/|(about|javascript|data|file|mailto|blob):)/i.test(url) ? url : 'http://' + url); return /^(https?|about):$/.test(u.protocol) && (u.protocol === 'about:' || isLocalHost(u.hostname)); } catch { return false; }
}

// ---------- the process ----------
let proc = null, cdp = null, starting = null, lastUse = Date.now(), idleTimer = null;
const contexts = new Map();   // key -> Promise<ctx>
const ctxById = new Map();    // browserContextId -> ctx
const tabs = new Map();       // targetId -> tab
const bySession = new Map();  // CDP sessionId -> tab
const attaching = new Map();  // targetId -> Promise<tab>
const touch = () => { lastUse = Date.now(); };
const cookieFile = (key) => path.join(dataDir, 'cookies', (key || 'new').replace(/[^\w-]/g, '_') + '.json');
export const running = () => !!cdp;
export const pid = () => proc?.pid || 0;

async function start() {
  const exe = findBrowser();
  if (!exe) throw new Error('No Chrome or Edge on this computer.');
  const profile = path.join(dataDir, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    '--headless=new', '--remote-debugging-pipe', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-client-side-phishing-detection',
    '--disable-features=Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider', '--password-store=basic', '--use-mock-keychain',
    '--mute-audio', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    // Root in a container has no sandbox to give Chrome; anywhere else it keeps its own.
    ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : []),
    'about:blank',
  ];
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
  const c = connect(child);
  proc = child; cdp = c;
  child.on('error', (e) => { c.fail(e); if (proc === child) reset(); });
  child.on('exit', () => { c.fail(new Error('The browser closed.')); if (proc === child) reset(); });
  c.ev.on('event', onEvent);
  try {
    await c.send('Browser.getVersion', {}, undefined, 20000);
    await c.send('Target.setDiscoverTargets', { discover: true });
  } catch (e) {
    try { child.kill(); } catch {}
    reset();
    throw new Error('The browser did not start: ' + e.message + (err ? ' ' + err.trim().split('\n').pop() : ''));
  }
  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    const watched = [...tabs.values()].some((t) => [...t.viewers].some((v) => v.visible));
    if (!watched && Date.now() - lastUse > IDLE_MS) shutdown();
  }, 30000);
  idleTimer.unref();
}
function reset() {
  proc = null; cdp = null; clearInterval(idleTimer);
  for (const t of tabs.values()) for (const v of t.viewers) v.send({ t: 'closed' });
  contexts.clear(); ctxById.clear(); tabs.clear(); bySession.clear(); attaching.clear();
}
export async function ensure() {
  touch();
  if (cdp) return cdp;
  if (!starting) starting = start().finally(() => { starting = null; });
  await starting;
  return cdp;
}
// Sign-ins outlive the browser: each context's cookies go to a file, and come back with it.
export async function shutdown() {
  const c = cdp, child = proc;
  if (!c) return;
  try {
    for (const p of contexts.values()) {
      const ctx = await p.catch(() => null); if (!ctx) continue;
      const { cookies } = await c.send('Storage.getCookies', { browserContextId: ctx.id }, undefined, 5000).catch(() => ({}));
      if (cookies) { fs.mkdirSync(path.dirname(cookieFile(ctx.key)), { recursive: true }); fs.writeFileSync(cookieFile(ctx.key), JSON.stringify(cookies)); }
    }
    await c.send('Browser.close', {}, undefined, 3000);
  } catch {}
  setTimeout(() => { try { child?.kill(); } catch {} }, 2000).unref();
  if (proc === child) reset();
}
// A plain kill is enough at the very end: the pipe closing takes Chrome down with it even
// when this process dies too hard to run this (a killed server leaves no orphan behind).
process.on('exit', () => { try { proc?.kill(); } catch {} });

function contextFor(key) {
  key = key || '';
  if (contexts.has(key)) return contexts.get(key);
  const p = (async () => {
    const { browserContextId: id } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: false });
    const ctx = { id, key, current: null };
    ctxById.set(id, ctx);
    try { const cookies = JSON.parse(fs.readFileSync(cookieFile(key), 'utf8')); if (cookies.length) await cdp.send('Storage.setCookies', { cookies, browserContextId: id }); } catch {}
    return ctx;
  })();
  contexts.set(key, p);
  p.catch(() => contexts.delete(key));
  return p;
}

async function attach(targetId, ctx) {
  if (tabs.has(targetId)) return tabs.get(targetId);
  if (attaching.has(targetId)) return attaching.get(targetId);
  const p = (async () => {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = { id: targetId, session: sessionId, ctx, url: '', title: '', loading: false, viewers: new Set(), logs: [], requests: new Map(), emu: null, scheme: null, applied: '', casting: '', lastFrame: null, entries: [], index: 0, stateTimer: null, dom: false };
    tabs.set(targetId, tab); bySession.set(sessionId, tab);
    const s = (m, a) => cdp.send(m, a, sessionId);
    // Focus emulation: a headless tab is never the focused window, and without it an input
    // clicked in the pane takes no caret and :focus styles never show.
    await Promise.all([s('Page.enable'), s('Runtime.enable'), s('Network.enable'), s('Log.enable'), s('Emulation.setFocusEmulationEnabled', { enabled: true })]);
    return tab;
  })();
  attaching.set(targetId, p);
  try { return await p; } finally { attaching.delete(targetId); }
}

export async function newTab(key, url) {
  await ensure();
  const ctx = await contextFor(key);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx.id });
  const tab = await attach(targetId, ctx);
  if (!ctx.current) ctx.current = tab.id;
  if (url && url !== 'about:blank') await navigate(tab, url);
  return tab;
}
export const getTab = (id) => tabs.get(id) || null;
export async function closeTab(id) {
  const tab = tabs.get(id); if (!tab || !cdp) return false;
  await cdp.send('Target.closeTarget', { targetId: id }).catch(() => {});
  return true;
}
// The tab Claude's tools act on: the one the pane last put in front for that session, so
// Claude and the person are always looking at the same page.
export async function tabFor(key, { create = true } = {}) {
  touch();
  if (cdp) {
    const ctx = await (contexts.get(key || '') || Promise.resolve(null)).catch(() => null);
    if (ctx) {
      const cur = ctx.current && tabs.get(ctx.current);
      if (cur) return cur;
      const any = [...tabs.values()].find((t) => t.ctx === ctx);
      if (any) { ctx.current = any.id; return any; }
    }
  }
  if (!create) return null;
  const tab = await newTab(key);
  tab.ctx.current = tab.id;
  return tab;
}
export function currentUrl(key) {
  for (const t of tabs.values()) if (t.ctx.key === (key || '') && t.ctx.current === t.id) return t.url;
  return '';
}
export const info = (tab) => ({ id: tab.id, url: tab.url, title: tab.title, spec: specOf(tab.url), loading: tab.loading });

// ---------- what the browser says ----------
function onEvent(method, p, sessionId) {
  if (sessionId) { const tab = bySession.get(sessionId); if (tab) onTabEvent(tab, method, p); return; }
  if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
    const i = p.targetInfo; if (i.type !== 'page') return;
    const tab = tabs.get(i.targetId);
    if (tab) { tab.url = i.url; tab.title = i.title; stateSoon(tab); return; }
    // A page that opened another (target=_blank, window.open): it becomes a tab of the pane.
    const ctx = ctxById.get(i.browserContextId);
    if (method === 'Target.targetCreated' && ctx && i.openerId) attach(i.targetId, ctx).then((t) => {
      t.url = i.url; const ev = { t: 'newtab', id: t.id, url: i.url, opener: i.openerId };
      for (const x of tabs.values()) if (x.ctx === ctx) for (const v of x.viewers) v.send(ev);
      events.emit('tab', { key: ctx.key, ...info(t) });
    }).catch(() => {});
  } else if (method === 'Target.targetDestroyed') {
    const tab = tabs.get(p.targetId); if (!tab) return;
    for (const v of tab.viewers) v.send({ t: 'gone' });
    tabs.delete(tab.id); bySession.delete(tab.session);
    if (tab.ctx.current === tab.id) tab.ctx.current = null;
  }
}
const MAX_LOGS = 500, MAX_REQ = 300;
const remote = (o) => (o.type === 'string' ? o.value : o.value !== undefined ? JSON.stringify(o.value) : o.description || o.type);
function log(tab, level, text) { tab.logs.push({ level, text: String(text).slice(0, 4000), at: Date.now() }); if (tab.logs.length > MAX_LOGS) tab.logs.splice(0, tab.logs.length - MAX_LOGS); }
function onTabEvent(tab, method, p) {
  switch (method) {
    case 'Page.screencastFrame': {
      cdp?.send('Page.screencastFrameAck', { sessionId: p.sessionId }, tab.session).catch(() => {});
      const buf = Buffer.from(p.data, 'base64');
      tab.lastFrame = buf;
      for (const v of tab.viewers) if (v.visible) v.frame(buf);
      break;
    }
    case 'Page.frameStartedLoading': if (p.frameId === tab.id) { tab.loading = true; stateSoon(tab); } break;
    case 'Page.frameStoppedLoading': if (p.frameId === tab.id) { tab.loading = false; stateSoon(tab); } break;
    case 'Page.frameNavigated': if (!p.frame.parentId) { tab.url = p.frame.url + (p.frame.urlFragment || ''); stateSoon(tab); } break;
    case 'Page.navigatedWithinDocument': if (p.frameId === tab.id) { tab.url = p.url; stateSoon(tab); } break;
    // Nobody is at the headless window to answer an alert, and an open one stops the page.
    case 'Page.javascriptDialogOpening': {
      cdp?.send('Page.handleJavaScriptDialog', { accept: true, promptText: p.defaultPrompt || '' }, tab.session).catch(() => {});
      log(tab, 'warning', `[${p.type} dialog, accepted] ${p.message}`);
      for (const v of tab.viewers) v.send({ t: 'note', text: 'The page said: ' + p.message });
      break;
    }
    case 'Runtime.consoleAPICalled': log(tab, p.type === 'warning' ? 'warn' : p.type, (p.args || []).map(remote).join(' ')); break;
    case 'Runtime.exceptionThrown': { const d = p.exceptionDetails || {}; log(tab, 'error', d.exception?.description || d.text || 'Uncaught exception'); break; }
    case 'Log.entryAdded': { const e = p.entry || {}; log(tab, e.level === 'warning' ? 'warn' : e.level, e.text + (e.url ? ' ' + e.url : '')); break; }
    case 'Network.requestWillBeSent': {
      tab.requests.set(p.requestId, { id: p.requestId, method: p.request.method, url: p.request.url, type: p.type || '', status: 0, at: Date.now() });
      if (tab.requests.size > MAX_REQ) tab.requests.delete(tab.requests.keys().next().value);
      break;
    }
    case 'Network.responseReceived': { const r = tab.requests.get(p.requestId); if (r) { r.status = p.response.status; r.mime = p.response.mimeType; } break; }
    case 'Network.loadingFailed': { const r = tab.requests.get(p.requestId); if (r) r.failed = p.canceled ? 'canceled' : p.errorText; break; }
  }
}
function stateSoon(tab) {
  clearTimeout(tab.stateTimer);
  tab.stateTimer = setTimeout(async () => {
    try { const h = await cdp.send('Page.getNavigationHistory', {}, tab.session); tab.entries = h.entries.map((e) => e.url); tab.index = h.currentIndex; } catch {}
    // A title set as the page loads does not always come as targetInfoChanged; asked, it does.
    try { const { targetInfo: i } = await cdp.send('Target.getTargetInfo', { targetId: tab.id }); tab.url = i.url; tab.title = i.title; } catch {}
    const ev = stateOf(tab);
    for (const v of tab.viewers) v.send(ev);
  }, 30);
}
const stateOf = (tab) => ({ t: 'state', ...info(tab), entries: tab.entries.map((u) => ({ url: u, spec: specOf(u) })), index: tab.index });

// ---------- acting on a tab ----------
const send = (tab, m, a, ms) => { touch(); return cdp.send(m, a, tab.session, ms); };
export async function navigate(tab, url) {
  const r = await send(tab, 'Page.navigate', { url });
  if (r.errorText && r.errorText !== 'net::ERR_ABORTED') throw new Error(url + ': ' + r.errorText);
  return r;
}
export async function historyStep(tab, dir) {
  const h = await send(tab, 'Page.getNavigationHistory');
  const e = h.entries[h.currentIndex + dir];
  if (e) await send(tab, 'Page.navigateToHistoryEntry', { entryId: e.id });
  return !!e;
}
export const reload = (tab) => send(tab, 'Page.reload', {});
export const stop = (tab) => send(tab, 'Page.stopLoading', {});
// Waits for the page to settle after something that may navigate: the load to finish, or a
// short quiet spell when nothing loads at all.
export async function settle(tab, ms = 8000) {
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 120));
  while (tab.loading && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
}

// Presets as Desktop's preview_resize has them; 'phone' is the pane's own toggle.
export const PRESETS = { mobile: { width: 375, height: 812, mobile: true }, phone: { width: 390, height: 844, mobile: true }, tablet: { width: 768, height: 1024, mobile: false } };
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
export async function emulate(tab, emu, { scheme } = {}) {
  tab.emu = emu ? { width: Math.round(emu.width), height: Math.round(emu.height), mobile: emu.mobile ?? emu.width < 768, by: emu.by || 'claude' } : null;
  if (scheme !== undefined) { tab.scheme = scheme; await send(tab, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme || '' }] }).catch(() => {}); }
  tab.applied = '';
  await reconfigure(tab, true);
}
// The page is laid out at the pane's size (or the emulated one) and streamed at the size the
// pane draws it, in device pixels - more would only be bytes the phone throws away.
async function reconfigure(tab, force = false) {
  const seen = [...tab.viewers].filter((v) => v.visible && v.size);
  const v = seen.at(-1);
  const size = v?.size;
  const vp = tab.emu || (size ? { width: size.w, height: size.h, mobile: !!size.mobile } : null);
  if (vp) {
    const dpr = Math.max(1, Math.min(3, size?.dpr || 1));
    const key = [vp.width, vp.height, vp.mobile, dpr].join(':');
    if (force || key !== tab.applied) {
      tab.applied = key;
      const ua = vp.mobile ? MOBILE_UA : '';
      await Promise.all([
        send(tab, 'Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: dpr, mobile: !!vp.mobile, screenWidth: vp.width, screenHeight: vp.height }),
        send(tab, 'Emulation.setTouchEmulationEnabled', { enabled: !!vp.mobile, maxTouchPoints: vp.mobile ? 5 : 1 }),
        send(tab, 'Emulation.setUserAgentOverride', { userAgent: ua || (await userAgent()) }),
      ]).catch(() => {});
    }
    // Every time, not only on a change: a pane that joins late maps its pointer by this.
    for (const x of tab.viewers) x.send({ t: 'viewport', width: vp.width, height: vp.height, mobile: !!vp.mobile, emu: tab.emu ? tab.emu.by : '' });
  }
  const cast = size ? [Math.round(size.pw || size.w * (size.dpr || 1)), Math.round(size.ph || size.h * (size.dpr || 1))].join('x') : '';
  if (cast === tab.casting && !force) return;
  if (tab.casting) await send(tab, 'Page.stopScreencast').catch(() => {});
  tab.casting = cast;
  if (cast) { const [w, h] = cast.split('x').map(Number); await send(tab, 'Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: w, maxHeight: h, everyNthFrame: 1 }).catch(() => {}); }
}
let ua0 = '';
async function userAgent() {
  if (!ua0) { const v = await cdp.send('Browser.getVersion'); ua0 = String(v.userAgent || '').replace('HeadlessChrome', 'Chrome'); }
  return ua0;
}

export async function screenshot(tab, { scale = 1, format = 'jpeg', quality = 80 } = {}) {
  const m = await send(tab, 'Page.getLayoutMetrics');
  const vv = m.cssVisualViewport || m.visualViewport;
  const s = Math.max(0.1, Math.min(1, Number(scale) || 1));
  const r = await send(tab, 'Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality } : {}), clip: { x: vv.pageX, y: vv.pageY, width: vv.clientWidth, height: vv.clientHeight, scale: s } });
  return r.data;
}

// The accessibility tree as text, one line per thing a person could read or use, each with a
// ref (the DOM node's backend id) that click and fill take back.
const SKIP = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'GenericContainer', 'paragraph', 'group', 'list', 'listitem', 'section', 'div']);
export async function snapshot(tab, { max = 40000 } = {}) {
  const { nodes } = await send(tab, 'Accessibility.getFullAXTree', {});
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) || nodes[0];
  const out = [];
  let size = 0;
  const val = (x) => (x && x.value !== undefined ? String(x.value) : '');
  const walk = (n, depth, parentName) => {
    if (!n || size > max) return;
    const role = val(n.role), name = val(n.name).replace(/\s+/g, ' ').trim();
    let shown = false;
    if (!n.ignored && role) {
      if (role === 'StaticText') {
        if (name && name !== parentName) { const l = '  '.repeat(depth) + '- text: ' + name.slice(0, 300); out.push(l); size += l.length; }
      } else if (!(SKIP.has(role) && !name) || role === 'RootWebArea') {
        const props = [];
        for (const p of n.properties || []) {
          const v = p.value?.value;
          if (['checked', 'selected', 'expanded', 'pressed', 'disabled', 'focused', 'required', 'invalid'].includes(p.name) && v && v !== 'false') props.push(v === true || v === 'true' ? p.name : p.name + '=' + v);
          if (p.name === 'level') props.push('level=' + v);
          if (p.name === 'url' && v) props.push('url=' + String(v).slice(0, 200));
        }
        const value = val(n.value);
        const l = '  '.repeat(depth) + '- ' + (role === 'RootWebArea' ? 'page' : role) + (name ? ' "' + name.slice(0, 200) + '"' : '') + (value ? ' value="' + value.slice(0, 200) + '"' : '') + (props.length ? ' [' + props.join(', ') + ']' : '') + (n.backendDOMNodeId && role !== 'RootWebArea' ? ' [ref=e' + n.backendDOMNodeId + ']' : '');
        out.push(l); size += l.length; shown = true;
      }
    }
    for (const c of n.childIds || []) walk(byId.get(c), depth + (shown ? 1 : 0), shown ? name : parentName);
  };
  walk(root, 0, '');
  if (size > max) out.push('… (cut short; the page has more)');
  return out.join('\n');
}

// An element by CSS selector or by a snapshot's ref, scrolled into view, as a remote object.
async function element(tab, { selector, ref }) {
  if (ref) {
    const id = Number(String(ref).replace(/^\D+/, ''));
    if (!tab.dom) { await send(tab, 'DOM.enable').catch(() => {}); await send(tab, 'DOM.getDocument', { depth: 0 }).catch(() => {}); tab.dom = true; }
    const r = await send(tab, 'DOM.resolveNode', { backendNodeId: id }).catch(() => null);
    if (!r?.object?.objectId) throw new Error('ref ' + ref + ' is stale - take a new preview_snapshot.');
    return r.object.objectId;
  }
  const r = await send(tab, 'Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(String(selector))})` });
  if (r.exceptionDetails) throw new Error('Bad selector: ' + selector);
  if (!r.result?.objectId) throw new Error('No element matches ' + selector);
  return r.result.objectId;
}
const call = async (tab, objectId, fn, args = []) => {
  const r = await send(tab, 'Runtime.callFunctionOn', { objectId, functionDeclaration: fn.toString(), arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
function centre() {
  const el = this.nodeType === 1 ? this : this.parentElement;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80) };
}
export async function click(tab, target, { double = false } = {}) {
  const at = await call(tab, await element(tab, target), centre);
  if (!at.w && !at.h) throw new Error('That element is not visible (it has no size).');
  const m = (type, clickCount, buttons) => send(tab, 'Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount });
  await m('mouseMoved', 0, 0);
  await m('mousePressed', 1, 1); await m('mouseReleased', 1, 0);
  if (double) { await m('mousePressed', 2, 1); await m('mouseReleased', 2, 0); }
  return at;
}
function fillIn(v) {
  const el = this;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  el.focus();
  const fire = () => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  if (el.tagName === 'SELECT') {
    const o = [...el.options].find((x) => x.value === v) || [...el.options].find((x) => x.text.trim() === v);
    if (!o) return { error: 'No option "' + v + '" in that select. Options: ' + [...el.options].map((x) => x.text.trim()).join(', ') };
    el.value = o.value; fire(); return { tag: 'select', value: o.value };
  }
  if (el.type === 'checkbox' || el.type === 'radio') { el.checked = !/^(false|0|off|no|)$/i.test(v); fire(); return { tag: el.type, value: String(el.checked) }; }
  if (el.isContentEditable) { el.textContent = v; fire(); return { tag: 'contenteditable', value: v }; }
  if (!('value' in el)) return { error: 'That element is not an input, textarea, select or editable area.' };
  // The prototype's setter, not el.value =: React and friends watch that one and would
  // otherwise put their own idea of the value straight back.
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  fire();
  return { tag: el.tagName.toLowerCase(), value: el.value };
}
export async function fill(tab, target, value) {
  const r = await call(tab, await element(tab, target), fillIn, [String(value)]);
  if (r?.error) throw new Error(r.error);
  return r;
}
export async function evaluate(tab, expression) {
  const r = await send(tab, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true, replMode: true }, 60000);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  const v = r.result;
  return v.value !== undefined ? v.value : v.description ?? (v.type === 'undefined' ? undefined : v.type);
}
function inspectEl(styles) {
  const el = this, cs = getComputedStyle(el), r = el.getBoundingClientRect();
  const want = styles && styles.length ? styles : ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'border', 'border-radius', 'opacity', 'visibility', 'z-index'];
  const out = {};
  for (const s of want) out[s] = cs.getPropertyValue(s);
  return { tagName: el.tagName.toLowerCase(), id: el.id, className: typeof el.className === 'string' ? el.className : '', text: (el.innerText || '').trim().slice(0, 500), box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }, styles: out };
}
export async function inspect(tab, selector, styles) {
  const objectId = await element(tab, { selector });
  const r = await send(tab, 'Runtime.callFunctionOn', { objectId, functionDeclaration: inspectEl.toString(), arguments: [{ value: styles || [] }], returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}
export const consoleLogs = (tab) => tab.logs;
export const requests = (tab) => [...tab.requests.values()];
export async function responseBody(tab, requestId) {
  const r = await send(tab, 'Network.getResponseBody', { requestId });
  return r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
}

// ---------- the pane: a websocket per shown tab, pictures out, input in ----------
const MAC = process.platform === 'darwin';
// On a Mac, Chrome's editing shortcuts are commands of the window, not keys: a Cmd+A sent as
// a key reaches the page and selects nothing.
const MAC_COMMANDS = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };
function input(tab, m) {
  const s = (meth, a) => send(tab, meth, a).catch(() => {});
  const mods = m.modifiers | 0;
  if (m.t === 'mouse') return s('Input.dispatchMouseEvent', { type: m.type, x: +m.x || 0, y: +m.y || 0, button: m.button || 'none', buttons: m.buttons | 0, clickCount: m.clickCount | 0, modifiers: mods });
  if (m.t === 'wheel') return s('Input.dispatchMouseEvent', { type: 'mouseWheel', x: +m.x || 0, y: +m.y || 0, deltaX: +m.dx || 0, deltaY: +m.dy || 0, modifiers: mods });
  if (m.t === 'text') return m.text ? s('Input.insertText', { text: String(m.text) }) : null;
  if (m.t === 'key') {
    const down = m.type === 'down', text = down && m.text ? String(m.text) : undefined;
    const a = { type: down ? (text ? 'keyDown' : 'rawKeyDown') : 'keyUp', key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode | 0, nativeVirtualKeyCode: m.keyCode | 0, modifiers: mods, location: m.location | 0, autoRepeat: !!m.repeat };
    if (text) { a.text = text; a.unmodifiedText = text; }
    if (down && MAC && (mods & 4) && MAC_COMMANDS[String(m.key).toLowerCase()]) a.commands = [MAC_COMMANDS[String(m.key).toLowerCase()]];
    return s('Input.dispatchKeyEvent', a);
  }
}
const EDITABLE = '(() => { const a = document.activeElement; return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); })()';
const SELECTION = '(() => { const a = document.activeElement; if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.selectionEnd > a.selectionStart) return a.value.slice(a.selectionStart, a.selectionEnd); return String(getSelection()); })()';

export function handleUpgrade(req, socket, head, { key, tabId }) {
  acceptHandshake(req, socket);
  if (head?.length) socket.unshift(head);
  let open = true, tab = null;
  const v = {
    visible: false, size: null,
    send: (ev) => { if (open) try { socket.write(encodeFrame(JSON.stringify(ev))); } catch {} },
    // A phone on a slow link cannot take every frame; one stuck in the socket means the
    // next is dropped, so what it sees is late by a frame, never by a minute.
    frame: (buf) => { if (open && socket.writableLength < 512 * 1024) try { socket.write(encodeFrame(buf, 2)); } catch {} },
  };
  const ready = (async () => {
    tab = (tabId && tabs.get(tabId)) || null;
    if (!tab) tab = await newTab(key);
    tab.viewers.add(v);
    v.send({ t: 'tab', id: tab.id, fresh: tab.id !== tabId });
    v.send(stateOf(tab));
    stateSoon(tab);
    return tab;
  })();
  ready.catch((e) => { v.send({ t: 'error', text: e.message }); socket.end(); });
  const handle = async (m) => {
    touch();
    switch (m.t) {
      case 'size':
        v.size = { w: Math.max(50, Math.round(+m.w || 0)), h: Math.max(50, Math.round(+m.h || 0)), dpr: +m.dpr || 1, mobile: !!m.mobile, pw: +m.pw || 0, ph: +m.ph || 0 };
        v.visible = true; tab.viewers.delete(v); tab.viewers.add(v); // the newest size wins
        await reconfigure(tab);
        if (tab.lastFrame) v.frame(tab.lastFrame);
        break;
      case 'hide': v.visible = false; await reconfigure(tab); break;
      case 'front': tab.ctx.current = tab.id; break;
      case 'goto': try { await navigate(tab, urlOf(m.spec)); } catch (e) { v.send({ t: 'note', text: e.message }); } break;
      case 'back': await historyStep(tab, -1).catch(() => {}); break;
      case 'forward': await historyStep(tab, 1).catch(() => {}); break;
      case 'reload': await reload(tab).catch(() => {}); break;
      case 'stop': await stop(tab).catch(() => {}); break;
      case 'emu': await emulate(tab, m.preset && PRESETS[m.preset] ? { ...PRESETS[m.preset], by: 'person' } : null); break;
      case 'copy': { const r = await send(tab, 'Runtime.evaluate', { expression: SELECTION, returnByValue: true }).catch(() => null); v.send({ t: 'copied', text: r?.result?.value || '' }); break; }
      case 'mouse': case 'wheel': case 'key': case 'text':
        await input(tab, m);
        if (m.t === 'mouse' && m.type === 'mouseReleased') { const r = await send(tab, 'Runtime.evaluate', { expression: EDITABLE, returnByValue: true }).catch(() => null); v.send({ t: 'editable', on: !!r?.result?.value }); }
        break;
    }
  };
  let chain = ready, incoming = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    incoming = Buffer.concat([incoming, chunk]);
    let f;
    while ((f = decodeFrame(incoming))) {
      incoming = Buffer.from(f.rest);
      if (f.opcode === 8) { socket.end(); return; }
      if (f.opcode === 9) { socket.write(encodeFrame(f.payload, 10)); continue; }
      if (f.opcode !== 1) continue;
      let m; try { m = JSON.parse(f.payload.toString('utf8')); } catch { continue; }
      // In order: a click is a press and a release, and they must not cross.
      chain = chain.then(() => handle(m)).catch(() => {});
    }
  });
  const cleanup = () => { if (!open) return; open = false; if (tab) { tab.viewers.delete(v); if (cdp) reconfigure(tab).catch(() => {}); } };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}
