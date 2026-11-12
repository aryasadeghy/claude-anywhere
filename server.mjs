// claude-anywhere — a small self-hosted bridge between the Claude Agent SDK and a
// Claude-styled web client, so local Claude Code sessions can be listed,
// continued and started from another device. Everything runs on this machine;
// the browser only ever talks to this process.
//
// Nothing here touches ~/.claude/settings.json or the Claude Desktop app. The
// SDK reads the same session transcripts Claude Code writes.
//
// By default it listens on localhost only. To reach it from a phone, expose it
// through Tailscale (`tailscale serve 7777`) or set HOST=0.0.0.0 in .env for
// your own LAN. It is protected by the shared password in .env.

import express from 'express';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
const SERVER_STARTED_AT = Date.now();
import { promisify } from 'node:util';
import { listSessions, getSessionMessages, getSessionInfo, renameSession, forkSession, deleteSession, tagSession } from '@anthropic-ai/claude-agent-sdk';
import { runs, pendingPermissions, isLive, isBusy, startRun, answerPermission, bus, contextBySession, lastLimits, ensureLive } from './lib/runs.mjs';
import { historyPage, historyImage, searchSession } from './lib/history.mjs';
import { readConvSettings, writeConvSettings } from './lib/conv-settings.mjs';
import * as runsMod from './lib/runs.mjs';
import * as limitQueue from './lib/limit-queue.mjs';
import * as rewindStore from './lib/rewind.mjs';
const execFileP = promisify(execFile);
import { tailSession, isWorkingElsewhere, WORKING_WINDOW_MS, sessionFile } from './lib/tail.mjs';
import { transcriptMentions } from './lib/mentioned.mjs';
import { cliProcessFor } from './lib/cli-sessions.mjs';
import { parsePreviewUrl, portFromReferer, proxyRequest, proxyUpgrade, listLocalPorts, proxyAtRoot, upgradeAtRoot, listenOn, injectBridge } from './lib/preview.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { searchTranscripts } from './lib/search.mjs';
import * as worktrees from './lib/worktrees.mjs';
import * as pr from './lib/pr.mjs';
import * as gitActions from './lib/git-actions.mjs';
import * as autofix from './lib/autofix.mjs';
import * as awake from './lib/awake.mjs';
import * as routines from './lib/routines.mjs';
import * as update from './lib/update.mjs';
import * as models from './lib/models.mjs';
import * as commandsMod from './lib/commands.mjs';
import * as filesearch from './lib/filesearch.mjs';
import * as shell from './lib/shell.mjs';
import * as claudeCode from './lib/claude-code.mjs';
import * as access from './lib/access.mjs';
import * as terminal from './lib/terminal.mjs';
import { getAuth, activeAccount, setActive, setToken, clearToken, setProvider, clearProvider, classifyToken, envFor, localSource, verifyEnv, candidateEnv, candidateProviderEnv } from './lib/auth.mjs';
import { findByName, searchContents, officePreview, writeFileChecked } from './lib/files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// This was called claude-remote until 0.3.0. An installed app, a saved .env or a
// running shell can still be passing the old names, so accept both everywhere.
const envOf = (name) => process.env['CLAUDE_ANYWHERE_' + name] || process.env['CLAUDE_REMOTE_' + name] || '';

