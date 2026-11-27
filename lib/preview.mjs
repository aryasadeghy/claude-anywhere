// The preview: whatever the project's dev server is serving, shown inside the
// app — and therefore on your phone, which cannot reach the PC's localhost by
// itself. Everything goes through this proxy on the app's own origin, so the
// page's relative URLs, its absolute ones, and its hot-reload socket all keep
// working, and the browser is willing to put it in a frame.
//
// Claude Desktop calls the same idea a preview pane, and refuses anything that
// is not localhost. So do we: this proxy is a window onto processes already
// running on this machine, never a way to fetch the internet through it.

import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listeners } from './ports.mjs';

const execFileP = promisify(execFile);

export const PREVIEW_PREFIX = '/preview/';
const okPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;

// Headers that belong to one hop and must not be forwarded.
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
// Frame-busting and CSP would stop the page appearing in the panel at all.
const DROP_BACK = new Set(['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'cross-origin-opener-policy', 'cross-origin-embedder-policy']);

/** `/preview/5173/some/path?q` -> { port: 5173, rest: '/some/path?q' } */
export function parsePreviewUrl(url) {
  const m = /^\/preview\/(\d+)(\/[^\s]*)?$/.exec(url || '');
  if (!m) return null;
  const port = Number(m[1]);
  return okPort(port) ? { port, rest: m[2] || '/' } : null;
}

// A page loaded at /preview/5173/ asks for /assets/app.js — an absolute path on
// our origin. The referer says which preview it came from, so it can still be
// answered from the right dev server.
export function portFromReferer(referer) {
  try {
    const p = parsePreviewUrl(new URL(referer).pathname + '');
    return p ? p.port : null;
  } catch { return null; }
}

// A page served at /preview/5173/ that links to `/about` would navigate the frame to
// our own origin's /about. The referer rescues the first hop, but the page that lands
// there is no longer under the prefix, so the hop after it has nothing to go on and
// the frame fills with this app instead of the project.
//
// So every HTML page gets two things: a <base> so relative URLs resolve inside the
// prefix, and a small script that puts the prefix back on root-relative navigation.
// Sub-resources still ride on the referer, which now always names a preview.
const injection = (port) => `<base href="/preview/${port}/"><script>(function(){
var P='/preview/${port}';
function fix(u){return (typeof u==='string'&&u.charAt(0)==='/'&&u.indexOf(P+'/')!==0&&u!==P)?P+u:u;}
document.addEventListener('click',function(e){
  if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
  var a=e.target&&e.target.closest&&e.target.closest('a[href]');
  if(!a||a.target&&a.target!=='_self'||a.hasAttribute('download'))return;
  var h=a.getAttribute('href');
  if(h&&h.charAt(0)==='/'&&fix(h)!==h){e.preventDefault();location.href=fix(h);}
},true);
document.addEventListener('submit',function(e){
  var f=e.target;if(!f||!f.getAttribute)return;
  var a=f.getAttribute('action');if(a&&fix(a)!==a)f.setAttribute('action',fix(a));
},true);
var ps=history.pushState,rs=history.replaceState;
history.pushState=function(s,t,u){return ps.call(this,s,t,fix(u));};
history.replaceState=function(s,t,u){return rs.call(this,s,t,fix(u));};
// Hot reload opens a socket at a root-relative path of its own, which would arrive
// with no preview in it and be refused. Put the prefix back on the way out.
var W=window.WebSocket;
if(W){var S=function(u,p){
  try{var x=new URL(u,location.href);
    // A relative socket path resolves against the document, so it arrives as http:
    // here even though the browser will open it as ws:.
    var sec=(x.protocol==='https:'||x.protocol==='wss:');
    var isWs=(x.protocol==='ws:'||x.protocol==='wss:'||x.protocol==='http:'||x.protocol==='https:');
    if(isWs&&x.host===location.host&&x.pathname.indexOf(P+'/')!==0){
      u=(sec?'wss://':'ws://')+x.host+P+x.pathname+x.search;
    }
  }catch(e){}
  return arguments.length>1?new W(u,p):new W(u);};
S.prototype=W.prototype;S.CONNECTING=W.CONNECTING;S.OPEN=W.OPEN;S.CLOSING=W.CLOSING;S.CLOSED=W.CLOSED;
window.WebSocket=S;}
})();</script>`;

// Sub-resources ride on the referer — unless the page says not to send one. Mailpit
// does exactly that, and then `/dist/app.js` came back as this app's own index.html
// and the panel stayed blank. So the prefix is written into the markup as well, where
// nothing can strip it. Only attributes are touched: the pattern runs over matched
// tags, never over the text between them, so script bodies are left alone.
const URL_ATTR = /(\s(?:src|href|action|formaction|poster|data-src)\s*=\s*)("([^"]*)"|'([^']*)'|([^\s">]+))/gi;
const SRCSET_ATTR = /(\ssrcset\s*=\s*)("([^"]*)"|'([^']*)')/gi;
// `/x` belongs to the dev server; `//host/x` is another origin and is left to fail on its own.
const needsPrefix = (u, p) => typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') && !u.startsWith(p + '/') && u !== p;

