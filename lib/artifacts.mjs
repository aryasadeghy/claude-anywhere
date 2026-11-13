// Artifacts: pages, diagrams and documents Claude makes for the person to look at, kept per
// session with every version. Claude Desktop's are claude.ai links; those cannot be made from
// outside, so ours live in the data dir and are drawn by this server.
//
// They are never drawn on the app's own origin: the app keeps its token in localStorage and an
// artifact is code Claude wrote. The panel puts the page in an iframe without allow-same-origin,
// and every standalone route sends `Content-Security-Policy: sandbox`, which gives the page an
// opaque origin however it was reached.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const TYPES = ['html', 'react', 'svg', 'markdown', 'mermaid', 'code'];
const MAX_BYTES = 2 * 1024 * 1024;
const SID = /^[0-9a-f-]{8,64}$/i;
const AID = /^[a-z0-9][a-z0-9-]{0,59}$/;

let root = path.join(process.env.CLAUDE_ANYWHERE_DATA_DIR || process.env.CLAUDE_REMOTE_DATA_DIR || path.join(process.cwd(), 'data'), 'artifacts');
export function configure(dir) { root = dir; }

export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'artifact';
const dirOf = (sid) => { if (!SID.test(sid || '')) throw new Error('bad session id'); return path.join(root, sid); };
const fileOf = (sid, id) => { if (!AID.test(id || '')) throw new Error('bad artifact id'); return path.join(dirOf(sid), id + '.json'); };
const read = (sid, id) => { try { return JSON.parse(fs.readFileSync(fileOf(sid, id), 'utf8')); } catch (e) { if (e.message?.startsWith('bad ')) throw e; return null; } };
function write(sid, a) { fs.mkdirSync(dirOf(sid), { recursive: true }); fs.writeFileSync(fileOf(sid, a.id), JSON.stringify(a)); }
const meta = (a) => ({ id: a.id, title: a.title, type: a.type, version: a.versions.length, created: a.created, updated: a.versions.at(-1).at, shared: !!a.share, size: a.versions.at(-1).content.length });
const checkContent = (c) => { if (typeof c !== 'string' || !c.trim()) throw new Error('content is empty'); if (Buffer.byteLength(c) > MAX_BYTES) throw new Error('content is over 2 MB'); };

export function create(sid, { id, title, type, content }) {
  if (!TYPES.includes(type)) throw new Error('type must be one of ' + TYPES.join(', '));
  checkContent(content);
  const aid = id ? slugify(id) : slugify(title);
  if (read(sid, aid)) throw new Error(`An artifact "${aid}" already exists in this session; use update_artifact to change it, or pick another id.`);
  const now = Date.now();
  const a = { id: aid, title: String(title || aid).slice(0, 120), type, created: now, share: null, versions: [{ at: now, content, note: 'Created' }] };
  write(sid, a);
  return meta(a);
}

// A change is either the whole new content or one find/replace on the latest version; a find
// that is missing or matches more than once is refused so Claude fixes its edit instead of
// silently getting a different page than it meant.
export function update(sid, id, { content, find, replace, all, title, note }) {
  const a = read(sid, id);
  if (!a) throw new Error(`No artifact "${id}" in this session; list_artifacts shows what exists.`);
  const cur = a.versions.at(-1).content;
  let next = content;
  if (typeof find === 'string') {
    if (!find) throw new Error('find is empty');
    const n = cur.split(find).length - 1;
    if (!n) throw new Error('find text is not in the artifact');
    if (n > 1 && !all) throw new Error(`find text appears ${n} times; make it longer so it is unique, or set all to true`);
    next = all ? cur.split(find).join(replace ?? '') : cur.replace(find, () => replace ?? '');
  }
  if (typeof next !== 'string') throw new Error('give content, or find and replace');
  checkContent(next);
  if (title) a.title = String(title).slice(0, 120);
  a.versions.push({ at: Date.now(), content: next, note: note ? String(note).slice(0, 200) : typeof find === 'string' ? 'Edited' : 'Rewritten' });
  write(sid, a);
  return meta(a);
}

export function list(sid) {
  let names = []; try { names = fs.readdirSync(dirOf(sid)).filter((n) => n.endsWith('.json')); } catch (e) { if (e.message?.startsWith('bad ')) throw e; }
  return names.map((n) => { try { return meta(JSON.parse(fs.readFileSync(path.join(dirOf(sid), n), 'utf8'))); } catch { return null; } }).filter(Boolean).sort((x, y) => y.updated - x.updated);
}

// `v` is 1-based; no v means the latest.
export function get(sid, id, v) {
  const a = read(sid, id); if (!a) return null;
  const n = Math.min(Math.max(Number(v) || a.versions.length, 1), a.versions.length);
  return { ...meta(a), shown: n, versions: a.versions.map((x, i) => ({ n: i + 1, at: x.at, note: x.note })), content: a.versions[n - 1].content };
}

export function remove(sid, id) {
  const a = read(sid, id); if (!a) return false;
  if (a.share) unshare(sid, id);
  fs.rmSync(fileOf(sid, id), { force: true });
  return true;
}

