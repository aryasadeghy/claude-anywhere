// Getting a newer release onto this computer without anyone having to remember to.
//
// lib/update.mjs only knows what GitHub says. This is what the title bar's "Relaunch to
// update" button reads: the release is fetched in the background as soon as it is
// announced, so pressing the button is instant, and Claude is never interrupted by an
// update unless the person says "anyway".
//
// Two kinds of computer, one button:
//   installer  an installed app. The release's installer is downloaded to DATA_DIR/updates
//              and update.ps1 runs it (closing the window, reopening it afterwards).
//   checkout   a server running from a git clone — the developer's. It never had an
//              installer to run and used to sit on month-old code. The release tag is
//              fetched and fast-forwarded to, then the server restarts.

import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const git = (dir, args, o = {}) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim();
const gitTry = (dir, args) => { try { return git(dir, args); } catch { return null; } };

// ---------- the decisions (pure enough to test against a temp repository) ----------

export const isCheckout = (dir) => fs.existsSync(path.join(dir, '.git'));

/**
 * What a checkout looks like right now. package-lock.json is allowed to differ because
 * `npm install` rewrites it on every machine and nobody means that as a change.
 */
export function checkoutInfo(dir) {
  const branch = gitTry(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || '';
  const lines = (gitTry(dir, ['status', '--porcelain']) || '').split('\n').filter(Boolean);
  // The command's output is trimmed, which eats the first line's leading space: take the status word off by shape, not by column.
  const files = lines.map((l) => l.replace(/^\S+\s+/, '').replace(/^"|"$/g, ''));
  const dirty = files.filter((f) => f !== 'package-lock.json');
  return { branch, dirty, lockDirty: files.includes('package-lock.json') };
}

/** Can this checkout move to `tag`? Needs the tag already fetched. */
export function planCheckout(dir, tag) {
  const info = checkoutInfo(dir);
  if (info.branch !== 'main') return { ok: false, reason: `This checkout is on ${info.branch || 'no branch'}, and updating only moves main. Switch to main to update.` };
  if (info.dirty.length) return { ok: false, reason: `This checkout has uncommitted changes (${info.dirty.slice(0, 3).join(', ')}${info.dirty.length > 3 ? ', …' : ''}). Commit or stash them to update.` };
  const commit = gitTry(dir, ['rev-parse', '--verify', `${tag}^{commit}`]);
  if (!commit) return { ok: false, reason: `The release tag ${tag} is not on origin yet.` };
  const head = gitTry(dir, ['rev-parse', 'HEAD']);
  if (head === commit) return { ok: false, reason: `Already at ${tag}.` };
  if (gitTry(dir, ['merge-base', '--is-ancestor', 'HEAD', commit]) === null) return { ok: false, reason: `This checkout has commits that ${tag} does not contain, so it cannot be fast-forwarded. Rebase or merge it by hand.` };
  const changed = (gitTry(dir, ['diff', '--name-only', 'HEAD', commit]) || '').split('\n');
  return { ok: true, commit, head, lockChanged: changed.includes('package-lock.json') || changed.includes('package.json') };
}

/** Fast-forward to the plan's commit, `npm install` when the dependencies moved. */
export async function applyCheckout(dir, tag, { install = true } = {}) {
  const plan = planCheckout(dir, tag);
  if (!plan.ok) throw Object.assign(new Error(plan.reason), { status: 409 });
  // npm rewrites the lock file locally; leaving that edit in place would make a merge that
  // touches the same file refuse, and npm install writes it again anyway.
  if (checkoutInfo(dir).lockDirty) git(dir, ['checkout', '--', 'package-lock.json']);
  git(dir, ['merge', '--ff-only', plan.commit], { timeout: 60000 });
  let installed = false;
  if (install && plan.lockChanged) {
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, timeout: 600000, windowsHide: true, shell: process.platform === 'win32' });
    installed = true;
  }
  return { from: plan.head, to: plan.commit, installed };
}