function rewriteHtmlUrls(html, port) {
  const p = PREVIEW_PREFIX.replace(/\/$/, '') + '/' + port;
  return html.replace(/<[a-zA-Z][^>]*>/g, (tag) => {
    if (/^<base\b/i.test(tag)) return tag;
    return tag
      .replace(URL_ATTR, (m, lead, raw, dq, sq, uq) => {
        const val = dq ?? sq ?? uq ?? '';
        if (!needsPrefix(val, p)) return m;
        const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
        return lead + quote + p + val + quote;
      })
      .replace(SRCSET_ATTR, (m, lead, raw, dq, sq) => {
        const val = dq ?? sq ?? '';
        const quote = dq !== undefined ? '"' : "'";
        const out = val.split(',').map((part) => {
          const t = part.trim();
          if (!t) return part;
          const [url, ...rest] = t.split(/\s+/);
          return (needsPrefix(url, p) ? p + url : url) + (rest.length ? ' ' + rest.join(' ') : '');
        }).join(', ');
        return lead + quote + out + quote;
      });
  });
}

function injectInto(html, port) {
  // A page that asks for no referer would break the fallback for anything built in JS.
  let out = html.replace(/<meta[^>]+name\s*=\s*["']?referrer["']?[^>]*>/gi, '');
  out = rewriteHtmlUrls(out, port);
  // The bridge as well, so the pane talks to a page the same way however it is served.
  const tag = injection(port) + BRIDGE;
  const head = /<head[^>]*>/i.exec(out);
  if (head) return out.slice(0, head.index + head[0].length) + tag + out.slice(head.index + head[0].length);
  const htmlTag = /<html[^>]*>/i.exec(out);
  if (htmlTag) return out.slice(0, htmlTag.index + htmlTag[0].length) + tag + out.slice(htmlTag.index + htmlTag[0].length);
  return tag + out;
}

/** Pipe one request through to 127.0.0.1:port and back. */
export function proxyRequest(req, res, port, rest) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || k === 'host' || k === 'cookie') continue; // our cookie is ours, not the dev server's
    headers[k] = v;
  }
  // Ask for plain text: the page is rewritten on the way back, and a local hop is not
  // where compression earns its keep.
  delete headers['accept-encoding'];
  headers.host = '127.0.0.1:' + port;
  // Dev servers check this to decide whether a request is same-origin.
  if (headers.origin) headers.origin = 'http://127.0.0.1:' + port;
  if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+\/preview\/\d+/, 'http://127.0.0.1:' + port);

  const up = http.request({ host: '127.0.0.1', port, path: rest, method: req.method, headers }, (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) {
      const lower = k.toLowerCase();
      if (HOP.has(lower) || DROP_BACK.has(lower)) continue;
      // A redirect to the dev server's own origin has to stay inside the panel.
      if (lower === 'location' && typeof v === 'string') { out[k] = rewriteLocation(v, port); continue; }
      out[k] = v;
    }
    // Only HTML is read and rewritten; everything else streams straight through.
    if (!/text\/html/i.test(String(r.headers['content-type'] || ''))) {
      res.writeHead(r.statusCode || 502, out);
      return r.pipe(res);
    }
    const chunks = [];
    let size = 0;
    r.on('data', (c) => { chunks.push(c); size += c.length; });
    r.on('end', () => {
      // A document big enough to be a download rather than a page goes through untouched.
      let body = Buffer.concat(chunks);
      if (size <= 8 * 1024 * 1024) body = Buffer.from(injectInto(body.toString('utf8'), port), 'utf8');
      delete out['content-length'];
      delete out['Content-Length'];
      // Whatever the page would have set, the referer still has to name the preview:
      // it is what answers anything the page builds a URL for at runtime.
      res.writeHead(r.statusCode || 502, { ...out, 'content-length': body.length, 'referrer-policy': 'same-origin' });
      res.end(body);
    });
    r.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  });
  up.on('error', (e) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Nothing is answering on port ${port} (${e.code || e.message}).\n\nStart the dev server, or pick another port.`);
  });
  req.pipe(up);
}

function rewriteLocation(loc, port) {
  if (loc.startsWith('/')) return PREVIEW_PREFIX + port + loc;
  try {
    const u = new URL(loc);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return PREVIEW_PREFIX + (u.port || port) + u.pathname + u.search;
  } catch {}
  return loc;
}

/** Hot reload runs over a WebSocket; tunnel the upgrade straight through. */
export function proxyUpgrade(req, socket, head, port, rest) {
  const up = http.request({ host: '127.0.0.1', port, path: rest, method: 'GET', headers: { ...req.headers, host: '127.0.0.1:' + port } });
  up.end();
  up.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (const [k, v] of Object.entries(upRes.headers)) lines.push(`${k}: ${v}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    // What the dev server sent right behind its 101 - Vite's "connected", webpack's first
    // status - arrives here, apart from the socket. It goes on to the page. It used to be
    // pushed into the page's own socket and back to the dev server, and was simply lost.
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    const bye = () => { try { upSocket.destroy(); } catch {} try { socket.destroy(); } catch {} };
    upSocket.on('error', bye); socket.on('error', bye);
    upSocket.on('close', bye); socket.on('close', bye);
  });
  up.on('response', () => socket.destroy());
  up.on('error', () => socket.destroy());
  if (head && head.length) socket.unshift(head);
}