// ---- share links: /a/<token>, read-only, no login. One token per artifact, revoked by removing it.
const sharesFile = () => path.join(root, 'shares.json');
const readShares = () => { try { return JSON.parse(fs.readFileSync(sharesFile(), 'utf8')); } catch { return {}; } };
const writeShares = (s) => { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(sharesFile(), JSON.stringify(s)); };
export function share(sid, id) {
  const a = read(sid, id); if (!a) return null;
  if (!a.share) { a.share = randomBytes(18).toString('base64url'); write(sid, a); const s = readShares(); s[a.share] = { sid, id }; writeShares(s); }
  return a.share;
}
export function unshare(sid, id) {
  const a = read(sid, id); if (!a || !a.share) return false;
  const s = readShares(); delete s[a.share]; writeShares(s);
  a.share = null; write(sid, a); return true;
}
export function shareToken(sid, id) { return read(sid, id)?.share || null; }
// A shared page is always the latest version, so the link keeps working as Claude updates it.
export function byShare(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const hit = readShares()[token]; if (!hit) return null;
  const a = read(hit.sid, hit.id);
  return a && a.share === token ? { ...meta(a), content: a.versions.at(-1).content } : null;
}

// ---- drawing
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Content travels inside a <script>: `<` and the two line separators must not end or break it.
const js = (s) => JSON.stringify(String(s)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const BASE = 'html,body{margin:0}body{font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f1f1e;background:#fff}';
const shell = (title, head, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${head}</head><body>${body}</body></html>`;

// JSX in, plain script out: Claude writes `import { useState } from 'react'` and `export default`,
// which a classic script cannot run, so the imports become the UMD globals and the default
// export is rendered. Other packages are not available - the page says so rather than blank.
export function reactSource(code) {
  let def = null;
  let out = String(code)
    .replace(/^\s*import\s+React\s*,\s*\{([^}]*)\}\s+from\s+['"]react['"];?/gm, 'const {$1} = React;')
    .replace(/^\s*import\s+React\s+from\s+['"]react['"];?/gm, '')
    .replace(/^\s*import\s+\{([^}]*)\}\s+from\s+['"]react['"];?/gm, 'const {$1} = React;')
    .replace(/^\s*import\s+[^;\n]*from\s+['"](?!react['"])[^'"]+['"];?/gm, (m) => `throw new Error(${JSON.stringify('Not available in an artifact: ' + m.trim())});`)
    .replace(/export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, (_, n) => { def = n; return 'function ' + n; })
    .replace(/export\s+default\s+class\s+([A-Za-z_$][\w$]*)/, (_, n) => { def = n; return 'class ' + n; })
    .replace(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m, (_, n) => { def = n; return ''; })
    .replace(/export\s+default\s+/, () => { def = '__Default'; return 'const __Default = '; })
    .replace(/^\s*export\s+(?=const|let|function|class)/gm, '');
  return out + `\nreturn ${def || 'typeof App !== "undefined" ? App : null'};`;
}

export function renderPage(type, content, title = 'Artifact') {
  switch (type) {
    case 'html':
      // A fragment gets a shell; a whole document is left exactly as written.
      return /<html[\s>]|<!doctype/i.test(content) ? content : shell(title, `<style>${BASE}</style>`, content);
    case 'svg':
      return shell(title, `<style>${BASE}body{display:grid;place-items:center;min-height:100vh}svg{max-width:100%;max-height:100vh;height:auto}</style>`, content);
    case 'markdown':
      return shell(title, `<style>${BASE}main{max-width:760px;margin:0 auto;padding:24px 20px}pre{background:#f4f3ef;padding:12px;border-radius:8px;overflow:auto}code{font-family:ui-monospace,Consolas,monospace;font-size:.92em}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 10px}img{max-width:100%}blockquote{margin-left:0;padding-left:14px;border-left:3px solid #ddd;color:#555}</style><script src="/vendor/marked.js"></script><script src="/vendor/purify.js"></script>`,
        `<main id="out"></main><script>var src=${js(content)};document.getElementById('out').innerHTML=DOMPurify.sanitize(marked.parse(src));</script>`);
    case 'mermaid':
      return shell(title, `<style>${BASE}body{display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}#e{color:#b00;white-space:pre-wrap}</style>`,
        `<pre class="mermaid" id="m"></pre><div id="e"></div><script type="module">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';var el=document.getElementById('m');el.textContent=${js(content)};try{mermaid.initialize({startOnLoad:false,securityLevel:'strict'});await mermaid.run({nodes:[el]});}catch(x){document.getElementById('e').textContent=String(x&&x.message||x);}</script>`);
    case 'code':
      return shell(title, `<style>${BASE}pre{margin:0;padding:16px;font:13px/1.55 ui-monospace,Consolas,monospace;white-space:pre;overflow:auto;min-height:100vh;box-sizing:border-box;background:#fafaf8}</style>`, `<pre><code>${esc(content)}</code></pre>`);
    case 'react':
      return shell(title, `<style>${BASE}#err{color:#b00;white-space:pre-wrap;padding:16px;font:13px ui-monospace,Consolas,monospace}</style><script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script><script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script><script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>`,
        `<div id="root"></div><div id="err"></div><script>(function(){var show=function(x){document.getElementById('err').textContent=String(x&&x.stack||x)};window.addEventListener('error',function(e){show(e.error||e.message)});try{var code=Babel.transform(${js(reactSource(content))},{presets:['react'],parserOpts:{allowReturnOutsideFunction:true}}).code;var C=new Function('React','ReactDOM',code)(React,ReactDOM);ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(C));}catch(x){show(x)}})();</script>`);
  }
  return shell(title, '', `<pre>${esc(content)}</pre>`);
}

// What every standalone route sends with a page: no origin, no cookies, nothing sent onward.
export const PAGE_HEADERS = { 'Content-Security-Policy': 'sandbox allow-scripts allow-modals allow-popups allow-forms', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
