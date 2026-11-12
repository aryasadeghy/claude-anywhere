// The Browser pane with a real browser behind it (lib/browser.mjs): a headless Chrome or Edge on
// the server's computer, streamed into the pane, driven by the pointer and keys in the pane and
// by Claude's preview_* tools. The page under test is a tiny local server that reports what
// happens to it, so every check is the page's own word, not the pane's. Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/browser-real.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const SHOTS = path.join(__dirname, 'shots');
const channel = process.env.PW_CHANNEL || undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail = '') { ok ? passed++ : failed++; console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail && !ok ? '  — ' + detail : '')); }
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(50); } return false; };

// A page with a big button, a text box, a link that opens a window, and a tall body to scroll -
// each reporting back to this server.
const PAGE = `<!doctype html><title>Test page</title><meta name=viewport content="width=device-width">
<style>body{margin:0;font:18px sans-serif;height:3000px} #btn{position:fixed;left:0;top:0;width:300px;height:120px;font-size:24px} #inp{position:fixed;left:0;top:140px;width:300px;height:40px;font-size:18px} #pop{position:fixed;left:0;top:200px;font-size:20px} #w{position:fixed;left:0;top:240px} body.clicked #btn{background:#c33;color:#fff}</style>
<button id=btn onclick="document.body.classList.add('clicked');this.textContent='Clicked';fetch('/ev?clicked')">Press</button>
<input id=inp oninput="fetch('/ev?typed='+encodeURIComponent(this.value))">
<a id=pop href="/two" target="_blank">Open two</a><div id=w></div>
<script>let t;function upd(){document.getElementById('w').textContent=innerWidth+'x'+innerHeight;fetch('/ev?w='+innerWidth)};addEventListener('resize',upd);upd();addEventListener('scroll',()=>{clearTimeout(t);t=setTimeout(()=>fetch('/ev?scroll='+Math.round(scrollY)),80)})</script>`;