// ---------- a preview at the root of its own origin ----------
// Under /preview/5173/ a page's router finds the prefix in location.pathname and draws
// its own "not found" - Expo Router, Next and React Router all do - and a page on the
// app's origin can read the app's sign-in token out of localStorage. So a dev server is
// also served from a port of its own, at its root: the page sees the paths it was built
// for, its hot-reload socket needs no help, and the app's storage is another origin's.
// Cookies ignore ports, so the preview key the app hands out still comes along.

// What the pane learns from inside the page, which it can no longer read directly: where
// the page is and what it is called, and the back / forward / reload the bar asks for.
export const BRIDGE = `<script>(function(){
if(window.top===window)return;
var post=function(m){try{m.caBrowser=1;parent.postMessage(m,'*');}catch(e){}};
var last='';
var nav=function(){var h=location.href,t=document.title||'';if(h+'\\n'+t===last)return;last=h+'\\n'+t;post({t:'nav',href:h,title:t});};
['pushState','replaceState'].forEach(function(k){var o=history[k];history[k]=function(){var r=o.apply(this,arguments);setTimeout(nav);return r;};});
addEventListener('popstate',nav);addEventListener('hashchange',nav);addEventListener('load',nav);
document.addEventListener('DOMContentLoaded',function(){nav();if(window.MutationObserver&&document.head)new MutationObserver(nav).observe(document.head,{subtree:true,childList:true,characterData:true});});
addEventListener('message',function(e){if(e.source!==parent)return;var m=e.data||{};if(!m.caBrowser)return;
if(m.cmd==='back')history.back();else if(m.cmd==='forward')history.forward();else if(m.cmd==='reload')location.reload();});
nav();
})();</script>`;

export function injectBridge(html) {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + BRIDGE + html.slice(head.index + head[0].length);
  const top = /<html[^>]*>/i.exec(html);
  if (top) return html.slice(0, top.index + top[0].length) + BRIDGE + html.slice(top.index + top[0].length);
  return BRIDGE + html;
}

// The page's own cookies are the page's: its sign-in has to survive a reload. Only the
// app's key is taken out on the way to the dev server.
const withoutCookie = (header, name) => String(header || '').split(';').map((c) => c.trim()).filter((c) => c && !c.startsWith(name + '=')).join('; ');
// A dev server's cookie names localhost, or wants https; the frame is neither, and a
// browser drops such a cookie without a word - which reads as "the login does not stick".
const looseCookie = (c) => String(c).replace(/;\s*domain=[^;]*/gi, '').replace(/;\s*secure(?=;|$)/gi, '').replace(/;\s*samesite=none/gi, '; SameSite=Lax');

// A redirect to the dev server's own address stays in the frame, at the same path.
function toRoot(loc, port) {
  try {
    const u = new URL(loc);
    if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port || 80) === port) return u.pathname + u.search + u.hash;
  } catch {}
  return loc;
}

