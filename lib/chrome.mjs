// Claude in Chrome: Claude driving the person's own Chrome, with their logins and tabs, through
// Anthropic's extension. Claude Code has all of it built in - a `--chrome` flag that adds the
// `claude-in-chrome` connector (its tools are `mcp__claude-in-chrome__*`), and a native-messaging
// host (`claude --chrome-native-host`) that Chrome starts for the extension and that links it to
// the CLI. This module is the two things the app adds: turning the flag on for a run, and showing
// whether the three pieces on this computer (a browser, the extension, the host) are in place.
//
// Read from the CLI's own code (2.1.3xx), so what is checked and written here is what it does:
//   - the extension is found as a folder `<user data>/<Default|Profile N>/Extensions/<id>`;
//   - the host is registered by a manifest `com.anthropic.claude_code_browser_extension.json` that
//     names a wrapper script, `<config dir>/chrome/chrome-native-host(.bat)`, which runs
//     `claude --chrome-native-host`. On Windows the manifest is in %APPDATA%\Claude Code\
//     ChromeNativeHost and each browser's registry key (HKCU\Software\...\NativeMessagingHosts\<name>)
//     points at it; on macOS and Linux the manifest sits in the browser's NativeMessagingHosts folder;
//   - a session started with Chrome on writes all of it again, pointing at the binary that session
//     runs - which is how an update of Claude Code repairs a host left pointing at the old one.
// `connect()` does the same writing without a session, so the first turn does not have to be the
// one that sets it up (Chrome only reads a new host when it starts, and the extension needs a
// reconnect the first time).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import * as claudeCode from './claude-code.mjs';

export const EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
export const HOST_NAME = 'com.anthropic.claude_code_browser_extension';
export const STORE_URL = 'https://chromewebstore.google.com/detail/claude/' + EXTENSION_ID;
export const INSTALL_URL = 'https://claude.ai/chrome';
const SERVER = 'claude-in-chrome';

// The browsers the extension runs in that people have, by the CLI's own table. `user` is the profile
// root under the OS's per-user data folder (LOCALAPPDATA on Windows), `reg` the key under HKCU.
const BROWSERS = [
  { id: 'chrome', name: 'Chrome', reg: 'Software\\Google\\Chrome', win: ['Google', 'Chrome', 'User Data'], mac: ['Library', 'Application Support', 'Google', 'Chrome'], linux: ['.config', 'google-chrome'] },
  { id: 'edge', name: 'Edge', reg: 'Software\\Microsoft\\Edge', win: ['Microsoft', 'Edge', 'User Data'], mac: ['Library', 'Application Support', 'Microsoft Edge'], linux: ['.config', 'microsoft-edge'] },
  { id: 'brave', name: 'Brave', reg: 'Software\\BraveSoftware\\Brave-Browser', win: ['BraveSoftware', 'Brave-Browser', 'User Data'], mac: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'], linux: ['.config', 'BraveSoftware', 'Brave-Browser'] },
];

// Where things are. CA_CHROME_HOME stands the whole machine in (a folder with its own
// AppData, .claude and a registry.json), so the tests can run every path of this module without
// touching the real browser, registry or Claude folder.
function where() {
  const fake = process.env.CA_CHROME_HOME || '';
  const platform = process.env.CA_CHROME_PLATFORM || process.platform;
  const home = fake || os.homedir();
  const local = fake ? path.join(fake, 'AppData', 'Local') : process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  // The CLI's own choice: APPDATA when set, else the Local folder (odd, but it is where it writes).
  const appData = fake ? path.join(fake, 'AppData', 'Roaming') : process.env.APPDATA || path.join(home, 'AppData', 'Local');
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return { fake, platform, home, local, appData, configDir, registry: process.env.CA_CHROME_REGISTRY || (fake ? path.join(fake, 'registry.json') : '') };
}

const userData = (w, b) => (w.platform === 'win32' ? path.join(w.local, ...b.win) : w.platform === 'darwin' ? path.join(w.home, ...b.mac) : path.join(w.home, ...b.linux));
const manifestDir = (w, b) => (w.platform === 'win32' ? path.join(w.appData, 'Claude Code', 'ChromeNativeHost') : path.join(userData(w, b), 'NativeMessagingHosts'));
const manifestFile = (w, b) => path.join(manifestDir(w, b), HOST_NAME + '.json');
const wrapperFile = (w) => path.join(w.configDir, 'chrome', w.platform === 'win32' ? 'chrome-native-host.bat' : 'chrome-native-host');
const regKey = (b) => `HKCU\\${b.reg}\\NativeMessagingHosts\\${HOST_NAME}`;

// The Windows registry, or the test's stand-in for it (a JSON file of key -> value).
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })));
const fakeReg = (w) => { try { return JSON.parse(fs.readFileSync(w.registry, 'utf8')); } catch { return {}; } };
async function regGet(w, key) {
  if (w.registry) return fakeReg(w)[key] || '';
  const r = await run('reg', ['query', key, '/ve']);
  if (r.code !== 0) return '';
  return (/REG_SZ\s+(.+?)\s*$/m.exec(r.stdout) || [])[1] || '';
}
async function regSet(w, key, value) {
  if (w.registry) { const all = fakeReg(w); all[key] = value; fs.mkdirSync(path.dirname(w.registry), { recursive: true }); fs.writeFileSync(w.registry, JSON.stringify(all, null, 2)); return true; }
  return (await run('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'])).code === 0;
}

