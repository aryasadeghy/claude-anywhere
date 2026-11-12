// Claude's Browser tools, named and worded as Desktop's Claude_Preview set. They act on the
// tab the person's Browser pane shows for this session (lib/browser.mjs), never a hidden one,
// and every call brings the pane forward on that tab so the person sees what Claude does.
//
// Asking: this computer's own pages (a dev server, a project file) are Claude's to open and
// use, as in Desktop. The web is not: opening a site, or clicking, filling or running script
// in one, goes through the normal permission prompt - decided per call by autoAllow below,
// since the same tool is harmless on localhost and not on someone's bank. preview_start runs
// a command from launch.json, which is Bash by another name, so it always asks.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import * as browser from './browser.mjs';

const LAUNCH_FORMAT = '```json\n{\n  "version": "0.0.1",\n  "configurations": [\n    { "name": "dev", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 5173 }\n  ]\n}\n```';
const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

// ---------- dev servers started with preview_start ----------
const servers = new Map(); // `${cwd}\n${name}` -> server
const killTree = (p) => { if (!p || p.exitCode !== null) return; if (process.platform === 'win32') execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {}); else { try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill(); } catch {} } } };
process.on('exit', () => { for (const s of servers.values()) { if (process.platform === 'win32' && s.proc?.exitCode === null) { try { s.proc.kill(); } catch {} } else killTree(s.proc); } });
const answers = (port) => new Promise((resolve) => {
  const req = http.get({ host: 'localhost', port, path: '/', timeout: 1500 }, (res) => { res.resume(); resolve(true); });
  req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
});
function readLaunch(cwd) {
  const file = path.join(cwd, '.claude', 'launch.json');
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '')); return { file, configs: Array.isArray(j.configurations) ? j.configurations : [] }; } catch (e) { return { file, configs: null, error: fs.existsSync(file) ? e.message : '' }; }
}
async function startServer(cwd, name) {
  const key = cwd + '\n' + name, had = servers.get(key);
  if (had && (had.external || had.proc?.exitCode === null) && (await answers(had.port))) return { server: had, reused: true };
  const { file, configs, error } = readLaunch(cwd);
  let cfg = configs?.find((c) => c.name === name);
  if (!cfg && !configs) {
    // No launch.json yet: a package.json script of that name is the obvious command.
    try { const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); if (pkg.scripts?.[name]) cfg = { name, runtimeExecutable: 'npm', runtimeArgs: ['run', name] }; } catch {}
  }
  if (!cfg) {
    if (error) throw new Error(`Could not read ${file}: ${error}`);
    if (configs) throw new Error(`No matching server in ${file}. Available servers: ${configs.map((c) => c.name).join(', ') || '(none)'}.`);
    throw new Error(`No ${file} and no package.json script called "${name}". Create it first with this format:\n${LAUNCH_FORMAT}`);
  }
  if (cfg.url && !cfg.runtimeExecutable) { const u = new URL(cfg.url); const s = { id: name, name, cwd, port: Number(u.port) || 80, url: cfg.url, external: true, lines: [], startedAt: Date.now() }; servers.set(key, s); return { server: s, reused: true }; }
  const port = Number(cfg.port) || 0;
  if (port && (await answers(port))) { const s = { id: name, name, cwd, port, url: `http://localhost:${port}/`, external: true, lines: [], startedAt: Date.now() }; servers.set(key, s); return { server: s, reused: true }; }
  const exe = cfg.runtimeExecutable || (cfg.program ? 'node' : '');
  if (!exe) throw new Error(`"${name}" in ${file} needs "runtimeExecutable" (optionally with "runtimeArgs") or "program". Expected format:\n${LAUNCH_FORMAT}`);
  const args = [...(cfg.program ? [cfg.program] : []), ...(cfg.runtimeArgs || []), ...(cfg.args || [])].map(String);
  const win = process.platform === 'win32';
  const proc = spawn(exe, win ? args.map((a) => (/[\s&|<>^"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)) : args, { cwd: cfg.cwd ? path.resolve(cwd, cfg.cwd) : cwd, env: { ...process.env, ...(cfg.env || {}), ...(port ? { PORT: String(port) } : {}), FORCE_COLOR: '0' }, shell: win, detached: !win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const s = { id: name, name, cwd, port, url: port ? `http://localhost:${port}/` : '', proc, lines: [], startedAt: Date.now(), command: [exe, ...args].join(' ') };
  servers.set(key, s);
  const take = (d) => {
    for (const l of String(d).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)) if (l.trim()) { s.lines.push(l); if (!s.port) { const m = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d+)/.exec(l); if (m) { s.port = Number(m[1]); s.url = `http://localhost:${s.port}/`; } } }
    if (s.lines.length > 2000) s.lines.splice(0, s.lines.length - 2000);
  };
  proc.stdout.on('data', take); proc.stderr.on('data', take);
  let exited = null; proc.on('exit', (code) => { exited = code ?? 'signal'; });
  proc.on('error', (e) => { exited = e.code || e.message; s.lines.push(String(e.message)); });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (exited !== null) throw new Error(`The server exited during startup (${exited}). Last output:\n${s.lines.slice(-20).join('\n')}`);
    if (s.port && (await answers(s.port))) return { server: s, reused: false };
    await new Promise((r) => setTimeout(r, 300));
  }
  return { server: s, reused: false, slow: true };
}

