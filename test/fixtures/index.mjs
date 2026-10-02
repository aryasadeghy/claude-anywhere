// What the Browser tests stand on: a dev server with everything the old /preview/<port>/
// proxy got wrong, a project folder Claude might have written into, a session whose answer
// links to it, and the app itself, started on its own data so nothing real is touched.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// A router that reads location.pathname, CSS at an absolute path, a sign-in cookie with
// Domain=localhost; Secure; SameSite=None, a redirect to http://localhost:<port>/..., and a
// hot-reload socket whose first message rides in the same write as its 101 - the way a busy
// dev server sends it, and the way the old proxy lost it.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Test app</title><link rel="stylesheet" href="/assets/app.css"></head>
<body><nav><a href="/" data-link id="to-home">Home</a> · <a href="/about" data-link id="to-about">About</a> · <a href="/go" id="to-go">Redirect</a> · <button id="sign-in" onclick="signIn()">Sign in</button></nav>
<h1 id="page"></h1><p id="login">…</p><p id="ws">socket: connecting</p><p id="token"></p>
<script type="module" src="/assets/app.js"></script></body></html>`;
const SCRIPT = `const routes = { '/': 'Home', '/about': 'About page' };
function render() { const t = routes[location.pathname]; document.getElementById('page').textContent = t || 'Not found: ' + location.pathname; document.title = 'Test app · ' + (t || '404'); }
document.addEventListener('click', (e) => { const a = e.target.closest('a[data-link]'); if (!a) return; e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); render(); });
addEventListener('popstate', render);
render();
fetch('/api/me').then((r) => r.json()).then((j) => { document.getElementById('login').textContent = j.user ? 'Signed in as ' + j.user : 'Signed out'; });
window.signIn = () => fetch('/api/login', { method: 'POST' }).then(() => location.reload());
let seen = 'none'; try { const t = localStorage.getItem('cr.token'); seen = t ? t.slice(0, 8) + '… (the app\\'s sign-in token)' : 'none'; } catch (e) { seen = 'blocked'; }
document.getElementById('token').textContent = 'app token visible here: ' + seen + ' · cookies: ' + (document.cookie || '(none)');
const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/hmr');
ws.onmessage = (e) => { document.getElementById('ws').textContent = 'socket: ' + e.data; };
ws.onerror = () => { document.getElementById('ws').textContent = 'socket: error'; };`;
const frame = (text) => { const b = Buffer.from(text); return Buffer.concat([Buffer.from([0x81, b.length]), b]); };

export function startDevServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/assets/app.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('body{font:15px system-ui;background:#eef3ff;margin:16px} h1{color:rgb(10,120,10)}'); }
    if (url.pathname === '/assets/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(SCRIPT); }
    if (url.pathname === '/api/me') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ user: /(?:^|;\s*)sess=ok/.test(req.headers.cookie || '') ? 'arya' : null })); }
    // What the dev server was actually asked: the tests read the path, host, origin and cookies here.
    if (url.pathname === '/api/echo') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ url: req.url, host: req.headers.host, origin: req.headers.origin || null, cookie: req.headers.cookie || '' })); }
    if (url.pathname === '/api/login' && req.method === 'POST') { res.writeHead(200, { 'set-cookie': 'sess=ok; Path=/; Domain=localhost; HttpOnly; SameSite=None; Secure', 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
    if (url.pathname === '/go') { res.writeHead(302, { location: `http://localhost:${server.address().port}/about` }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
    res.end(PAGE);
  });
  // Upgraded sockets are no longer the HTTP server's to close, and close() waits for them.
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/hmr')) return socket.destroy();
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.on('error', () => {});
    socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`), frame('live')]));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.closeAllConnections?.(); server.close(() => r()); }) })));
}

// Two pages, by hand: objects, then a cross-reference table with their byte offsets.
function pdf(pages) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((text, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> >>`);
    const stream = `BT /F1 28 Tf 72 700 Td (${text}) Tj ET`;
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  return out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