function browserProcesses(dir) {
  try {
    if (process.platform === 'win32') {
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${dir.replace(/'/g, "''")}*' -and $_.Name -match 'chrome|msedge' } | Measure-Object | Select-Object -ExpandProperty Count`;
      return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim()) || 0;
    }
    return execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(dir) && /chrom|edge/i.test(l)).length;
  } catch { return -1; }
}

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-browser-real-'));
  const cwd = path.join(tmp, 'project'); fs.mkdirSync(cwd, { recursive: true });
  const events = [];
  const site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/ev') { events.push(decodeURIComponent(u.search.slice(1))); res.writeHead(204); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(u.pathname === '/two' ? '<title>Page two</title><h1>Two</h1>' : PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const port = site.address().port;
  const api = await fx.startFakeApi({ delay: 0 });
  const dataDir = path.join(tmp, 'data');
  const app = await fx.startApp({ port: await fx.freePort(), dataDir, configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'abababab-1111-2222-3333-444444444444');
  fs.mkdirSync(SHOTS, { recursive: true });
  const status = await (await fetch(app.base + '/api/browser/status', { headers: { authorization: 'Bearer ' + app.token } })).json();
  if (!status.available) { console.log('skip  no Chrome or Edge on this computer'); await app.stop(); await api.close(); site.close(); return; }
  const has = (e) => events.includes(e);
  const lastW = () => [...events].reverse().find((e) => e.startsWith('w='));

  async function open(type, opts) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'light', ...opts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    await ctx.route('**/api/preview/ports', (r) => r.fulfill({ json: { ports: [] } }));
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + sid);
    await page.waitForSelector('#thread .msg');
    return { browser, page, errors };
  }
  const view = (page) => page.$('#pv-stage .rv:not(.hidden)');
  const box = async (page) => (await view(page)).boundingBox();
  const live = (page) => until(async () => !!(await page.$('#pv-stage .rv.live:not(.hidden)')));
  const goTo = async (page, addr) => { await page.fill('#pv-addr', addr); await page.press('#pv-addr', 'Enter'); };

  // ---------- desktop ----------
  {
    const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });
    await page.keyboard.press('Control+Shift+B');
    await page.waitForSelector('#preview-panel.rv-on:not(.hidden)');
    check('the pane knows it has a real browser behind it', true);
    await goTo(page, 'localhost:' + port);
    check('a local page opens in the pane and its picture arrives', await live(page));
    const b = await box(page);
    check('the page is laid out at the pane\'s size', await until(() => lastW() === 'w=' + Math.round(b.width)), lastW() + ' vs ' + b.width);
    check('the tab takes the page\'s title', await until(async () => (await page.$eval('#pv-tabs .pv-tab.on', (t) => t.textContent)).includes('Test page')));
    await page.mouse.click(b.x + 150, b.y + 60);
    check('a click in the pane presses the page\'s button', await until(() => has('clicked')), events.join(','));
    await page.mouse.click(b.x + 150, b.y + 160);
    await page.keyboard.type('hello');
    await page.keyboard.press('Backspace');
    check('typing goes into the page\'s text box, Backspace too', await until(() => has('typed=hell')), events.filter((e) => e.startsWith('typed')).join(','));
    await page.mouse.move(b.x + 400, b.y + 400); await page.mouse.wheel(0, 600);
    check('the wheel scrolls the page', await until(() => events.some((e) => /^scroll=[1-9]/.test(e))), events.filter((e) => e.startsWith('scroll')).join(','));
    await page.screenshot({ path: path.join(SHOTS, 'browser-real-desktop.png'), clip: { x: 300, y: 0, width: 1080, height: 860 } });

    await page.click('#pv-device');
    check('Phone size lays the page out at 390 wide', await until(() => lastW() === 'w=390'), lastW());
    check('...shown whole inside the pane', await until(async () => !!(await page.$('#pv-stage .rv.emu'))) && (await page.$eval('#pv-device', (x) => x.getAttribute('aria-pressed'))) === 'true');
    await wait(300);
    await page.screenshot({ path: path.join(SHOTS, 'browser-real-phone-size.png'), clip: { x: 300, y: 0, width: 1080, height: 860 } });
    await page.click('#pv-device');
    check('...and back to the pane\'s own size', await until(() => lastW() === 'w=' + Math.round(b.width)), lastW());

    const before = (await page.$$('#pv-tabs .pv-tab')).length;
    await page.mouse.click(b.x + 40, b.y + 210);
    check('a link that opens a window becomes a tab of the pane', await until(async () => (await page.$$('#pv-tabs .pv-tab')).length === before + 1 && (await page.$eval('#pv-tabs .pv-tab.on', (t) => t.textContent)).includes('Page two')));
    await page.click('#pv-back').catch(() => {});
    await page.click('#pv-tabs .pv-tab.on .pv-tab-x');
    check('closing that tab goes back to the first', await until(async () => (await page.$eval('#pv-tabs .pv-tab.on', (t) => t.textContent)).includes('Test page')));

    await page.click('#pv-capture');
    check('Capture screenshot puts the page in the message, ready to mark up', await until(async () => !!(await page.$('#annotate-modal:not(.hidden)'))) && (await page.$$('.att-chip img, #attachments img')).length >= 0);
    await page.click('#an-cancel').catch(() => {});

    // Claude's own tools, through the fake API: open the page, take a screenshot, click #btn.
    events.length = 0;
    await page.click('#pv-close');
    await page.fill('#input', `[browse:http://localhost:${port}/] check the button`);
    await page.press('#input', 'Enter');
    check('Claude using a Browser tool opens the pane on its tab', await until(async () => !!(await page.$('#preview-panel:not(.hidden) #pv-stage .rv.live:not(.hidden)')), 30000));
    check('preview_click presses the button, local page, no asking', await until(() => has('clicked'), 30000), events.join(','));
    check('the turn ends with Claude\'s answer', await until(async () => (await page.$eval('#thread', (t) => t.innerText)).includes('Clicked the button.'), 30000));
    const shotResult = api.bodies.flatMap((bd) => bd.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_result').some((c) => Array.isArray(c.content) && c.content.some((x) => x.type === 'image' && x.source?.data?.length > 1000));
    check('preview_screenshot hands Claude an image', shotResult);
    check('no permission was asked for this computer\'s own page', !(await page.$('.perm-card, .permission')));
    check('the thread shows the screenshot Claude took', await until(async () => !!(await page.$('#thread img.tool-img'))));
    await page.screenshot({ path: path.join(SHOTS, 'browser-real-claude.png'), clip: { x: 300, y: 0, width: 1080, height: 860 } });
    check('no page errors (desktop)', !errors.length, errors.join(' | '));
    await browser.close();
  }

  // ---------- iPhone, WebKit: a tap is a click, a drag scrolls ----------
  {
    const { browser, page, errors } = await open(webkit, { ...devices['iPhone 15 Pro Max'] });
    await page.keyboard.press('Control+Shift+B');
    await page.waitForSelector('#preview-panel.rv-on:not(.hidden)');
    events.length = 0;
    await goTo(page, 'localhost:' + port);
    // The pane may come back to the tab it had, scrolled and clicked: a fresh load says so.
    await page.click('#pv-reload');
    check('the pane shows the page on a phone', await live(page));
    const b = await box(page);
    check('the page is laid out at the phone pane\'s width', await until(() => lastW() === 'w=' + Math.round(b.width)), lastW() + ' vs ' + b.width);
    events.length = 0;
    await page.touchscreen.tap(b.x + 150, b.y + 60);
    check('a tap clicks the button', await until(() => has('clicked')), events.join(','));
    await page.evaluate(({ x, y }) => {
      const f = document.querySelector('#pv-stage .rv:not(.hidden)');
      const ev = (type, yy) => f.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', pointerId: 7, clientX: x, clientY: yy, bubbles: true, cancelable: true, isPrimary: true }));
      ev('pointerdown', y); for (let i = 1; i <= 10; i++) ev('pointermove', y - i * 30); ev('pointerup', y - 300);
    }, { x: b.x + 200, y: b.y + 500 });
    check('a finger dragging up scrolls the page down', await until(() => events.some((e) => /^scroll=[1-9]/.test(e))), events.join(','));
    check('the keyboard button is there on a phone', await page.isVisible('#pv-kbd'));
    await page.screenshot({ path: path.join(SHOTS, 'browser-real-iphone.png') });
    check('no page errors (iPhone)', !errors.length, errors.join(' | '));
    await browser.close();
  }

  const profile = path.join(dataDir, 'browser');
  check('the browser is running while the app is', browserProcesses(profile) > 0);
  await app.stop();
  check('stopping the app leaves no browser behind', await until(() => browserProcesses(profile) === 0, 10000), String(browserProcesses(profile)));
  await api.close(); site.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