export default function (run) {
  const key = () => run.sessionId || '';
  const show = (tab) => run.push({ t: 'browser_show', tab: browser.info(tab) });
  const serverFor = (id) => [...servers.values()].find((s) => s.id === id && s.cwd === run.cwd) || [...servers.values()].find((s) => s.id === id);
  // The pane's tab for this session - on a server Claude named, if it is not there already.
  async function tabOf(serverId) {
    const tab = await browser.tabFor(key());
    const s = serverId && serverFor(serverId);
    if (s?.port && browser.specOf(tab.url).port !== s.port) { await browser.navigate(tab, s.url || `http://localhost:${s.port}/`); await browser.settle(tab); }
    show(tab);
    return tab;
  }
  const guard = (fn) => async (args) => {
    if (!browser.available()) return text('No Chrome or Edge on the computer that runs claude-anywhere, so the Browser pane cannot be driven. Install one, or set CLAUDE_ANYWHERE_BROWSER to its path.', true);
    try { return await fn(args); } catch (e) { return text(String(e?.message || e), true); }
  };
  const serverId = z.string().optional().describe('Server ID from preview_start or preview_list; leave out to act on the tab the Browser pane is showing');
  const READS = new Set(['preview_list', 'preview_logs', 'preview_console_logs', 'preview_screenshot', 'preview_snapshot', 'preview_inspect', 'preview_network', 'preview_resize', 'preview_stop']);

  return {
    allow: [], // every call is decided by autoAllow, below
    autoAllow: (name, input) => READS.has(name)
      || (name === 'preview_navigate' && browser.isLocalUrl(String(input?.url || '')))
      || (['preview_click', 'preview_fill', 'preview_eval'].includes(name) && browser.isLocalUrl(browser.currentUrl(key()))),
    tools: [
      tool('preview_start', `Start a dev server by name from .claude/launch.json and open it in the Browser pane. If .claude/launch.json doesn't exist, create it first with this format:\n${LAUNCH_FORMAT}\nReuses the server if already running. ALWAYS use this instead of Bash for running servers.`,
        { name: z.string().describe('Server name from .claude/launch.json.') },
        guard(async ({ name }) => {
          const { server: s, reused, slow } = await startServer(run.cwd, name);
          if (!s.port) return text(`Started "${name}" (${s.command}) but could not tell which port it serves on yet. Add "port" to its configuration, or check preview_logs.`);
          const tab = await browser.tabFor(key());
          await browser.navigate(tab, s.url); await browser.settle(tab); show(tab);
          return text(`${reused ? 'Reusing' : 'Started'} server "${name}" (serverId: ${s.id}) at ${s.url}${slow ? ' - it has not answered yet, check preview_logs' : ''}. It is open in the Browser pane.`);
        })),
      tool('preview_stop', 'Stop a server started with preview_start.',
        { serverId: z.string().describe('Server ID to stop') },
        guard(async ({ serverId: id }) => {
          const s = serverFor(id); if (!s) return text(`No server "${id}". preview_list shows them.`, true);
          for (const [k, v] of servers) if (v === s) servers.delete(k);
          if (s.external) return text(`"${id}" was already running before preview_start, so it was left running; it is no longer listed.`);
          killTree(s.proc);
          return text(`Stopped "${id}".`);
        })),
      tool('preview_list', 'List servers started with preview_start. Returns serverIds for use with other preview_* tools.', {},
        guard(async () => {
          const list = [...servers.values()].filter((s) => s.cwd === run.cwd);
          const tab = await browser.tabFor(key(), { create: false });
          const lines = list.map((s) => `- ${s.id}: ${s.url || '(port not known yet)'} ${s.external ? '(already running)' : s.proc?.exitCode === null ? '(running)' : '(exited)'}`);
          return text((lines.length ? lines.join('\n') : 'No servers started with preview_start.') + (tab ? `\nThe Browser pane shows: ${tab.url || 'a blank tab'}` : ''));
        })),
      tool('preview_logs', "Get server stdout/stderr output. Use to check for build errors, verify server behavior, or read debug output. Use 'level' to filter to errors only, or 'search' to filter for specific text. Use after preview_start.",
        { serverId: z.string().describe('Server ID'), level: z.enum(['all', 'error']).optional().describe("Filter by level: 'all' (default) shows all output, 'error' shows only lines containing error/exception/failed/fatal"), lines: z.number().optional().describe('Max lines to return (default: 50)'), search: z.string().optional().describe("Filter to lines containing this text (e.g., '[DEBUG]', 'POST /api')") },
        guard(async ({ serverId: id, level, lines = 50, search }) => {
          const s = serverFor(id); if (!s) return text(`No server "${id}". preview_list shows them.`, true);
          let out = s.lines;
          if (level === 'error') out = out.filter((l) => /error|exception|failed|fatal/i.test(l));
          if (search) out = out.filter((l) => l.includes(search));
          return text(out.slice(-Math.max(1, lines)).join('\n') || (s.external ? 'This server was already running before preview_start; its output is not visible here.' : '(no output)'));
        })),
      tool('preview_navigate', 'Open an address in the Browser pane tab: a dev server (localhost:5173/path, or just 5173), a page on the web, or a project file path. Pages on this computer open straight away; a web address asks the person first.',
        { url: z.string().describe('The address: http(s) URL, localhost:PORT/path, a port number, or an absolute path to an HTML/PDF file'), serverId },
        guard(async ({ url }) => {
          const tab = await browser.tabFor(key());
          let to = String(url).trim();
          if (/^\d{1,5}(\/.*)?$/.test(to)) to = 'http://localhost:' + to;
          else if (/^([A-Za-z]:[\\/]|\/)/.test(to) && /\.(html?|pdf|svg|png|jpe?g)$/i.test(to)) to = browser.urlOf({ kind: 'file', file: to });
          else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(to)) to = (browser.isLocalUrl(to) ? 'http://' : 'https://') + to;
          if (!/^https?:\/\//i.test(to)) return text('Only http and https addresses open in the Browser pane.', true);
          await browser.navigate(tab, to); await browser.settle(tab); show(tab);
          return text(`Opened ${tab.url}${tab.title ? ` ("${tab.title}")` : ''} in the Browser pane.`);
        })),
      tool('preview_console_logs', "Get browser console output (log, info, warn, error, debug). Use to check runtime behavior, debug values, or client-side errors. Use 'level' to filter to errors or warnings only.",
        { serverId, level: z.enum(['all', 'error', 'warn']).optional().describe("Filter by level: 'all' (default), 'error' (errors only), 'warn' (warnings + errors)"), lines: z.number().optional().describe('Max lines to return (default: 50, max: 200)') },
        guard(async ({ serverId: id, level, lines = 50 }) => {
          const tab = await tabOf(id);
          let logs = browser.consoleLogs(tab);
          if (level === 'error') logs = logs.filter((l) => l.level === 'error');
          if (level === 'warn') logs = logs.filter((l) => l.level === 'error' || l.level === 'warn');
          return text(logs.slice(-Math.min(200, Math.max(1, lines))).map((l) => `[${l.level}] ${l.text}`).join('\n') || '(no console output)');
        })),
      tool('preview_screenshot', 'Take a screenshot of the page. Good for checking layout and general appearance, but DO NOT rely on it for verifying colors, font sizes, or precise styles - use preview_inspect with specific CSS properties instead. Returns a compressed JPEG image.',
        { serverId, scale: z.number().optional().describe('Scale factor in [0.1, 1] for the returned image; smaller images use fewer tokens. preview_click uses CSS selectors or refs from preview_snapshot, not pixel coordinates.') },
        guard(async ({ serverId: id, scale }) => {
          const tab = await tabOf(id);
          const data = await browser.screenshot(tab, { scale: scale ?? 1, quality: 70 });
          return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }, { type: 'text', text: `${tab.url}${tab.title ? ` - "${tab.title}"` : ''}` }] };
        })),
      tool('preview_snapshot', 'Get an accessibility tree snapshot of the page. Returns exact text content, roles, and element refs for use with click/fill. PREFERRED over screenshot for verifying text, element presence, and page structure.',
        { serverId },
        guard(async ({ serverId: id }) => { const tab = await tabOf(id); return text(`${tab.url}\n${await browser.snapshot(tab)}`); })),
      tool('preview_inspect', 'Inspect a DOM element by CSS selector. Returns text content, className, tagName, id, computed styles, and bounding box. BEST tool for verifying visual properties like colors, fonts, spacing, and dimensions - more accurate than screenshots.',
        { serverId, selector: z.string().describe("CSS selector (e.g., '.button', '#header')"), styles: z.array(z.string()).optional().describe("CSS properties to return (e.g., ['padding', 'color']). Defaults to common properties.") },
        guard(async ({ serverId: id, selector, styles }) => { const tab = await tabOf(id); return text(JSON.stringify(await browser.inspect(tab, selector, styles), null, 2)); })),
      tool('preview_click', `Click an element by CSS selector (e.g., 'button.primary', '#submit', '[data-testid="btn"]') or by a ref from preview_snapshot (e.g., 'e42').`,
        { serverId, selector: z.string().optional().describe('CSS selector for the element to click'), ref: z.string().optional().describe('Element ref from preview_snapshot, instead of a selector'), doubleClick: z.boolean().optional().describe('Perform a double-click') },
        guard(async ({ serverId: id, selector, ref, doubleClick }) => {
          if (!selector && !ref) return text('Give a selector or a ref.', true);
          const tab = await tabOf(id);
          const at = await browser.click(tab, { selector, ref }, { double: !!doubleClick });
          await browser.settle(tab, 5000);
          return text(`Clicked <${at.tag}>${at.text ? ` "${at.text}"` : ''}. The page is now ${tab.url}.`);
        })),
      tool('preview_fill', 'Fill an input, textarea, or select element with a value. For select elements, matches by value or text.',
        { serverId, selector: z.string().optional().describe('CSS selector for the input element'), ref: z.string().optional().describe('Element ref from preview_snapshot, instead of a selector'), value: z.string().describe('Value to fill') },
        guard(async ({ serverId: id, selector, ref, value }) => {
          if (!selector && !ref) return text('Give a selector or a ref.', true);
          const tab = await tabOf(id);
          const r = await browser.fill(tab, { selector, ref }, value);
          return text(`Filled <${r.tag}> with ${JSON.stringify(r.value)}.`);
        })),
      tool('preview_eval', "Execute JavaScript in the Browser pane's page for DEBUGGING and INSPECTION only. Use for reading page state, DOM queries, checking variables, navigation, page reload, hover/type/key events. Do NOT use this to implement UI changes the user requests - edit the source code instead. Any DOM modifications via eval are temporary and lost on reload. Wrap multi-step logic in an IIFE.",
        { serverId, expression: z.string().describe('JavaScript expression to evaluate in the page context. Return values are serialized as JSON.') },
        guard(async ({ serverId: id, expression }) => {
          const tab = await tabOf(id);
          const v = await browser.evaluate(tab, expression);
          const out = v === undefined ? 'undefined' : typeof v === 'string' ? v : JSON.stringify(v, null, 2);
          return text(out.length > 30000 ? out.slice(0, 30000) + '\n… (cut short)' : out);
        })),
      tool('preview_network', 'List network requests or inspect a specific response body. Without requestId, lists all requests with URL, method, status, and requestId. With requestId, returns the full response body for that request (useful for inspecting API payloads).',
        { serverId, filter: z.enum(['all', 'failed']).optional().describe("Filter: 'all' (default) shows all requests, 'failed' shows only 4xx/5xx and network errors. Ignored when requestId is provided."), requestId: z.string().optional().describe('If provided, returns the response body for this specific request instead of listing all requests. Get requestIds from the listing output.') },
        guard(async ({ serverId: id, filter, requestId }) => {
          const tab = await tabOf(id);
          if (requestId) { const b = await browser.responseBody(tab, requestId); return text(b.length > 50000 ? b.slice(0, 50000) + '\n… (cut short)' : b); }
          let list = browser.requests(tab);
          if (filter === 'failed') list = list.filter((r) => r.failed || r.status >= 400);
          return text(list.slice(-200).map((r) => `${r.id} ${r.method} ${r.failed ? 'FAILED (' + r.failed + ')' : r.status || '…'} ${r.url.slice(0, 300)}`).join('\n') || '(no requests yet)');
        })),
      tool('preview_resize', 'Emulate a viewport size in the Browser pane tab to test responsive layouts. Presets: mobile (375x812), tablet (768x1024), or desktop, which clears the size emulation and returns the tab to the pane\'s own size. Custom sizes need both width and height. Reset it with preset "desktop" as soon as you finish testing. colorScheme (light/dark) emulates prefers-color-scheme on that tab. The mobile preset (and any width < 768) also emulates a mobile device: a phone user agent and touch points. Reload the page after switching so load-time device gates re-run.',
        { serverId, preset: z.enum(['mobile', 'tablet', 'desktop']).optional().describe('Device preset. Overrides width/height if provided. "desktop" clears the size emulation (back to the pane\'s size).'), width: z.number().optional().describe('Viewport width in CSS pixels (requires height)'), height: z.number().optional().describe('Viewport height in CSS pixels (requires width)'), colorScheme: z.enum(['light', 'dark']).optional().describe('Emulate prefers-color-scheme media feature for dark/light mode testing.') },
        guard(async ({ serverId: id, preset, width, height, colorScheme }) => {
          const tab = await tabOf(id);
          const emu = preset === 'desktop' ? null : preset ? browser.PRESETS[preset] : width && height ? { width, height } : undefined;
          if (emu === undefined && !colorScheme) return text('Give a preset, both width and height, or a colorScheme.', true);
          await browser.emulate(tab, emu === undefined ? tab.emu : emu, colorScheme ? { scheme: colorScheme } : {});
          return text(tab.emu ? `The tab is now ${tab.emu.width}x${tab.emu.height}${tab.emu.mobile ? ' (mobile)' : ''}${colorScheme ? ', ' + colorScheme : ''}.` : `The tab is back to the pane's own size${colorScheme ? ', ' + colorScheme : ''}.`);
        })),
    ],
  };
}