// The first few lines of a release's notes, without the markdown.
export const notesHead = (md, n = 6) => String(md || '').split('\n').map((l) => l.replace(/^[#>\s*-]+/, '').replace(/[*_`]/g, '').trim()).filter(Boolean).slice(0, n);

// ---------- the downloaded installer ----------

/**
 * Fetch `asset` into `dir`, picking up a partial file where it stopped. Nothing but a
 * complete file of the announced size ever gets the real name, so nothing can run a
 * half-written installer.
 */
export async function downloadAsset(asset, dir, onProgress = () => {}, fetchFn = fetch) {
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, path.basename(asset.name));
  const part = final + '.part';
  const size = Number(asset.size) || 0;
  try { if (fs.statSync(final).size === size || (!size && fs.statSync(final).size > 0)) { onProgress(fs.statSync(final).size, size); return final; } } catch {}
  for (let attempt = 0; attempt < 2; attempt++) {
    let have = 0; try { have = fs.statSync(part).size; } catch {}
    if (size && have > size) { fs.rmSync(part, { force: true }); have = 0; }
    const res = await fetchFn(asset.url, { redirect: 'follow', headers: { 'User-Agent': 'claude-anywhere', ...(have ? { Range: `bytes=${have}-` } : {}) } });
    // 416: what we hold is not a prefix of anything the server has. Start over once.
    if (res.status === 416 && attempt === 0) { fs.rmSync(part, { force: true }); continue; }
    if (!res.ok) throw new Error(`The download answered ${res.status}`);
    // A server that ignores Range sends the whole file with a 200; appending it would corrupt the file.
    if (res.status === 200) have = 0;
    const total = size || have + (Number(res.headers.get('content-length')) || 0);
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    let got = have;
    try {
      for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        got += chunk.length; onProgress(got, total);
      }
    } finally { await new Promise((r) => out.end(r)); }
    const final_size = fs.statSync(part).size;
    if (size && final_size !== size) throw new Error(`The download stopped at ${final_size} of ${size} bytes. It picks up from there next time.`);
    fs.renameSync(part, final);
    return final;
  }
  throw new Error('The download could not be resumed.');
}

// ---------- the thing the button reads ----------

/**
 * deps: dataDir, dir (the server's own directory), platform, status() (lib/update.mjs's
 * answer), busy() (how many chats are at work), launchInstaller(file) and restartServer()
 * (server.mjs owns both: they are how this process gets replaced), canInstall.
 */
export function createUpdater(deps) {
  const updDir = path.join(deps.dataDir, 'updates');
  const mode = () => process.env.CLAUDE_ANYWHERE_UPDATE_MODE || (isCheckout(deps.dir) ? 'checkout' : 'installer');
  let dl = { state: 'idle', got: 0, total: 0, file: '', error: '', retryAt: 0, tag: '' };
  let plan = null; // checkout: { tag, ok, reason, … }
  let planning = null;
  let waiting = false;
  let action = { kind: '', text: '', error: '', done: false };
  let timer = null;

  const writeReady = (file, version) => { try { fs.writeFileSync(path.join(updDir, 'ready.json'), JSON.stringify({ file, version, at: Date.now() })); } catch {} };
  const clearReady = () => { try { fs.rmSync(path.join(updDir, 'ready.json'), { force: true }); } catch {} };

  async function planFor(tag) {
    if (plan?.tag === tag && Date.now() - plan.at < 10 * 60 * 1000) return;
    if (planning) return planning;
    planning = (async () => {
      let fetchError = '';
      try { await run('git', ['-C', deps.dir, 'fetch', 'origin', '--tags', '--quiet'], { timeout: 60000, windowsHide: true }); } catch (e) { fetchError = String(e.stderr || e.message || e).trim().split('\n')[0]; }
      plan = { tag, at: Date.now(), ...planCheckout(deps.dir, tag) };
      if (fetchError && !plan.ok) plan.reason += ` (git fetch said: ${fetchError})`;
    })().finally(() => { planning = null; });
    return planning;
  }

  async function startDownload(st) {
    const a = st.download;
    if (!a?.url || dl.state === 'downloading' || (dl.state === 'ready' && dl.tag === st.latest)) return;
    if (dl.state === 'error' && Date.now() < dl.retryAt) return;
    dl = { state: 'downloading', got: 0, total: a.size || 0, file: '', error: '', retryAt: 0, tag: st.latest };
    try {
      const file = await downloadAsset(a, updDir, (got, total) => { dl.got = got; dl.total = total; });
      dl = { ...dl, state: 'ready', file };
      writeReady(file, st.latest);
      // Older installers are no use once a newer one is here.
      for (const f of fs.readdirSync(updDir)) if (/\.(exe|msi|dmg|deb|rpm|AppImage|part)$/i.test(f) && path.join(updDir, f) !== file) fs.rmSync(path.join(updDir, f), { force: true });
    } catch (e) {
      // A partial file stays for the next try; the next try is minutes away so a dead network is not hammered.
      dl = { ...dl, state: 'error', error: String(e.message || e), retryAt: Date.now() + 5 * 60 * 1000 };
    }
  }

  /** Look at the release and get ready for it. Cheap when nothing changed. */
  async function sync() {
    const st = deps.status();
    if (!st?.newer) { if (dl.state !== 'idle') { dl = { state: 'idle', got: 0, total: 0, file: '', error: '', retryAt: 0, tag: '' }; clearReady(); } plan = null; return; }
    if (mode() === 'checkout') return planFor(st.tag || 'v' + st.latest);
    if (!deps.canInstall) return;
    if (dl.tag && dl.tag !== st.latest) dl = { state: 'idle', got: 0, total: 0, file: '', error: '', retryAt: 0, tag: '' };
    // A finished download from before a restart is still good: the size check is all it takes.
    return startDownload(st);
  }

  function state() {
    const st = deps.status() || {};
    const m = mode();
    const out = { mode: m, current: st.current || '', latest: st.latest || '', url: st.url || '', notes: notesHead(st.notes), busy: deps.busy(), waiting, action: { ...action } };
    if (!st.newer || st.off) return { ...out, available: false };
    if (m === 'checkout') {
      const ready = !!plan?.ok;
      return { ...out, available: true, ready, blocked: plan && !plan.ok ? plan.reason : '', checking: !plan, download: { state: ready ? 'ready' : 'idle', got: 0, total: 0 } };
    }
    if (!deps.canInstall) return { ...out, available: false };
    return { ...out, available: true, ready: dl.state === 'ready', blocked: '', download: { state: dl.state, got: dl.got, total: dl.total, error: dl.error } };
  }

  async function perform() {
    const st = deps.status();
    waiting = false; clearInterval(timer); timer = null;
    if (action.kind && !action.done && !action.error) return;
    try {
      if (mode() === 'checkout') {
        const tag = st.tag || 'v' + st.latest;
        action = { kind: 'checkout', text: `Fetching ${tag}…`, error: '', done: false };
        await planFor(tag);
        action.text = 'Updating the checkout…';
        const r = await applyCheckout(deps.dir, tag);
        action = { kind: 'checkout', text: r.installed ? 'Updated, dependencies installed. Restarting the server…' : 'Updated. Restarting the server…', error: '', done: false };
        plan = null;
        // Started by hand (npm start), nothing is there to bring the server back: say so rather than vanish.
        if (!deps.restartServer()) action = { kind: 'checkout', text: `Updated to ${tag}. Restart the server (npm start) to run it.`, error: '', done: true };
      } else {
        if (dl.state !== 'ready') throw Object.assign(new Error('The update is still downloading.'), { status: 409 });
        action = { kind: 'installer', text: 'Closing the window to install…', error: '', done: false };
        deps.launchInstaller(dl.file);
      }
    } catch (e) { action = { ...action, error: String(e.message || e), done: true }; throw e; }
  }

  function tick() {
    if (!waiting) return;
    if (deps.busy() === 0) perform().catch(() => {});
  }

  return {
    sync, state,
    /** now: run it; force passes over "Claude is working". idle: wait for no chat to be busy. cancel: stop waiting. */
    async request(when, force = false) {
      if (when === 'cancel') { waiting = false; clearInterval(timer); timer = null; return state(); }
      const s = state();
      if (!s.available || !s.ready) throw Object.assign(new Error(s.blocked || (s.checking ? 'Still checking this checkout.' : 'The update is not downloaded yet.')), { status: 409 });
      if (when === 'idle') {
        if (deps.busy() === 0) { await perform(); return state(); }
        waiting = true; if (!timer) timer = setInterval(tick, 3000);
        return state();
      }
      if (deps.busy() && !force) throw Object.assign(new Error('Claude is working.'), { status: 409, busy: deps.busy() });
      await perform();
      return state();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}
