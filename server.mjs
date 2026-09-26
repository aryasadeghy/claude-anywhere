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
import { runs, pendingPermissions, isLive, startRun, answerPermission, bus, contextBySession, lastLimits } from './lib/runs.mjs';
import * as runsMod from './lib/runs.mjs';
const execFileP = promisify(execFile);
import { tailSession, isWorkingElsewhere, WORKING_WINDOW_MS, sessionFile } from './lib/tail.mjs';
import { parsePreviewUrl, portFromReferer, proxyRequest, proxyUpgrade, listLocalPorts } from './lib/preview.mjs';
import { searchTranscripts } from './lib/search.mjs';
import * as worktrees from './lib/worktrees.mjs';
import * as pr from './lib/pr.mjs';
import * as awake from './lib/awake.mjs';
import * as update from './lib/update.mjs';
import * as models from './lib/models.mjs';
import * as access from './lib/access.mjs';
import { getAuth, activeAccount, setActive, setToken, clearToken, setProvider, clearProvider, classifyToken, envFor, localSource, verifyEnv, candidateEnv, candidateProviderEnv } from './lib/auth.mjs';

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
// Remote access off (the default, and always without a password): only this computer may use it. Everything else -
// another device on the network, a tunnel, a proxy - is turned away with the reason,
// before the page or any API answers. Setting a password opens it again.
const CLOSED = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remote access is off</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#1a1a1a;color:#eee}main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#bbb;margin:0}</style></head><body><main><h1>Remote access is off</h1><p>Only the computer itself can use it. Turn remote access on there, in Settings → Remote access, to use it from here.</p></main></body></html>`;
app.use((req, res, next) => {
  if (access.remoteAllowed() || access.isLocal(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Remote access is off on that computer. Turn it on there, in Settings → Remote access.', remoteClosed: true });
  res.status(403).type('html').send(CLOSED);
});
app.use(express.json({ limit: '60mb' })); // attachments travel as base64

// Attachments: images are sent to Claude as image blocks; any other file is saved on
// this PC and referenced from the prompt by path, the way Remote Control does it.
const UPLOAD_DIR = path.join(os.tmpdir(), 'claude-anywhere-uploads');
function parseAttachments(body) {
  const images = (Array.isArray(body?.attachments) ? body.attachments : [])
    .filter((a) => a && typeof a.data === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(a.media_type || ''))
    .slice(0, 10)
    .map((a) => ({ media_type: a.media_type, data: a.data }));
  const paths = [];
  for (const f of (Array.isArray(body?.files) ? body.files : []).slice(0, 10)) {
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
const previewAllowed = (req) => knownToken(cookieOf(req, PREVIEW_COOKIE) || '') || knownToken(String(req.query?.token || ''));
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
  const viaQuery = req.method === 'GET' && (/^\/sessions\/[0-9a-f-]+\/events$/i.test(req.path) || req.path === '/notify' || req.path === '/file') && knownToken(String(req.query.token || ''));
  if (!knownToken(auth.replace(/^Bearer /, '')) && !viaQuery) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Signed in, so the cookie the frame will ride on can be handed out.
app.get('/api/preview/grant', (req, res) => {
  // Lax, not None: the frame is same-origin, so this is enough, and it never
  // travels to anyone else's site.
  res.setHeader('Set-Cookie', `${PREVIEW_COOKIE}=${bearer(req)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  res.json({ ok: true });
});
app.get('/api/preview/ports', async (_req, res) => res.json({ ports: await listLocalPorts({ self: PORT }) }));

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

const shape = (s, pinned) => ({
  id: s.sessionId,
  needsInput: isWaiting(s.sessionId) || (isLive(s.sessionId) && !!attention[s.sessionId]?.needsInput),
  failed: !!attention[s.sessionId]?.failed,
  unread: !!attention[s.sessionId]?.unread,
  title: s.customTitle || s.summary || s.firstPrompt || 'Untitled',
  cwd: s.cwd || '',
  project: s.cwd ? path.basename(s.cwd) : '',
  branch: s.gitBranch || '',
  lastModified: s.lastModified,
  createdAt: s.createdAt,
  live: isLive(s.sessionId),
  runStartedAt: isLive(s.sessionId) ? runs.get(s.sessionId).startedAt : null,
  working: isLive(s.sessionId) || Date.now() - s.lastModified < WORKING_WINDOW_MS,
  pinned: !!pinned?.has(s.sessionId),
  tag: s.tag || '',
  archived: s.tag === 'archived',
  context: contextBySession.get(s.sessionId) || null,
});

// ---------- session menu: rename, fork, archive, delete (the Desktop ⋮ menu) ----------
app.post('/api/sessions/:id/rename', async (req, res, next) => {
  try { const title = String(req.body?.title || '').trim().slice(0, 200); if (!title) return res.status(400).json({ error: 'Empty title' }); await renameSession(req.params.id, title); res.json({ ok: true, title }); } catch (e) { next(e); }
});
app.post('/api/sessions/:id/fork', async (req, res, next) => {
  try { const r = await forkSession(req.params.id, req.body?.title ? { title: String(req.body.title).slice(0, 200) } : {}); res.json({ sessionId: r.sessionId }); } catch (e) { next(e); }
});
app.post('/api/sessions/:id/archive', async (req, res, next) => {
  try { await tagSession(req.params.id, req.body?.archived ? 'archived' : null); res.json({ ok: true, archived: !!req.body?.archived }); } catch (e) { next(e); }
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
    if (isLive(id)) return res.status(409).json({ error: 'Stop the running turn first.' });
    const info = await getSessionInfo(id).catch(() => null);
    const kept = trashSession(id, info);
    if (!kept) await deleteSession(id); // nothing to move, or the move failed: do as asked
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

// Branch and uncommitted diff of the session's folder, for the bar above the composer.
app.get('/api/sessions/:id/git', async (req, res) => {
  try {
    const s = await getSessionInfo(req.params.id);
    if (!s?.cwd || !fs.existsSync(s.cwd)) return res.json({ git: false });
    const run = (args) => execFileP('git', ['-C', s.cwd, ...args], { timeout: 6000, windowsHide: true }).then((r) => r.stdout.trim()).catch(() => null);
    const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === null) return res.json({ git: false });
    const stat = (await run(['diff', '--shortstat', 'HEAD'])) || '';
    const untrackedFiles = ((await run(['ls-files', '--others', '--exclude-standard'])) || '').split('\n').filter(Boolean);
    let added = Number((stat.match(/(\d+) insertion/) || [])[1] || 0), removed = Number((stat.match(/(\d+) deletion/) || [])[1] || 0);
    const files = Number((stat.match(/(\d+) files? changed/) || [])[1] || 0);
    // New files are part of the work too: count their lines (text files up to 2 MB), as Desktop does.
    for (const rel of untrackedFiles.slice(0, 400)) {
      try { const p = path.join(s.cwd, rel); const st = fs.statSync(p); if (st.size > 2 * 1024 * 1024 || /\.(png|jpe?g|gif|webp|mp4|mp3|wav|zip|pdf|woff2?|ico|exe|dll)$/i.test(rel)) continue; const buf = fs.readFileSync(p); if (buf.includes(0)) continue; added += buf.toString('utf8').split('\n').length - 1; } catch {}
    }
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
    for (const p of untracked.slice(0, 500)) {
      const f = { path: p, status: '?', added: 0, removed: 0, binary: BINARY_EXT.test(p) };
      try { const full = path.join(cwd, p); const st = fs.statSync(full); if (!f.binary && st.size <= 2 * 1024 * 1024) { const buf = fs.readFileSync(full); if (buf.includes(0)) f.binary = true; else { const t = buf.toString('utf8'); f.added = t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0; } } } catch {}
      files.set(p, f);
    }
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
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) return res.json({ path: rel, binary: true, diff: '' });
      const lines = buf.toString('utf8').split('\n'); if (lines[lines.length - 1] === '') lines.pop();
      diff = ['--- /dev/null', '+++ b/' + rel, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => '+' + l)].join('\n');
    }
    const lines = diff.split('\n'); const truncated = lines.length > MAX_LINES;
    res.json({ path: rel, diff: (truncated ? lines.slice(0, MAX_LINES) : lines).join('\n'), truncated });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Rewind: a new session that is this one up to just before the chosen message, so the
// message can be edited and sent again. The original session is left as it was.
app.post('/api/sessions/:id/rewind', async (req, res, next) => {
  try {
    const uuid = String(req.body?.uuid || '');
    const msgs = (await getSessionMessages(req.params.id)).filter((m) => !m.parent_tool_use_id);
    const idx = msgs.findIndex((m) => m.uuid === uuid);
    if (idx < 0) return res.status(404).json({ error: 'That message is not in the transcript.' });
    const info = await getSessionInfo(req.params.id).catch(() => null);
    if (idx === 0) return res.json({ sessionId: null, cwd: info?.cwd || null }); // nothing before it: start fresh in the same folder
    const title = ((info?.customTitle || info?.summary || info?.firstPrompt || 'Session').slice(0, 160)) + ' · rewound';
    const r = await forkSession(req.params.id, { upToMessageId: msgs[idx - 1].uuid, title });
    res.json({ sessionId: r.sessionId, cwd: info?.cwd || null });
  } catch (e) { next(e); }
});

// Folder browser for "Open folder…" (the browser has no native folder dialog).
app.get('/api/browse', (req, res) => {
  const raw = String(req.query.path || '');
  // The folder picker wants directories only; the file browser asks for both.
  const withFiles = req.query.files === '1';
  const drives = [];
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { if (fs.existsSync(L + ':\\')) drives.push(L + ':\\'); } catch {} }
  if (!drives.length) drives.push('/'); // no lettered drives: macOS or Linux, where the root is the only one
  if (!raw) return res.json({ path: '', parent: null, dirs: drives.map((d) => ({ name: d, path: d })), files: [], drives, home: os.homedir() });
  const p = path.resolve(raw);
  let entries = [];
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return res.status(400).json({ error: 'Cannot open ' + p }); }
  const hidden = (n) => n.startsWith('.') || n.startsWith('$');
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
    if (IMAGE_EXT.test(p)) return res.json({ path: p, size: st.size, image: true });
    const MAX = 512 * 1024;
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(Math.min(st.size, MAX));
    fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    if (buf.includes(0)) return res.json({ path: p, size: st.size, binary: true });
    res.json({ path: p, size: st.size, truncated: st.size > MAX, text: buf.toString('utf8') });
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
    if ([...runs.values()].some((r) => !r.done && r.cwd && worktrees.sameDir(r.cwd, dir))) return res.status(409).json({ error: 'Claude is working in that worktree. Stop the turn first.' });
    await worktrees.remove(known, { force: !!req.body?.force });
    const p = readPrefs(); p.worktrees = listWorktrees().filter((w) => !worktrees.sameDir(w.path, dir)); writePrefs(p);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: worktrees.cliError(e) }); }
});

// ---------- the pull request for a session's branch ----------
app.get('/api/sessions/:id/pr', async (req, res) => {
  const cwd = await sessionCwd(req.params.id);
  if (!cwd || !fs.existsSync(cwd)) return res.json({ has: false });
  res.json(req.query.fresh === '1' ? (pr.forget(cwd), await pr.cached(cwd)) : await pr.cached(cwd));
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
models.useCache(DATA_DIR);
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
  res.json({ connectors, plugins: listPlugins() });
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
app.get('/api/me', (_req, res) => res.json({ version: appVersion, userName: USER_NAME, host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'this machine', account: whoAmI(), active: activeAccount(), hasToken: getAuth().hasToken, port: PORT, listensEverywhere: HOST === '0.0.0.0' || HOST === '::', passwordRequired: access.passwordRequired(), passwordSource: access.source(), addresses: reachableAt() }));

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
    for (const s of await listSessions({ limit: 500 })) { const k = s.cwd && path.normalize(s.cwd).toLowerCase(); if (k && !seen.has(k)) seen.set(k, { cwd: s.cwd, name: path.basename(s.cwd), lastModified: s.lastModified }); }
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
  return { model: saved.model || model || '', permissionMode: saved.permissionMode || mode || '', effort: saved.effort ?? '' };
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
    const interrupted = !base.live && !base.working ? interruptedTurn(req.params.id) : null;
    res.json({ ...base, settings: sessionSettings(req.params.id), interrupted });
  } catch (e) { next(e); }
});
app.post('/api/sessions/:id/prefs', (req, res) => {
  const p = readPrefs(); p.sessionPrefs = p.sessionPrefs || {};
  const cur = p.sessionPrefs[req.params.id] || {};
  for (const k of ['model', 'permissionMode', 'effort', 'ultracode']) if (req.body?.[k] !== undefined) cur[k] = req.body[k];
  p.sessionPrefs[req.params.id] = cur; writePrefs(p);
  res.json(cur);
});

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
    // Claude is mid-turn here: hand the message over, it runs right after (Desktop behaviour).
    if (isLive(id)) { const qid = runs.get(id).enqueue(prompt, images); if (qid) return res.json({ queued: true, id: qid, sessionId: id }); }
    const info = await getSessionInfo(id);
    if (!info) return res.status(404).json({ error: 'Session not found' });
    const { model, permissionMode, effort } = req.body || {};
    const { run } = startRun({ sessionId: id, cwd: info.cwd, prompt, images, model, permissionMode, effort, disabledMcp: readPrefs().disabledMcp || [] });
    res.json({ runId: run.id, sessionId: id });
  } catch (e) { next(e); }
});

// Change permission mode / model / effort while Claude is working; takes effect
// for the next tool call or model request.
app.post('/api/sessions/:id/controls', async (req, res, next) => {
  try {
    const run = runs.get(req.params.id);
    if (!run || run.done) return res.json({ applied: {}, live: false });
    const { permissionMode, model, effort, ultracode } = req.body || {};
    res.json({ applied: await run.setControls({ permissionMode, model, effort, ultracode }), live: true });
  } catch (e) { next(e); }
});

app.post('/api/sessions', async (req, res) => {
  const { text: prompt, images } = parseAttachments(req.body);
  let cwd = String(req.body?.cwd || '').trim();
  if (!cwd || cwd === '~') cwd = os.homedir(); // "No folder": Desktop runs those from the home directory
  if (!prompt && !images.length) return res.status(400).json({ error: 'Empty message' });
  if (!fs.existsSync(cwd)) return res.status(400).json({ error: 'That folder does not exist on this machine.' });
  const { model, permissionMode, effort } = req.body || {};
  const { run, ready } = startRun({ cwd, prompt, images, model, permissionMode, effort, disabledMcp: readPrefs().disabledMcp || [] });
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('Claude Code did not start in time')), 60000));
    const sessionId = await Promise.race([ready, timeout]);
    res.json({ runId: run.id, sessionId });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/sessions/:id/stop', (req, res) => {
  const run = runs.get(req.params.id);
  if (run && !run.done) run.stop();
  res.json({ ok: true });
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
app.get('/api/sessions/:id/events', (req, res) => {
  const id = req.params.id;
  const run = runs.get(id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  if (run && !run.done) {
    const since = Number(req.get('last-event-id') ?? req.query.since ?? -1);
    // A page that knows `batch` gets what it missed condensed, in a few messages it draws in
    // one pass each; a page loaded before this server still gets the events one by one. About
    // a megabyte a message, each with its own id - screenshots make a long turn tens of MB, and
    // a phone that drops the connection halfway resumes from the last piece, not the start.
    if (req.query.batch) {
      let part = [], size = 0, last = -1;
      const flush = () => { if (part.length) res.write(`id: ${last}\ndata: {"t":"batch","events":[${part.join(',')}]}\n\n`); part = []; size = 0; };
      for (const ev of run.backlog(since)) { const s = JSON.stringify(ev); part.push(s); size += s.length; last = ev.i; if (size > 1 << 20) flush(); }
      flush();
    } else for (const ev of run.events) if (ev.i > since) res.write(`id: ${ev.i}\ndata: ${JSON.stringify(ev)}\n\n`);
    run.listeners.add(res);
    req.on('close', () => { clearInterval(ping); run.listeners.delete(res); });
    return;
  }
  // A turn that just finished here also touched the file; that is not "another window".
  const quietUntil = run?.finishedAt || 0;
  res.write(`data: ${JSON.stringify({ t: 'tail', working: isWorkingElsewhere(id, quietUntil) })}\n\n`);
  const stop = tailSession(id, (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`), { quietUntil });
  req.on('close', () => { clearInterval(ping); if (stop) stop(); });
});

app.post('/api/permissions/:reqId', (req, res) => {
  const { behavior, always, updatedInput } = req.body || {};
  if (!answerPermission(req.params.reqId, behavior, !!always, updatedInput)) return res.status(404).json({ error: 'No such request (it may have expired).' });
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
async function insideProjectRoots(p) {
  const roots = new Set([os.tmpdir()]);
  for (const s of await listSessions({ limit: 500 })) if (s.cwd && path.normalize(s.cwd).replace(/[\\/]+$/, '').length > 3) roots.add(path.normalize(s.cwd)); // a session run from a drive root would open the whole drive
  for (const w of listWorktrees()) roots.add(path.normalize(w.path)); // a worktree is newer than any transcript that names it
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
    if (!IMAGE_EXT.test(p) || !fs.existsSync(p) || !fs.statSync(p).isFile()) return res.status(404).json({ error: 'Not an image on this PC' });
    if (!(await insideProjectRoots(p))) return res.status(403).json({ error: 'Outside the project folders' });
    res.sendFile(p, { headers: { 'Cache-Control': 'private, max-age=60' }, acceptRanges: true });
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

// ---------- updating from anywhere: what is running, restart the server, rebuild the app ----------
const liveCount = () => [...runs.values()].filter((r) => !r.done).length;

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
  res.json({ ...git, commit: git.commit || appCommit.slice(0, 7), version: appVersion, repo: REPO, platform: process.platform, host: process.env.COMPUTERNAME || process.env.HOSTNAME || 'this computer', serverDir: here, serverStartedAt: SERVER_STARTED_AT, appExe: envOf('APP_EXE') || null, appBuiltAt: exeAt, devBuild: devBuild(), liveRuns: liveCount(), inApp: !!envOf('PARENT_PID'), restartQueued, stale: changed.length > 0, changed, shellStale: shellChanged.length > 0, shellChanged, update: update.status({ repo: REPO, version: appVersion, platform: process.platform }) });
});
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
  res.json([...runs.values()].filter((r) => !r.done).map((r) => ({ sessionId: r.sessionId, startedAt: r.startedAt, waiting: [...pendingPermissions.values()].some((p) => p.run === r) })));
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
        const hit = parsePreviewUrl((req.url || '').split('?')[0]);
        if (!hit) return;
        if (!knownToken(cookieOf(req, PREVIEW_COOKIE) || '') || (!access.remoteAllowed() && !access.isLocal(req))) return socket.destroy();
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
  const live = [...runs.values()].filter((r) => !r.done).length;
  if (live) { if (!orphanSince) { orphanSince = Date.now(); console.log(`[claude-anywhere] desktop app is gone; staying up for ${live} running turn(s)`); } return; }
  console.log('[claude-anywhere] desktop app is gone and nothing is running, exiting'); process.exit(0);
}, 2000).unref();
// The adopting app may be a newer build than the one that started this server, and
// until the server restarts its own environment still describes the old one — so the
// About line and the update check take the version from whoever owns it now.
app.post('/api/adopt', (req, res) => { const pid = Number(req.body?.pid); if (pid > 0) { parentPid = pid; orphanSince = 0; if (req.body?.version) appVersion = String(req.body.version); if (req.body?.commit) appCommit = String(req.body.commit); console.log('[claude-anywhere] adopted by app pid', pid, req.body?.version ? 'v' + req.body.version : ''); } res.json({ ok: true, parentPid, liveRuns: [...runs.values()].filter((r) => !r.done).length }); });
