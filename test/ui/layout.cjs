// The layout package: the row under the composer (mode, one menu for model + effort, the
// context ring), the session rail and its cards, the title-bar pane buttons, minimize (a live
// view, not a frozen pill), and split view (a second session as an embedded copy of the page).
// Fake Anthropic API, no real account. Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/layout.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-layout-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const api = await fx.startFakeApi();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'dddddddd-1111-2222-3333-444444444444');
  const sid2 = fx.makeSession(path.join(tmp, 'claude'), cwd, 'eeeeeeee-1111-2222-3333-444444444444');

  async function open(type, opts) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
    // try: the script also runs in the Artifacts pane's sandboxed frame, which has no storage by design
    await ctx.addInitScript((token) => { try { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } catch {} }, app.token);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + sid);
    await page.waitForSelector('#thread .msg');
    await wait(500);
    return { browser, page, errors };
  }

  const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });

  // 1. The row under the box: mode, one menu for model + effort, usage ring - not inside it.
  check('the + and microphone stay inside the box', await page.isVisible('#composer #attach-btn'));
  check('mode/model/usage moved to a row under the box', await page.$eval('#composer-footrow', (r) => r.contains(document.querySelector('#mode-btn')) && r.contains(document.querySelector('#model-btn')) && r.contains(document.querySelector('#usage-btn'))));
  await page.click('#model-btn');
  check('one menu opens with both the model list and the effort slider', await until(async () => (await page.isVisible('#modeleffort-menu .menu-item')) && (await page.isVisible('#ef-track')), 5000));
  await page.screenshot({ path: path.join(SHOTS, 'layout-modeleffort-menu.png') });
  await page.keyboard.press('Escape'); await page.click('#thread', { position: { x: 5, y: 5 } }).catch(() => {});

  // 2. The session rail: toggled from the title bar, remembered, cards with real data.
  await page.click('#pane-rail-btn');
  check('the rail opens', await until(() => page.isVisible('#rail'), 3000));
  check('its cards load (Environment, Context, Connectors...)', await until(async () => (await page.$$('.rail-card')).length >= 5, 8000));
  await page.reload();
  await page.waitForSelector('#thread .msg');
  check('...and stays open across a reload (remembered)', await until(() => page.isVisible('#rail'), 5000));
  await page.screenshot({ path: path.join(SHOTS, 'layout-rail.png') });
  // Right-click a card header: choose which cards show, remembered.
  await page.click('.rail-card-head', { button: 'right' });
  check('right-click a card header opens the card-choice menu', await until(() => page.isVisible('#rail-card-menu .menu-item'), 3000));
  await page.click('#rail-card-menu .menu-item:has-text("Servers")');
  check('unchecking a card hides it', await until(async () => !(await page.$$eval('.rail-card-title', (ts) => ts.map((t) => t.textContent))).includes('Servers'), 3000));
  await page.evaluate(() => localStorage.removeItem('cr.rail.hidden')); // back to every card, for what follows

  // 3. Minimize: the Terminal becomes a small live view, docked in the rail since it is open.
  await page.click('#pane-terminal-btn');
  await until(() => page.isVisible('#terminal-panel:not(.hidden)'), 5000);
  await page.click('#term-min');
  check('minimized, the terminal docks in the rail, still live (not a frozen pill)', await until(async () => (await page.isVisible('#rail-dock .mini-shell')) && (await page.isVisible('#term-stage')), 5000));
  await page.screenshot({ path: path.join(SHOTS, 'layout-mini-docked.png') });
  await page.click('.mini-bar .icon-btn'); // Expand (the first button in the bar)
  check('Expand restores the full pane', await until(async () => (await page.isVisible('#terminal-panel:not(.hidden)')) && !(await page.isVisible('#rail-dock .mini-shell')), 5000));
  await page.click('#pane-rail-btn'); // close the rail: a minimized pane would float instead
  await page.click('#term-min'); // the terminal is already open (Expand left it that way) - just minimize it again
  check('with the rail closed, a minimized pane floats in the corner of the chat', await until(() => page.isVisible('#mini-host .mini-shell.floating'), 5000));
  await page.screenshot({ path: path.join(SHOTS, 'layout-mini-floating.png') });
  await page.click('#mini-host .mini-bar button[title="Close"]');
  check('Close ends it, not just hides it', await until(async () => !(await page.isVisible('#terminal-panel:not(.hidden)')), 3000));

  // 4. Split view: Alt+click a sidebar session opens a second one beside the current, dimmed
  // focus toggling between them, as an embedded copy of the page (no sidebar, no outer chrome).
  await page.click(`.session-item[data-id="${sid2}"]`, { modifiers: ['Alt'] });
  check('alt+click opens a second session in split view', await until(() => page.$eval('#app', (e) => e.classList.contains('split-open')), 5000));
  await until(() => !!page.frame({ url: /embed=1/ }), 10000);
  const frame = page.frame({ url: /embed=1/ });
  check('the split pane is the app itself, embedded', !!frame);
  if (frame) {
    await frame.waitForSelector('#thread .msg').catch(() => {});
    check('...with the sidebar and outer chrome hidden', await frame.$eval('#sidebar', (e) => getComputedStyle(e).display === 'none').catch(() => false));
  }
  await page.screenshot({ path: path.join(SHOTS, 'layout-split-view.png') });
  await page.click('#split-close');
  check('× ends the split', await until(async () => !(await page.isVisible('#split-pane:not(.hidden)')), 3000));

  check('no errors in the app', !errors.length, errors.join(' | '));
  await browser.close();

  // 5. On a phone: the composer row and the session menu sheet still fit.
  {
    const { browser, page, errors } = await open(webkit, devices['iPhone 15 Pro Max']);
    check('the pane buttons are not shown (a phone uses the session menu instead)', !(await page.isVisible('#pane-btns')));
    const wide = await page.evaluate(() => [...document.querySelectorAll('#composer-footrow, #composer-footrow *')].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).map((n) => n.className));
    check('iphone: the composer row fits the screen', !wide.length, wide.join(', '));
    await page.click('#session-menu-btn');
    await until(() => page.isVisible('#session-menu .menu-item'), 5000);
    check('iphone: the session menu (rail\'s sheet) fits the screen', await page.$eval('#session-menu', (m) => m.getBoundingClientRect().right <= window.innerWidth + 1));
    await page.screenshot({ path: path.join(SHOTS, 'layout-iphone.png') });
    check('iphone: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed · screenshots in test/ui/shots`);
  await Promise.race([app.stop(), wait(5000)]);
  await api.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