/** One request to 127.0.0.1:port, answered at the root of the preview's own origin. */
export function proxyAtRoot(req, res, port, cookieName) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && k !== 'host' && k !== 'cookie') headers[k] = v;
  const jar = withoutCookie(req.headers.cookie, cookieName);
  if (jar) headers.cookie = jar;
  delete headers['accept-encoding']; // the page is read on the way back; a local hop gains nothing from gzip
  // Dev servers check these: Vite refuses a Host it does not know, and CSRF checks compare Origin.
  headers.host = '127.0.0.1:' + port;
  if (headers.origin) headers.origin = 'http://127.0.0.1:' + port;
  if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, 'http://127.0.0.1:' + port);
  const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers }, (r) => {
    const out = {};
    for (const [k, v] of Object.entries(r.headers)) {
      const lower = k.toLowerCase();
      if (HOP.has(lower) || DROP_BACK.has(lower)) continue;
      if (lower === 'location' && typeof v === 'string') out[k] = toRoot(v, port);
      else if (lower === 'set-cookie') out[k] = [].concat(v).map(looseCookie);
      else out[k] = v;
    }
    if (!/text\/html/i.test(String(r.headers['content-type'] || ''))) { res.writeHead(r.statusCode || 502, out); return r.pipe(res); }
    const chunks = []; let size = 0;
    r.on('data', (c) => { chunks.push(c); size += c.length; });
    r.on('end', () => {
      let body = Buffer.concat(chunks);
      if (size <= 8 * 1024 * 1024) body = Buffer.from(injectBridge(body.toString('utf8')), 'utf8');
      delete out['content-length']; delete out['Content-Length'];
      res.writeHead(r.statusCode || 502, { ...out, 'content-length': body.length });
      res.end(body);
    });
    r.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  });
  up.on('error', (e) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Nothing is answering on port ${port} (${e.code || e.message}).\n\nStart the dev server, then reload.`);
  });
  req.pipe(up);
}

/** Hot reload at the root: the socket is tunnelled with the dev server's own Host. */
export function upgradeAtRoot(req, socket, head, port, cookieName) {
  const headers = { ...req.headers, host: '127.0.0.1:' + port };
  const jar = withoutCookie(req.headers.cookie, cookieName);
  if (jar) headers.cookie = jar; else delete headers.cookie;
  if (headers.origin) headers.origin = 'http://127.0.0.1:' + port;
  const up = http.request({ host: '127.0.0.1', port, path: req.url, method: 'GET', headers });
  up.end();
  up.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (const [k, v] of Object.entries(upRes.headers)) for (const x of [].concat(v)) lines.push(`${k}: ${x}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.write(upHead); // the dev server's first message, on to the page (see proxyUpgrade)
    upSocket.pipe(socket); socket.pipe(upSocket);
    const bye = () => { try { upSocket.destroy(); } catch {} try { socket.destroy(); } catch {} };
    upSocket.on('error', bye); socket.on('error', bye); upSocket.on('close', bye); socket.on('close', bye);
  });
  up.on('response', () => socket.destroy());
  up.on('error', () => socket.destroy());
  if (head && head.length) socket.unshift(head);
}

/**
 * A listener of our own for one origin, on the first free port of `wants` (0 lets the
 * system choose). The same wish gives the same port after a restart, so a previewed app
 * keeps its origin - and with it its sign-in and storage.
 */
export async function listenOn(host, wants, onRequest, onUpgrade) {
  for (const want of [...wants, 0]) {
    if (want && !okPort(want)) continue;
    const server = http.createServer(onRequest);
    if (onUpgrade) server.on('upgrade', onUpgrade);
    const port = await new Promise((resolve) => {
      server.once('error', () => resolve(0));
      // Once listening, a stray socket error must not take the whole app down with it.
      server.listen(want, host, () => { server.on('error', () => {}); resolve(server.address().port); });
    });
    if (port) return { port, server };
  }
  throw new Error('No free port for the preview');
}

// ---------- what is worth previewing ----------
// A listening port is not a web server. A normal Windows machine has thirty of
// them — RPC, printer spooling, a keyboard's lighting daemon — and offering that
// list means the panel opens on a GPU monitor and the person has to guess.
//
// So every candidate is asked, once, whether it speaks HTTP, and only the ones
// that answer are offered. The page's own <title> comes back with it, which is a
// far better label than the name of the executable behind the socket.
const NAMES = { node: 'Node', 'node.exe': 'Node', python: 'Python', 'python.exe': 'Python', 'ruby.exe': 'Ruby', 'java.exe': 'Java', 'dotnet.exe': '.NET', 'caddy.exe': 'Caddy', 'nginx.exe': 'nginx', 'docker.exe': 'Docker', 'com.docker.backend.exe': 'Docker', bun: 'Bun', 'bun.exe': 'Bun', deno: 'Deno', 'deno.exe': 'Deno', 'php.exe': 'PHP', 'go.exe': 'Go' };