// The binary a session would run: the one Settings picked, else the one the app came with.
export const binary = () => claudeCode.spawnOptions().pathToClaudeCodeExecutable || claudeCode.bundled().file;

// The profile folders of a browser that hold the extension.
function profilesWithExtension(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && (d.name === 'Default' || d.name.startsWith('Profile '))).map((d) => d.name); } catch {}
  for (const n of names) { try { if (fs.statSync(path.join(dir, n, 'Extensions', EXTENSION_ID)).isDirectory()) out.push(n); } catch {} }
  return out;
}

// What the wrapper runs, read back from its text: the first quoted path of its command line.
function wrapperTarget(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { exists: false, target: '' }; }
  const line = text.split(/\r?\n/).filter((l) => l && !/^(@echo|REM|#)/i.test(l.trim())).pop() || '';
  const m = /^(?:exec\s+)?(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/.exec(line.trim());
  const target = (m && (m[1] ?? m[2] ?? m[3]) || '').replace(/%%/g, '%');
  return { exists: true, target };
}

/**
 * What is in place on this computer for each browser.
 * -> { platform, supported, extensionId, binary, browsers: [{ id, name, found, extension, profiles, registered,
 *      manifest, manifestOk, wrapper, target, targetExists }], state, text }
 * `state`: 'unsupported' | 'no-browser' | 'no-extension' | 'no-host' | 'stale' | 'ready'.
 */
export async function status() {
  const w = where();
  const bin = binary();
  const out = { platform: w.platform, supported: w.platform !== 'linux' || !process.env.WSL_DISTRO_NAME, extensionId: EXTENSION_ID, binary: bin, storeUrl: STORE_URL, installUrl: INSTALL_URL, browsers: [] };
  const wrap = wrapperTarget(wrapperFile(w));
  for (const b of BROWSERS) {
    const dir = userData(w, b);
    const found = fs.existsSync(dir);
    const profiles = found ? profilesWithExtension(dir) : [];
    const mf = manifestFile(w, b);
    // Windows asks the registry which manifest the browser will read; the others read the folder.
    const pointsAt = w.platform === 'win32' ? await regGet(w, regKey(b)) : fs.existsSync(mf) ? mf : '';
    let manifest = null;
    if (pointsAt) { try { manifest = JSON.parse(fs.readFileSync(pointsAt, 'utf8')); } catch {} }
    const registered = !!manifest && manifest.name === HOST_NAME;
    const hostPath = registered ? String(manifest.path || '') : '';
    const hostWrap = hostPath && path.resolve(hostPath) === path.resolve(wrapperFile(w)) ? wrap : hostPath ? wrapperTarget(hostPath) : { exists: false, target: '' };
    const manifestOk = registered && (manifest.allowed_origins || []).includes(`chrome-extension://${EXTENSION_ID}/`) && hostWrap.exists;
    out.browsers.push({ id: b.id, name: b.name, found, extension: profiles.length > 0, profiles, registered, manifest: pointsAt, manifestOk, wrapper: hostPath, target: hostWrap.target, targetExists: !!hostWrap.target && fs.existsSync(hostWrap.target) });
  }
  const here = out.browsers.filter((b) => b.found);
  const withExt = here.filter((b) => b.extension);
  const hostOk = (withExt.length ? withExt : here).some((b) => b.manifestOk && b.targetExists);
  const hostAny = here.some((b) => b.registered);
  out.state = !out.supported ? 'unsupported' : !here.length ? 'no-browser' : !withExt.length ? 'no-extension' : hostOk ? 'ready' : hostAny ? 'stale' : 'no-host';
  // The extension can be missing and the host fine: the host is the part this app sets up, so say it separately.
  out.host = hostOk ? 'ok' : hostAny ? 'stale' : 'missing';
  out.extension = withExt.length > 0;
  out.account = { ok: !accountReason(), reason: accountReason() };
  return out;
}

const quoteSh = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
// The wrapper's text, byte for byte what the CLI writes, so a session's own rewrite finds it unchanged.
function wrapperText(w, argv) {
  return w.platform === 'win32'
    ? `@echo off\nREM Chrome native host wrapper script\nREM Generated by Claude Code - do not edit manually\n${argv.map((s) => `"${s.replaceAll('%', '%%')}"`).join(' ')}\n`
    : `#!/bin/sh\n# Chrome native host wrapper script\n# Generated by Claude Code - do not edit manually\nexec ${argv.map(quoteSh).join(' ')}\n`;
}

/**
 * Registers the native host for every browser this computer has, the way a session with Chrome on
 * does: the wrapper script, one manifest, and on Windows a registry key per browser. Idempotent.
 * -> the new status().
 */
export async function connect() {
  const w = where();
  const bin = binary();
  if (!bin) throw Object.assign(new Error('Claude Code was not found on this computer.'), { status: 409 });
  const here = BROWSERS.filter((b) => fs.existsSync(userData(w, b)));
  if (!here.length) throw Object.assign(new Error('Chrome is not installed on this computer.'), { status: 409 });
  const wrap = wrapperFile(w);
  fs.mkdirSync(path.dirname(wrap), { recursive: true });
  const text = wrapperText(w, [bin, '--chrome-native-host']);
  let had = ''; try { had = fs.readFileSync(wrap, 'utf8'); } catch {}
  if (had !== text) fs.writeFileSync(wrap, text);
  if (w.platform !== 'win32') { try { fs.chmodSync(wrap, 0o755); } catch {} }
  const manifest = JSON.stringify({ name: HOST_NAME, description: 'Claude Code Browser Extension Native Host', path: wrap, type: 'stdio', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] }, null, 2);
  for (const b of here) {
    const file = manifestFile(w, b);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let cur = ''; try { cur = fs.readFileSync(file, 'utf8'); } catch {}
    if (cur !== manifest) fs.writeFileSync(file, manifest);
    if (w.platform === 'win32' && !(await regSet(w, regKey(b), file))) throw Object.assign(new Error('Windows would not take the registration for ' + b.name + '.'), { status: 500 });
  }
  return status();
}

// ---------- what a run is told ----------
// Whether a session starts Claude Code with Chrome. The server says how (its preferences); this
// module only keeps the answer in one place for lib/runs.mjs.
let policy = () => false;
export const setPolicy = (fn) => { policy = fn; };
export const wanted = (sessionId) => { try { return !!policy(sessionId); } catch { return false; } };
// The CLI's own switch is `--chrome` (lib/runs.mjs passes it as extraArgs): a project's settings cannot turn it on,
// on purpose, so a repository cannot connect Claude to a browser.
// The CLI keeps Chrome off for a login that is a pasted token, an API key or a provider (the extension cannot sign in with
// those), so a turn started with --chrome under one would only fail. The server says which account is active; the
// setting stays on and waits for the right one.
export const NEEDS_LOGIN = "Claude in Chrome needs this computer's own Claude login, not a pasted token or API key. Switch the account to This computer to use it.";
let account = () => 'local';
export const setAccount = (fn) => { account = fn; };
export const accountReason = () => { try { return account() === 'local' ? '' : NEEDS_LOGIN; } catch { return ''; } };
// Whether a run for this session is started with --chrome: asked for, and able.
export const willRun = (sessionId) => wanted(sessionId) && !accountReason();
export const toolPrefix = `mcp__${SERVER}__`;

// What the system prompt says when Chrome is on (lib/app-prompt.mjs).
export const PROMPT = `You can drive the user's own Chrome with the \`${toolPrefix}*\` tools: their tabs and their sign-ins, so use it for what needs a login or a page only they can see (their email, a dashboard, a site they are signed in to). Start with \`${toolPrefix}tabs_context_mcp\` and work in a tab of your own rather than one they have open. For the project's own pages and dev servers use the app's Browser pane (the \`preview_*\` tools) instead: it needs no extension and does not touch their browser. Ask before anything that cannot be undone on a site (buying, sending, deleting).`;
