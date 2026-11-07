// Sending, as two devices see it, with the real Claude Code talking to a fake Anthropic API
// (test/fixtures): every turn runs end to end - the CLI, the app, the page - offline and free.
//
// A message showed twice whenever it was sent while only a background command was left (a
// render): the "queued" event looked for a dashed bubble and that one is not drawn dashed. A
// second device with the session open saw a turn a block at a time from the transcript, and
// only after it reconnected. And every message after an answer started Claude Code again.
// This sends from one page while another watches: the message once on each, the answer
// streaming on the watcher too, the follow-up going into the same process, quickly.
//
//   npm i --no-save playwright && npx playwright install chromium
//   node test/ui/realtime.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const SHOTS = path.join(__dirname, 'shots');
const channel = process.env.PW_CHANNEL || undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail = '') { ok ? passed++ : failed++; console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail && !ok ? '  — ' + detail : '')); }
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(50); } return false; };

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-realtime-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const api = await fx.startFakeApi();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  fs.mkdirSync(SHOTS, { recursive: true });
  // A session that exists but has no Claude Code running: the watcher follows its transcript.
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'aaaaaaaa-1111-2222-3333-444444444444');
  // Bypass, so the background command in the third message needs no one to allow it.
  await fetch(app.base + `/api/sessions/${sid}/prefs`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + app.token }, body: JSON.stringify({ permissionMode: 'bypassPermissions' }) });

  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  async function device(name) {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 860 }, colorScheme: 'dark' });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); localStorage.setItem('cr.mode', 'bypassPermissions'); } }, app.token);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + sid);
    await page.waitForSelector('#thread .msg');
    await wait(800);
    return { name, page, errors };
  }
  const bubbles = (d, text) => d.page.$$eval('#thread .msg.user .msg-text', (ns, t) => ns.filter((n) => n.textContent.trim() === t).length, text);
  const threadText = (d) => d.page.$eval('#thread', (t) => t.innerText);
  async function send(d, text) {
    await d.page.fill('#input', text);
    await d.page.press('#input', 'Enter');
  }
  const startsSince = (t0) => api.requests.filter((r) => r.at >= t0 && r.path === '/api/hello').length; // the CLI says hello as it starts

  const a = await device('sender'), b = await device('watcher');

  // 1. A turn the watcher sees as it streams, not a block at a time from the file.
  const samples = [];
  const sampling = (async () => { for (let i = 0; i < 120; i++) { samples.push(await threadText(b).catch(() => '')); await wait(60); } })();
  await send(a, 'Q1 [slow] first question');
  check('the sender: its message once', await until(async () => (await bubbles(a, 'Q1 [slow] first question')) === 1) && (await bubbles(a, 'Q1 [slow] first question')) === 1);
  check('the watcher: the message appears there too, once', await until(async () => (await bubbles(b, 'Q1 [slow] first question')) === 1, 8000));
  const done1 = await until(async () => (await threadText(b)).includes('Answer to: Q1. Done.'), 30000);
  await sampling;
  const partial = samples.some((s) => /Answer to:/.test(s) && !/Answer to: Q1\. Done\./.test(s));
  check('the watcher sees the answer stream in, word by word', done1 && partial, done1 ? 'it arrived whole' : 'it never arrived');
  check('and the sender has the answer once', (await threadText(a)).split('Answer to: Q1. Done.').length === 2);
  await a.page.screenshot({ path: path.join(SHOTS, 'realtime-sender.png') });
  await b.page.screenshot({ path: path.join(SHOTS, 'realtime-watcher.png') });

  // 2. The next message goes into the same Claude Code, resting after its answer: no new start.
  await until(async () => !(await a.page.$eval('#live-pill', (p) => !p.classList.contains('hidden'))), 10000);
  const t2 = Date.now();
  await send(a, 'Q2 second question');
  const got2 = await until(async () => (await threadText(a)).includes('Answer to: Q2. Done.'), 20000);
  const ms2 = Date.now() - t2;
  check('the next message goes into the same Claude Code - it does not start again', got2 && startsSince(t2) === 0, got2 ? startsSince(t2) + ' starts' : 'no answer');
  check('and its answer comes quickly', got2 && ms2 < 1500, ms2 + ' ms');
  check('the message once on each device', (await bubbles(a, 'Q2 second question')) === 1 && await until(async () => (await bubbles(b, 'Q2 second question')) === 1, 5000));

  // 3. A message sent while only a background command runs (the answer done, a render going) -
  // the composer is idle then, and its bubble is not drawn dashed. It used to appear twice.
  await send(a, 'Q3 [background] start the render');
  await until(async () => (await threadText(a)).includes('Started it in the background.'), 30000);
  await until(async () => !(await a.page.$eval('#live-pill', (p) => !p.classList.contains('hidden'))), 10000);
  check('a background command is left running', await until(() => a.page.$eval('#tasks-bar', (n) => !n.classList.contains('hidden')), 8000));
  await send(a, 'Q4 how is it going');
  await until(async () => (await threadText(a)).includes('Answer to: Q4. Done.'), 20000);
  await wait(800);
  check('a message sent while a background command runs shows once', (await bubbles(a, 'Q4 how is it going')) === 1, (await bubbles(a, 'Q4 how is it going')) + ' bubbles');
  check('on the watcher too', await until(async () => (await bubbles(b, 'Q4 how is it going')) === 1, 5000) && (await bubbles(b, 'Q4 how is it going')) === 1);
  await a.page.screenshot({ path: path.join(SHOTS, 'realtime-background.png') });

  // 4. A third device opening the session now: every message once, and not "working".
  const c = await device('latecomer');
  const counts = await Promise.all(['Q1 [slow] first question', 'Q2 second question', 'Q3 [background] start the render', 'Q4 how is it going'].map((t) => bubbles(c, t)));
  check('opening it later: each message once, from the transcript and the run together', counts.every((n) => n === 1), JSON.stringify(counts));
  check('and Claude Code resting is not shown as working', !(await c.page.$eval('#live-pill', (p) => !p.classList.contains('hidden'))) && !(await c.page.$eval('#send', (s) => s.classList.contains('running'))));

  check('no errors on any page', ![a, b, c].some((d) => d.errors.length), [a, b, c].flatMap((d) => d.errors).join(' | '));

  console.log(`\n${passed} passed, ${failed} failed`);
  await browser.close();
  await Promise.race([app.stop(), wait(5000)]);
  await api.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
