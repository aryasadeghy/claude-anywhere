// Artifacts: Claude's create_artifact / update_artifact, the card in the chat, the panel beside it
// (title switcher, versions, share link, delete) and the page a share link opens without logging in.
// The real Claude Code talks to the fake Anthropic API (test/fixtures); "[artifact]" makes it create
// an html page and then edit it. Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/artifacts.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-artifacts-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const api = await fx.startFakeApi({ delay: 0 });
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'eeeeeeee-1111-2222-3333-444444444444');
  const seed = (token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } };

  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 }, colorScheme: 'dark', permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(seed, app.token);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(app.base + '/#/s/' + sid);
  await page.waitForSelector('#thread .msg');
  const frame = page.frameLocator('#art-frame');
  const idle = () => until(async () => (await page.$eval('#send', (b) => b.title)) === 'Send', 30000);

  await page.fill('#input', '[artifact] make me a page'); await page.press('#input', 'Enter');
  check('the tool call is a card in the chat', await until(() => page.isVisible('.artifact-card .artifact-card-title:has-text("Hello page")')));
  check('a new artifact opens the panel by itself', await until(() => page.$eval('#artifacts-panel', (p) => !p.classList.contains('hidden'))));
  check('the panel draws the page inside the sandboxed frame', await until(async () => (await frame.locator('#hello').textContent({ timeout: 500 }).catch(() => '')) === 'Hello again'), 'the update should already have landed');
  await idle();
  check('the panel follows the update to version 2', (await page.textContent('#art-ver')) === 'Version 2 of 2', await page.textContent('#art-ver'));
  check('"Updated ..." says when', /^Updated /.test(await page.textContent('#art-updated')));
  check('the frame has no allow-same-origin', !/allow-same-origin/.test(await page.getAttribute('#art-frame', 'sandbox')));
  check('the page cannot reach the app\'s token', (await frame.locator('body').evaluate(() => { try { return localStorage.getItem('cr.token') ? 'leak' : 'empty'; } catch { return 'blocked'; } })) === 'blocked');
  await frame.locator('#b').click();
  check('the page runs its own script', (await frame.locator('#hello').textContent()) === 'Clicked');
  await page.screenshot({ path: path.join(SHOTS, 'artifacts-panel.png') });

  // Versions: back to the first, forward again.
  await page.click('#art-prev');
  check('the previous version shows the older page', await until(async () => (await frame.locator('#hello').textContent({ timeout: 500 }).catch(() => '')) === 'Hello artifact') && /Version 1 of 2/.test(await page.textContent('#art-ver')));
  check('...and Updated becomes Saved', /^Saved /.test(await page.textContent('#art-updated')));
  await page.click('#art-next');
  check('forward again to the latest', await until(async () => (await frame.locator('#hello').textContent({ timeout: 500 }).catch(() => '')) === 'Hello again'));

  // The title is a switcher; a second artifact appears in it (made over the API the way the tool does).
  await page.click('#art-title-btn');
  check('the title dropdown lists the session\'s artifacts', await page.$$eval('#art-switch .menu-item', (b) => b.length) === 1);
  await page.keyboard.press('Escape'); await page.click('#art-bar', { position: { x: 4, y: 4 } });

  // Copy link makes a share link that opens with no login, and only that artifact.
  await page.click('#art-menu-btn'); await page.click('#art-menu .menu-item:has-text("Copy link")');
  check('Shared shows once a link exists', await until(() => page.isVisible('#art-share-badge')));
  const link = await page.evaluate(() => navigator.clipboard.readText());
  check('the link is /a/<token>', /\/a\/[A-Za-z0-9_-]{20,}$/.test(link), link);
  const fresh = await browser.newContext({ viewport: { width: 900, height: 600 } });
  const anon = await fresh.newPage();
  const r = await anon.goto(link);
  check('the link opens in a fresh browser with no token', r.status() === 200 && (await anon.textContent('#hello')) === 'Hello again');
  check('...served sandboxed, no cache', /sandbox/.test(r.headers()['content-security-policy'] || '') && /no-store/.test(r.headers()['cache-control'] || ''));
  check('...and exposes nothing else', (await (await fresh.request.get(app.base + `/api/sessions/${sid}/artifacts`)).status()) === 401);
  check('a guessed token is a plain 404', (await (await fresh.request.get(app.base + '/a/' + 'A'.repeat(24))).status()) === 404);
  await page.click('#art-menu-btn'); await page.click('#art-menu .menu-item:has-text("Stop sharing")');
  check('Stop sharing revokes it', await until(async () => (await fresh.request.get(link)).status() === 404));
  await fresh.close();

  // Open in a new tab: a one-time address, not the token in a URL.
  const popup = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  await page.click('#art-menu-btn'); await page.click('#art-menu .menu-item:has-text("Open in a new tab")');
  const p2 = await popup;
  check('Open in a new tab shows just the page', !!p2 && await until(async () => (await p2.textContent('#hello', { timeout: 500 }).catch(() => '')) === 'Hello again'));
  if (p2) await p2.close();

  // The card opens the panel again, from a closed one.
  await page.click('#art-close');
  await page.click('.artifact-card-open >> nth=0');
  check('the card\'s Open brings the panel back', await until(() => page.$eval('#artifacts-panel', (p) => !p.classList.contains('hidden'))));
  check('Files closes it (one pane at a time)', await page.click('#pane-files-btn').then(() => until(() => page.$eval('#artifacts-panel', (p) => p.classList.contains('hidden')))));

  // Phone: the same panel as a full-width sheet, from the session menu.
  const wk = await webkit.launch({ headless: true });
  const pctx = await wk.newContext({ ...devices['iPhone 15 Pro Max'], colorScheme: 'dark' });
  await pctx.addInitScript(seed, app.token);
  const phone = await pctx.newPage();
  const perrors = []; phone.on('pageerror', (e) => perrors.push(e.message));
  await phone.goto(app.base + '/#/s/' + sid);
  await phone.waitForSelector('#thread .msg');
  await phone.click('.artifact-card-open >> nth=0');
  check('on a phone the card opens the sheet', await until(() => phone.$eval('#artifacts-panel', (p) => !p.classList.contains('hidden'))));
  const box = await phone.$eval('#artifacts-panel', (p) => { const b = p.getBoundingClientRect(); return { w: b.width, vw: innerWidth }; });
  check('...full width', Math.abs(box.w - box.vw) < 2, JSON.stringify(box));
  check('...with the page drawn', await until(async () => (await phone.frameLocator('#art-frame').locator('#hello').textContent({ timeout: 500 }).catch(() => '')) === 'Hello again'));
  await phone.screenshot({ path: path.join(SHOTS, 'artifacts-phone.png') });
  await wk.close();
  check('phone: no page errors', perrors.length === 0, perrors.join(' | '));

  // Delete: the confirm, then the panel is empty.
  await page.click('.artifact-card-open >> nth=0');
  await until(() => page.isVisible('#art-menu-btn'));
  await page.click('#art-menu-btn'); await page.click('#art-menu .menu-item:has-text("Delete")');
  check('Delete empties the panel', await until(() => page.isVisible('#art-empty')));
  const left = await (await fetch(app.base + `/api/sessions/${sid}/artifacts`, { headers: { Authorization: 'Bearer ' + app.token } })).json();
  check('...and the artifact is gone', left.artifacts.length === 0);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close(); await app.stop?.(); await api.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