// ---------- config (.env is optional; real env vars win) ----------
function loadDotEnv() {
  const p = envOf('ENV_FILE') || path.join(here, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || '127.0.0.1';
// An app password is optional (REMOTE_PASSWORD in .env, or set in the app). Without
// one, anybody who can reach the port can use Claude on this PC, so keep the server on
// localhost, Tailscale, or a network you trust. lib/access.mjs keeps the password, the
// per-device tokens and the sign-in limits.
const USER_NAME = process.env.USER_NAME || 'there';
const knownToken = (t) => access.knownToken(t);
const bearer = (req) => String(req.get('authorization') || '').replace(/^Bearer /, '');

// ---------- http ----------
const app = express();
app.disable('x-powered-by');
// The server ran out of memory and died at 4 GB, taking every running turn with it, and its log
// said nothing about what it had been doing. It keeps its last requests now, and says them - with
// how much memory it holds - once it holds more than it should.
const recent = [];
app.use((req, res, next) => { const t0 = Date.now(); res.on('finish', () => { recent.push(`${new Date(t0).toISOString().slice(11, 19)} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms`); if (recent.length > 30) recent.shift(); }); next(); });
let memSaidAt = 0;
setInterval(() => {
  const m = process.memoryUsage();
  if (m.rss < 1.5 * 1024 ** 3 || Date.now() - memSaidAt < 10 * 60 * 1000) return;
  memSaidAt = Date.now();
  console.warn(`[claude-anywhere] holding ${Math.round(m.rss / 1048576)} MB (heap ${Math.round(m.heapUsed / 1048576)} MB, buffers ${Math.round(m.arrayBuffers / 1048576)} MB); the last requests:\n  ${recent.join('\n  ')}`);
}, 30000).unref();
// Remote access off (the default, and always without a password): only this computer may use it. Everything else -
// another device on the network, a tunnel, a proxy - is turned away with the reason,
// before the page or any API answers. Setting a password opens it again.
const CLOSED = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote access is off</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#1a1a1a;color:#eee}main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#bbb;margin:0}</style></head><body><main><h1>Remote access is off</h1><p>Only the computer itself can use it. Turn remote access on there, in Settings → Remote access, to use it from here.</p></main></body></html>`;
app.use((req, res, next) => {
  if (access.remoteAllowed() || access.isLocal(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Remote access is off on that computer. Turn it on there, in Settings → Remote access.', remoteClosed: true });
  res.status(403).type('html').send(CLOSED);
});
// 20 images at the client's own resize ceiling (1600px, jpeg .85) is a few MB of base64;
// 60mb was sized for the old 10-image cap and left no room once the limit doubled.
app.use(express.json({ limit: '100mb' })); // attachments travel as base64

// Attachments: images are sent to Claude as image blocks; any other file is saved on
// this PC and referenced from the prompt by path, the way Remote Control does it.
const UPLOAD_DIR = path.join(os.tmpdir(), 'claude-anywhere-uploads');
function parseAttachments(body) {
  const images = (Array.isArray(body?.attachments) ? body.attachments : [])
    .filter((a) => a && typeof a.data === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(a.media_type || ''))
    .slice(0, 20) // Desktop's own ceiling ("Attach up to 20 images in a single message for local sessions")
    .map((a) => ({ media_type: a.media_type, data: a.data }));
  const paths = [];
  for (const f of (Array.isArray(body?.files) ? body.files : []).slice(0, 20)) {
    if (!f || typeof f.data !== 'string') continue;
    const safe = String(f.name || 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const p = path.join(UPLOAD_DIR, `${Date.now().toString(36)}-${safe}`);
    fs.writeFileSync(p, Buffer.from(f.data, 'base64'));
    paths.push(p);
  }
  let text = String(body?.text || '').trim();
  if (paths.length) text += (text ? '\n\n' : '') + 'Attached file' + (paths.length > 1 ? 's' : '') + ':\n' + paths.map((p) => '- ' + p).join('\n');
  return { text, images };
}

// ---------- preview: the project's own dev server, shown inside the app ----------
// The frame cannot send an Authorization header, and neither can the requests the
// previewed page makes, so the panel asks for a cookie first and everything under
// /preview rides on that. Localhost only, by construction: the port is all the
// proxy takes, and the host is always 127.0.0.1.
const PREVIEW_COOKIE = 'ca_preview';
const cookieOf = (req, name) => (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='))?.slice(name.length + 1);
// The key the frames ride on is not the sign-in token. A cookie goes to every port on the
// host - the dev server's own included - and the pages behind it are other people's code
// (a dependency of a dependency); with the token they could drive Claude. A key only opens
// previews, and each signed-in device keeps one for a day.
const previewKeys = new Map(); // key -> { exp, owner }
function previewKeyFor(owner) {
  const now = Date.now();
  for (const [k, v] of previewKeys) if (v.exp < now) previewKeys.delete(k);
  for (const [k, v] of previewKeys) if (v.owner === owner && v.exp - now > 3600e3) return k;
  const k = randomBytes(24).toString('base64url');
  previewKeys.set(k, { exp: now + 86400e3, owner });
  return k;
}
const validPreviewKey = (k) => { const v = k && previewKeys.get(k); return !!v && v.exp > Date.now(); };
const previewAllowed = (req) => validPreviewKey(cookieOf(req, PREVIEW_COOKIE)) || knownToken(String(req.query?.token || ''));
const previewCookie = (k) => `${PREVIEW_COOKIE}=${k}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
app.use((req, res, next) => {
  const hit = parsePreviewUrl(req.path);
  if (hit) {
    if (!previewAllowed(req)) return res.status(401).send('Open the preview from the app first.');
    const qs = req.originalUrl.includes('?') ? '?' + req.originalUrl.split('?').slice(1).join('?') : '';
    return proxyRequest(req, res, hit.port, hit.rest + qs);
  }
  // A previewed page asking for an absolute path (/assets/app.js) lands here; its
  // referer says which dev server meant to answer it. This has to include /api/ as
  // well: a previewed app whose own API lives there — Mailpit's /api/v1, and most
  // things with a backend — was being answered by ours, which said 401 and left the
  // panel blank. Our own client never sends a preview referer, so the two cannot
  // be confused.
  const fromPreview = portFromReferer(req.headers.referer || '');
  if (fromPreview && previewAllowed(req)) return proxyRequest(req, res, fromPreview, req.originalUrl);
  next();
});

app.use('/vendor/marked.js', express.static(path.join(here, 'node_modules/marked/lib/marked.umd.js')));
app.use('/vendor/purify.js', express.static(path.join(here, 'node_modules/dompurify/dist/purify.min.js')));
// The terminal pane's xterm.js, loaded only once a tab is actually opened (dynamic import),
// so every other page load is none the heavier for it.
app.use('/vendor/xterm/', express.static(path.join(here, 'node_modules/@xterm/xterm/lib')));
app.use('/vendor/xterm/', express.static(path.join(here, 'node_modules/@xterm/xterm/css')));
app.use('/vendor/xterm-fit/', express.static(path.join(here, 'node_modules/@xterm/addon-fit/lib')));
// The whole dist, not one file: katex.min.css pulls its fonts from a `fonts/` next to it.
app.use('/vendor/katex', express.static(path.join(here, 'node_modules/katex/dist')));
// The app's own WebView caches hard: without this it keeps serving the page it
// first loaded, so "Restart server" and a rebuild would look like nothing happened.
// `no-cache` still allows 304s - it only forces a revalidation.
app.use(express.static(path.join(here, 'public'), { extensions: ['html'], setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.get('/api/config', (_req, res) => res.json({ passwordRequired: access.passwordRequired(), userName: USER_NAME }));

// Sign in. With no app password configured this simply hands out the open token; with
// one, each sign-in gets a token of its own, and wrong guesses are slowed down.
// "Chrome on Mac", from the user agent: enough to tell one's own devices apart in the list.
function deviceName(req) {
  const given = String(req.body?.device || '').trim(); if (given) return given;
  const ua = String(req.get('user-agent') || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl\//.test(ua) ? 'curl' : 'Browser';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? browser + ' on ' + os : browser;
}
const waitWords = (s) => (s >= 90 ? Math.ceil(s / 60) + ' minutes' : s + ' seconds');
app.post('/api/login', (req, res) => {
  const ip = access.clientIp(req);
  const wait = access.locked(ip);
  if (wait) return res.status(429).json({ error: 'Too many wrong passwords. Try again in ' + waitWords(wait) + '.' });
  if (!access.checkPassword(typeof req.body?.password === 'string' ? req.body.password : '')) { access.failed(ip); return res.status(401).json({ error: 'Wrong password' }); }
  access.succeeded(ip);
  res.json({ token: access.issue({ name: deviceName(req), ip }), userName: USER_NAME });
});

app.use('/api', (req, res, next) => {
  const auth = req.get('authorization') || '';
  // EventSource cannot send headers, so the live-events stream may carry the token in the query string.
  const viaQuery = req.method === 'GET' && (/^\/sessions\/[0-9a-f-]+\/(events|image\/[0-9a-f-]+\/\d+)$/i.test(req.path) || req.path === '/notify' || req.path === '/file') && knownToken(String(req.query.token || ''));
  if (!knownToken(auth.replace(/^Bearer /, '')) && !viaQuery) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Signed in, so the cookie the frames ride on can be handed out. Lax, not None: another
// port of this host is still the same site, and the cookie never goes to anyone else's.
app.get('/api/preview/grant', async (req, res) => {
  const key = previewKeyFor(bearer(req));
  res.setHeader('Set-Cookie', previewCookie(key));
  let files = 0;
  try { files = await filesOrigin(); } catch {}
  res.json({ ok: true, key, files });
});
app.get('/api/preview/ports', async (_req, res) => res.json({ ports: (await listLocalPorts({ self: PORT })).filter((p) => !ownPorts.has(p.port)) }));
// The origin a dev server is shown on: its own port plus 10000, when that is free.
app.get('/api/preview/origin', async (req, res) => {
  const port = Number(req.query.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || ownPorts.has(port)) return res.status(400).json({ error: 'That is not a port the Browser can show.' });
  try { res.json({ port: await devOrigin(port) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- the Browser's own origins ----------
// A port of our own for each dev server shown, and one for the project's files: see
// lib/preview.mjs for why a preview needs an origin of its own. The app's gate applies -
// remote access off means this computer only - and then the preview key.
const ownPorts = new Set([PORT]);
const originOf = new Map(); // 'dev:5173' | 'files' -> Promise<port>
const RESERVED = '/__claude-anywhere/';
function originGate(req, res) {
  if (!access.remoteAllowed() && !access.isLocal(req)) { res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' }); res.end(CLOSED); return false; }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === RESERVED + 'ping') {
    // How the pane finds out this origin can be reached from where it is, cookie and all.
    const from = req.headers.origin;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(from ? { 'access-control-allow-origin': from, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {}) });
    res.end(JSON.stringify({ ok: true, key: previewAllowed(req) }));
    return false;
  }
  if (url.pathname === RESERVED + 'enter') {
    // "Open in browser": a browser the app never handed the cookie to is given it here.
    const key = url.searchParams.get('key') || '', to = url.searchParams.get('to') || '/';
    if (!validPreviewKey(key) || !to.startsWith('/') || to.startsWith('//')) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('This link has expired. Open it again from the app.'); return false; }
    res.writeHead(302, { 'set-cookie': previewCookie(key), location: to });
    res.end();
    return false;
  }
  if (!previewAllowed(req)) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Open this from the app first.'); return false; }
  return true;
}
function origin(name, wants, onRequest, onUpgrade) {
  if (!originOf.has(name)) {
    originOf.set(name, listenOn(HOST, wants.filter((p) => p > 0 && p < 65536 && !ownPorts.has(p)), onRequest, onUpgrade)
      .then(({ port }) => { ownPorts.add(port); return port; })
      .catch((e) => { originOf.delete(name); throw e; }));
  }
  return originOf.get(name);
}
const devOrigin = (port) => origin('dev:' + port, [port + 10000, port + 20000],
  (req, res) => { if (originGate(req, res)) proxyAtRoot(req, res, port, PREVIEW_COOKIE); },
  (req, socket, head) => {
    if ((!access.remoteAllowed() && !access.isLocal(req)) || !previewAllowed(req)) return socket.destroy();
    upgradeAtRoot(req, socket, head, port, PREVIEW_COOKIE);
  });
const filesApp = express();
filesApp.disable('x-powered-by');
filesApp.use((req, res) => { if (originGate(req, res)) serveProjectFile(req, res, req.path, false); });
const filesOrigin = () => origin('files', [PORT + 10000], filesApp);

// A project's file at a path that keeps its folder - /C:/Users/me/site/index.html - so the
// page's own relative links, its CSS, scripts and pictures, resolve beside it. Only under a
// folder some session has worked in, like every other file the app shows.
async function serveProjectFile(req, res, urlPath, sandboxed) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return res.status(400).type('text').send('Not a file path.'); }
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  if (!path.isAbsolute(p)) return res.status(400).type('text').send('Not a file path.');
  p = path.normalize(p);
  if (!(await insideProjectRoots(p))) return res.status(403).type('text').send('That file is outside the project folders.');
  let st;
  try { st = fs.statSync(p); } catch { return res.status(404).type('text').send('There is no such file on this computer.'); }
  if (st.isDirectory()) {
    if (!urlPath.endsWith('/')) return res.redirect(302, req.originalUrl.split('?')[0] + '/');
    p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) return res.status(404).type('text').send('This folder has no index.html.');
  }
  // Served from the app's own origin (the fallback), a page gets no origin of its own at
  // all, so it cannot read the app's storage; it can still run, which is the point of it.
  const sandbox = sandboxed ? { 'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads' } : {};
  if (/\.html?$/i.test(p) && fs.statSync(p).size <= 16 * 1024 * 1024) {
    return res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...sandbox }).send(injectBridge(fs.readFileSync(p, 'utf8')));
  }
  res.sendFile(p, { dotfiles: 'allow', acceptRanges: true, headers: { 'Cache-Control': 'no-cache', ...(/\.(html?|svg)$/i.test(p) ? sandbox : {}) } });
}
// The same files for a page that cannot reach another port - the app behind `tailscale
// serve` is one https origin - with the key in the path, where relative links keep it.
app.use('/files/', (req, res) => {
  const m = /^\/([A-Za-z0-9_-]{20,})(\/.*)$/.exec(req.path);
  if (!m || !validPreviewKey(m[1])) return res.status(401).type('text').send('This link has expired. Open it again from the app.');
  serveProjectFile(req, res, m[2], true);
});

// ---------- small preferences file: pinned sessions (shared by every device) ----------
const DATA_DIR = envOf('DATA_DIR') || path.join(here, 'data');
access.init(DATA_DIR, process.env.REMOTE_PASSWORD);
const PREFS_PATH = path.join(DATA_DIR, 'prefs.json');
function readPrefs() {
  try { return { pinned: [], ...JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')) }; } catch { return { pinned: [] }; }
}
function writePrefs(p) {
  fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
  fs.writeFileSync(PREFS_PATH, JSON.stringify(p, null, 2));
}

// Who a given account ('local' = this computer's `claude login`, 'token' = the pasted
// token) is, as reported by the CLI itself. Nothing secret leaves this function.
const whoCache = new Map(); // which -> { at, value }
function whoAmI(which = activeAccount()) {
  const hit = whoCache.get(which);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  // A provider is an address, not a login: `claude auth status` has nobody to ask about
  // it, and asking anyway would report whatever this computer happens to be signed into.
  if (which === 'provider') {
    const p = getAuth().provider;
    return p
      ? { which, email: '', name: p.name, org: '', plan: '', auth: 'provider', loggedIn: true, source: p.name + ' · ' + p.baseUrl, model: p.model || '', baseUrl: p.baseUrl, keyKind: p.keyKind }
      : { which, email: '', plan: '', auth: 'provider', loggedIn: false, source: 'no provider added' };
  }
  const cli = envOf('CLI') || 'claude';
  try {
    const raw = execFileSync(cli, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 15000, windowsHide: true, env: envFor(which) });
    const j = JSON.parse(raw);
    const a = getAuth();
    const value = {
      which,
      email: j.email || '', name: '', org: j.orgName || '', plan: j.subscriptionType || '',
      auth: j.authMethod || (j.loggedIn ? 'unknown' : 'none'), loggedIn: !!j.loggedIn,
      source: which === 'token' ? 'token entered in the app' : localSource(), tokenKind: which === 'token' ? a.tokenKind : '',
      projectsDir: j.projectsDirectory || '',
    };
    whoCache.set(which, { at: Date.now(), value });
    return value;
  } catch {}
  return which === 'local' ? whoAmIFromFiles() : { which, email: '', plan: '', auth: 'oauth_token', loggedIn: true, source: 'token entered in the app', tokenKind: getAuth().tokenKind };
}
function whoAmIFromFiles() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const out = { which: 'local', email: '', name: '', org: '', plan: '', source: localSource(), tokenKind: '' };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    const a = j.oauthAccount || {};
    out.email = a.emailAddress || ''; out.name = a.displayName || a.fullName || ''; out.org = a.organizationName || '';
    out.plan = a.organizationType ? a.organizationType.replace(/^claude_/, '') : '';
  } catch {}
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'));
    if (c.claudeAiOauth?.subscriptionType) out.plan = c.claudeAiOauth.subscriptionType;
    out.auth = c.claudeAiOauth ? 'claude.ai' : 'api-key';
  } catch { out.auth = process.env.ANTHROPIC_API_KEY ? 'api-key' : 'unknown'; }
  return out;
}

// What a session's sidebar dot says: waiting for you, failed, or finished while you were
// elsewhere. Unread survives a restart; the other two are about the live process.
const ATTN_PATH = path.join(DATA_DIR, 'attention.json');
let attention = {};
try { attention = JSON.parse(fs.readFileSync(ATTN_PATH, 'utf8')) || {}; } catch {}
const saveAttention = () => { try { fs.writeFileSync(ATTN_PATH, JSON.stringify(attention)); } catch {} };
const attn = (id) => attention[id] || (attention[id] = {});
bus.on('permission', ({ sessionId }) => { if (sessionId) { attn(sessionId).needsInput = true; saveAttention(); } });
bus.on('permission_resolved', ({ sessionId }) => { if (sessionId && attention[sessionId]) { delete attention[sessionId].needsInput; saveAttention(); } });
bus.on('turn_done', ({ sessionId, isError }) => { if (!sessionId) return; const a = attn(sessionId); a.unread = true; a.failed = !!isError; delete a.needsInput; a.at = Date.now(); saveAttention(); });
const isWaiting = (id) => [...pendingPermissions.values()].some((p) => p.run.sessionId === id);

// Where "No folder" chats keep what they make: ~/.claude-anywhere/chats/<session id>/.
const CHATS_DIR = path.resolve(envOf('CHATS_DIR') || path.join(os.homedir(), '.claude-anywhere', 'chats'));
const isChat = (cwd) => !!cwd && path.dirname(path.resolve(cwd)).toLowerCase() === CHATS_DIR.toLowerCase();
const shape = (s, pinned) => ({
  id: s.sessionId,
  needsInput: isWaiting(s.sessionId) || (isLive(s.sessionId) && !!attention[s.sessionId]?.needsInput),
  failed: !!attention[s.sessionId]?.failed,
  unread: !!attention[s.sessionId]?.unread,
  title: s.customTitle || s.summary || s.firstPrompt || 'Untitled',
  cwd: s.cwd || '',
  // A chat's folder is named by its id, which is no name to show: they are "Chats", together.
  project: isChat(s.cwd) ? 'Chats' : s.cwd ? path.basename(s.cwd) : '',
  chat: isChat(s.cwd),
  branch: s.gitBranch || '',
  lastModified: s.lastModified,
  createdAt: s.createdAt,
  live: isLive(s.sessionId),
  runStartedAt: isLive(s.sessionId) ? runs.get(s.sessionId).startedAt : null,
  // A process can rest between turns, ready for the next message: live, but not working.
  busy: isBusy(s.sessionId),
  turnStartedAt: isLive(s.sessionId) && runs.get(s.sessionId).inTurn ? runs.get(s.sessionId).turnStartedAt : null,
  // A Claude Code at work on it anywhere - Desktop, VS Code, a terminal - says so itself (lib/cli-sessions.mjs).
  working: isBusy(s.sessionId) || cliProcessFor(s.sessionId)?.status === 'busy' || Date.now() - s.lastModified < WORKING_WINDOW_MS,
  pinned: !!pinned?.has(s.sessionId),
  tag: s.tag || '',
  archived: s.tag === 'archived',
  routine: routines.nameForSession(s.sessionId) || null, // "started by this scheduled task", for the sidebar
  context: contextBySession.get(s.sessionId) || null,
  // Set by Claude's own SetSessionStatus tool (lib/tools-conversation.mjs), shown as a sidebar badge.
  status: readConvSettings().status[s.sessionId] || null,
});

// ---------- composer: "/" commands, "@" file mentions, "!" shell commands ----------
// The "/" menu's Claude Code half: a live run answers for itself (its own process already
// knows, and commands_changed keeps it current); a resting session or the folder chosen for a
// new one goes through lib/commands.mjs's per-folder cache instead.
app.get('/api/commands', async (req, res) => {
  const run = runs.get(String(req.query.sessionId || ''));
  if (run && !run.done && run.query) {
    try { return res.json({ commands: await run.query.supportedCommands(), from: 'live' }); } catch {}
  }
  const cwd = String(req.query.cwd || '');
  if (!cwd) return res.json({ commands: [], from: 'none' });
  try { res.json({ commands: await commandsMod.forFolder(cwd), from: 'cache' }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// "@"'s file picker: fuzzy-ranked, and only ever inside a folder a session has actually worked in.
app.get('/api/files/search', async (req, res) => {
  try {
    const cwd = String(req.query.cwd || '');
    if (!cwd || !fs.existsSync(cwd)) return res.json({ files: [] });
    if (!(await insideProjectRoots(cwd))) return res.status(403).json({ error: 'Outside the project folders' });
    res.json({ files: await filesearch.search(cwd, String(req.query.q || '')) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// "!": a shell command in the session's folder. One at a time per session; the output streams
// back as newline-delimited JSON (see lib/shell.mjs for why not an EventSource).
app.post('/api/sessions/:id/shell', async (req, res) => {
  try {
    const cwd = await sessionCwd(req.params.id);
    if (!cwd || !fs.existsSync(cwd)) return res.status(400).json({ error: 'No folder for this session.' });
    const command = String(req.body?.command || '').trim();
    if (!command) return res.status(400).json({ error: 'Nothing to run.' });
    res.json(shell.start(req.params.id, cwd, command));
  } catch (e) { res.status(e.status || 500).json({ error: String(e.message || e) }); }
});
app.get('/api/sessions/:id/shell/:runId/stream', (req, res) => {
  const r = shell.get(req.params.runId);
  if (!r || r.sessionId !== req.params.id) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(JSON.stringify({ t: 'start', command: r.command, buffered: r.buffer }) + '\n');
  if (r.done) { res.write(JSON.stringify({ t: 'done', exitCode: r.exitCode }) + '\n'); return res.end(); }
  r.listeners.add(res);
  req.on('close', () => r.listeners.delete(res));
});
app.post('/api/sessions/:id/shell/:runId/kill', (req, res) => {
  const r = shell.get(req.params.runId);
  if (!r || r.sessionId !== req.params.id) return res.status(404).json({ error: 'No such run.' });
  res.json({ ok: shell.kill(req.params.runId) });
});

// ---------- session menu: rename, fork, archive, delete (the Desktop ⋮ menu) ----------
app.post('/api/sessions/:id/rename', async (req, res, next) => {
  try { const title = String(req.body?.title || '').trim().slice(0, 200); if (!title) return res.status(400).json({ error: 'Empty title' }); await renameSession(req.params.id, title); res.json({ ok: true, title }); } catch (e) { next(e); }
});
app.post('/api/sessions/:id/fork', async (req, res, next) => {
  try { const r = await forkSession(req.params.id, req.body?.title ? { title: String(req.body.title).slice(0, 200) } : {}); res.json({ sessionId: r.sessionId }); } catch (e) { next(e); }
});
app.post('/api/sessions/:id/archive', async (req, res, next) => {
  try {
    const archived = !!req.body?.archived;
    await tagSession(req.params.id, archived ? 'archived' : null);
    // "A session's worktree is kept until the session is archived" - then removed, but only one
    // this app made for it (forSession), never a manual one from the Worktrees… menu, and never
    // while a turn is still using it.
    if (archived) {
      const cwd = await sessionCwd(req.params.id);
      const known = cwd && listWorktrees().find((w) => w.forSession && worktrees.sameDir(w.path, cwd));
      if (known && !isBusy(req.params.id)) {
        try {
          await worktrees.remove(known, {});
          const p = readPrefs(); p.worktrees = listWorktrees().filter((w) => !worktrees.sameDir(w.path, known.path)); writePrefs(p);
        } catch {} // the session itself is archived either way; the worktree just outlives it this once
      }
    }
    res.json({ ok: true, archived });
  } catch (e) { next(e); }
});
// ---------- deleting a session puts it aside, it does not destroy it ----------
// Sessions are the only thing here that cannot be made again, and deleting several
// at once is one confirm away. So the transcript is moved to a trash folder and can
// be put back; a rename on the same drive is instant even for a 300 MB one. Only
// emptying the trash actually removes anything.
const TRASH_DIR = path.join(DATA_DIR, 'trash');
const TRASH_INDEX = path.join(TRASH_DIR, 'index.json');
const readTrash = () => { try { return JSON.parse(fs.readFileSync(TRASH_INDEX, 'utf8')); } catch { return {}; } };
const writeTrash = (t) => { try { fs.mkdirSync(TRASH_DIR, { recursive: true }); fs.writeFileSync(TRASH_INDEX, JSON.stringify(t, null, 2)); } catch {} };

function trashSession(id, info) {
  const from = sessionFile(id);
  if (!from) return null;
  try {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    fs.renameSync(from, path.join(TRASH_DIR, id + '.jsonl'));
  } catch { return null; } // another drive, or the file is held open: let the caller delete properly
  // Subagent transcripts live in a folder beside the file and belong with it.
  const side = from.replace(/\.jsonl$/i, '');
  let sideMoved = false;
  try { if (fs.existsSync(side)) { fs.renameSync(side, path.join(TRASH_DIR, id)); sideMoved = true; } } catch {}
  const t = readTrash();
  t[id] = { id, from, side: sideMoved, at: Date.now(), title: info?.customTitle || info?.summary || 'Untitled', cwd: info?.cwd || '', project: info?.cwd ? path.basename(info.cwd) : '' };
  writeTrash(t);
  return t[id];
}

app.delete('/api/sessions/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (isBusy(id)) return res.status(409).json({ error: 'Stop the running turn first.' });
    runs.get(id)?.close(); // a process resting between turns goes with its session
    const info = await getSessionInfo(id).catch(() => null);
    const kept = trashSession(id, info);
    if (!kept) await deleteSession(id); // nothing to move, or the move failed: do as asked
    autofix.forgetSession(id); // gone from the sidebar: stop polling GitHub for it
    res.json({ ok: true, recoverable: !!kept });
  } catch (e) { next(e); }
});

app.get('/api/trash', (_req, res) => res.json({ items: Object.values(readTrash()).sort((a, b) => b.at - a.at), dir: TRASH_DIR }));

app.post('/api/trash/:id/restore', (req, res) => {
  const t = readTrash();
  const it = t[req.params.id];
  if (!it) return res.status(404).json({ error: 'Not in the trash.' });
  try {
    if (fs.existsSync(it.from)) return res.status(409).json({ error: 'A session is already back at that path.' });
    fs.mkdirSync(path.dirname(it.from), { recursive: true });
    fs.renameSync(path.join(TRASH_DIR, it.id + '.jsonl'), it.from);
    if (it.side) { try { fs.renameSync(path.join(TRASH_DIR, it.id), it.from.replace(/\.jsonl$/i, '')); } catch {} }
    delete t[req.params.id]; writeTrash(t);
    res.json({ ok: true, id: it.id });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// For good, this time. Two routes, not one optional parameter: Express 5 refuses that.
const emptyTrash = (req, res) => {
  const t = readTrash();
  const ids = req.params.id ? [req.params.id] : Object.keys(t);
  for (const id of ids) {
    try { fs.rmSync(path.join(TRASH_DIR, id + '.jsonl'), { force: true }); } catch {}
    try { fs.rmSync(path.join(TRASH_DIR, id), { recursive: true, force: true }); } catch {}
    delete t[id];
  }
  writeTrash(t);
  res.json({ ok: true, removed: ids.length });
};
app.delete('/api/trash', emptyTrash);
app.delete('/api/trash/:id', emptyTrash);

// Lines the session wrote so far (Write / Edit / NotebookEdit inputs), what Desktop's
// "+19,770 −0" in the session bar counts. Cached by transcript size.
const lineStatsCache = new Map();
async function sessionLineStats(id) {
  let key = 0; try { const f = sessionFile(id); key = f ? fs.statSync(f).size : 0; } catch {}
  const hit = lineStatsCache.get(id); if (hit && hit.key === key) return hit.value;
  const count = (s) => (s ? String(s).split('\n').length : 0);
  let added = 0, removed = 0;
  try {
    for (const m of await getSessionMessages(id)) {
      if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) continue;
      for (const b of m.message.content) {
        if (b.type !== 'tool_use') continue;
        const i = b.input || {};
        if (b.name === 'Write') added += count(i.content);
        else if (b.name === 'Edit') { added += count(i.new_string); removed += count(i.old_string); }
        else if (b.name === 'NotebookEdit') added += count(i.new_source);
      }
    }
  } catch {}
  const value = { added, removed }; lineStatsCache.set(id, { key, value }); return value;
}

// Untracked files, counted the way Desktop counts them so both apps show the same "+N": the
// files the whole repository lists (from its root, not the session's subfolder), the first 200
// of them read - text only, up to 1 MB each - and the rest listed with nothing added. Counting
// 400 files of up to 2 MB, as this did, showed +64,172 where Desktop said +32,414.
const UNTRACKED_READ = 200, UNTRACKED_MAX = 1024 * 1024;
async function untrackedLines(cwd) {
  const git = (args) => execFileP('git', ['-C', cwd, ...args], { timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout).catch(() => null);
  const top = ((await git(['rev-parse', '--show-toplevel'])) || '').trim() || cwd;
  const files = ((await git(['ls-files', '--others', '--exclude-standard', '--full-name', ':/'])) || '').split('\n').filter(Boolean);
  let added = 0;
  for (const rel of files.slice(0, UNTRACKED_READ)) {
    try {
      const p = path.join(top, rel), st = fs.statSync(p);
      if (st.isFile() && st.size <= UNTRACKED_MAX) { const buf = fs.readFileSync(p); if (!buf.includes(0)) { const lines = buf.toString('utf8').split('\n'); if (lines[lines.length - 1] === '') lines.pop(); added += lines.length; } }
    } catch {}
  }
  return { files, added };
}

// Branch and uncommitted diff of the session's folder, for the bar above the composer.
app.get('/api/sessions/:id/git', async (req, res) => {
  try {
    const s = await getSessionInfo(req.params.id);
    if (!s?.cwd || !fs.existsSync(s.cwd)) return res.json({ git: false });
    const run = (args) => execFileP('git', ['-C', s.cwd, ...args], { timeout: 6000, windowsHide: true }).then((r) => r.stdout.trim()).catch(() => null);
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === null) return res.json({ git: false });
    const stat = (await run(['diff', '--shortstat', 'HEAD'])) || '';
    let added = Number((stat.match(/(\d+) insertion/) || [])[1] || 0), removed = Number((stat.match(/(\d+) deletion/) || [])[1] || 0);
    const files = Number((stat.match(/(\d+) files? changed/) || [])[1] || 0);
    // New files are part of the work too, counted as Desktop counts them (see untrackedLines).
    const untracked = await untrackedLines(s.cwd);
    const untrackedFiles = untracked.files;
    added += untracked.added;
    const lines = await sessionLineStats(req.params.id);
    const dirty = files + untrackedFiles.length > 0;
    res.json({ git: true, branch, added, removed, files: files + untrackedFiles.length, dirty, sessionAdded: dirty ? added : lines.added, sessionRemoved: dirty ? removed : lines.removed });
  } catch (e) { res.json({ git: false, error: String(e.message || e) }); }
});

// Changes: what is different from HEAD in the session's folder (Desktop's Changes pane).
const gitIn = (cwd, args, opts = {}) => execFileP('git', ['-C', cwd, ...args], { timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }).then((r) => r.stdout).catch(() => null);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|mp4|mov|webm|mp3|wav|ogg|zip|gz|7z|pdf|woff2?|ttf|otf|exe|dll|so|dylib|bin|pyc|class|jar)$/i;
async function sessionCwd(id) {
  const s = await getSessionInfo(id).catch(() => null);
  if (s?.cwd) return s.cwd;
  const run = runs.get(id); const init = run?.events.find((e) => e.t === 'init');
  return init?.cwd || null;
}
app.get('/api/sessions/:id/changes', async (req, res) => {
  try {
    const cwd = await sessionCwd(req.params.id);
    if (!cwd || !fs.existsSync(cwd)) return res.json({ git: false });
    const branch = (await gitIn(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
    if (branch == null) return res.json({ git: false });
    const files = new Map();
    const status = (await gitIn(cwd, ['diff', '--name-status', '-M', 'HEAD'])) || '';
    for (const line of status.split('\n')) { if (!line.trim()) continue; const [st, a, b] = line.split('\t'); const p = b || a; files.set(p, { path: p, status: st[0], from: b ? a : undefined, added: 0, removed: 0, binary: BINARY_EXT.test(p) }); }
    const numstat = (await gitIn(cwd, ['diff', '--numstat', '-M', 'HEAD'])) || '';
    for (const line of numstat.split('\n')) { if (!line.trim()) continue; const [a, d, ...rest] = line.split('\t'); let p = rest.join('\t'); const m = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/); if (m) p = m[1] + m[3] + m[4]; else if (p.includes(' => ')) p = p.split(' => ').pop(); const f = files.get(p) || files.get(rest.join('\t')); if (f) { if (a === '-') f.binary = true; else { f.added = Number(a); f.removed = Number(d); } } }
    const untracked = ((await gitIn(cwd, ['ls-files', '--others', '--exclude-standard'])) || '').split('\n').filter(Boolean);
    // Counted as the bar counts them (untrackedLines): the first 200 read, text up to 1 MB.
    untracked.slice(0, 500).forEach((p, i) => {
      const f = { path: p, status: '?', added: 0, removed: 0, binary: BINARY_EXT.test(p) };
      try { const full = path.join(cwd, p); const st = fs.statSync(full); if (!f.binary && i < UNTRACKED_READ && st.size <= UNTRACKED_MAX) { const buf = fs.readFileSync(full); if (buf.includes(0)) f.binary = true; else { const t = buf.toString('utf8'); f.added = t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0; } } } catch {}
      files.set(p, f);
    });
    const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    res.json({ git: true, branch, cwd, files: list, added: list.reduce((n, f) => n + f.added, 0), removed: list.reduce((n, f) => n + f.removed, 0) });
  } catch (e) { res.json({ git: false, error: String(e.message || e) }); }
});
app.get('/api/sessions/:id/changes/diff', async (req, res) => {
  try {
    const cwd = await sessionCwd(req.params.id);
    const rel = String(req.query.path || '');
    if (!cwd || !rel || rel.includes('..')) return res.status(400).json({ error: 'Bad path' });
    const MAX_LINES = 4000;
    if (BINARY_EXT.test(rel)) return res.json({ path: rel, binary: true, diff: '' });
    let diff = await gitIn(cwd, ['diff', '--no-color', '-M', 'HEAD', '--', rel]);
    if (!diff) {
      // untracked: show the whole file as added
      const full = path.join(cwd, rel);
      if (!fs.existsSync(full)) return res.json({ path: rel, diff: '', missing: true });
      // Only its start: an untracked crawl output or log can be gigabytes, and reading one whole (then
      // copying it line by line) took the server past 4 GB and down, with every running turn in it.
      const size = fs.statSync(full).size, CAP = 1024 * 1024;
      const buf = Buffer.alloc(Math.min(size, CAP)); const fd = fs.openSync(full, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
      if (buf.includes(0)) return res.json({ path: rel, binary: true, diff: '' });
      const lines = buf.toString('utf8').split('\n'); if (lines[lines.length - 1] === '') lines.pop();
      if (size > CAP) lines.pop(); // the last one is cut mid-line
      diff = ['--- /dev/null', '+++ b/' + rel, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => '+' + l)].join('\n');
      if (size > CAP) { const shown = diff.split('\n').slice(0, MAX_LINES).join('\n'); return res.json({ path: rel, diff: shown, truncated: true }); }
    }
    const lines = diff.split('\n'); const truncated = lines.length > MAX_LINES;
    res.json({ path: rel, diff: (truncated ? lines.slice(0, MAX_LINES) : lines).join('\n'), truncated });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Rewind: Desktop's "Rewind to this message?", with the choice of conversation, code, or both.
// The conversation side forks - a new session that is this one up to just before the chosen
// message, so it can be edited and sent again; the original session is left as it was, which is
// this app's own non-destructive stand-in for Desktop's in-place truncate-and-undo. The code side
// is genuinely destructive (Query.rewindFiles overwrites tracked files on disk), so it is
// snapshotted first - lib/rewind.mjs - which is what "Redo rewind" restores from.
app.post('/api/sessions/:id/rewind/preview', async (req, res) => {
  try {
    const uuid = String(req.body?.uuid || '');
    const info = await getSessionInfo(req.params.id).catch(() => null);
    if (!info?.cwd) return res.json({ canRewind: false, error: "This session doesn't support rewind." });
    const { run } = await ensureLive(req.params.id, info.cwd);
    res.json(await run.rewindFiles(uuid, { dryRun: true }));
  } catch (e) { res.status(500).json({ canRewind: false, error: String(e.message || e) }); }
});
app.post('/api/sessions/:id/rewind', async (req, res, next) => {
  try {
    const uuid = String(req.body?.uuid || '');
    const scope = ['conversation', 'code', 'both'].includes(req.body?.scope) ? req.body.scope : 'conversation';
    const msgs = (await getSessionMessages(req.params.id)).filter((m) => !m.parent_tool_use_id);
    const idx = msgs.findIndex((m) => m.uuid === uuid);
    if (idx < 0) return res.status(404).json({ error: 'That message is not in the transcript.' });
    const info = await getSessionInfo(req.params.id).catch(() => null);

    let filesOk = true, fileError = null, stats = null;
    if (scope !== 'conversation') {
      try {
        const { run, created } = await ensureLive(req.params.id, info?.cwd);
        // A fresh dry run right before the real one: the preview the dialog showed may be stale by
        // the time the person confirmed it.
        const preview = await run.rewindFiles(uuid, { dryRun: true });
        if (preview.canRewind) rewindStore.snapshot(req.params.id, info?.cwd, preview.filesChanged || []);
        const r = await run.rewindFiles(uuid, { dryRun: false });
        filesOk = !!r.canRewind;
        fileError = r.error || (filesOk ? null : "Couldn't restore the code from this point. Try again.");
        stats = { filesChanged: r.filesChanged || [], insertions: r.insertions || 0, deletions: r.deletions || 0 };
        if (created) run.maybeClose(); // this run only existed to make this one request
      } catch (e) { filesOk = false; fileError = String(e.message || e); }
    }
    if (scope === 'code') return filesOk ? res.json({ sessionId: null, cwd: info?.cwd || null, filesOnly: true, stats }) : res.status(500).json({ error: fileError });
    if (scope === 'both' && !filesOk) return res.status(500).json({ error: fileError }); // nothing forked yet: say so plainly, nothing to undo
    if (idx === 0) return res.json({ sessionId: null, cwd: info?.cwd || null, stats }); // nothing before it: start fresh in the same folder
    const title = ((info?.customTitle || info?.summary || info?.firstPrompt || 'Session').slice(0, 160)) + ' · rewound';
    try {
      const r = await forkSession(req.params.id, { upToMessageId: msgs[idx - 1].uuid, title });
      res.json({ sessionId: r.sessionId, cwd: info?.cwd || null, stats });
    } catch (e) {
      // The code side already moved (scope 'both'): say exactly that, Desktop's own words, rather
      // than the fork's raw error - the files are not in question, only the conversation branch.
      if (scope === 'both' && filesOk) return res.status(500).json({ error: "Restored the code, but couldn't rewind the conversation. Try rewinding again.", filesOk: true });
      throw e;
    }
  } catch (e) { next(e); }
});
app.post('/api/sessions/:id/rewind/redo', (req, res) => { res.json({ ok: rewindStore.redo(req.params.id) }); });

// Folder browser for "Open folder…" (the browser has no native folder dialog).
app.get('/api/browse', (req, res) => {
  const raw = String(req.query.path || '');
  // The folder picker wants directories only; the file browser asks for both. The Files
  // pane also wants dotfiles (Desktop shows them); the folder picker never asked for those,
  // so an existing caller's view of the world does not change underneath it.
  const withFiles = req.query.files === '1';
  const showHidden = req.query.all === '1';
  const drives = [];
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { if (fs.existsSync(L + ':\\')) drives.push(L + ':\\'); } catch {} }
  if (!drives.length) drives.push('/'); // no lettered drives: macOS or Linux, where the root is the only one
  if (!raw) return res.json({ path: '', parent: null, dirs: drives.map((d) => ({ name: d, path: d })), files: [], drives, home: os.homedir() });
  const p = path.resolve(raw);
  let entries = [];
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return res.status(400).json({ error: 'Cannot open ' + p }); }
  const hidden = (n) => (!showHidden && (n.startsWith('.') || n.startsWith('$')));
  const dirs = entries.filter((e) => e.isDirectory() && !hidden(e.name) && e.name !== 'node_modules').map((e) => ({ name: e.name, path: path.join(p, e.name) })).sort((a, b) => a.name.localeCompare(b.name));
  const files = withFiles ? entries.filter((e) => e.isFile() && !hidden(e.name)).map((e) => { let size = 0; try { size = fs.statSync(path.join(p, e.name)).size; } catch {} return { name: e.name, path: path.join(p, e.name), size }; }).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const parent = path.dirname(p) === p ? '' : path.dirname(p);
  res.json({ path: p, parent, dirs, files, drives, home: os.homedir(), isGit: fs.existsSync(path.join(p, '.git')) });
});

// Make a folder, so a new project can start in one that does not exist yet. Anything
// the person can reach in the picker they can create in: this is their own machine and
// their own file dialog. What it will not do is invent a drive or walk out of one.
app.post('/api/browse/mkdir', (req, res) => {
  try {
    const raw = String(req.body?.path || '').trim();
    const name = String(req.body?.name || '').trim();
    if (!raw) return res.status(400).json({ error: 'No path' });
    // Either a whole path to create, or a name inside the folder being looked at.
    const target = path.normalize(name ? path.join(raw, name) : raw);
    if (!path.isAbsolute(target)) return res.status(400).json({ error: 'Give the whole path, starting from the drive.' });
    if (name && (name.includes('..') || /[\\/]/.test(name))) return res.status(400).json({ error: 'A folder name cannot contain a slash.' });
    if (/[<>:"|?*]/.test(target.replace(/^[A-Za-z]:/, ''))) return res.status(400).json({ error: 'That name has characters Windows does not allow in a folder.' });
    if (path.dirname(target) === target) return res.status(400).json({ error: 'That is a drive, not a folder.' });
    if (fs.existsSync(target)) {
      if (!fs.statSync(target).isDirectory()) return res.status(409).json({ error: 'A file of that name is already there.' });
      return res.json({ path: target, existed: true });
    }
    fs.mkdirSync(target, { recursive: true });
    res.json({ path: target, existed: false });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(500).json({ error: /EPERM|EACCES/.test(msg) ? 'Windows would not let this app create a folder there.' : msg });
  }
});

// Read a text file for the file browser. Images already go through /api/file; this uses
// the same roots, so nothing outside a folder some session ran in can be read.
app.get('/api/fs/read', async (req, res) => {
  try {
    const p = path.normalize(String(req.query.path || ''));
    if (!p || !path.isAbsolute(p)) return res.status(400).json({ error: 'No path' });
    if (!(await insideProjectRoots(p))) return res.status(403).json({ error: 'Outside the project folders' });
    let st;
    try { st = fs.statSync(p); } catch { return res.status(404).json({ error: 'Not on this PC' }); }
    if (!st.isFile()) return res.status(400).json({ error: 'Not a file' });
    // mtimeMs travels with every read so the editor can refuse to overwrite a file that
    // changed on disk since it was loaded (lib/files.mjs#writeFileChecked checks it back).
    if (IMAGE_EXT.test(p)) return res.json({ path: p, size: st.size, mtimeMs: st.mtimeMs, image: true });
    const MAX = 512 * 1024;
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(Math.min(st.size, MAX));
    fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    if (buf.includes(0)) return res.json({ path: p, size: st.size, mtimeMs: st.mtimeMs, binary: true });
    res.json({ path: p, size: st.size, mtimeMs: st.mtimeMs, truncated: st.size > MAX, text: buf.toString('utf8') });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Text anywhere in a session's transcript. Newest transcripts first, under a time
// budget: `truncated` says the older ones were not reached.
app.get('/api/search', async (req, res, next) => {
  try {
    const r = searchTranscripts(String(req.query.q || ''), { budgetMs: Math.min(Number(req.query.budget) || 8000, 20000) });
    const known = new Map();
    for (const s of await listSessions({ limit: 500 })) known.set(s.sessionId, s);
    res.json({ ...r, hits: r.hits.filter((h) => known.has(h.id)).map((h) => ({ ...h, title: known.get(h.id).customTitle || known.get(h.id).summary || 'Untitled', cwd: known.get(h.id).cwd || '' })) });
  } catch (e) { next(e); }
});

// Branch of any folder (for the new-session chips).
app.get('/api/git', async (req, res) => {
  const cwd = String(req.query.cwd || '');
  if (!cwd || !fs.existsSync(cwd)) return res.json({ git: false });
  try { const r = await execFileP('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000, windowsHide: true }); res.json({ git: true, branch: r.stdout.trim() }); }
  catch { res.json({ git: false }); }
});

// ---------- conversation: chapters, session status, transcript view, find in session ----------
// A chapter's anchor is the uuid of the message it was marked on (MarkChapter's own tool_use
// block, or a message the person pinned from its menu) - the client registers one the first
// time it draws that message, live or from history, so reopening a session a page at a time
// still ends up with the same list without scanning the whole transcript up front.
app.get('/api/sessions/:id/chapters', (_req, res) => {
  const s = readConvSettings();
  res.json({ chapters: Object.values(s.chapters[_req.params.id] || {}).sort((a, b) => (a.at || 0) - (b.at || 0)) });
});
app.post('/api/sessions/:id/chapters', (req, res) => {
  const { uuid, title } = req.body || {};
  if (!uuid || !title) return res.status(400).json({ error: 'uuid and title are required' });
  const s = readConvSettings();
  (s.chapters[req.params.id] ||= {})[uuid] = { uuid, title: String(title).slice(0, 120), at: Date.now() };
  writeConvSettings(s);
  res.json({ ok: true });
});
app.delete('/api/sessions/:id/chapters/:uuid', (req, res) => {
  const s = readConvSettings();
  if (s.chapters[req.params.id]) { delete s.chapters[req.params.id][req.params.uuid]; writeConvSettings(s); }
  res.json({ ok: true });
});

// The app-wide switches: the default Transcript view for a newly opened session, and whether
// Claude's SetSessionStatus tool exists at all (lib/tools-conversation.mjs reads it per turn).
app.get('/api/conversation/settings', (_req, res) => { const { transcriptView, autoClassify } = readConvSettings(); res.json({ transcriptView, autoClassify }); });
app.post('/api/conversation/settings', (req, res) => {
  const s = readConvSettings();
  if (req.body?.transcriptView && ['normal', 'thinking', 'verbose'].includes(req.body.transcriptView)) s.transcriptView = req.body.transcriptView;
  if (req.body?.autoClassify !== undefined) s.autoClassify = !!req.body.autoClassify;
  writeConvSettings(s);
  res.json({ transcriptView: s.transcriptView, autoClassify: s.autoClassify });
});

// Text anywhere in one session's own transcript (not every session - that is /api/search):
// the find bar over an open session, reading the same file lib/history.mjs pages through.
app.get('/api/sessions/:id/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ hits: [] });
    res.json(await searchSession(req.params.id, q, { limit: Math.min(Number(req.query.limit) || 200, 500) }));
  } catch (e) { next(e); }
});

// ---------- per-session worktrees ----------
// The ones we made are recorded in prefs, so the file browser trusts a fresh worktree
// before any transcript mentions it.
const listWorktrees = () => readPrefs().worktrees || [];
app.get('/api/worktrees', async (req, res) => {
  const cwd = String(req.query.cwd || '');
  if (!cwd || !fs.existsSync(cwd)) return res.json({ git: false, worktrees: [] });
  try { res.json({ git: true, ...(await worktrees.listFor(cwd, listWorktrees())) }); }
  catch (e) {
    // "not a git repository" is the ordinary answer for a folder outside one, not a fault worth quoting.
    const why = worktrees.cliError(e);
    res.json({ git: false, worktrees: [], ...(/not a git repository/i.test(why) ? {} : { error: why }) });
  }
});
app.post('/api/worktrees', async (req, res) => {
  try {
    const cwd = String(req.body?.cwd || '');
    if (!cwd || !fs.existsSync(cwd)) return res.status(400).json({ error: 'That folder is not on this machine.' });
    const made = await worktrees.add(cwd, req.body?.branch);
    const p = readPrefs();
    p.worktrees = [...listWorktrees().filter((w) => !worktrees.sameDir(w.path, made.path)), { ...made, createdAt: Date.now() }];
    writePrefs(p);
    res.json(made);
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : worktrees.cliError(e) }); }
});
app.delete('/api/worktrees', async (req, res) => {
  try {
    const dir = String(req.body?.path || '');
    const known = listWorktrees().find((w) => worktrees.sameDir(w.path, dir));
    if (!known) return res.status(400).json({ error: 'That is not a worktree this app made.' });
    if ([...runs.values()].some((r) => r.busy() && r.cwd && worktrees.sameDir(r.cwd, dir))) return res.status(409).json({ error: 'Claude is working in that worktree. Stop the turn first.' });
    for (const r of runs.values()) if (r.cwd && worktrees.sameDir(r.cwd, dir)) r.close(); // resting there: it goes with the worktree
    await worktrees.remove(known, { force: !!req.body?.force });
    const p = readPrefs(); p.worktrees = listWorktrees().filter((w) => !worktrees.sameDir(w.path, dir)); writePrefs(p);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: worktrees.cliError(e) }); }
});
// A worktree for a brand-new session: made from the first message, before the session itself
// exists, so the client cannot just wait on one request for it - `git worktree add` on a big
// repository is minutes, and Desktop's own "step-by-step progress and a Stop button" needs
// something to poll and something to cancel while that runs. A job, not a Run: nothing here
// talks to Claude yet.
const wtJobs = new Map(); // jobId -> { step, done, error, result, controller }
app.post('/api/worktrees/begin', async (req, res) => {
  const cwd = String(req.body?.cwd || '');
  if (!cwd || !fs.existsSync(cwd)) return res.status(400).json({ error: 'That folder is not on this machine.' });
  const jobId = randomUUID();
  const controller = new AbortController();
  const job = { step: 'branch', done: false, error: null, result: null, controller };
  wtJobs.set(jobId, job);
  (async () => {
    try {
      job.step = 'worktree';
      const made = await worktrees.addForSession(cwd, String(req.body?.message || ''), { signal: controller.signal });
      job.step = 'done'; job.result = made;
      // forSession: true marks this apart from one made through the Worktrees… menu, so
      // archiving the session can remove it and nothing else mistakes it for a manual one.
      const p = readPrefs();
      p.worktrees = [...listWorktrees().filter((w) => !worktrees.sameDir(w.path, made.path)), { ...made, createdAt: Date.now(), forSession: true }];
      writePrefs(p);
    } catch (e) {
      job.error = controller.signal.aborted ? 'Cancelled.' : worktrees.cliError(e);
      if (e.root && e.dir) await worktrees.abandon(e.root, e.dir).catch(() => {});
    } finally { job.done = true; }
    setTimeout(() => wtJobs.delete(jobId), 5 * 60 * 1000); // kept a while so a slow poll still sees the result
  })();
  res.json({ jobId });
});
app.get('/api/worktrees/begin/:jobId', (req, res) => {
  const job = wtJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Gone.' });
  res.json({ step: job.step, done: job.done, error: job.error, result: job.result });
});
app.post('/api/worktrees/begin/:jobId/cancel', (req, res) => {
  const job = wtJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Gone.' });
  job.controller.abort();
  res.json({ ok: true });
});

// ---------- queued message controls, and the usage-limit queue ----------
// Desktop's row menu on a dashed (queued) bubble: Edit in composer is Remove plus the page
// putting the text back in the box itself, so only Remove, Send now and reorder need the CLI.
app.post('/api/sessions/:id/queue/:msgId/remove', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run || run.done) return res.status(404).json({ error: 'No live turn.' });
  try { res.json({ ok: await run.removeQueued(req.params.msgId) }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/sessions/:id/queue/:msgId/send-now', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run || run.done) return res.status(404).json({ error: 'No live turn.' });
  try { res.json({ ok: await run.sendNowQueued(req.params.msgId) }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/sessions/:id/queue/reorder', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run || run.done) return res.status(404).json({ error: 'No live turn.' });
  const order = Array.isArray(req.body?.order) ? req.body.order.map(String) : [];
  try { res.json({ ok: await run.reorderQueued(order) }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Messages typed after the plan's usage limit was reached: held above the composer (lib/limit-
// queue.mjs) until it resets, each still editable, cancellable, or sendable right away.
app.get('/api/sessions/:id/limit-queue', (req, res) => {
  const limited = limitQueue.currentLimit();
  res.json({ items: limitQueue.list(req.params.id), resetsAt: limited?.resetsAt || null });
});
app.post('/api/sessions/:id/limit-queue/:msgId/edit', (req, res) => {
  const row = limitQueue.edit(req.params.id, req.params.msgId, req.body?.text);
  if (!row) return res.status(404).json({ error: 'That message is gone.' });
  res.json({ ok: true, item: row });
});
app.post('/api/sessions/:id/limit-queue/:msgId/remove', (req, res) => res.json({ ok: limitQueue.remove(req.params.id, req.params.msgId) }));
app.post('/api/sessions/:id/limit-queue/:msgId/send-now', async (req, res) => {
  try { res.json({ ok: await limitQueue.release(req.params.id, req.params.msgId) }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------- the pull request for a session's branch ----------
app.get('/api/sessions/:id/pr', async (req, res) => {
  const cwd = await sessionCwd(req.params.id);
  if (!cwd || !fs.existsSync(cwd)) return res.json({ has: false });
  const data = req.query.fresh === '1' ? (pr.forget(cwd), await pr.cached(cwd)) : await pr.cached(cwd);
  res.json({ ...data, autoFix: autofix.isAutoFix(req.params.id), autoArchive: autofix.isAutoArchive(req.params.id) });
});
app.post('/api/sessions/:id/pr/auto-merge', async (req, res) => {
  try {
    const cwd = await sessionCwd(req.params.id);
    if (!cwd) return res.status(400).json({ error: 'No folder for this session.' });
    await pr.setAutoMerge(cwd, req.body?.on !== false, req.body?.method);
    pr.forget(cwd);
    res.json(await pr.cached(cwd));
  } catch (e) { res.status(500).json({ error: worktrees.cliError(e) }); }
});

// ---------- Files pane: fuzzy find, content search, write, Office previews, live refresh ----------
// Every route here takes a path inside a folder some session has worked in (insideProjectRoots),
// the same rule /api/fs/read already follows.
app.get('/api/fs/find', async (req, res) => {
  try {
    const root = path.normalize(String(req.query.root || ''));
    if (!root || !(await insideProjectRoots(root))) return res.status(403).json({ error: 'Outside the project folders' });
    res.json(findByName(root, String(req.query.q || ''), { limit: 200 }));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/fs/search', async (req, res) => {
  try {
    const root = path.normalize(String(req.query.root || ''));
    if (!root || !(await insideProjectRoots(root))) return res.status(403).json({ error: 'Outside the project folders' });
    res.json(await searchContents(root, String(req.query.q || ''), { limit: 200, budgetMs: Math.min(Number(req.query.budget) || 8000, 20000) }));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// A lightweight poll for "has this changed since I loaded it" — the editor and an open
// preview both use it, so Claude editing a file while it is open shows up without a
// websocket or a per-file fs.watch (unreliable on a network drive, and one more thing to
// clean up on every tab close).
app.get('/api/fs/stat', async (req, res) => {
  try {
    const p = path.normalize(String(req.query.path || ''));
    if (!p || !(await insideProjectRoots(p))) return res.status(403).json({ error: 'Outside the project folders' });
    let st; try { st = fs.statSync(p); } catch { return res.status(404).json({ error: 'Not on this PC' }); }
    res.json({ mtimeMs: st.mtimeMs, size: st.size });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/fs/write', async (req, res) => {
  try {
    const p = path.normalize(String(req.body?.path || ''));
    if (!p || !path.isAbsolute(p)) return res.status(400).json({ error: 'No path' });
    if (!(await insideProjectRoots(p))) return res.status(403).json({ error: 'Outside the project folders' });
    const text = String(req.body?.text ?? '');
    if (Buffer.byteLength(text, 'utf8') > 5 * 1024 * 1024) return res.status(413).json({ error: 'That file is larger than this editor saves (5 MB).' });
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not on this PC' });
    const r = writeFileChecked(p, text, req.body?.mtimeMs);
    if (!r.ok) return res.status(409).json({ error: 'The file changed on disk.', ...r });
    res.json(r);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/fs/office', async (req, res) => {
  try {
    const p = path.normalize(String(req.query.path || ''));
    if (!p || !(await insideProjectRoots(p))) return res.status(403).json({ error: 'Outside the project folders' });
    res.json(officePreview(p));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// "Open in editor": VS Code's CLI if it is on PATH (so the file opens in the window
// already there), else a vscode:// URL the page opens with its own external-link helper.
app.post('/api/fs/open-editor', async (req, res) => {
  const p = String(req.body?.path || '');
  const line = Number(req.body?.line) || null;
  if (!p) return res.status(400).json({ error: 'No path' });
  const target = line ? `${p}:${line}` : p;
  try {
    await execFileP(process.platform === 'win32' ? 'code.cmd' : 'code', ['-g', target], { timeout: 4000, windowsHide: true });
    res.json({ opened: true });
  } catch {
    res.json({ opened: false, url: 'vscode://file/' + p.replace(/\\/g, '/') + (line ? ':' + line : '') });
  }
});

// ---------- keep this computer awake ----------
const syncAwake = () => awake.sync(readPrefs().awake || 'off', liveCount() > 0);
app.get('/api/awake', (_req, res) => res.json(awake.state(readPrefs().awake || 'off')));
app.post('/api/awake', (req, res) => {
  const mode = ['off', 'working', 'always'].includes(req.body?.mode) ? req.body.mode : 'off';
  const p = readPrefs(); p.awake = mode; writePrefs(p);
  syncAwake();
  res.json(awake.state(mode));
});
// A turn ending is the moment to let go; the timer catches one starting, and anything
// that ended without saying so.
bus.on('turn_done', () => syncAwake());
setInterval(() => syncAwake(), 30000).unref();

// ---------- terminal: a shell pane like Desktop's, several tabs, streamed over a websocket ----------
// Authenticated the same way the rest of /api is (the app.use('/api', ...) gate above already
// covers everything under here); the websocket itself cannot carry that header, so it rides
// on the query string, the same compromise EventSource already uses for /sessions/:id/events.
app.get('/api/sessions/:id/terminal/tabs', (req, res) => res.json({ tabs: terminal.listTabs(req.params.id), status: terminal.status() }));
app.post('/api/sessions/:id/terminal/tabs', async (req, res) => {
  try {
    const cwd = req.body?.cwd || await sessionCwd(req.params.id) || os.homedir();
    res.json(await terminal.createTab(req.params.id, { cwd, cols: Number(req.body?.cols) || undefined, rows: Number(req.body?.rows) || undefined }));
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }); }
});
app.delete('/api/sessions/:id/terminal/tabs/:tabId', (req, res) => res.json({ ok: terminal.closeTab(req.params.id, req.params.tabId) }));
app.post('/api/sessions/:id/terminal/tabs/:tabId/restart', async (req, res) => {
  const tab = await terminal.restartTab(req.params.id, req.params.tabId);
  if (!tab) return res.status(404).json({ error: 'No such tab.' });
  res.json(tab);
});
// "Run in terminal and send output to Claude" and Claude's own run_in_terminal tool both
// end up here: one command, written to the tab and awaited to the shell's next prompt.
app.post('/api/sessions/:id/terminal/tabs/:tabId/run', async (req, res) => {
  const tab = terminal.getTab(req.params.id, req.params.tabId);
  if (!tab) return res.status(404).json({ error: 'No such tab.' });
  const command = String(req.body?.command || '');
  if (!command.trim()) return res.status(400).json({ error: 'No command.' });
  res.json(await terminal.runCommand(tab, command, { timeoutMs: Number(req.body?.timeoutMs) || undefined }));
});

// ---------- plan limits straight from the account (no turn needed) ----------
// Same endpoint the CLI uses for the usage popover; works for claude.ai logins and
// setup-token tokens, not for Console API keys.
const limitsCache = new Map(); // which -> { at, value }
function oauthTokenFor(which) {
  const a = getAuth();
  if (which === 'token') return a.hasToken && a.tokenKind === 'oauth' ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'auth.json'), 'utf8')).token?.token : null;
  try { return JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken || null; } catch { return null; }
}
async function fetchLimits(which = activeAccount()) {
  const hit = limitsCache.get(which); if (hit && Date.now() - hit.at < 60000) return hit.value;
  const tok = oauthTokenFor(which); if (!tok) return null;
  // The endpoint rate-limits bursts (429): keep the last good answer and retry later.
  const stale = hit?.value || null;
  const fail = () => { limitsCache.set(which, { at: Date.now() - 30000, value: stale }); return stale; };
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-anywhere/0.2' }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return fail();
    const u = await r.json();
    const pick = (x) => (x && x.utilization != null ? { utilization: x.utilization, resets_at: x.resets_at } : null);
    const value = {
      subscription_type: whoAmI(which)?.plan || null,
      rate_limits: { five_hour: pick(u.five_hour), seven_day: pick(u.seven_day), seven_day_opus: pick(u.seven_day_opus), seven_day_sonnet: pick(u.seven_day_sonnet), model_scoped: [] },
      at: Date.now(), which,
    };
    limitsCache.set(which, { at: Date.now(), value });
    return value;
  } catch { return fail(); }
}

// Context window of a session and the active account's plan limits (the Desktop popover).
app.get('/api/sessions/:id/usage', async (req, res) => res.json({ context: contextBySession.get(req.params.id) || null, limits: (await fetchLimits()) || runsMod.lastLimits }));
app.get('/api/limits', async (req, res) => res.json({ limits: await fetchLimits(req.query.which === 'token' ? 'token' : req.query.which === 'local' ? 'local' : activeAccount()) }));

// ---------- connectors (MCP servers) and plugins, like Desktop's panel ----------
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const normPath = (p) => path.normalize(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
function listConnectors(cwd) {
  const out = []; const disabled = new Set(readPrefs().disabledMcp || []);
  const add = (name, cfg, scope) => { if (!cfg || out.some((x) => x.name === name)) return; out.push({ name, scope, type: cfg.type || (cfg.command ? 'stdio' : cfg.url ? 'http' : 'unknown'), target: cfg.url || [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' '), enabled: !disabled.has(name) }); };
  const cj = readJson(path.join(os.homedir(), '.claude.json')) || {};
  for (const [n, c] of Object.entries(cj.mcpServers || {})) add(n, c, 'user');
  if (cwd) {
    for (const [k, v] of Object.entries(cj.projects || {})) if (normPath(k) === normPath(cwd)) for (const [n, c] of Object.entries(v.mcpServers || {})) add(n, c, 'project');
    const pj = readJson(path.join(cwd, '.mcp.json')); for (const [n, c] of Object.entries(pj?.mcpServers || pj || {})) if (c && typeof c === 'object') add(n, c, '.mcp.json');
  }
  out.push({ name: 'claude-anywhere', scope: 'built-in', type: 'in-process', target: 'SendUserFile — shows files in this chat', enabled: true, builtin: true });
  return out;
}
// Skills (Customize page): no on/off switch per skill exists in Claude Code's settings - they
// are turned on by being present, project or user-wide (options.skills, not a settings key) -
// so this list is read-only, same reasoning as the Session Info panel's skill count.
function listSkills(cwd) {
  const out = [];
  const scan = (dir, source) => {
    let names; try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const md = path.join(dir, name, 'SKILL.md');
      let text; try { text = fs.readFileSync(md, 'utf8'); } catch { continue; }
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '';
      const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
      out.push({ name: field('name') || name, source, description: field('description') || '' });
    }
  };
  if (cwd) scan(path.join(cwd, '.claude', 'skills'), 'project');
  scan(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'skills'), 'user');
  return out;
}
function listPlugins() {
  const settings = readJson(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json')) || {};
  const enabled = settings.enabledPlugins || {};
  const known = readJson(path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json')) || {};
  const out = [];
  for (const [mkt, info] of Object.entries(known)) {
    const mj = readJson(path.join(info.installLocation || '', '.claude-plugin', 'marketplace.json'));
    for (const p of mj?.plugins || []) { const id = `${p.name}@${mkt}`; out.push({ id, name: p.name, marketplace: mkt, description: p.description || '', enabled: enabled[id] === true }); }
  }
  return out;
}
// The model menu, straight from the CLI: same names, same descriptions, same effort
// levels per model as Claude Code and Claude Desktop show. Cached on disk, so the
// menu is right on the first paint and a refresh happens behind it.
claudeCode.useDir(path.join(DATA_DIR, 'claude-code')); // first: asking for the menu starts Claude Code
models.useCache(DATA_DIR);
limitQueue.init(DATA_DIR); // messages held while the plan's usage limit is reached; survives a restart
autofix.init(DATA_DIR); // per-PR auto-fix and auto-archive switches, and the watcher behind them
// Scheduled tasks: each due run is a new session, started the same way /api/sessions starts one.
routines.init(DATA_DIR, {
  onDue: async (routine) => {
    if (!fs.existsSync(routine.folder)) throw new Error('Folder no longer exists: ' + routine.folder);
    const newId = randomUUID();
    const { ready } = startRun({ newId, cwd: routine.folder, prompt: routine.prompt, model: routine.model, permissionMode: routine.permissionMode, disabledMcp: readPrefs().disabledMcp || [] });
    const sessionId = await ready;
    return { sessionId };
  },
}).catch((e) => console.error('[routines] startup catch-up failed:', e.message || e));
models.warm().catch(() => {});
// Refresh waits: a background refresh would answer with the very list it was asked to
// replace, and the menu would need a second press to show what changed.
app.get('/api/models', async (req, res) => {
  if (req.query.refresh === '1') await models.refreshNow().catch(() => {});
  res.json(models.list());
});

app.get('/api/connectors', async (req, res) => {
  const cwd = String(req.query.cwd || ''); const sessionId = String(req.query.sessionId || '');
  const connectors = listConnectors(cwd);
  const run = runs.get(sessionId);
  if (run && !run.done && run.query) { try { for (const s of await run.query.mcpServerStatus()) { const c = connectors.find((x) => x.name === s.name); if (c) { c.status = s.status; c.tools = (s.tools || []).length; c.error = s.error; } } } catch {} }
  res.json({ connectors, plugins: listPlugins(), skills: listSkills(cwd) });
});
app.post('/api/connectors/:name', async (req, res) => {
  const name = req.params.name; const enabled = !!req.body?.enabled;
  const p = readPrefs(); const set = new Set(p.disabledMcp || []);
  if (enabled) set.delete(name); else set.add(name);
  p.disabledMcp = [...set]; writePrefs(p);
  const run = runs.get(String(req.body?.sessionId || ''));
  if (run && !run.done && run.query) { try { await run.query.toggleMcpServer(name, enabled); } catch (e) { return res.json({ enabled, note: 'Applies to the next turn: ' + e.message }); } }
  res.json({ enabled });
});
// Plugins are switched in Claude Code's own settings file, exactly what `/plugin` does.
app.post('/api/plugins/:id', (req, res) => {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  const settings = readJson(file) || {};
  settings.enabledPlugins = { ...(settings.enabledPlugins || {}), [req.params.id]: !!req.body?.enabled };
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  res.json({ id: req.params.id, enabled: !!req.body?.enabled });
});

// ---------- routines ----------
// Scheduled tasks: CRUD plus Run now, each backed by lib/routines.mjs (storage, cron, the
// scheduler loop) and started the same way a session started by hand is (startRun, above).
app.get('/api/routines', (_req, res) => res.json({ routines: routines.list() }));
app.post('/api/routines', (req, res) => {
  const { name, prompt, folder, model, permissionMode, schedule } = req.body || {};
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'A routine needs a prompt.' });
  const dir = String(folder || '').trim();
  if (!dir || !fs.existsSync(dir)) return res.status(400).json({ error: 'That folder does not exist on this machine.' });
  try { res.json(routines.create({ name, prompt, folder: dir, model, permissionMode, schedule })); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.put('/api/routines/:id', (req, res) => {
  const row = routines.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'No such routine.' });
  const folder = req.body?.folder !== undefined ? String(req.body.folder).trim() : row.folder;
  if (!fs.existsSync(folder)) return res.status(400).json({ error: 'That folder does not exist on this machine.' });
  try { res.json(routines.update(req.params.id, { ...req.body, folder })); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.delete('/api/routines/:id', (req, res) => res.json({ ok: routines.remove(req.params.id) }));
app.post('/api/routines/:id/run', async (req, res) => {
  const row = await routines.runNow(req.params.id);
  if (!row) return res.status(404).json({ error: 'No such routine.' });
  res.json(row);
});
app.get('/api/routines/:id/runs', (req, res) => {
  const row = routines.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'No such routine.' });
  res.json({ runs: row.runs });
});

// Where another device can reach this computer — the answer to "what do I type on the
// Mac?", which otherwise means hunting for an IP in Windows settings. Link-local
// (169.254) addresses are dropped: nothing can route to them. A Tailscale address
// (100.64.0.0/10) comes first, because it is the one that works from anywhere.
function reachableAt() {
  const out = [];
  for (const [nic, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal || ni.address.startsWith('169.254.')) continue;
      const tailscale = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ni.address);
      // A Hyper-V or WSL switch has a perfectly ordinary private address that no other
      // device can reach; the interface name is the only thing that gives it away.
      const virtual = /vEthernet|Hyper-V|VirtualBox|VMware|Loopback|Bluetooth/i.test(nic);
      out.push({ url: `http://${ni.address}:${PORT}`, nic, kind: tailscale ? 'tailscale' : virtual ? 'virtual' : 'lan' });
    }
  }
  const rank = (k) => (k === 'tailscale' ? 0 : k === 'lan' ? 1 : 2);
  return out.sort((a, b) => rank(a.kind) - rank(b.kind));
}
app.get('/api/me', (_req, res) => res.json({ version: appVersion, userName: USER_NAME, host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'this machine', account: whoAmI(), active: activeAccount(), hasToken: getAuth().hasToken, port: PORT, listensEverywhere: HOST === '0.0.0.0' || HOST === '::', passwordRequired: access.passwordRequired(), passwordSource: access.source(), addresses: reachableAt(), credentialExpiresAt: activeAccount() === 'local' ? runsMod.credentialExpiresAt : null }));

// ---------- remote access: the password, the signed-in devices, the failed attempts ----------
app.get('/api/access', (req, res) => res.json({ source: access.source(), minLength: access.MIN_PASSWORD, listensEverywhere: HOST === '0.0.0.0' || HOST === '::', remoteOpen: access.remoteAllowed(), fromApp: access.isAppKey(bearer(req)), devices: access.devices(bearer(req)), failures: access.failures() }));
// From a browser, changing it asks for the current one: a stolen device token must not be
// enough to take the computer over. The desktop app's own window is the person at this
// computer, and is not asked. The device doing it stays signed in with a new token.
app.post('/api/access/password', (req, res) => {
  const ip = access.clientIp(req);
  const wait = access.locked(ip);
  if (wait) return res.status(429).json({ error: 'Too many wrong passwords. Try again in ' + waitWords(wait) + '.' });
  if (access.passwordRequired() && !access.isAppKey(bearer(req)) && !access.checkPassword(String(req.body?.current || ''))) { access.failed(ip); return res.status(401).json({ error: 'The current password is not right.' }); }
  try { res.json({ token: access.setPassword(String(req.body?.password || ''), { name: deviceName(req), ip, fromApp: access.isAppKey(bearer(req)) }), source: access.source() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// The switch. Turning it on needs a password to be set; turning it off from another
// device is allowed, and closes that device out with everything else.
app.post('/api/access/remote', (req, res) => { try { res.json({ remoteOpen: access.setRemote(!!req.body?.on) }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/access/devices/:id', (req, res) => res.json({ revoked: access.revoke(req.params.id), devices: access.devices(bearer(req)) }));

// ---------- accounts: this computer's login, and an optional token; switch any time ----------
app.get('/api/accounts', (_req, res) => {
  const a = getAuth();
  res.json({ active: activeAccount(), local: whoAmI('local'), token: a.hasToken ? whoAmI('token') : null, provider: a.provider ? whoAmI('provider') : null });
});
app.post('/api/accounts/active', (req, res) => {
  const asked = String(req.body?.which || 'local');
  const which = asked === 'token' || asked === 'provider' ? asked : 'local';
  if (which === 'token' && !getAuth().hasToken) return res.status(400).json({ error: 'No token has been added yet.' });
  if (which === 'provider' && !getAuth().provider) return res.status(400).json({ error: 'No provider has been added yet.' });
  models.forget(); // the menu belongs to the account that was just left
  res.json({ active: setActive(which) });
});
// Add or replace the token; it is proven with one tiny request before it is kept.
app.post('/api/accounts/token', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  const kind = classifyToken(token);
  if (!kind) return res.status(400).json({ error: 'Paste a token first.' });
  const check = await verifyEnv(candidateEnv(token, kind));
  if (!check.ok) return res.status(400).json({ error: 'Claude rejected that token: ' + check.error });
  setToken(token, kind);
  whoCache.delete('token'); models.forget();
  res.json({ active: 'token', token: whoAmI('token') });
});
app.delete('/api/accounts/token', (_req, res) => { clearToken(); whoCache.delete('token'); models.forget(); res.json({ active: 'local' }); });

// Another address for the same API. Proven before it is kept, exactly like a token: one
// tiny turn, and whatever the endpoint says back is what the screen shows - an endpoint
// that only speaks OpenAI's API answers with its own complaint, which is the honest
// answer to "can I use this here?".
app.post('/api/accounts/provider', async (req, res) => {
  const b = req.body || {};
  const baseUrl = String(b.baseUrl || '').trim();
  const key = String(b.key || '').trim();
  const name = String(b.name || '').trim() || (() => { try { return new URL(baseUrl).hostname; } catch { return 'Provider'; } })();
  if (!/^https?:\/\//i.test(baseUrl)) return res.status(400).json({ error: 'The address has to start with http:// or https://' });
  if (!key) return res.status(400).json({ error: 'Paste the key that provider gave you.' });
  const p = { name, baseUrl, key, keyKind: b.keyKind === 'apikey' ? 'apikey' : 'bearer', model: String(b.model || '').trim() };
  // Its own list first: the menu will offer nothing else, and the test turn has to ask
  // for a model the provider actually serves - Claude's haiku is not one of hy24's.
  let offered;
  try { offered = await models.fromProvider(p); } catch (e) { if (e.refused || !p.model) return res.status(400).json({ error: String(e.message || e) + (e.refused ? '.' : '. Name a model below to use this provider anyway.') }); }
  const check = await verifyEnv(candidateProviderEnv(p), p.model || offered[0].value);
  if (!check.ok) return res.status(400).json({ error: name + ' did not answer as the Anthropic API with ' + (p.model || offered[0].value) + ': ' + check.error + (p.model ? '' : ' — name the model to test with below.') });
  setProvider(p);
  whoCache.delete('provider'); models.forget();
  res.json({ active: 'provider', provider: whoAmI('provider') });
});
app.delete('/api/accounts/provider', (_req, res) => { clearProvider(); whoCache.delete('provider'); models.forget(); res.json({ active: activeAccount() }); });

// Sidebar order (projects, sessions within each project, pinned), shared by every device.
// The list never re-sorts itself: new items slot in once, then only drag-and-drop moves them.
app.get('/api/order', (_req, res) => { const p = readPrefs(); res.json(p.order || { projects: [], sessions: {}, pinned: [] }); });
app.post('/api/order', (req, res) => {
  const o = req.body || {};
  const p = readPrefs();
  p.order = { projects: Array.isArray(o.projects) ? o.projects.slice(0, 500) : [], sessions: o.sessions && typeof o.sessions === 'object' ? o.sessions : {}, pinned: Array.isArray(o.pinned) ? o.pinned.slice(0, 500) : [] };
  writePrefs(p);
  res.json(p.order);
});

// Opening a session (or finishing a turn while looking at it) clears its dot; the menu can set it back.
app.post('/api/sessions/:id/read', (req, res) => { const a = attention[req.params.id]; if (a) { delete a.unread; delete a.failed; saveAttention(); } res.json({ ok: true }); });
app.post('/api/sessions/:id/unread', (req, res) => { attn(req.params.id).unread = true; saveAttention(); res.json({ ok: true }); });

app.post('/api/sessions/:id/pin', (req, res) => {
  const p = readPrefs();
  const set = new Set(p.pinned);
  if (req.body?.pinned) set.add(req.params.id); else set.delete(req.params.id);
  p.pinned = [...set]; writePrefs(p);
  res.json({ pinned: set.has(req.params.id) });
});

app.get('/api/sessions', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;
    const pinned = new Set(readPrefs().pinned);
    const showArchived = req.query.archived === '1';
    res.json((await listSessions({ limit, offset })).filter((s) => showArchived || s.tag !== 'archived').map((s) => shape(s, pinned)));
  } catch (e) { next(e); }
});

app.get('/api/projects', async (_req, res, next) => {
  try {
    const seen = new Map();
    // Each chat's own folder is not a project to start another session in.
    for (const s of await listSessions({ limit: 500 })) { const k = s.cwd && !isChat(s.cwd) && path.normalize(s.cwd).toLowerCase(); if (k && !seen.has(k)) seen.set(k, { cwd: s.cwd, name: path.basename(s.cwd), lastModified: s.lastModified }); }
    res.json([...seen.values()].sort((a, b) => b.lastModified - a.lastModified));
  } catch (e) { next(e); }
});

// The model and mode a session is on, like Desktop: what the user last picked for it,
// else what its transcript shows (assistant lines carry the model, user lines the mode).
// Transcripts run to hundreds of MB and a working one grows every second, and reading the
// whole file on each open held the server up for most of a second every time. So it is read
// from the end, and after that only what was written since is looked at.
const settingsCache = new Map(); // id -> { size, upTo, model, mode }
function sessionSettings(id) {
  const prefs = readPrefs();
  const saved = (prefs.sessionPrefs || {})[id] || {};
  let model = '', mode = '';
  try {
    const f = sessionFile(id);
    if (f) {
      const size = fs.statSync(f).size; const hit = settingsCache.get(id);
      if (hit && hit.size === size) ({ model, mode } = hit);
      else {
        const from = hit && hit.upTo <= size ? hit.upTo : 0;
        const found = lastSettings(f, from, size);
        model = found.model || (from ? hit.model : ''); mode = found.mode || (from ? hit.mode : '');
        settingsCache.set(id, { size, upTo: found.upTo, model, mode });
      }
    }
  } catch {}
  // Ultracode and Fast mode are remembered per session too; Ultracode was saved and never read back.
  return { model: saved.model || model || '', permissionMode: saved.permissionMode || mode || '', effort: saved.effort ?? '', ultracode: !!saved.ultracode, ...(saved.fast !== undefined ? { fast: !!saved.fast } : {}) };
}
// The newest model and mode in bytes [from, to) of a transcript, a few MB at a time from the
// end, stopping once both are found - prompt lines (the mode) are rare in a long transcript,
// where tool results dominate, so that can still be far back. `upTo` is where the last whole
// line ends: a line still being written is read again next time, complete.
function lastSettings(f, from, to) {
  let model = '', mode = '', upTo = from, end = to, carry = Buffer.alloc(0);
  const fd = fs.openSync(f, 'r');
  try {
    while (end > from && !(model && mode)) {
      const start = Math.max(from, end - (4 << 20));
      const buf = Buffer.alloc(end - start); fs.readSync(fd, buf, 0, buf.length, start);
      if (end === to) { const nl = buf.lastIndexOf(10); if (nl >= 0) upTo = start + nl + 1; }
      // This slice may begin halfway through a line; that part is finished by the slice before
      // it. A line longer than a slice (a pasted picture) keeps growing until it is whole.
      const all = Buffer.concat([buf, carry]);
      end = start;
      const cut = start > from ? all.indexOf(10) : -1;
      if (start > from && cut < 0) { carry = all; continue; }
      carry = cut >= 0 ? all.subarray(0, cut) : Buffer.alloc(0);
      for (const line of all.subarray(cut + 1).toString('utf8').split('\n').reverse()) {
        if (model && mode) break;
        if (!line.includes('"permissionMode"') && !line.includes('"model"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (!model && j.type === 'assistant' && j.message?.model) model = j.message.model;
        if (!mode && j.type === 'user' && j.permissionMode) mode = j.permissionMode; // ('mode' lines are something else: "normal")
      }
    }
  } finally { fs.closeSync(fd); }
  return { model, mode, upTo };
}
// A turn that never finished (the app or the machine was restarted mid-work) leaves the
// transcript ending on a tool call with no result, or on a tool result with no answer.
function interruptedTurn(id) {
  try {
    const f = sessionFile(id); if (!f) return null;
    const st = fs.statSync(f); const size = Math.min(st.size, 512 * 1024);
    const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(size); fs.readSync(fd, buf, 0, size, st.size - size); fs.closeSync(fd);
    let last = null;
    for (const line of buf.toString('utf8').split('\n').reverse()) {
      if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.isSidechain || (j.type !== 'assistant' && j.type !== 'user')) continue;
      last = j; break;
    }
    if (!last) return null;
    const c = last.message?.content;
    if (last.type === 'assistant' && Array.isArray(c) && c.some((b) => b.type === 'tool_use')) return { kind: 'tool_call', at: last.timestamp };
    if (last.type === 'user' && Array.isArray(c) && c.some((b) => b.type === 'tool_result')) return { kind: 'tool_result', at: last.timestamp };
    return null;
  } catch { return null; }
}
// Desktop resumes a sleep-interrupted session by itself and shows the manual banner "only when
// resuming isn't safe". A dangling tool_call is exactly the unsafe case either way: it is a
// half-written tool call AND the only way a pending permission prompt (never itself written to
// the transcript) would show up here, since Claude Code does not write the tool_use until it
// asks, and does not write the tool_result until the prompt is answered. A dangling tool_result,
// by contrast, is a clean stopping point - a step finished, nothing left open - so it is safe
// once it is not too stale to trust (the person may well have fixed things by hand since).
const SAFE_RESUME_MS = 30 * 60 * 1000;
function safeToAutoResume(interrupted) {
  return !!interrupted && interrupted.kind === 'tool_result' && interrupted.at && Date.now() - Date.parse(interrupted.at) < SAFE_RESUME_MS;
}
app.get('/api/sessions/:id', async (req, res, next) => {
  try {
    let s = await getSessionInfo(req.params.id);
    // A session that started a moment ago has a live process but no transcript on disk yet.
    if (!s && isLive(req.params.id)) {
      const run = runs.get(req.params.id); const first = run.events.find((e) => e.t === 'prompt'); const init = run.events.find((e) => e.t === 'init');
      s = { sessionId: req.params.id, firstPrompt: (first?.text || '').slice(0, 120), cwd: init?.cwd || run.cwd || '', lastModified: run.startedAt, createdAt: run.startedAt };
    }
    if (!s) return res.status(404).json({ error: 'Not found' });
    const base = shape(s, new Set(readPrefs().pinned));
    // Not "stopped" while a Claude Code process still has the session: a long command in another
    // window writes nothing for minutes, and Continue would have started a second one beside it.
    const interruptedRaw = !base.live && !base.working && !cliProcessFor(req.params.id) ? interruptedTurn(req.params.id) : null;
    const interrupted = interruptedRaw && { ...interruptedRaw, safe: safeToAutoResume(interruptedRaw) };
    res.json({ ...base, settings: sessionSettings(req.params.id), interrupted });
  } catch (e) { next(e); }
});
app.post('/api/sessions/:id/prefs', (req, res) => {
  const p = readPrefs(); p.sessionPrefs = p.sessionPrefs || {};
  const cur = p.sessionPrefs[req.params.id] || {};
  for (const k of ['model', 'permissionMode', 'effort', 'ultracode', 'fast']) if (req.body?.[k] !== undefined) cur[k] = req.body[k];
  p.sessionPrefs[req.params.id] = cur; writePrefs(p);
  res.json(cur);
});

// The conversation a page at a time, newest first: `before` is the previous page's, `until` leaves
// out a turn still running here (the live stream replays it). All of it, across compactions.
app.get('/api/sessions/:id/history', async (req, res, next) => {
  try {
    const before = req.query.before != null && req.query.before !== '' ? Number(req.query.before) : Infinity;
    // Thinking/Verbose keep the thinking blocks Normal leaves out (lib/history.mjs); the
    // savings Normal relies on (never reading them off disk) only hold when nobody asked.
    const view = ['thinking', 'verbose'].includes(req.query.view) ? req.query.view : 'normal';
    const page = await historyPage(req.params.id, { before: Number.isFinite(before) ? before : Infinity, until: Number(req.query.until) || 0, thinking: view !== 'normal' });
    res.json(page || { messages: [], before: 0, more: false, midTurn: false });
  } catch (e) { next(e); }
});
// A picture from the transcript, drawn when it scrolls into view. The line never changes.
app.get('/api/sessions/:id/image/:uuid/:n', async (req, res, next) => {
  try {
    const pic = await historyImage(req.params.id, req.params.uuid, Number(req.params.n));
    if (!pic) return res.status(404).end();
    res.setHeader('Content-Type', /^image\/(png|jpeg|gif|webp)$/.test(pic.type) ? pic.type : 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.end(pic.data);
  } catch (e) { next(e); }
});

// The page before this server paged its history asks here, and draws the whole list it gets.
app.get('/api/sessions/:id/messages', async (req, res, next) => {
  try {
    const out = [];
    // `before` (ms): leave out lines written by a turn that is still running here,
    // because the live stream will replay that turn from its start.
    const before = Number(req.query.before) || 0;
    for (const m of await getSessionMessages(req.params.id)) {
      if (m.parent_tool_use_id) continue; // subagent traffic
      if (before && m.timestamp && Date.parse(m.timestamp) >= before - 1500) continue;
      const c = m.message?.content;
      const content = Array.isArray(c) ? c : [{ type: 'text', text: String(c ?? '') }];
      out.push({ role: m.type, uuid: m.uuid, timestamp: m.timestamp, content });
    }
    res.json(out);
  } catch (e) { next(e); }
});

app.post('/api/sessions/:id/send', async (req, res, next) => {
  try {
    const id = req.params.id;
    const { text: prompt, images } = parseAttachments(req.body);
    if (!prompt && !images.length) return res.status(400).json({ error: 'Empty message' });
    const cid = clientId(req.body?.cid);
    // Claude Code is running for this session - mid-turn, or resting ready for the next message:
    // hand the message over, it runs right after (Desktop behaviour), without starting it again.
    if (isLive(id)) { const qid = runs.get(id).enqueue(prompt, images, cid || undefined); if (qid) return res.json({ queued: true, id: qid, sessionId: id }); }
    const info = await getSessionInfo(id);
    if (!info) return res.status(404).json({ error: 'Session not found' });
    const { model, permissionMode, effort, ultracode, fast } = req.body || {};
    // Already known to be over a plan usage limit, with nothing live to fold it into: it waits
    // above the composer (lib/limit-queue.mjs) instead of starting a turn that only comes back
    // rejected, and goes in by itself once the limit resets.
    const limited = limitQueue.currentLimit();
    if (limited) {
      const held = limitQueue.hold(id, { id: cid, text: prompt, images, cwd: info.cwd, model, permissionMode, effort, ultracode, fast });
      return res.json({ held: true, id: held.id, sessionId: id, resetsAt: limited.resetsAt });
    }
    const { run } = startRun({ sessionId: id, cwd: info.cwd, prompt, images, model, permissionMode, effort, ultracode, fast, disabledMcp: readPrefs().disabledMcp || [], promptId: cid });
    joinRun(id, run); // other devices with this session open watch the turn as it streams
    res.json({ runId: run.id, sessionId: id, id: cid });
  } catch (e) { next(e); }
});

// Change permission mode / model / effort while Claude is working; takes effect
// for the next tool call or model request.
app.post('/api/sessions/:id/controls', async (req, res, next) => {
  try {
    const run = runs.get(req.params.id);
    if (!run || run.done) return res.json({ applied: {}, live: false });
    const { permissionMode, model, effort, ultracode, fast } = req.body || {};
    res.json({ applied: await run.setControls({ permissionMode, model, effort, ultracode, fast }), live: true });
  } catch (e) { next(e); }
});

app.post('/api/sessions', async (req, res) => {
  const { text: prompt, images } = parseAttachments(req.body);
  let cwd = String(req.body?.cwd || '').trim();
  // "No folder": a folder of the chat's own, named after its session id, in the app's chats
  // folder. Desktop runs these from the home directory, and everything Claude made there was
  // left lying in it - a page, a CSV, a script - mixed with the person's own files and with
  // no way to tell which chat it came from. The id is chosen here and handed to the SDK, so
  // the folder and the session are the same name.
  if (!prompt && !images.length) return res.status(400).json({ error: 'Empty message' });
  let newId;
  if (!cwd || cwd === '~') { newId = randomUUID(); cwd = path.join(CHATS_DIR, newId); fs.mkdirSync(cwd, { recursive: true }); }
  if (!fs.existsSync(cwd)) return res.status(400).json({ error: 'That folder does not exist on this machine.' });
  const { model, permissionMode, effort, ultracode, fast } = req.body || {};
  const { run, ready } = startRun({ newId, cwd, prompt, images, model, permissionMode, effort, ultracode, fast, disabledMcp: readPrefs().disabledMcp || [], promptId: clientId(req.body?.cid) });
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Claude Code did not start in time')), 60000));
    const sessionId = await Promise.race([ready, timeout]);
    res.json({ runId: run.id, sessionId, id: run.events[0]?.id });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/sessions/:id/stop', async (req, res) => {
  const run = runs.get(req.params.id);
  // An interrupt Claude Code never answers must not hold the button: the turn is stopped either way.
  const taken = run && !run.done ? await Promise.race([run.stop(), new Promise((r) => setTimeout(() => r([]), 3000))]) : [];
  res.json({ ok: true, unqueued: (taken || []).map((x) => ({ id: x.id, text: x.text })) });
});

// Tasks: the commands, subagents and workflows a live turn is running (Desktop's tasks panel).
const liveTasks = (id) => { const run = runs.get(id); return run && !run.done ? [...run.tasks.values()].filter((t) => !t.ambient) : []; };
app.get('/api/sessions/:id/tasks', (req, res) => res.json({ tasks: liveTasks(req.params.id) }));
app.post('/api/sessions/:id/tasks/:taskId/stop', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run || run.done) return res.status(404).json({ error: 'No live turn.' });
  try { res.json({ ok: await run.stopTask(req.params.taskId) }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/sessions/:id/tasks/:taskId/background', async (req, res) => {
  const run = runs.get(req.params.id);
  if (!run || run.done) return res.status(404).json({ error: 'No live turn.' });
  try { res.json({ ok: await run.backgroundTask(req.params.taskId) }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// What a task has printed so far: the CLI writes it under the temp dir, per project slug and session.
function taskOutputFile(sessionId, task) {
  if (task?.outputFile && fs.existsSync(task.outputFile)) return task.outputFile;
  const f = sessionFile(sessionId); if (!f) return null;
  const slug = path.basename(path.dirname(f));
  const p = path.join(os.tmpdir(), 'claude', slug, sessionId, 'tasks', task.id + '.output');
  return fs.existsSync(p) ? p : null;
}
app.get('/api/sessions/:id/tasks/:taskId/output', (req, res) => {
  const run = runs.get(req.params.id);
  const task = run?.tasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'Unknown task.' });
  const file = taskOutputFile(req.params.id, task);
  if (!file) return res.json({ text: '', size: 0, exists: false });
  const MAX = 64 * 1024;
  try {
    const st = fs.statSync(file); const start = Math.max(0, st.size - MAX);
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(st.size - start); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
    res.json({ text: buf.toString('utf8'), size: st.size, exists: true, truncated: start > 0 });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Server-sent events for one session. While a turn started here is running,
// it streams that turn (replaying what the client missed via Last-Event-ID).
// Otherwise it follows the transcript file, so work done in VS Code, a
// terminal or Claude Desktop shows up here as it happens.
// A page's own id for a message it sends: its bubble carries it, and the events saying the message
// was queued and then taken up carry it back, so the page finds that bubble instead of drawing a
// second one. Only ever an id - it goes into the page's selectors.
const clientId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);

// A page that knows `batch` gets what it missed condensed, in a few messages it draws in one pass
// each; a page loaded before this server still gets the events one by one. About a megabyte a
// message, each with its own id - screenshots make a long turn tens of MB, and a phone that drops
// the connection halfway resumes from the last piece, not the start.
function writeEvents(res, events, batch) {
  if (!batch) { for (const ev of events) res.write(`id: ${ev.i}\ndata: ${JSON.stringify(ev)}\n\n`); return; }
  let part = [], size = 0, last = -1;
  const flush = () => { if (part.length) res.write(`id: ${last}\ndata: {"t":"batch","events":[${part.join(',')}]}\n\n`); part = []; size = 0; };
  for (const ev of events) { const s = JSON.stringify(ev); part.push(s); size += s.length; last = ev.i; if (size > 1 << 20) flush(); }
  flush();
}

// Pages following a session's transcript (it was idle when they opened it). When a turn starts
// here they are moved onto the run itself: another device sees the message and the answer as
// they stream, at once, instead of a block at a time from the file, and only once it reconnects.
const followers = new Map(); // sessionId -> Set<{ res, batch, stop, run }>
function joinRun(id, run) {
  const set = followers.get(id);
  if (!set) return;
  followers.delete(id);
  for (const f of set) { f.stop?.(); f.run = run; writeEvents(f.res, f.batch ? run.backlog(-1) : run.events, f.batch); run.listeners.add(f.res); }
}

// Server-sent events for one session. While Claude Code runs here (in a turn, or resting ready for
// the next message) it streams the run; otherwise it follows the transcript file, so work done in
// VS Code, a terminal or Claude Desktop shows up here as it happens.
app.get('/api/sessions/:id/events', (req, res) => {
  const id = req.params.id;
  const run = runs.get(id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  // Back within a second after a drop (a phone changing networks), not the browser's three.
  res.write('retry: 1000\n\n');
  // A ping the page can see - an EventSource never shows comments, so a page could not tell a
  // quiet session from a dead connection. One that hears nothing for a while reconnects.
  const ping = setInterval(() => res.write('data: {"t":"ping"}\n\n'), 15000);
  if (run && !run.done) {
    const lastId = req.get('last-event-id');
    const since = Number(lastId ?? req.query.since ?? -1);
    // Opening the session, the page reads the earlier turns from the transcript: from the run it
    // needs the turn under way. Reconnecting, it needs what it missed.
    const events = lastId == null && req.query.from === 'turn' ? run.attach() : req.query.batch ? run.backlog(since) : run.events.filter((ev) => ev.i > since);
    writeEvents(res, events, !!req.query.batch);
    run.listeners.add(res);
    req.on('close', () => { clearInterval(ping); run.listeners.delete(res); });
    return;
  }
  // A turn that just finished here also touched the file; that is not "another window".
  const quietUntil = run?.finishedAt || 0;
  res.write(`data: ${JSON.stringify({ t: 'tail', working: isWorkingElsewhere(id, quietUntil) })}\n\n`);
  const f = { res, batch: !!req.query.batch, stop: null, run: null };
  f.stop = tailSession(id, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`), { quietUntil });
  (followers.get(id) || followers.set(id, new Set()).get(id)).add(f);
  req.on('close', () => { clearInterval(ping); f.stop?.(); const set = followers.get(id); set?.delete(f); if (set && !set.size) followers.delete(id); f.run?.listeners.delete(res); });
});

app.post('/api/permissions/:reqId', (req, res) => {
  const { behavior, always, updatedInput, updatedPermissions, message } = req.body || {};
  if (!answerPermission(req.params.reqId, behavior, !!always, updatedInput, undefined, updatedPermissions, message)) return res.status(404).json({ error: 'No such request (it may have expired).' });
  res.json({ ok: true });
});

// Notification stream for the desktop shell: permission requests and finished turns.
app.get('/api/notify', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (t) => (payload) => res.write(`data: ${JSON.stringify({ t, ...payload })}\n\n`);
  const onPerm = send('permission'), onDone = send('turn_done'), onResolved = send('permission_resolved');
  bus.on('permission', onPerm); bus.on('turn_done', onDone); bus.on('permission_resolved', onResolved);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); bus.off('permission', onPerm); bus.off('turn_done', onDone); bus.off('permission_resolved', onResolved); });
});

// Images that Claude's answers point at on this PC (a screenshot it saved, a generated
// share card, `![...](build/icon.png)`): served so the chat can show them, like Desktop.
// Only image files, and only inside a project folder Claude Code has worked in or the
// upload/temp folder.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|mp4|webm|mov|m4v|mp3|m4a|wav|ogg)$/i; // images, plus video/audio that answers link to
// A folder some session has worked in, or the temp folder. The file browser and the
// image route share it, so widening one never quietly widens the other.
// A page opened in the Browser asks for its CSS, scripts and pictures one by one, and each
// of those is checked here: the list of folders is kept for a few seconds, not re-read.
let rootsCache = { at: 0, roots: null };
// `fresh`: read the sessions again unless that was just done - a session in a brand-new folder is
// not in a list up to 15 seconds old, and its first pictures were refused.
async function insideProjectRoots(p, fresh = false) {
  let roots = rootsCache.roots;
  if (!roots || Date.now() - rootsCache.at > (fresh ? 2000 : 15000)) {
    roots = new Set([os.tmpdir()]);
    for (const s of await listSessions({ limit: 500 })) if (s.cwd && path.normalize(s.cwd).replace(/[\\/]+$/, '').length > 3) roots.add(path.normalize(s.cwd)); // a session run from a drive root would open the whole drive
    for (const w of listWorktrees()) roots.add(path.normalize(w.path)); // a worktree is newer than any transcript that names it
    rootsCache = { at: Date.now(), roots };
  }
  const lower = path.normalize(p).toLowerCase();
  return [...roots].some((r) => { const base = r.toLowerCase().replace(/[\\/]+$/, ''); return lower === base || lower.startsWith(base + path.sep) || lower.startsWith(base + '/'); });
}
app.get('/api/file', async (req, res) => {
  try {
    const raw = String(req.query.path || '');
    const cwd = String(req.query.cwd || '');
    let p = path.isAbsolute(raw) ? raw : (cwd ? path.resolve(cwd, raw) : '');
    if (!p) return res.status(400).json({ error: 'No path' });
    p = path.normalize(p);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return res.status(404).json({ error: 'Not on this PC' });
    // A file outside every session's folder is still this session's to show when its transcript
    // names it (lib/mentioned.mjs): a picture saved to Downloads, a file sent from the Desktop.
    const sid = /^[0-9a-f-]{36}$/i.test(String(req.query.sid || '')) ? String(req.query.sid) : '';
    const allowed = (await insideProjectRoots(p)) || (await insideProjectRoots(p, true)) || (sid && sessionFile(sid) && transcriptMentions(sessionFile(sid), p));
    if (!allowed) return res.status(403).json({ error: 'Outside the project folders' });
    // Pictures, video and sound play inline. Anything else - a file Claude sent, the
    // Download button in the Files panel - is handed over as a download only: served
    // inline from the app's own origin, an HTML page would run as the app. (Pages render
    // in the Browser, on an origin of their own.) Before, every other file was a 404
    // reading "Not an image on this PC", which is what a sent .html opened to.
    // dotfiles: 'allow' - express refuses any path through a hidden folder by default, and a 'No
    // folder' chat works in ~/.claude-anywhere/chats/<id>: every picture made there was a 500.
    if (IMAGE_EXT.test(p) && !req.query.download) return res.sendFile(p, { dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=60' }, acceptRanges: true });
    res.attachment(path.basename(p));
    res.sendFile(p, { dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' }, acceptRanges: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// LAN / Tailscale addresses of this PC, for the "Phone connection" dialog.
app.get('/api/addresses', (_req, res) => {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, tailscale: /tailscale/i.test(name) || a.address.startsWith('100.') });
  }
  res.json(out.sort((a, b) => Number(b.tailscale) - Number(a.tailscale)));
});

// ---------- git actions: commit, push, draft PR, ready for review, merge, auto-fix, auto-archive ----------
app.post('/api/sessions/:id/git/commit-push', async (req, res) => {
  try {
    const cwd = await sessionCwd(req.params.id);
    if (!cwd) return res.status(400).json({ error: 'No folder for this session.' });
    const r = await gitActions.commitAndPush(cwd, String(req.body?.message || '').trim());
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: gitActions.cliError(e) }); }
});
app.post('/api/sessions/:id/git/commit-wip', async (req, res) => {
  try {
    const cwd = await sessionCwd(req.params.id);
    if (!cwd) return res.status(400).json({ error: 'No folder for this session.' });
    res.json({ ok: true, ...(await gitActions.commitWip(cwd)) });
  } catch (e) { res.status(500).json({ error: gitActions.cliError(e) }); }
});
app.post('/api/sessions/:id/git/create-draft-pr', async (req, res) => {
  try {
    const cwd = await sessionCwd(req.params.id);
    if (!cwd) return res.status(400).json({ error: 'No folder for this session.' });
    const r = await gitActions.createDraftPr(cwd);
    pr.forget(cwd);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: gitActions.cliError(e) }); }
});
app.post('/api/sessions/:id/git/mark-ready', async (req, res) => {
  try {
    const cwd = await sessionCwd(req.params.id);
    if (!cwd) return res.status(400).json({ error: 'No folder for this session.' });
    await gitActions.markReady(cwd);
    pr.forget(cwd);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: gitActions.cliError(e) }); }
});
app.post('/api/sessions/:id/git/merge', async (req, res) => {
  try {
    const cwd = await sessionCwd(req.params.id);
    if (!cwd) return res.status(400).json({ error: 'No folder for this session.' });
    const method = await gitActions.mergePr(cwd);
    pr.forget(cwd);
    res.json({ ok: true, method });
  } catch (e) { res.status(500).json({ error: gitActions.cliError(e) }); }
});
// Per-PR switches in the PR menu: Auto-fix (lib/autofix.mjs's watcher wakes the session when
// GitHub reports trouble) and auto-archive (that watcher archives the session once the PR is done).
app.post('/api/sessions/:id/pr/auto-fix', (req, res) => res.json({ on: autofix.setAutoFix(req.params.id, req.body?.on !== false) }));
app.post('/api/sessions/:id/pr/auto-archive', (req, res) => res.json({ on: autofix.setAutoArchive(req.params.id, req.body?.on !== false) }));

// ---------- updating from anywhere: what is running, restart the server, rebuild the app ----------
// Runs at work. One resting between turns holds nothing up - not a restart, not leaving.
const liveCount = () => [...runs.values()].filter((r) => r.busy()).length;

// What this copy of the app is. A packaged install has no checkout to ask, so the
// shell passes its own compiled-in version and commit; running from a clone, the
// package and git are the better answer because they move with every edit.
const PKG = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')); } catch { return {}; } })();
const REPO = update.parseRepo(PKG.repository?.url || PKG.repository);
let appVersion = envOf('APP_VERSION') || PKG.version || '';
let appCommit = envOf('APP_COMMIT') || '';

function gitInfo() {
  const g = (args) => { try { return execFileSync('git', ['-C', here, ...args], { encoding: 'utf8', timeout: 4000, windowsHide: true }).trim(); } catch { return ''; } };
  return { commit: g(['rev-parse', '--short', 'HEAD']), subject: g(['log', '-1', '--format=%s']), when: g(['log', '-1', '--format=%ci']), dirty: g(['status', '--porcelain']).split('\n').filter(Boolean).length };
}
// Files newer than what is running: server/page code since the server started (needs
// Restart server), Rust sources since the app was built (needs Rebuild app).
function newerThan(files, since) {
  const out = [];
  for (const f of files) { try { if (fs.statSync(f).mtimeMs > since + 1000) out.push(path.relative(here, f).replace(/\\/g, '/')); } catch {} }
  return out;
}
// Is the running window the build in this checkout, or an installed release? Rebuild
// only means anything for the first: it compiles into src-tauri/target and starts what
// it finds there, so pressing it while an installed app is running spends three minutes
// and changes nothing you can see.
const devBuild = () => {
  const exe = envOf('APP_EXE');
  if (!exe) return false;
  try { return path.resolve(exe).toLowerCase().startsWith(path.join(here, 'src-tauri', 'target').toLowerCase()); } catch { return false; }
};
const listDir = (d, ext) => { try { return fs.readdirSync(d).filter((f) => ext.test(f)).map((f) => path.join(d, f)); } catch { return []; } };
app.get('/api/version', (_req, res) => {
  let exeAt = null; try { exeAt = fs.statSync(envOf('APP_EXE')).mtimeMs; } catch {}
  const serverFiles = [path.join(here, 'server.mjs'), path.join(here, 'package.json'), ...listDir(path.join(here, 'lib'), /\.mjs$/), ...listDir(path.join(here, 'public'), /\.(js|css|html|json)$/)];
  const shellFiles = [...listDir(path.join(here, 'src-tauri', 'src'), /\.rs$/), path.join(here, 'src-tauri', 'Cargo.toml'), path.join(here, 'src-tauri', 'tauri.conf.json')];
  const changed = newerThan(serverFiles, SERVER_STARTED_AT);
  const shellChanged = exeAt ? newerThan(shellFiles, exeAt) : [];
  const git = gitInfo();
  res.json({ ...git, commit: git.commit || appCommit.slice(0, 7), version: appVersion, repo: REPO, platform: process.platform, host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'this computer', serverDir: here, serverStartedAt: SERVER_STARTED_AT, appExe: envOf('APP_EXE') || null, appBuiltAt: exeAt, devBuild: devBuild(), liveRuns: liveCount(), inApp: !!envOf('PARENT_PID'), restartQueued, stale: changed.length > 0, changed, shellStale: shellChanged.length > 0, shellChanged, update: update.status({ repo: REPO, version: appVersion, platform: process.platform }), claudeCode: { version: claudeCode.version(), using: claudeCode.status().using } });
});

// Claude Code on this computer: Settings › General shows the version, asks npm for a newer one,
// and takes it on request - from any device, since the binary belongs to the machine that runs it.
app.get('/api/claude-code', (_req, res) => res.json(claudeCode.status()));
// Check now asks npm; opening Settings sends force: false and takes an answer up to five minutes old.
app.post('/api/claude-code/check', async (req, res) => res.json(await claudeCode.check({ force: req.body?.force !== false })));
app.post('/api/claude-code/update', (_req, res) => {
  try { res.json(claudeCode.update()); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/claude-code/bundled', (_req, res) => res.json(claudeCode.useBundled()));

// "Check again" in the App panel: the hourly cache is fine for a banner, less so for
// someone standing there having just merged a pull request.
app.post('/api/update/check', async (_req, res) => {
  res.json(await update.checkNow({ repo: REPO, version: appVersion, platform: process.platform }));
});

// Installing the new version **on this computer**, asked for from anywhere — the phone,
// or the Mac that is using this machine. The device you are holding downloads its own
// file; this is the other half, the one you cannot do by tapping Download.
const UPDATE_LOG = path.join(DATA_DIR, 'update.log');
const stampLine = (m) => '[' + new Date().toTimeString().slice(0, 8) + '] ' + m + '\n';
let installing = false;
app.post('/api/update/install', async (_req, res) => {
  if (installing) return res.status(409).json({ error: 'Already installing.' });
  const u = update.status({ repo: REPO, version: appVersion, platform: process.platform });
  if (!u?.newer) return res.status(400).json({ error: 'There is nothing newer to install on this computer.' });
  if (process.platform !== 'win32') return res.status(400).json({ error: 'Installing from here is a Windows thing for now. On this computer, open ' + (u.download?.name || 'the release') + ' yourself.' });
  const script = path.join(here, 'scripts', 'update.ps1');
  if (!fs.existsSync(script)) return res.status(400).json({ error: 'scripts/update.ps1 is missing' });
  if (!u.download?.url) return res.status(400).json({ error: 'That release has no installer for this computer.' });
  if (liveCount()) return res.status(409).json({ error: 'Claude is working. The app has to close to be replaced, so finish the turn first.' });

  installing = true;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const mb = (n) => (n >= 10485760 ? Math.round(n / 1048576) + ' MB' : (n / 1048576).toFixed(1) + ' MB');
  fs.writeFileSync(UPDATE_LOG, stampLine('downloading ' + u.download.name + ' (' + mb(u.download.size) + ')'));
  res.json({ ok: true, log: UPDATE_LOG, asset: u.download.name });

  // The download is here rather than in the script so its progress can be reported,
  // and so a half-written installer is never run.
  const target = path.join(os.tmpdir(), u.download.name);
  try {
    const r = await fetch(u.download.url, { redirect: 'follow', headers: { 'User-Agent': 'claude-anywhere' } });
    if (!r.ok) throw new Error('GitHub answered ' + r.status);
    const total = Number(r.headers.get('content-length')) || u.download.size || 0;
    let got = 0, lastSaid = 0;
    const out = fs.createWriteStream(target);
    for await (const chunk of r.body) {
      out.write(chunk);
      got += chunk.length;
      const pct = total ? Math.round((got / total) * 100) : 0;
      if (pct >= lastSaid + 10) { lastSaid = pct; fs.appendFileSync(UPDATE_LOG, stampLine(pct + '%')); }
    }
    out.end();
    await new Promise((done, fail) => { out.on('finish', done); out.on('error', fail); });
    fs.appendFileSync(UPDATE_LOG, stampLine('downloaded; closing the window to install'));
    // Same two Windows traps as the rebuild: a detached PowerShell with no console
    // exits at once, and an attached one dies with whatever started it.
    const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Installer', target, '-Exe', envOf('APP_EXE') || '', '-Log', UPDATE_LOG];
    const launcher = `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList ${args.map(q).join(',')}`;
    spawn('powershell.exe', ['-NoProfile', '-Command', launcher], { stdio: 'ignore', windowsHide: true }).unref();
  } catch (e) {
    fs.appendFileSync(UPDATE_LOG, stampLine('could not download it: ' + (e.message || e)) + stampLine('done'));
    installing = false;
  }
});
app.get('/api/update/install/log', (_req, res) => {
  let text = '', at = 0;
  try { text = fs.readFileSync(UPDATE_LOG, 'utf8'); at = fs.statSync(UPDATE_LOG).mtimeMs; } catch {}
  const done = /\]\s*done\s*$/.test(text.trim());
  res.json({ text, at, done, running: !!text.trim() && !done && Date.now() - at < 300000 });
});
// New server code (server.mjs, lib/, public/) without touching the window: the app
// restarts the server on exit code 75 and reloads the page.
// Restarting kills whatever turn is running, so when Claude is busy the request
// is remembered instead of refused: the moment the last turn ends, the server
// exits 75 and the app brings it back. Refusing was the old behaviour, and it
// left the update banner up with nothing the person could do about it.
let restartQueued = false;
const restartNow = () => setTimeout(() => process.exit(75), 300);
app.post('/api/restart', (req, res) => {
  if (!envOf('PARENT_PID')) return res.status(400).json({ error: 'Not running inside the desktop app; restart `npm start` by hand.' });
  if (liveCount() && !req.body?.force) {
    restartQueued = true;
    return res.json({ ok: true, restarting: false, queued: true, liveRuns: liveCount() });
  }
  res.json({ ok: true, restarting: true });
  restartNow();
});
bus.on('turn_done', () => { if (restartQueued) setTimeout(() => { if (!liveCount()) restartNow(); }, 1500); });
// The Rust shell changed (rare): a script closes the window, rebuilds and relaunches.
const REBUILD_LOG = path.join(DATA_DIR, 'rebuild.log');
app.post('/api/rebuild', (_req, res) => {
  // The rebuild script is PowerShell and knows how the Windows app locks its own files.
  // Elsewhere, rebuild the app the way you built it: cargo tauri build.
  if (process.platform !== 'win32') return res.status(400).json({ error: 'Rebuilding from the app is a Windows thing. Run: npx tauri build' });
  const script = path.join(here, 'scripts', 'rebuild.ps1');
  if (!fs.existsSync(script)) return res.status(400).json({ error: 'scripts/rebuild.ps1 is missing' });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const stamp = () => '[' + new Date().toTimeString().slice(0, 8) + '] ';
  try { fs.writeFileSync(REBUILD_LOG, stamp() + 'starting the rebuild script\n'); } catch {}
  // Two Windows traps in one line, both silent when you get them wrong:
  //   detached + stdio:'ignore' gives PowerShell no console and it exits at once;
  //   attached, it dies with whatever started it.
  // So: a short-lived attached PowerShell whose only job is to Start-Process the
  // real script, which then belongs to nobody and survives the window closing.
  const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Repo', here, '-Port', String(PORT), '-Token', access.getLocalKey(), '-Log', REBUILD_LOG];
  const launcher = `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList ${args.map(q).join(',')}`;
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', launcher], { stdio: 'ignore', windowsHide: true });
  child.on('error', (e) => { try { fs.appendFileSync(REBUILD_LOG, stamp() + 'could not start PowerShell: ' + e.message + '\n' + stamp() + 'done\n'); } catch {} });
  child.unref();
  res.json({ ok: true, log: REBUILD_LOG });
});
app.get('/api/rebuild/log', (_req, res) => {
  let text = '', at = 0;
  try { text = fs.readFileSync(REBUILD_LOG, 'utf8'); at = fs.statSync(REBUILD_LOG).mtimeMs; } catch {}
  const done = /\]\s*done\s*$/.test(text.trim());
  // A log that has not been written to for two minutes is not a live build either,
  // whatever it says - the script was killed, or the machine restarted under it.
  const running = !!text.trim() && !done && Date.now() - at < 120000;
  res.json({ text, at, done, running, failed: done && /build FAILED/.test(text), liveRuns: liveCount() });
});

app.get('/api/runs', (_req, res) => {
  res.json([...runs.values()].filter((r) => r.busy()).map((r) => ({ sessionId: r.sessionId, startedAt: r.startedAt, waiting: [...pendingPermissions.values()].some((p) => p.run === r) })));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: String(err?.message || err) });
});

export { HOST, PORT, bus };
export function startServer({ host = HOST, port = PORT } = {}) {
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      // Hot reload is a WebSocket, and express never sees an upgrade.
      server.on('upgrade', (req, socket, head) => {
        if ((req.url || '').split('?')[0] === '/api/terminal/ws') {
          const q = new URL(req.url, 'http://x').searchParams;
          if ((!access.remoteAllowed() && !access.isLocal(req)) || !knownToken(q.get('token') || '')) return socket.destroy();
          return terminal.handleUpgrade(req, socket, head, { sessionId: q.get('session') || '', tabId: q.get('tab') || '' });
        }
        const hit = parsePreviewUrl((req.url || '').split('?')[0]);
        if (!hit) return;
        if (!validPreviewKey(cookieOf(req, PREVIEW_COOKIE)) || (!access.remoteAllowed() && !access.isLocal(req))) return socket.destroy();
        const qs = (req.url || '').includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
        proxyUpgrade(req, socket, head, hit.port, hit.rest + qs);
      });
      console.log(`claude-anywhere listening on http://${host}:${port}`);
      resolve({ server, url: `http://${host}:${port}` });
    });
  });
}

// Run directly (`node server.mjs`): listen. When imported as a module, the importer calls startServer().
const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
console.log(`[claude-anywhere] node ${process.version} argv1=${process.argv[1]} main=${isMain} cwd=${process.cwd()}`);
if (isMain) startServer();

// Started by the desktop app: leave when it leaves, but never while Claude is mid-turn.
// A new app instance (after a rebuild or update) finds this server on the port, adopts
// it (POST /api/adopt) and carries on with the same live runs.
let parentPid = Number(envOf('PARENT_PID')) || 0;
let orphanSince = 0;
if (parentPid) setInterval(() => {
  try { process.kill(parentPid, 0); orphanSince = 0; return; } catch {}
  const live = liveCount();
  if (live) { if (!orphanSince) { orphanSince = Date.now(); console.log(`[claude-anywhere] desktop app is gone; staying up for ${live} running turn(s)`); } return; }
  console.log('[claude-anywhere] desktop app is gone and nothing is running, exiting'); process.exit(0);
}, 2000).unref();
// The adopting app may be a newer build than the one that started this server, and
// until the server restarts its own environment still describes the old one — so the
// About line and the update check take the version from whoever owns it now.
app.post('/api/adopt', (req, res) => { const pid = Number(req.body?.pid); if (pid > 0) { parentPid = pid; orphanSince = 0; if (req.body?.version) appVersion = String(req.body.version); if (req.body?.commit) appCommit = String(req.body.commit); console.log('[claude-anywhere] adopted by app pid', pid, req.body?.version ? 'v' + req.body.version : ''); } res.json({ ok: true, parentPid, liveRuns: liveCount() }); });
