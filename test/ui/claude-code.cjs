// Settings › Claude Code, as a person uses it: the row says which Claude Code that computer runs
// and that a newer one is out; Update downloads it with a bar that moves, and from then on the row
// says it is up to date, with the way back to the app's own. The registry is a stand-in
// (test/fixtures) serving the Claude Code the app came with as 2.1.999 - offline, the same every time.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/claude-code.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
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
  const cc = await import(pathToFileURL(path.join(__dirname, '..', '..', 'lib', 'claude-code.mjs')).href);
  const own = cc.bundled(), mine = cc.bundledVersion();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-claude-code-'));
  const registry = await fx.startFakeRegistry({ binary: own.file, key: own.key });
  registry.state.rate = 30 * 1048576; // a download of a few seconds, to see it go
  // The fake Anthropic API too: no real account behind the app, and none in the screenshots.
  const api = await fx.startFakeApi();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: { ...fx.fakeApiEnv(api), npm_config_registry: registry.url } });
  fs.mkdirSync(SHOTS, { recursive: true });

  async function open(type, opts) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/');
    await page.waitForSelector('#account-btn', { state: 'attached' });
    await page.waitForFunction(() => (document.querySelector('#sidebar-account')?.textContent || '').trim().length > 0, null, { timeout: 15000 }).catch(() => {});
    await wait(500);
    return { browser, page, errors };
  }
  async function settings(page) {
    // On a phone the sidebar is a drawer, slid off the screen until it is opened.
    const offscreen = () => page.$eval('#account-btn', (n) => { const r = n.getBoundingClientRect(); return r.right <= 0 || r.left >= window.innerWidth; });
    for (let i = 0; i < 3 && (await offscreen()); i++) { await page.click('#sidebar-open'); await until(async () => !(await offscreen()), 2000); }
    await page.click('#account-btn');
    await page.click('#account-menu >> text=Settings…');
    await page.waitForSelector('#set-cc', { state: 'visible' });
  }
  const desc = (page) => page.$eval('#set-cc-desc', (n) => n.textContent);
  const btn = (page) => page.$eval('#set-cc-btn', (n) => n.textContent);
  const more = (page) => page.$eval('#set-cc-more', (n) => n.textContent);
  const updated = (page) => until(async () => /^2\.1\.999 · up to date/.test(await desc(page)), 60000);

  // 1. On a computer: the newer one is offered, taken, named in About, and given back.
  {
    const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });
    await settings(page);
    check('the row says which Claude Code runs, and that a newer one is out', await until(async () => (await desc(page)) === `${mine} · 2.1.999 is out`), await desc(page));
    check('...with a button to take it', (await btn(page)) === 'Update to 2.1.999', await btn(page));
    await page.screenshot({ path: path.join(SHOTS, 'claude-code-available.png') });
    await page.click('#set-cc-btn');
    check('Update shows the download as it goes, with a bar', await until(async () => /^Downloading 2\.1\.999 · \d+ MB of \d+ MB$/.test(await desc(page)) && (await page.isVisible('#set-cc-bar')), 10000), await desc(page));
    const width = () => page.$eval('#set-cc-bar > span', (s) => parseFloat(s.style.width) || 0);
    const w1 = await width(); await wait(1000); const w2 = await width();
    check('...and the bar moves', w2 > w1, w1 + '% then ' + w2 + '%');
    await page.screenshot({ path: path.join(SHOTS, 'claude-code-downloading.png') });
    check('then it is the one in use, up to date', await updated(page), await desc(page));
    check('...it says what that means for a turn already running', /New messages use it/.test(await more(page)), await more(page));
    check('...and offers the way back', (await more(page)).includes(`Go back to ${mine}, the one this app came with`), await more(page));
    check('the bar is gone, and the button checks again', !(await page.isVisible('#set-cc-bar')) && (await btn(page)) === 'Check now', await btn(page));
    await page.screenshot({ path: path.join(SHOTS, 'claude-code-updated.png') });
    await page.click('.set-tab[data-pane="about"]');
    check('About names the Claude Code in use', await until(async () => (await page.$eval('#set-about', (n) => n.innerText)).includes('2.1.999 (taken from npm)'), 5000));
    await page.click('.set-tab[data-pane="general"]');
    await until(async () => (await more(page)).includes('Go back'), 5000);
    await page.click('#set-cc-more >> text=Go back');
    check("Go back returns to the app's own, and the newer one is offered again", await until(async () => (await desc(page)) === `${mine} · 2.1.999 is out`, 10000), await desc(page));
    check('desktop: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  // 2. On the phone, in Safari's engine: the same row, for the computer it is showing.
  {
    const { browser, page, errors } = await open(webkit, devices['iPhone 15 Pro Max']);
    await settings(page);
    await until(async () => (await desc(page)).includes('is out'), 10000);
    await page.screenshot({ path: path.join(SHOTS, 'claude-code-iphone-available.png') });
    await page.click('#set-cc-btn');
    check('iphone: Update works from the phone', await updated(page), await desc(page));
    const wide = await page.evaluate(() => [...document.querySelectorAll('#set-cc, #set-cc *')].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).map((n) => n.id || n.className));
    check('iphone: the row fits the screen', !wide.length, wide.join(', '));
    await page.screenshot({ path: path.join(SHOTS, 'claude-code-iphone-updated.png') });
    await page.click('#set-cc-more >> text=Go back');
    await until(async () => (await desc(page)).includes('is out'), 10000);
    check('iphone: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  // 3. A page newer than its server: the checkout's pages change before Restart server.
  {
    const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });
    await page.route('**/api/claude-code**', (r) => r.fulfill({ status: 404, contentType: 'text/html', body: 'Cannot GET /api/claude-code' }));
    await settings(page);
    check('old server: the row says to restart the server, with no button', await until(async () => (await desc(page)) === 'Restart server to update Claude Code from here.' && !(await page.isVisible('#set-cc-btn')), 5000), await desc(page));
    check('old server: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed · screenshots in test/ui/shots`);
  await Promise.race([app.stop(), wait(5000)]);
  await registry.close(); await api.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
