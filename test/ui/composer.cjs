// Claude Desktop's message box, in a real browser against the real Claude Code (fake API):
//   - "/" opens a popover of the app's own commands and Claude Code's;
//   - "@" opens a fuzzy file picker for the session's folder;
//   - a message starting with "!" runs as a shell command and its output becomes context;
//   - Ctrl/Cmd+U opens the file picker, up to 20 images a message;
//   - clicking a staged image opens an annotate editor (pen, rectangle, arrow, text, undo);
//   - a microphone button dictates (hidden where the browser has no Web Speech API);
//   - number keys 1-9 pick an option on an open question card;
//   - selecting text in the thread offers "Attach as context", as removable chips above the box.
// Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/composer.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
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
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(100); } return false; };

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-composer-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  // A couple of real files, so "@" has something to find - including a dotfile, which Desktop
  // includes too ("Dotfiles show up in the file tree and @-mention search").
  fs.writeFileSync(path.join(cwd, 'notes.md'), '# Notes\n');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"demo"}');
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'index.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'node_modules\n');
  const api = await fx.startFakeApi();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'dddddddd-5555-2222-3333-444444444444');

  // A stand-in for the Web Speech API: real recognition needs a microphone and a live network
  // connection to the browser's speech service, neither available here. window.__rec exposes
  // the newest instance so a test can call .fire('text', final) the way the real API delivers
  // a result, without touching anything about how app.js itself uses SpeechRecognition.
  const FAKE_SPEECH = `window.SpeechRecognition = window.webkitSpeechRecognition = class {
    start() { window.__rec = this; }
    stop() { this.onend?.(); }
    fire(text, isFinal = true) { this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal, length: 1 }] }); }
  };`;
  async function open(type, opts, { speech = false } = {}) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', permissions: [], ...opts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    if (speech) await ctx.addInitScript(FAKE_SPEECH);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + sid);
    await page.waitForSelector('#thread .msg');
    await wait(500);
    return { browser, page, errors };
  }
  const threadText = (page) => page.$eval('#thread', (t) => t.innerText);
  async function send(page, text) { await page.fill('#input', text); await page.press('#input', 'Enter'); }
  const idle = (page) => until(async () => (await page.$eval('#send', (b) => b.title)) === 'Send', 30000);

  const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } }, { speech: true });

  // 1. Selecting text in an assistant message offers "Attach as context"; clicking it makes a
  // removable chip above the box, and sending quotes it ahead of what was typed.
  await page.evaluate(() => {
    const p = document.querySelector('#thread .msg.assistant .prose p, #thread .msg.assistant .prose');
    const r = document.createRange(); r.selectNodeContents(p);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
  });
  check('selecting thread text shows the floating button', await until(() => page.isVisible('#ctx-float-btn:not(.hidden)'), 4000));
  await page.screenshot({ path: path.join(SHOTS, 'composer-attach-as-context.png') });
  await page.click('#ctx-float-btn');
  check('...and a removable chip appears above the box', await until(() => page.isVisible('.ctx-chip'), 3000));
  await send(page, 'see above');
  const before = api.bodies.length;
  check('Claude reads the quoted context ahead of the message', await until(() => api.bodies.slice(before - 1).some((b) => JSON.stringify(b.messages || []).includes('> Done.')), 15000));
  check('the chip is gone once sent', !(await page.isVisible('.ctx-chip')));
  await idle(page);

  // 2. "/" opens a popover of the app's own commands and Claude Code's; arrows and Enter pick one.
  await page.fill('#input', '/');
  check('"/" opens the popover', await until(() => page.isVisible('#composer-pop .cpop-item'), 5000));
  const names = () => page.$$eval('#composer-pop .cpop-item .cpop-name', (ns) => ns.map((n) => n.textContent));
  check('the app\'s own commands are offered', (await names()).includes('/rename'), (await names()).join(', '));
  check('and Claude Code\'s own are too', (await names()).includes('/compact'), (await names()).join(', '));
  await page.screenshot({ path: path.join(SHOTS, 'composer-slash-menu.png') });
  await page.type('#input', 'comp');
  check('filters as you type', await until(async () => { const n = await names(); return n.length === 1 && n[0] === '/compact'; }, 3000), (await names()).join(', '));
  await page.press('#input', 'Enter');
  check('Enter inserts "/name " and closes the popover', await until(async () => (await page.inputValue('#input')) === '/compact ' && !(await page.isVisible('#composer-pop:not(.hidden) .cpop-item')), 3000), await page.inputValue('#input'));
  await page.fill('#input', '');

  // 3. An app command (/rename) runs here instead of reaching Claude Code.
  await send(page, '/rename Renamed from the box');
  check('/rename changes the title without a turn', await until(async () => (await page.$eval('#chat-title', (n) => n.textContent)) === 'Renamed from the box', 8000), await page.$eval('#chat-title', (n) => n.textContent));
  check('...and Claude never saw it as a message', !(await threadText(page)).includes('/rename'));

  // 4. "@" opens a fuzzy file picker for the session's folder.
  await page.fill('#input', 'see @ind');
  check('"@" opens the file picker', await until(() => page.isVisible('#composer-pop .cpop-item'), 5000));
  check('it finds the file by a fuzzy match', await until(async () => (await page.$$eval('#composer-pop .cpop-name', (ns) => ns.map((n) => n.textContent))).some((n) => n.includes('index.js')), 3000));
  await page.screenshot({ path: path.join(SHOTS, 'composer-mention-menu.png') });
  await page.keyboard.press('Enter');
  check('picking inserts "@path "', await until(async () => /^see @.*index\.js $/.test(await page.inputValue('#input')), 3000), await page.inputValue('#input'));
  await page.fill('#input', '');

  // 5. "!" runs a shell command here and attaches its output as context for the next message.
  await send(page, '!echo from-the-shell');
  check('a "You ran" block appears', await until(() => page.isVisible('.step.shell'), 8000));
  check('...with the command shown', await until(async () => (await page.$eval('.step.shell summary .arg', (n) => n.textContent)).includes('echo from-the-shell')), 3000);
  check('...and its output streams in', await until(async () => (await page.$eval('.step-shell-out', (n) => n.textContent)).includes('from-the-shell'), 8000));
  await page.screenshot({ path: path.join(SHOTS, 'composer-shell-command.png') });
  check('the output is attached as context for the next message', await until(() => page.isVisible('.ctx-chip'), 5000));
  await page.click('.ctx-chip-x').catch(() => {});
  await idle(page);

  // 6. Dictation: a microphone button (Web Speech API), hidden where it does not exist - this
  // page was given a stand-in so starting and stopping it can be tested without a real mic.
  check('the dictate button shows up where SpeechRecognition exists', await until(() => page.isVisible('#dictate-btn:not(.hidden)'), 3000));
  await page.click('#dictate-btn');
  check('clicking starts it: "Cancel dictation"', await until(async () => (await page.getAttribute('#dictate-btn', 'title')) === 'Cancel dictation' && (await page.getAttribute('#dictate-btn', 'class')).includes('recording'), 3000));
  await page.evaluate(() => window.__rec.fire('this came from dictation'));
  check('a result lands in the box', await until(async () => (await page.inputValue('#input')).includes('this came from dictation'), 3000), await page.inputValue('#input'));
  await page.screenshot({ path: path.join(SHOTS, 'composer-dictation.png') });
  await page.click('#dictate-btn');
  check('clicking again cancels it: back to "Dictation"', await until(async () => (await page.getAttribute('#dictate-btn', 'title')) === 'Dictation' && !(await page.getAttribute('#dictate-btn', 'class')).includes('recording'), 3000));
  await page.fill('#input', '');

  // 7. Number keys 1-9 pick an option on an open question card, when focus is not in a text field.
  await send(page, 'Q7 [ask] pick one');
  check('Claude asks: the question card', await until(() => page.isVisible('.question-card .q-opt'), 20000));
  await page.click('#chat-title'); // focus leaves the box, onto something that is not a text field
  await page.keyboard.press('2');
  check('"2" picks the second option', await until(async () => (await page.$eval('.question-card:not(.answered) .q-opt:nth-child(2)', (b) => b.classList.contains('on'))), 3000));
  await page.screenshot({ path: path.join(SHOTS, 'composer-number-key-answer.png') });
  await page.click('.question-card:not(.answered) .permission-actions button:has-text("Answer")');
  await idle(page);

  // 8. Ctrl/Cmd+U opens the file picker (the input itself; a real OS dialog never appears headless).
  await page.evaluate(() => { window.__fileInputClicked = false; document.querySelector('#file-input').addEventListener('click', () => { window.__fileInputClicked = true; }, { once: true }); });
  await page.keyboard.press((process.platform === 'darwin' ? 'Meta' : 'Control') + '+u');
  check('Ctrl/Cmd+U opens the file picker', await until(() => page.evaluate(() => window.__fileInputClicked), 3000));

  // 9. Clicking a staged image opens the annotate editor: pen, rectangle, undo, Done replaces it.
  const pngPath = path.join(tmp, 'photo.png');
  fs.writeFileSync(pngPath, fx.pngOf(300, 200));
  await page.setInputFiles('#file-input', pngPath);
  check('the image is staged', await until(() => page.isVisible('.att-img img'), 5000));
  const srcBefore = await page.$eval('.att-img img', (img) => img.src);
  await page.click('.att-img img');
  check('clicking it opens the annotate editor', await until(() => page.isVisible('#annotate-modal:not(.hidden)'), 3000));
  const canvasBox = async () => page.$eval('#an-canvas', (c) => { const r = c.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
  let box = await canvasBox();
  // Rectangle, dragged corner to corner.
  await page.click('.an-tool[data-tool="rect"]');
  await page.mouse.move(box.left + box.width * 0.15, box.top + box.height * 0.15);
  await page.mouse.down();
  await page.mouse.move(box.left + box.width * 0.7, box.top + box.height * 0.6, { steps: 6 });
  await page.mouse.up();
  await page.screenshot({ path: path.join(SHOTS, 'composer-annotate-rect.png') });
  // Pen, a short scribble - a second stroke, so Undo below only takes this one back.
  await page.click('.an-tool[data-tool="pen"]');
  await page.mouse.move(box.left + box.width * 0.3, box.top + box.height * 0.75);
  await page.mouse.down();
  await page.mouse.move(box.left + box.width * 0.55, box.top + box.height * 0.8, { steps: 4 });
  await page.mouse.up();
  const beforeUndo = await page.$eval('#an-canvas', (c) => c.toDataURL());
  await page.click('#an-undo');
  const afterUndo = await page.$eval('#an-canvas', (c) => c.toDataURL());
  check('Undo takes the last stroke back', beforeUndo !== afterUndo);
  await page.click('#an-done');
  check('Done closes the editor', await until(async () => !(await page.isVisible('#annotate-modal:not(.hidden)')), 3000));
  const srcAfter = await page.$eval('.att-img img', (img) => img.src);
  check('...and replaces the staged image', srcAfter !== srcBefore);
  await page.screenshot({ path: path.join(SHOTS, 'composer-annotate-done.png') });
  await page.click('.att-x');

  await browser.close();

  // 10. The phone, in Safari's engine: the popover, the shell block and the annotate editor all
  // fit at 390px, and a finger (Pointer Events with pointerType "touch") draws on the canvas.
  {
    const { browser, page, errors } = await open(webkit, devices['iPhone 15 Pro Max']);
    await page.fill('#input', '/');
    check('iphone: "/" opens the popover', await until(() => page.isVisible('#composer-pop .cpop-item'), 5000));
    const wideSlash = await page.evaluate(() => [...document.querySelectorAll('#composer-pop')].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1));
    check('iphone: the popover fits the screen', !wideSlash.length);
    await page.screenshot({ path: path.join(SHOTS, 'composer-iphone-slash.png') });
    await page.fill('#input', '');

    await page.setInputFiles('#file-input', pngPath);
    await until(() => page.isVisible('.att-img img'), 5000);
    await page.click('.att-img img');
    check('iphone: the annotate editor opens', await until(() => page.isVisible('#annotate-modal:not(.hidden)'), 3000));
    const blank = await page.$eval('#an-canvas', (c) => c.toDataURL());
    const ibox = await page.$eval('#an-canvas', (c) => { const r = c.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
    const pt = (fx2, fy2) => ({ x: ibox.left + ibox.width * fx2, y: ibox.top + ibox.height * fy2 });
    const touch = async (x, y, type) => page.dispatchEvent('#an-canvas', type, { pointerType: 'touch', pointerId: 2, isPrimary: true, clientX: x, clientY: y, bubbles: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
    const a = pt(0.2, 0.2), b = pt(0.6, 0.5);
    await touch(a.x, a.y, 'pointerdown'); await touch(b.x, b.y, 'pointermove'); await touch(b.x, b.y, 'pointerup');
    const touched = await page.$eval('#an-canvas', (c) => c.toDataURL());
    check('iphone: a touch (pointerType touch) draws on the canvas', touched !== blank);
    await page.screenshot({ path: path.join(SHOTS, 'composer-iphone-annotate.png') });
    check('iphone: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed overall`);
  await Promise.race([app.stop(), wait(5000)]);
  await api.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exitCode = failed ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
