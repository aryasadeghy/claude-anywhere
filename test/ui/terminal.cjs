// The terminal pane: tabs, a real shell per tab (PowerShell here), the running dot, a
// crashed/exited shell staying open with Restart, closing a busy tab asking first, the
// right-click menu, and Minimize. Shots in test/ui/shots/.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/terminal.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// Attached context is a chip above the box (the message box group); its title is what will be sent.
const chipsText = (page) => page.$$eval('#context-chips .ctx-chip', (cs) => cs.map((c) => c.title).join('\n---\n'));
const clearChips = async (page) => { while (await page.$('#context-chips .ctx-chip-x')) await page.click('#context-chips .ctx-chip-x'); };

const SHOTS = path.join(__dirname, 'shots');
const channel = process.env.PW_CHANNEL || undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail = '') { ok ? passed++ : failed++; console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail && !ok ? '  — ' + detail : '')); }
// A real shell cold-starting (PowerShell especially) is slower than the fake API's turns.
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(100); } return false; };

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-terminal-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const api = await fx.startFakeApi({ delay: 0 }); // nothing here sends a chat message; word-by-word pacing would only slow teardown
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'eeeeeeee-1111-2222-3333-444444444444');

  async function open(type, opts) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + sid);
    await page.waitForSelector('#thread .msg');
    return { browser, page, errors };
  }
  const termText = (page) => page.$eval('#term-stage .term-view:not(.hidden) .term-xterm', (n) => n.innerText).catch(() => '');
  const activeTabRunning = (page) => page.evaluate(() => !!document.querySelector('#term-tabs .pv-tab.on .term-dot'));
  const bannerVisible = (page) => page.evaluate(() => !document.querySelector('#term-stage .term-view:not(.hidden) .term-banner').classList.contains('hidden'));

  const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });

  // 1. Ctrl+` opens the pane and a tab starts a real shell.
  await page.keyboard.press('Control+`');
  check('the terminal panel opens', await until(() => page.isVisible('#terminal-panel:not(.hidden)'), 5000));
  check('a tab appears in the tab bar', await until(async () => (await page.$$('#term-tabs .pv-tab')).length === 1, 5000));
  check('the shell has started (a prompt, something to read)', await until(async () => (await termText(page)).trim().length > 0, 15000), await termText(page));

  // 2. A command run by hand: its output shows, and the running dot comes and goes. `echo`
  // alone finishes inside one poll of this check, so the command itself takes a beat - node
  // is the one thing guaranteed to be on PATH in both PowerShell and bash, which is what
  // this needs rather than something shell-specific.
  await page.click('#term-stage .term-view:not(.hidden) .term-xterm');
  await page.keyboard.type(`node -e "setTimeout(()=>console.log('hello-ca-terminal'),900)"`);
  await page.keyboard.press('Enter');
  check('the running dot appears while the command runs', await until(() => activeTabRunning(page), 4000));
  check('the command’s output reaches the pane', await until(async () => (await termText(page)).includes('hello-ca-terminal'), 15000), await termText(page));
  check('the running dot goes once the shell is back at its prompt', await until(async () => !(await activeTabRunning(page)), 8000));

  // 3. A second tab, in the tab bar.
  await page.click('#term-new');
  check('a second tab opens', await until(async () => (await page.$$('#term-tabs .pv-tab')).length === 2, 10000));
  check('the new tab is the one shown', await until(async () => (await termText(page)).trim().length > 0, 15000));
  await page.screenshot({ path: path.join(SHOTS, 'terminal-two-tabs.png') }); // the one desktop shot: tabs, a live shell, the pane itself

  // 4. The shell ending on its own (here, typing exit) leaves the tab open with Restart,
  // not closed - the same as a crash, per Desktop's own wording.
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  check('the tab stays, offering Restart, once its shell has ended', await until(() => bannerVisible(page), 10000));
  check('"Shell exited." is what it says', await until(async () => (await page.$eval('#term-stage .term-view:not(.hidden) .term-banner', (n) => n.innerText)).includes('Shell exited.'), 2000));
  await page.click('#term-stage .term-view:not(.hidden) .term-banner button:has-text("Restart")');
  check('Restart brings the shell back', await until(async () => !(await bannerVisible(page)), 10000));
  await page.click('#term-stage .term-view:not(.hidden) .term-xterm');
  await page.keyboard.type('echo back-again');
  await page.keyboard.press('Enter');
  check('...and it runs commands again', await until(async () => (await termText(page)).includes('back-again'), 15000));

  // 5. Closing a tab that has something running asks first.
  await page.click('#term-stage .term-view:not(.hidden) .term-xterm');
  await page.keyboard.type(`node -e "setTimeout(()=>{},1500)"`);
  await page.keyboard.press('Enter');
  check('(setup) the command is running', await until(() => activeTabRunning(page), 4000));
  let dialogText = '';
  page.once('dialog', (d) => { dialogText = d.message(); d.dismiss(); });
  await page.click('#term-tabs .pv-tab.on .pv-tab-x');
  check('closing a tab with a command still running asks first', await until(() => !!dialogText, 4000), dialogText);
  check('...and dismissing it keeps the tab', (await page.$$('#term-tabs .pv-tab')).length >= 1);
  await until(async () => !(await activeTabRunning(page)), 8000); // let the sleep finish so the next close asks nothing
  const before = (await page.$$('#term-tabs .pv-tab')).length;
  await page.click('#term-tabs .pv-tab.on .pv-tab-x');
  check('a tab with nothing running closes without asking', await until(async () => (await page.$$('#term-tabs .pv-tab')).length === before - 1, 5000));

  // 6. Right-click: Copy, Paste, Attach selection as context - and the last one reaches the composer.
  await page.click('#term-stage .term-view:not(.hidden) .term-xterm');
  await page.keyboard.type('echo attach-me-please');
  await page.keyboard.press('Enter');
  await until(async () => (await termText(page)).includes('attach-me-please'), 15000);
  // Double-click a word the shell echoed back: xterm.js selects it, the way a terminal does.
  // xterm's own mouse-handling overlay sits on top of the row text, so Playwright's element
  // click (which insists the target itself is on top) never lands - a real mouse double-click
  // at the text's own coordinates does, the same as a person's would.
  const word = page.locator('#term-stage .term-view:not(.hidden) .xterm-rows div', { hasText: 'attach-me-please' }).last();
  const box = await word.boundingBox();
  await page.mouse.dblclick(box.x + 10, box.y + box.height / 2);
  await page.click('#term-stage .term-view:not(.hidden) .term-xterm', { button: 'right' });
  const menuText = await page.$eval('#ctx-menu', (n) => n.innerText).catch(() => '');
  check('the right-click menu offers Copy, Paste and Attach selection as context', /Copy/.test(menuText) && /Paste/.test(menuText) && /Attach selection as context/.test(menuText), menuText);
  await page.click('#ctx-menu .menu-item:has-text("Attach selection as context")');
  check('...and attaches the selection as a chip', await until(async () => /attach-me-please/.test(await chipsText(page)), 4000), await chipsText(page));
  await clearChips(page);
  await page.fill('#input', '');

  // 7. Minimize.
  await page.click('#term-min');
  check('minimizing hides the tabs and shows the pill', await until(() => page.isVisible('#term-pill:not(.hidden)'), 3000));
  check('...and the chat behind it is reachable again', await until(() => page.isVisible('#thread'), 2000));
  await page.click('#term-pill');
  check('clicking the pill restores it', await until(async () => (await page.isVisible('#terminal-panel:not(.hidden)')) && !(await page.isVisible('#term-pill:not(.hidden)')), 3000));

  // 8. Found from the command palette and the session menu too.
  await page.click('#term-close');
  await page.keyboard.press('Control+k');
  await page.fill('#palette-input', 'terminal');
  check('the command palette lists Terminal', await until(() => page.isVisible('.palette-item:has-text("Terminal")'), 3000));
  await page.keyboard.press('Escape');

  // 9. Claude's own open_terminal_tab (allowed, no asking): the pane opens with the tab it
  // used, the same one the person would see if they had opened it themselves.
  await page.fill('#input', 'Q [terminal] open one for me');
  await page.press('#input', 'Enter');
  check('Claude opening a tab opens the pane, unasked', await until(() => page.isVisible('#terminal-panel:not(.hidden)'), 15000));

  check('no errors in the app', !errors.length, errors.join(' | '));
  await browser.close();

  // 9. On a phone, in Safari's engine: a full-screen sheet, and typing works.
  {
    const { browser, page, errors } = await open(webkit, devices['iPhone 15 Pro Max']);
    await page.click('#session-menu-btn');
    await page.click('.menu-item:has-text("Terminal")');
    check('iphone: the terminal opens as a full-screen sheet', await until(() => page.isVisible('#terminal-panel:not(.hidden)'), 5000));
    // xterm.js keeps its own IME textarea off-screen on purpose (left: -9999em, 0x0, opacity 0)
    // for IMEs to find it at the cursor without it ever being seen - not a layout bug to flag.
    const wide = await page.evaluate(() => [...document.querySelectorAll('#terminal-panel, #terminal-panel *')].filter((n) => !n.classList.contains('xterm-helper-textarea') && n.getBoundingClientRect().right > window.innerWidth + 1).map((n) => n.className));
    check('iphone: nothing in the pane is wider than the screen', !wide.length, wide.join(', '));
    await until(async () => (await termText(page)).trim().length > 0, 15000);
    await page.click('#term-stage .term-view:not(.hidden) .term-xterm');
    await page.keyboard.type('echo iphone-ok');
    await page.keyboard.press('Enter');
    check('iphone: typing reaches the shell', await until(async () => (await termText(page)).includes('iphone-ok'), 15000), await termText(page));
    await page.screenshot({ path: path.join(SHOTS, 'terminal-iphone.png') });
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
