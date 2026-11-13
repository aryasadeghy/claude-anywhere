// Desktop's row menu on a dashed (queued) message - Edit in composer, Send now, Remove - plus
// drag to reorder and several collapsing into a stack, with the real Claude Code talking to the
// fake Anthropic API (test/fixtures) so a message really does sit in the CLI's own queue while
// this exercises the controls on it.
// Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/queue-controls.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-queue-controls-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const api = await fx.startFakeApi();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'dddddddd-1111-2222-3333-444444444444');

  async function open(type, opts) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept()); // "Discard queued message?" - accept by default; tests override per-click with page.once where they need to
    await page.goto(app.base + '/#/s/' + sid);
    await page.waitForSelector('#thread .msg');
    await wait(800);
    return { browser, page, errors };
  }
  const threadText = (page) => page.$eval('#thread', (t) => t.innerText);
  async function send(page, text) { await page.fill('#input', text); await page.press('#input', 'Enter'); }
  const idle = (page) => until(async () => (await page.$eval('#send', (b) => b.title)) === 'Send', 30000);
  // Claude Code's request for a round's short label quotes the latest messages, a queued one too:
  // that is not the message reaching Claude as a turn, so it does not count.
  const reached = (words) => api.bodies.some((b) => !JSON.stringify(b.system || '').includes('short summary label') && JSON.stringify(b.messages || []).includes(words));

  const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });
  const queued = () => page.$$('#thread .msg.user.queued');
  const kebabOf = (h) => h.$('.queue-row-actions button');

  // 1. A message typed mid-turn is still queued straight into Claude Code (the house rule) - it
  // shows dashed, with a row menu.
  await send(page, 'Q1 [slow] a long one so there is time to act on what gets queued behind it');
  await until(async () => (await queued()).length === 0 && (await page.$eval('#send', (b) => b.title)) !== 'Send', 5000); // the turn is under way
  await send(page, 'Q2 remove me');
  check('a message typed mid-turn waits, dashed', await until(async () => (await queued()).length === 1, 5000));
  await page.screenshot({ path: path.join(SHOTS, 'queue-controls-dashed.png') });

  // 2. The row menu: Edit in composer / Send now / Remove.
  let h = (await queued())[0];
  await (await kebabOf(h)).click();
  const menuItems = await page.$$eval('#queue-ctx-menu .menu-item', (ns) => ns.map((n) => n.textContent.trim()));
  check('the row menu offers Edit in composer, Send now and Remove', ['Edit in composer', 'Send now', 'Remove'].every((w) => menuItems.some((t) => t.includes(w))), menuItems.join(' | '));
  await page.screenshot({ path: path.join(SHOTS, 'queue-controls-row-menu.png') });
  await page.keyboard.press('Escape');

  // 3. Right-click opens the same menu.
  await h.click({ button: 'right' });
  check('right-click opens the same menu', await page.isVisible('#queue-ctx-menu .menu-item:has-text("Remove")'));

  // 4. Remove: a confirm ("Discard queued message?"), then the dashed bubble goes and it never
  // runs as a turn of its own.
  const before = api.bodies.length;
  await page.click('#queue-ctx-menu .menu-item:has-text("Remove")');
  check('Remove takes the dashed bubble away', await until(async () => (await queued()).length === 0, 5000));
  await wait(1500);
  check('...and it never reaches Claude', !reached('Q2 remove me'), 'bodies since: ' + (api.bodies.length - before));
  await idle(page);

  // 5. Edit in composer: the bubble goes, its words come back in the box.
  await send(page, 'Q1 [slow] again, so there is time to edit what gets queued');
  await until(async () => (await page.$eval('#send', (b) => b.title)) !== 'Send', 5000);
  await send(page, 'Q3 edit me');
  await until(async () => (await queued()).length === 1, 5000);
  h = (await queued())[0];
  await (await kebabOf(h)).click();
  await page.click('#queue-ctx-menu .menu-item:has-text("Edit in composer")');
  check('Edit in composer removes the dashed bubble', await until(async () => (await queued()).length === 0, 5000));
  check('...and its words are back in the box', await until(async () => (await page.inputValue('#input')) === 'Q3 edit me', 5000), await page.inputValue('#input'));
  await page.fill('#input', '');
  await idle(page);

  // 6. Send now: the message runs ahead of waiting its turn behind the current one.
  await send(page, 'Q1 [slow] once more, so Send now has something to act on');
  await until(async () => (await page.$eval('#send', (b) => b.title)) !== 'Send', 5000);
  await send(page, 'Q4 send me now');
  await until(async () => (await queued()).length === 1, 5000);
  h = (await queued())[0];
  await (await kebabOf(h)).click();
  await page.click('#queue-ctx-menu .menu-item:has-text("Send now")');
  check('Send now answers the queued message', await until(async () => (await threadText(page)).includes('Answer to: Q4'), 15000));
  await page.screenshot({ path: path.join(SHOTS, 'queue-controls-send-now.png') });
  await idle(page);

  // 7. Several queued messages collapse into a stack - click to expand - and drag reorders them.
  await send(page, 'Q1 [slow] a last long one, for two messages to queue up behind');
  await until(async () => (await page.$eval('#send', (b) => b.title)) !== 'Send', 5000);
  await send(page, 'Q5 first in');
  await send(page, 'Q6 second in');
  check('two queued messages collapse into a stack', await until(() => page.isVisible('.queue-stack.collapsed'), 5000));
  check('...with Desktop\'s own words for it', (await page.textContent('.queue-stack-head')).includes('Queued messages collapse into a stack'));
  await page.screenshot({ path: path.join(SHOTS, 'queue-controls-stack-collapsed.png') });
  await page.click('.queue-stack-head');
  check('clicking it expands the stack', await until(() => page.isVisible('.queue-stack:not(.collapsed)'), 3000));
  check('...and both queued messages are there', (await queued()).length === 2);
  check('...with a way to collapse it again', (await page.textContent('.queue-stack-head')).includes('Collapse queued messages'));
  await page.screenshot({ path: path.join(SHOTS, 'queue-controls-stack-expanded.png') });

  const order = async () => page.$$eval('.queue-stack-body .msg.user.queued .msg-text', (ns) => ns.map((n) => n.textContent));
  check('queued in the order sent', (await order())[0].includes('Q5') && (await order())[1].includes('Q6'), (await order()).join(' | '));
  await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.queue-stack-body .msg.user.queued')];
    const [first, second] = bubbles;
    const dt = new DataTransfer();
    first.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const r = second.getBoundingClientRect();
    second.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
    second.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
    first.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  check('dragging the first below the second reorders them, on the page', await until(async () => (await order())[0].includes('Q6'), 3000), (await order()).join(' | '));
  check('...and the server took the new order without complaint', !(await page.$$eval('#thread .note.error', (ns) => ns.map((n) => n.textContent).join(' | '))).includes("reorder"));
  await page.screenshot({ path: path.join(SHOTS, 'queue-controls-reordered.png') });

  // Clean up the two still queued: Send now one, Remove the other, so the turn ends tidily.
  const remaining = await queued();
  await (await kebabOf(remaining[0])).click();
  await page.click('#queue-ctx-menu .menu-item:has-text("Remove")');
  await until(async () => (await queued()).length === 1, 5000);
  const last = (await queued())[0];
  await (await kebabOf(last)).click();
  await page.click('#queue-ctx-menu .menu-item:has-text("Send now")');
  await until(async () => (await queued()).length === 0, 8000);
  await idle(page);
  check('no errors in the app', !errors.length, errors.join(' | '));
  await browser.close();

  // 8. On a phone, in Safari's engine: the row menu and the stack still fit. A session of its
  // own, not the one above (grown long by now) - a long transcript takes a moment longer to
  // render in WebKit, and that moment is exactly the 600 ms the fake API's [slow] pacing gives
  // a turn to still be running in when the next message arrives.
  {
    const sid2 = fx.makeSession(path.join(tmp, 'claude'), cwd, 'ffffffff-1111-2222-3333-444444444444');
    const browser0 = await webkit.launch({ headless: true });
    const ctx0 = await browser0.newContext(devices['iPhone 15 Pro Max']);
    await ctx0.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    const page = await ctx0.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + sid2);
    await page.waitForSelector('#thread .msg');
    await wait(800);
    const browser = browser0;
    // Below 861px Enter only makes a newline (input's own keydown handler) - the phone sends by
    // tapping Send, same as a person would here.
    const sendPhone = async (text) => { await page.fill('#input', text); await page.click('#send'); };
    await sendPhone('Q1 [slow] on the phone, long enough to queue behind');
    // Wait for the prompt bubble itself, not the turn's answer: the run is already live (and the
    // next send already queues into it) the instant that bubble is drawn, well before the fake
    // API's 600 ms of streaming is anywhere near over.
    await until(async () => (await threadText(page)).includes('Q1 [slow] on the phone'), 10000);
    await sendPhone('Q7 on the phone');
    check('iphone: a queued message shows dashed', await until(() => page.isVisible('#thread .msg.user.queued'), 5000));
    const wide = await page.evaluate(() => [...document.querySelectorAll('.msg.user.queued, .msg.user.queued *')].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).map((n) => n.className));
    check('iphone: the dashed message and its row fit the screen', !wide.length, wide.join(', '));
    await page.screenshot({ path: path.join(SHOTS, 'queue-controls-iphone.png') });
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