// A page with its own CSS, script (which keeps a count in localStorage) and picture, a
// second page it links to, and a two-page PDF.
export function makeProject(dir) {
  const site = path.join(dir, 'site');
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Quarterly report</title><link rel="stylesheet" href="style.css"></head>
<body><h1 id="h">Quarterly report</h1><img id="img" src="chart.svg" width="160" height="96" alt="chart"><p id="count"></p><p><a id="next" href="page2.html">Next page</a></p><script src="app.js"></script></body></html>`);
  fs.writeFileSync(path.join(site, 'page2.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Page two</title><link rel="stylesheet" href="style.css"></head><body><h1>Second page</h1><a id="back" href="index.html">Back to the report</a></body></html>`);
  fs.writeFileSync(path.join(site, 'style.css'), 'body{font:15px system-ui;margin:20px} h1{color:rgb(200,30,30)}');
  fs.writeFileSync(path.join(site, 'app.js'), `var n = 0; try { n = Number(localStorage.getItem('visits') || 0) + 1; localStorage.setItem('visits', n); document.getElementById('count').textContent = 'Visits: ' + n; } catch (e) { document.getElementById('count').textContent = 'Storage: ' + e.name; }`);
  fs.writeFileSync(path.join(site, 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96" viewBox="0 0 160 96"><rect width="160" height="96" rx="10" fill="#f4efe6"/><rect x="20" y="52" width="24" height="30" fill="#d97757"/><rect x="56" y="36" width="24" height="46" fill="#d97757"/><rect x="92" y="22" width="24" height="60" fill="#d97757"/><rect x="128" y="12" width="14" height="70" fill="#b85c3e"/></svg>');
  fs.writeFileSync(path.join(site, 'report.pdf'), pdf(['Page one of the report', 'Page two of the report']), 'latin1');
  return { dir, site };
}

// A session in that project whose answer links to the page by a relative path and to the
// PDF by an absolute one, as Claude writes both. Claude Code keeps a project's transcripts
// in a folder named after its path, every other character turned into a dash.
export function makeSession(configDir, cwd, id = 'cccccccc-1111-2222-3333-444444444444') {
  const dir = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  const lines = [
    { type: 'user', uuid: id + '-u', timestamp: at(60), cwd, customTitle: 'Report and PDF', message: { role: 'user', content: [{ type: 'text', text: 'Make me a small report page and a PDF of it.' }] } },
    { type: 'assistant', uuid: id + '-a', timestamp: at(55), cwd, message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: `Done. The page is [site/index.html](site/index.html) and the PDF is [report.pdf](${path.join(cwd, 'site', 'report.pdf')}).` }] } },
  ];
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // A transcript written this second reads as "working in another window" to the app.
  const then = new Date(Date.now() - 10 * 60 * 1000); fs.utimesSync(file, then, then);
  return id;
}