const titleOf = (html) => {
  const m = /<title[^>]*>([^<]{1,90})/i.exec(html || '');
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
};

/**
 * One GET to 127.0.0.1:port. Resolves { http, status, server, title } — `http` is
 * false for anything that is not an HTTP server, including one that never answers.
 */
function probeHttp(port, timeout = 700) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout, headers: { host: '127.0.0.1:' + port, accept: 'text/html,*/*', 'user-agent': 'claude-anywhere-preview' } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 8192) { done({ http: true, status: res.statusCode, server: res.headers.server || '', title: titleOf(body) }); req.destroy(); }
        });
        const end = () => done({ http: true, status: res.statusCode, server: res.headers.server || '', title: titleOf(body) });
        res.on('end', end); res.on('close', end); res.on('aborted', end);
      },
    );
    req.on('error', () => done({ http: false }));
    req.on('timeout', () => { req.destroy(); done({ http: false }); });
    req.end();
  });
}

// Rescanning on every open would mean a second of netstat and thirty probes each time.
let portCache = { at: 0, value: [] };

export const forgetPorts = () => { portCache = { at: 0, value: [] }; };
export async function listLocalPorts({ self = 0, maxAge = 4000 } = {}) {
  if (Date.now() - portCache.at < maxAge) return portCache.value;
  const rows = [];
  try {
    // netstat on Windows, lsof elsewhere (lib/ports.mjs): the card is as useful on a Mac as on this PC.
    const seen = new Map();
    for (const [port, pid] of await listeners({ loopbackOnly: true })) { if (port === self || port < 80 || port > 65000) continue; seen.set(port, pid); }
    const pids = [...new Set(seen.values())];
    const names = await pidNames(pids);
    const ports = [...seen.keys()];
    const probes = await Promise.all(ports.map((p) => probeHttp(p)));
    ports.forEach((port, i) => {
      const pid = seen.get(port);
      const proc = names.get(pid) || '';
      const r = probes[i];
      // Answering HTTP is not the same as having something to show: a printer service
      // that says 503, or a launcher that says 400, is not a page anyone wants framed.
      const serves = !!r.http && (r.status || 0) < 400;
      rows.push({
        port, pid, process: proc, label: NAMES[proc.toLowerCase()] || proc,
        http: !!r.http, status: r.status || 0, server: r.server || '', title: r.title || '',
        serves,
        // What a project's own dev server looks like: a development runtime, serving
        // something, on a port people actually use for it.
        dev: serves && DEV_RUNTIMES.has(proc.toLowerCase()) && port >= 1024,
      });
    });
  } catch {}
  const rank = (p) => (p.dev ? 0 : p.serves ? 1 : p.http ? 2 : 3);
  const inRange = (p) => (p.port >= 3000 && p.port <= 9999 ? 0 : 1);
  const value = rows.sort((a, b) => rank(a) - rank(b) || inRange(a) - inRange(b) || a.port - b.port).slice(0, 60);
  portCache = { at: Date.now(), value };
  return value;
}

// Something a project is served by, as opposed to something the machine came with.
const DEV_RUNTIMES = new Set(['node', 'node.exe', 'python', 'python.exe', 'python3', 'python3.exe', 'pythonw.exe', 'ruby', 'ruby.exe', 'java', 'java.exe', 'dotnet', 'dotnet.exe', 'bun', 'bun.exe', 'deno', 'deno.exe', 'php', 'php.exe', 'go', 'go.exe', 'caddy', 'caddy.exe', 'nginx', 'nginx.exe', 'docker', 'docker.exe', 'com.docker.backend.exe', 'rails', 'puma', 'gunicorn', 'uvicorn', 'flask', 'cargo', 'cargo.exe']);

async function pidNames(pids) {
  const out = new Map();
  if (!pids.length) return out;
  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileP('ps', ['-p', pids.join(','), '-o', 'pid=,comm='], { timeout: 8000 });
      for (const line of stdout.split('\n')) { const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line); if (m) out.set(Number(m[1]), m[2].split('/').pop()); }
    } catch {}
    return out;
  }
  try {
    const { stdout } = await execFileP('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (m && pids.includes(Number(m[2]))) out.set(Number(m[2]), m[1]);
    }
  } catch {}
  return out;
}
