// "Relaunch to update", as a person meets it. GitHub is a stand-in server announcing v9.9.9 with an
// installer that downloads slowly; the real app downloads it in the background, shows the button in
// the title bar on a desktop and an iPhone, and "Relaunch when Claude is done" waits for a real
// [slow] turn (real Claude Code, fake Anthropic API). The installer is never run:
// CLAUDE_ANYWHERE_UPDATE_DRY_RUN makes the install step write its log line and stop.
// A second app, running from this git checkout (not on main), shows the refusal and its reason.
// Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/updates.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const SHOTS = path.join(__dirname, 'shots');
const channel = process.env.PW_CHANNEL || undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail = '') { ok ? passed++ : failed++; console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail && !ok ? '  — ' + detail : '')); }
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(50); } return false; };

// GitHub's side: the latest release, and an installer that arrives 100 KB at a time.
function startFakeGithub() {
  const body = Buffer.alloc(2 * 1024 * 1024, 7);
  const names = ['Claude-Anywhere_9.9.9_x64-setup.exe', 'Claude-Anywhere_9.9.9_aarch64.dmg', 'Claude-Anywhere_9.9.9_amd64.deb'];
  const srv = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${srv.address().port}`;
    if (req.url.startsWith('/dl/')) {
      res.writeHead(200, { 'content-length': body.length });
      for (let i = 0; i < body.length; i += 102400) { res.write(body.subarray(i, i + 102400)); await wait(120); }
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      tag_name: 'v9.9.9', html_url: base + '/release', published_at: new Date().toISOString(),
      body: "## What's new\n\n- Updates download in the background\n- A Relaunch to update button in the title bar\n- Fixed a crash when a chat was renamed mid-turn\n",
      assets: names.map((name) => ({ name, size: body.length, browser_download_url: base + '/dl/' + name })),
    }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-updates-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const gh = await startFakeGithub();
  const api = await fx.startFakeApi();
  const env = { ...fx.fakeApiEnv(api), GITHUB_API_URL: gh.base, CLAUDE_ANYWHERE_UPDATE_CHECK: 'on' };
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: { ...env, CLAUDE_ANYWHERE_UPDATE_MODE: 'installer', CLAUDE_ANYWHERE_UPDATE_DRY_RUN: '1' } });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'eeeeeeee-1111-2222-3333-444444444444');
  const H = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const get = async (p) => (await fetch(app.base + '/api' + p, { headers: H })).json();

  async function open(type, opts, base = app.base, token = app.token, hash = '#/s/' + sid) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
    await ctx.addInitScript((t) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', t); } }, token);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/' + hash);
    await page.waitForSelector('#thread .msg');
    return { browser, page, errors };
  }
  const label = (page) => page.$eval('#update-btn .ub-long', (n) => n.textContent);
  const popText = (page) => page.$eval('#update-pop', (n) => n.innerText).catch(() => '');
  const threadText = (page) => page.$eval('#thread', (t) => t.innerText);

  // 1. It downloads by itself, and the button says how far.
  const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });
  check('the server fetches a newer release without being asked', await until(async () => (await get('/update/state')).available === true, 20000));
  check('the button is in the title bar while it downloads', await until(async () => !(await page.$eval('#update-btn', (b) => b.classList.contains('hidden'))), 15000));
  check('...and shows the progress', await until(async () => /^Downloading update… \d+%$/.test(await label(page)), 8000), await label(page));
  await page.click('#update-btn');
  check('the popover has a progress bar while downloading', await until(() => page.isVisible('#update-pop .up-bar'), 4000));
  check('...and Relaunch now waits for the file', await page.$eval('#update-pop .up-actions button.primary', (b) => b.disabled));
  await page.screenshot({ path: path.join(SHOTS, 'updates-downloading.png') });
  const doneDl = await until(async () => (await get('/update/state')).ready === true, 20000);
  check('the download finishes', doneDl);
  const dir = path.join(tmp, 'data', 'updates');
  const files = fs.readdirSync(dir);
  const exe = files.find((f) => /setup\.exe$|\.deb$|\.dmg$/.test(f));
  check('the installer is in the data folder at its full size, no partial file left', exe && fs.statSync(path.join(dir, exe)).size === 2 * 1024 * 1024 && !files.some((f) => f.endsWith('.part')), files.join(','));
  check('...with a note for install-on-quit', fs.existsSync(path.join(dir, 'ready.json')) && JSON.parse(fs.readFileSync(path.join(dir, 'ready.json'), 'utf8')).version === '9.9.9');
  check('the button now says Relaunch to update', await until(async () => (await label(page)) === 'Relaunch to update', 5000), await label(page));
  const ver = (await get('/version')).version;
  const pop = await until(async () => (await popText(page)).includes('Release notes'), 5000) && await popText(page);
  check('the popover names both versions', pop.includes('Update available to v9.9.9.') && pop.includes('You are currently on v' + ver + '.'), pop);
  check('...shows the notes', pop.includes('Updates download in the background'), pop);
  check('...and offers both ways to relaunch', pop.includes('Relaunch now') && pop.includes('Relaunch when Claude is done'));
  await page.screenshot({ path: path.join(SHOTS, 'updates-popover.png') });
  await page.keyboard.press('Escape'); await page.click('#thread', { position: { x: 5, y: 5 } });
  check('clicking away closes the popover', await until(async () => !(await page.isVisible('#update-pop')), 3000));
  check('the old dismissible banner is not there for this update', await page.$eval('#update-banner', (b) => b.classList.contains('hidden')));

  // 2. While a turn runs: confirm, then wait for it.
  await page.fill('#input', 'Q1 [slow] tell me a long story about the sea and the ships upon it'); await page.press('#input', 'Enter');
  check('a slow turn is running', await until(async () => (await get('/runs')).length > 0, 15000));
  await page.click('#update-btn');
  await page.click('#update-pop button:has-text("Relaunch now")');
  check('Relaunch now with Claude working asks "Relaunch Claude?"', await until(async () => (await popText(page)).includes('Relaunch Claude?') && (await popText(page)).includes('Relaunch anyway'), 4000), await popText(page));
  await page.screenshot({ path: path.join(SHOTS, 'updates-confirm.png') });
  await page.click('#update-pop button:has-text("Cancel")');
  await page.click('#update-pop button:has-text("Relaunch when Claude is done")');
  check('"when Claude is done" says it is waiting for 1 chat', await until(async () => (await popText(page)).includes('Waiting for 1 chat to finish'), 4000), await popText(page));
  check('...and so does the button', await until(async () => (await label(page)) === 'Waiting for 1 chat…', 4000), await label(page));
  await page.screenshot({ path: path.join(SHOTS, 'updates-waiting.png') });
  await page.click('#update-pop button:has-text("Cancel")');
  check('Cancel stops waiting', await until(async () => (await get('/update/state')).waiting === false && (await label(page)) === 'Relaunch to update', 4000));
  await page.click('#update-pop button:has-text("Relaunch when Claude is done")');
  await wait(1500);
  check('nothing was installed while the turn ran', !fs.existsSync(path.join(tmp, 'data', 'update.log')));
  check('when the turn ends the update goes ahead by itself', await until(async () => fs.existsSync(path.join(tmp, 'data', 'update.log')) && /dry run: would start/.test(fs.readFileSync(path.join(tmp, 'data', 'update.log'), 'utf8')), 60000));
  check('...after the answer, not before', (await threadText(page)).includes('Answer to: Q1'));
  check('...and the popover says it is on its way', await until(async () => (await popText(page)).includes('Closing the window to install'), 6000), await popText(page));
  check('no errors in the app', !errors.length, errors.join(' | '));
  await browser.close();

  // 3. Phone: compact button, popover inside the screen.
  {
    const { browser, page, errors } = await open(webkit, devices['iPhone 15 Pro Max']);
    check('iphone: the button is there', await until(async () => !(await page.$eval('#update-btn', (b) => b.classList.contains('hidden'))), 10000));
    const box = await page.$eval('#update-btn', (b) => { const r = b.getBoundingClientRect(); return { r: r.right, w: r.width, vw: innerWidth }; });
    check('iphone: it is compact and on screen', box.r <= box.vw && box.w < 110, JSON.stringify(box));
    await page.screenshot({ path: path.join(SHOTS, 'updates-iphone-button.png') });
    await page.tap('#update-btn');
    await until(() => page.isVisible('#update-pop'), 3000);
    const pb = await page.$eval('#update-pop', (p) => { const r = p.getBoundingClientRect(); return { l: r.left, r: r.right, vw: innerWidth }; });
    check('iphone: the popover fits the screen', pb.l >= 0 && pb.r <= pb.vw, JSON.stringify(pb));
    await page.screenshot({ path: path.join(SHOTS, 'updates-iphone-popover.png') });
    check('iphone: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }
  await Promise.race([app.stop(), wait(5000)]);

  // 4. Running from a git checkout that is not on main: the button is there, and the reason is plain.
  const co = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data2'), configDir: path.join(tmp, 'claude'), env });
  {
    const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } }, co.base, co.token, '#/s/' + sid);
    const st = await until(async () => (await (await fetch(co.base + '/api/update/state', { headers: { authorization: 'Bearer ' + co.token } })).json()).blocked, 25000);
    check('a checkout off main is offered the update but told why it cannot take it', st);
    await until(async () => !(await page.$eval('#update-btn', (b) => b.classList.contains('hidden'))), 25000);
    await page.click('#update-btn');
    const t = await popText(page);
    check('...the popover explains, and Relaunch now is disabled', /updating only moves main|uncommitted/.test(t) && (await page.$eval('#update-pop .up-actions button.primary', (b) => b.disabled)), t);
    await page.screenshot({ path: path.join(SHOTS, 'updates-checkout-blocked.png') });
    check('checkout: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed · screenshots in test/ui/shots`);
  await Promise.race([co.stop(), wait(5000)]);
  await api.close(); gh.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