// A thinking block's signature, the way the API writes one: a protobuf whose field 2 > 1 > 8 is
// "narration" when the model meant the block to be read. Any other word there is thinking.
const pbBytes = (field, bytes) => Buffer.concat([Buffer.from([(field << 3) | 2, bytes.length]), bytes]);
export const thinkingSignature = (kind) => Buffer.concat([Buffer.from([0x08, 0x04]), pbBytes(2, pbBytes(1, pbBytes(8, Buffer.from(kind))))]).toString('base64');
export const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// A plain PNG of a given size: a picture with some height, which grows the thread when it
// arrives - what a sent screenshot does, and what a 1-pixel one does not.
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
export function pngOf(w, h, rgb = [217, 119, 87]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

// A long session the way a day of work leaves one: turns of commands, reads and writes, two
// compactions, a message answered by a second process off the parent chain, background
// commands whose notices arrive mid-turn (one fails), a message typed mid-turn, thinking that
// is narration and thinking that is not, pictures - and the lines nobody is shown: meta
// prompts, the CLI answering itself, a subagent's sidechain, titles and queue bookkeeping.
// `said` lists what the chat must show and `hidden` what it must not.
export function makeLongSession(configDir, cwd, { id = 'eeeeeeee-1111-2222-3333-444444444444', turns = 60 } = {}) {
  const dir = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  let n = 0, clock = Date.now() - (turns + 5) * 90 * 1000, parent = null;
  const lines = [], said = [], hidden = [];
  const uid = () => `${id.slice(0, 8)}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const add = (o) => { const l = { parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId: id, version: '2.1.281', gitBranch: 'main', ...o, uuid: uid(), timestamp: new Date((clock += 1000)).toISOString() }; lines.push(l); parent = l.uuid; return l; };
  const msg = (content) => ({ model: 'claude-opus-5-5', id: 'msg_' + (n + 1), type: 'message', role: 'assistant', content });
  const user = (text) => add({ type: 'user', message: { role: 'user', content: text }, promptSource: 'sdk', origin: { kind: 'human' } });
  const say = (text) => add({ type: 'assistant', message: msg([{ type: 'text', text }]) });
  const think = (text, kind) => add({ type: 'assistant', message: msg([{ type: 'thinking', thinking: text, signature: thinkingSignature(kind) }]) });
  const call = (name, input, result, { isError = false, image = false } = {}) => {
    const toolId = 'toolu_' + String(n + 1).padStart(8, '0');
    add({ type: 'assistant', message: msg([{ type: 'tool_use', id: toolId, name, input }]) });
    const content = image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL } }] : [{ type: 'text', text: result }];
    add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content, ...(isError ? { is_error: true } : {}) }] } });
    return toolId;
  };
  const notice = (desc, status, toolUseId) => `<task-notification>\n<task-id>b${n}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Background command "${desc}" ${status === 'failed' ? 'failed with exit code 1' : 'completed (exit code 0)'}</summary>\n</task-notification>`;
  const folded = (prompt, commandMode) => add({ type: 'attachment', attachment: { type: 'queued_command', prompt, commandMode } });
  const compaction = (k) => {
    add({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', level: 'info', parentUuid: null, logicalParentUuid: parent, compactMetadata: { trigger: 'auto', preTokens: 950000 + k, postTokens: 9000 } });
    add({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary ${k}: the first ${turns} things were being built.` } });
  };
  lines.push({ type: 'custom-title', customTitle: 'A long day of work', sessionId: id });
  let bg = null, failing = null;
  for (let i = 1; i <= turns; i++) {
    clock += 60 * 1000;
    user(`Turn ${i}: build thing ${i}`); said.push(`Turn ${i}: build thing ${i}`);
    if (i % 6 === 0) { add({ type: 'user', isMeta: true, message: { role: 'user', content: `Base directory for this skill ${i}` } }); hidden.push(`Base directory for this skill ${i}`); }
    think(`private reasoning about thing ${i}`, 'reasoning'); hidden.push(`private reasoning about thing ${i}`);
    say(`Working on thing ${i}.`); said.push(`Working on thing ${i}.`);
    call('Bash', { command: `make thing-${i}`, description: `Build thing ${i}` }, 'built');
    if (i === 10) { folded('also keep the logs', 'prompt'); said.push('also keep the logs'); }
    if (i === 12) bg = call('Bash', { command: 'render --long', description: 'Render the long video', run_in_background: true }, 'Command running in background with ID: b12');
    if (i === 13) folded(notice('Render the long video', 'completed', bg), 'task-notification');
    if (i === 14) failing = call('Bash', { command: 'upload --all', description: 'Upload the renders', run_in_background: true }, 'Command running in background with ID: b14');
    call('Bash', { command: `test thing-${i}`, description: `Test thing ${i}` }, i === 16 ? 'Exit code 2' : 'ok', { isError: i === 16 });
    if (i === 15) folded(notice('Upload the renders', 'failed', failing), 'task-notification');
    // The pictures a turn reads or sends are on disk, as they would be: a sent one is drawn from its file.
    if (i % 5 === 0 || i % 9 === 0) fs.writeFileSync(path.join(cwd, `shot-${i}.png`), pngOf(400, 240));
    if (i % 5 === 0) call('Read', { file_path: path.join(cwd, `shot-${i}.png`) }, '', { image: true });
    if (i % 7 === 0 || i === turns) call('Write', { file_path: path.join(cwd, 'out', `thing-${i}.txt`), content: 'one\ntwo\nthree\n' }, 'File created');
    if (i % 9 === 0) call('mcp__claude-anywhere__SendUserFile', { files: [path.join(cwd, `shot-${i}.png`)], caption: `Thing ${i}` }, 'Sent');
    think(`Thing ${i} is built and tested.`, 'narration'); said.push(`Thing ${i} is built and tested.`);
    if (i === 25) {
      // A second process answering a message from an earlier point, beside the main thread.
      const main = parent; parent = lines.filter((l) => l.uuid && !l.isSidechain).at(-6).uuid;
      user('stop the gpu for a game'); say('Stopped the GPU jobs, play away.'); said.push('stop the gpu for a game', 'Stopped the GPU jobs, play away.');
      parent = main;
    }
    if (i === 30) { lines.push({ type: 'assistant', parentUuid: null, isSidechain: true, cwd, sessionId: id, uuid: uid(), timestamp: new Date(clock).toISOString(), message: msg([{ type: 'text', text: 'subagent chatter' }]) }); hidden.push('subagent chatter'); }
    if (i === 33) { add({ type: 'user', isMeta: true, message: { role: 'user', content: 'Continue from where you left off.' } }); add({ type: 'assistant', message: { ...msg([{ type: 'text', text: 'No response requested.' }]), model: '<synthetic>' } }); hidden.push('Continue from where you left off.', 'No response requested.'); }
    say(`Done with thing ${i}.`); said.push(`Done with thing ${i}.`);
    lines.push({ type: 'queue-operation', operation: 'dequeue', timestamp: new Date(clock).toISOString(), sessionId: id });
    if (i === Math.round(turns / 3) || i === Math.round((2 * turns) / 3)) compaction(i);
  }
  add({ type: 'user', origin: { kind: 'task-notification' }, promptSource: 'system', queueTranscriptOnly: true, message: { role: 'user', content: "<task-notification>\n<task-id>b1</task-id>\n<status>stopped</status>\n<summary>2 background shell command tasks didn't finish before the previous session ended.</summary>\n</task-notification>" } });
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const then = new Date(Date.now() - 10 * 60 * 1000); fs.utimesSync(file, then, then);
  return { id, file, said, hidden, lines };
}

