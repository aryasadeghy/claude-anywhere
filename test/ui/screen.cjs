// This PC's screen, as a person meets it, with the real Claude Code talking to the fake Anthropic
// API (test/fixtures):
//   - the Remote desktop pane starts off, says what turning it on means, and once allowed shows the
//     PC's screen; a click in the pane presses a button on the PC, typing reaches its text box, and
//     Ctrl+Alt+Del says it cannot be sent;
//   - Settings › Remote access turns on "Let Claude use this PC";
//   - Claude takes a screenshot and clicks the same button: the permission card names the app and
//     the tier, and the click lands only once it is allowed;
//   - the Android emulator opens in the same pane, and without an SDK says how to get one;
//   - on an iPhone the pane fills the screen and a tap is a click.
//
// It drives the real mouse and keyboard, so it touches nothing but a window it opens itself: a
// small topmost form (test/fixtures/screen-form.ps1). The app runs with
// CLAUDE_ANYWHERE_SCREEN_CONFINE set to that window's title, which makes the helper refuse any input
// that would land anywhere else and paint everything else out of every picture. Windows only.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/screen.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

if (process.platform !== 'win32') {
  console.log('skip  test/ui/screen.cjs: remote desktop and computer use are Windows only for now, and this walkthrough drives a real Windows desktop.');
  process.exit(0);
}
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const SHOTS = path.join(__dirname, 'shots');
const channel = process.env.PW_CHANNEL || undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail = '') { ok ? passed++ : failed++; console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail && !ok ? '  — ' + detail : '')); }
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(60); } return false; };

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const screen = await import(pathToFileURL(path.join(__dirname, '..', '..', 'lib', 'screen.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-screen-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const win = await fx.openTestWindow({ x: 160, y: 300 });
  const api = await fx.startFakeApi();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: { ...fx.fakeApiEnv(api), CLAUDE_ANYWHERE_SCREEN_CONFINE: win.title } });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'abababab-1111-2222-3333-444444444444');
  const browsers = [];
  const clicks = () => win.log().filter((l) => l === 'clicked').length;
  const status = async () => (await fetch(app.base + '/api/screen/status', { headers: { authorization: 'Bearer ' + app.token } })).json();
  try {
    async function open(type, opts) {
      const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
      browsers.push(browser);
      const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
      await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
      const page = await ctx.newPage();
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(app.base + '/#/s/' + sid);
      await page.waitForSelector('#thread .msg');
      await wait(500);
      return { page, errors };
    }
    // Where a point of the PC's screen is in the pane: the picture is the display, fitted.
    async function inPane(page, sx, sy) {
      const r = await page.$eval('#sd-stage', (s) => { const b = s.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height, size: s.dataset.size }; });
      const [W, H] = r.size.split('x').map(Number);
      const s = Math.min(r.w / W, r.h / H);
      return { x: r.x + (r.w - W * s) / 2 + sx * s, y: r.y + (r.h - H * s) / 2 + sy * s };
    }
    const mid = (b) => [b.x + b.w / 2, b.y + b.h / 2];

    // ---- 1. the pane, off until allowed ----
    const { page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });
    check('the pane buttons have a Remote desktop button', await page.isVisible('#pane-screen-btn'));
    await page.click('#pane-screen-btn');
    check('it opens off, and says what turning it on means', await until(() => page.isVisible('.sd-card:has-text("Remote desktop is off")'), 5000));
    check('...that a banner on the PC says so, with a Stop', /banner on the PC/.test(await page.$eval('.sd-card', (n) => n.textContent)));
    check('...and nothing runs on the PC yet', !(await status()).controlledBy.people);
    await page.screenshot({ path: path.join(SHOTS, 'screen-off.png') });
    await page.click('.sd-card button:has-text("Allow remote desktop")');
    check('allowed, the PC\'s screen shows in the pane', await until(() => page.$eval('#sd-stage', (s) => s.classList.contains('live') && !!s.dataset.size), 30000));
    check('...and the server counts one person controlling it', (await status()).controlledBy.people === 1);
    await wait(600);
    await page.screenshot({ path: path.join(SHOTS, 'screen-live.png') });

    // ---- 2. a click in the pane presses the button on the PC; typing reaches the text box ----
    let p = await inPane(page, ...mid(win.button));
    await page.mouse.click(p.x, p.y);
    check('a click in the pane presses the button on the PC', await until(() => clicks() === 1, 8000), win.log().join(' | '));
    p = await inPane(page, win.input.x + 30, win.input.y + win.input.h / 2);
    await page.mouse.click(p.x, p.y);
    await wait(300);
    await page.keyboard.type('hi there');
    check('typing in the pane reaches the text box', await until(() => win.log().includes('text:hi there'), 8000), win.log().slice(-3).join(' | '));
    await page.keyboard.press('Backspace');
    check('...and so do keys', await until(() => win.log().includes('text:hi ther'), 5000), win.log().slice(-2).join(' | '));
    await until(async () => (await page.$eval('#sd-stage', (s) => s.querySelector('img').naturalWidth)) > 0, 3000);
    await wait(800); // the next frame, showing the text
    await page.screenshot({ path: path.join(SHOTS, 'screen-typed.png') });
    await page.click('#sd-keys');
    check('the keys menu has Ctrl+Alt+Del', await until(() => page.isVisible('#sd-keys-menu .menu-item:has-text("Ctrl+Alt+Del")'), 3000));
    await page.screenshot({ path: path.join(SHOTS, 'screen-keys.png') });
    await page.click('#sd-keys-menu .menu-item:has-text("Ctrl+Alt+Del")');
    check('...which says it cannot be sent', await until(async () => /Ctrl\+Alt\+Del cannot be sent/.test(await page.$eval('#sd-note', (n) => n.textContent)), 3000));
    await page.click('#sd-close');
    check('closing the pane stops it on the PC', await until(async () => (await status()).controlledBy.people === 0, 5000));

    // ---- 3. Settings: Let Claude use this PC ----
    await page.click('#account-btn');
    await page.click('#account-menu .menu-item:has-text("Settings")');
    await page.click('.set-tab[data-pane="remote"]');
    check('Settings › Remote access has the two switches', await until(() => page.isVisible('#sd-set-cu .toggle'), 5000));
    check('...Claude\'s off, and remote desktop on since the pane allowed it', !(await page.$eval('#sd-set-cu .toggle', (t) => t.classList.contains('on'))) && (await page.$eval('#sd-set-rd .toggle', (t) => t.classList.contains('on'))));
    await page.click('#sd-set-cu .toggle');
    check('"Let Claude use this PC" turns on', await until(async () => (await status()).computerUse === true, 5000));
    await page.$eval('.sd-settings', (n) => n.scrollIntoView());
    await page.screenshot({ path: path.join(SHOTS, 'screen-settings.png') });
    await page.click('#settings-close');

    // ---- 4. Claude: a screenshot, then a click on the same button, asked for first ----
    const d = (await page.$eval('#sd-stage', (s) => s.dataset.size)).split('x').map(Number);
    const k = screen.fitScale(d[0], d[1]);
    const [bx, by] = mid(win.button);
    await page.fill('#input', `[computer:${Math.round(bx * k)},${Math.round(by * k)}] press the button`);
    await page.press('#input', 'Enter');
    check('Claude asks before it touches the app', await until(() => page.isVisible('.permission.computer-access'), 60000));
    const card = await page.$eval('.permission.computer-access', (n) => n.innerText);
    check('...naming the app and the tier', /Allow Claude to use .*PowerShell/.test(card) && /Click only/.test(card), card);
    check('...for the session, with Desktop\'s button', await page.isVisible('.permission.computer-access button:has-text("Allow for this session")'));
    check('...and nothing was clicked yet', clicks() === 1);
    await page.$eval('.permission.computer-access', (n) => n.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(SHOTS, 'screen-permission.png') });
    let sawClaude = false;
    await page.click('.permission.computer-access button:has-text("Allow for this session")');
    check('allowed, Claude\'s click presses the button', await until(async () => { if ((await status()).controlledBy.claude) sawClaude = true; return clicks() === 2; }, 30000), win.log().join(' | '));
    check('...the turn ends with Claude saying so', await until(async () => /Clicked the button\. Clicked at/.test(await page.$eval('#thread', (t) => t.innerText)), 30000));
    check('...while it worked the PC showed Claude in control', sawClaude || (await status()).controlledBy.claude);
    check('...and when the turn ended, it no longer is', await until(async () => !(await status()).controlledBy.claude, 10000));
    check('...and its steps read as Desktop\'s "Used your computer"', /Used your computer/.test(await page.$eval('#thread', (t) => t.innerText)));
    await page.screenshot({ path: path.join(SHOTS, 'screen-claude.png') });

    // ---- 5. the Android emulator, from the session menu ----
    const droid = await (await fetch(app.base + '/api/android/status', { headers: { authorization: 'Bearer ' + app.token } })).json();
    await page.click('#session-menu-btn');
    await page.click('#session-menu .menu-item:has-text("Android emulator")');
    if (!droid.sdk) {
      check('without an Android SDK the pane says how to get one', await until(() => page.isVisible('.sd-card:has-text("No Android SDK on this computer")'), 8000));
      check('...in words: Android Studio and its Device Manager', /Android Studio/.test(await page.$eval('.sd-card', (n) => n.textContent)));
    } else check('with an Android SDK the pane opens on the emulator', await until(() => page.isVisible('#sd-title:has-text("Android emulator")'), 8000));
    await page.screenshot({ path: path.join(SHOTS, 'screen-android.png') });
    await page.click('#sd-close');
    check('no page errors on the desktop', !errors.length, errors.join(' | '));

    // ---- 6. iPhone: the pane fills the screen, a tap is a click ----
    const phone = await open(webkit, { ...devices['iPhone 13'] });
    await phone.page.click('#session-menu-btn');
    await phone.page.click('#session-menu .menu-item:has-text("Remote desktop")');
    check('on the phone the session menu opens the pane', await until(() => phone.page.$eval('#sd-stage', (s) => s.classList.contains('live') && !!s.dataset.size), 30000));
    const box = await phone.page.$eval('#sd-panel', (n) => { const r = n.getBoundingClientRect(); return [r.width, window.innerWidth]; });
    check('...full width', box[0] >= box[1] - 1, JSON.stringify(box));
    p = await inPane(phone.page, ...mid(win.button));
    await phone.page.touchscreen.tap(p.x, p.y);
    check('a tap in the pane is a click on the PC', await until(() => clicks() === 3, 8000), win.log().join(' | '));
    await wait(800);
    await phone.page.screenshot({ path: path.join(SHOTS, 'screen-phone.png') });
    check('no page errors on the phone', !phone.errors.length, phone.errors.join(' | '));
  } finally {
    for (const b of browsers) await b.close().catch(() => {});
    await app.stop();
    await api.close();
    win.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