// A stand-in for the Anthropic API, for the real Claude Code to talk to (ANTHROPIC_BASE_URL):
// turns run end to end - the CLI, the app, the page - offline, free and the same every time.
// An answer streams back a word at a time. A prompt with "[background]" in it is answered first
// with a background command (`sleep`), the way a render keeps a run alive after its answer;
// "[slow]" streams at 150 ms a word. `requests` lists what the CLI asked for.
export async function startFakeApi({ delay = 15 } = {}) {
  const requests = [];
  const userText = (m) => (typeof m?.content === 'string' ? m.content : (m?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const url = new URL(req.url, 'http://x');
    let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
    requests.push({ method: req.method, path: url.pathname, stream: !!j.stream, at: Date.now() });
    if (url.pathname.endsWith('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":12}'); }
    if (req.method !== 'POST' || !url.pathname.endsWith('/v1/messages')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"not_found_error","message":"not here"}}'); }
    const last = (j.messages || []).at(-1) || {};
    const afterTool = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
    const said = userText(last);
    const words = afterTool ? 'Started it in the background.' : /\[background\]/.test(said) ? null : `Answer to: ${(said.match(/Q\d+/) || ['it'])[0]}. Done.`;
    if (!j.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_' + requests.length, type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: words || 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 6 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const pace = /\[slow\]/.test(said) ? 150 : delay;
    send('message_start', { type: 'message_start', message: { id: 'msg_' + requests.length, type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } });
    if (words) {
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      for (const w of words.split(/(?<= )/)) { send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }); await new Promise((r) => setTimeout(r, pace)); }
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } });
    } else {
      const input = JSON.stringify({ command: 'sleep 20', description: 'Render the long video', run_in_background: true });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fake_' + requests.length, name: 'Bash', input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: input } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
    }
    send('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
// What the app needs to run Claude Code against the fake API: its address, a key it will accept,
// and none of the CLI's own traffic elsewhere.
export const fakeApiEnv = (api) => ({ ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-test-fake', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' });

// A stand-in for the npm registry, for Settings' Claude Code update. The newest SDK says which
// Claude Code it carries, and this platform's package is a real tarball holding `binary` - the
// Claude Code the app came with, under a newer number. Set `state.integrity` to break the checksum,
// `state.rate` to slow the download down.
export async function startFakeRegistry({ binary, key, sdk = '0.3.999', cli = '2.1.999' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-registry-'));
  const tgz = path.join(dir, 'package.tgz');
  const pkg = `@anthropic-ai/claude-agent-sdk-${key}`;
  await writeTarball(tgz, [['package/package.json', Buffer.from(JSON.stringify({ name: pkg, version: sdk }))], ['package/' + path.basename(binary), binary, 0o755]]);
  const hash = crypto.createHash('sha512'); for await (const c of fs.createReadStream(tgz)) hash.update(c);
  const state = { integrity: 'sha512-' + hash.digest('base64'), requests: [] };
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url); // npm writes a scoped name @scope%2fname
    state.requests.push(u);
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u === '/@anthropic-ai/claude-agent-sdk/latest') return json({ name: '@anthropic-ai/claude-agent-sdk', version: sdk, claudeCodeVersion: cli });
    if (u === `/${pkg}/${sdk}`) return json({ name: pkg, version: sdk, dist: { tarball: url + '/tarballs/package.tgz', integrity: state.integrity } });
    if (u === '/tarballs/package.tgz') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(tgz).size });
      if (!state.rate) return fs.createReadStream(tgz).pipe(res);
      // `state.rate` bytes a second, for a page to show the download as it goes.
      return void (async () => {
        for await (const c of fs.createReadStream(tgz, { highWaterMark: 1 << 20 })) {
          if (res.destroyed) return;
          if (!res.write(c)) await new Promise((r) => res.once('drain', r));
          await new Promise((r) => setTimeout(r, (1000 * c.length) / state.rate));
        }
        res.end();
      })();
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"Not found"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, sdk, cli, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} r(); }); }) };
}
// A gzipped ustar archive, the way npm packs one: a 512-byte header per file, its bytes padded to 512.
async function writeTarball(file, entries) {
  const header = (name, size, mode) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'latin1');
    h.write('0000000\0', 108, 'latin1'); h.write('0000000\0', 116, 'latin1');
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'latin1');
    h.write('        ', 148, 'latin1'); h[156] = 0x30; h.write('ustar\x0000', 257, 'latin1');
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
    return h;
  };
  async function* tar() {
    for (const [name, src, mode = 0o644] of entries) {
      const size = Buffer.isBuffer(src) ? src.length : fs.statSync(src).size;
      yield header(name, size, mode);
      if (Buffer.isBuffer(src)) yield src; else for await (const c of fs.createReadStream(src)) yield c;
      if (size % 512) yield Buffer.alloc(512 - (size % 512));
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(tar()), zlib.createGzip({ level: 1 }), fs.createWriteStream(file));
}

// The app, on its own port and data, with no app password: this computer only, and the
// open token for whoever signs in from it.
export async function startApp({ port, dataDir, configDir, env: extra = {} }) {
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', CLAUDE_ANYWHERE_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: configDir, ...extra };
  delete env.REMOTE_PASSWORD; delete env.CLAUDE_ANYWHERE_REMOTE_PASSWORD;
  if (extra.ANTHROPIC_API_KEY) delete env.CLAUDE_CODE_OAUTH_TOKEN; // the fake API's key, not a real login
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/api/config'); if (r.ok) break; } catch {}
    if (child.exitCode !== null) throw new Error('the app exited:\n' + log);
    await new Promise((r) => setTimeout(r, 150));
  }
  const { token } = await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '' }) })).json();
  return { base, token, log: () => log, stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', () => r()); child.kill(); }) };
}
