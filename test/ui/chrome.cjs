// Claude in Chrome, as a person meets it, on a pretend computer (CA_CHROME_HOME: a folder standing in for
// Chrome's profiles, the registry and ~/.claude - nothing real is read or written):
//   - Settings › General has a card that says which of the three pieces are in place (Chrome, the extension,
//     the connection to Claude Code), with Get the extension, Connect and Check again;
//   - the extension appears, Check again sees it, Connect registers the host and the card turns ready;
//   - the switch in Settings and the one in a session's menu are remembered;
//   - a session that used Chrome reads in words ("Opened mail.example.com", the screenshot) in the transcript.
// Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/chrome.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
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
const EXT = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-chrome-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  // The pretend computer: Chrome has a profile, the extension is not in it yet.
  const pc = path.join(tmp, 'pc');
  const profile = path.join(pc, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default');
  fs.mkdirSync(profile, { recursive: true });
  const api = await fx.startFakeApi();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: { ...fx.fakeApiEnv(api), CA_CHROME_HOME: pc, CA_CHROME_PLATFORM: 'win32' } });
  fs.mkdirSync(SHOTS, { recursive: true });
  const get = async (p) => (await fetch(app.base + '/api' + p, { headers: { authorization: 'Bearer ' + app.token } })).json();

  // A session that used Chrome: a page opened, a screenshot, the page read.
  const sid = 'eeeeeeee-1111-2222-3333-444444444444';
  {
    const dir = path.join(tmp, 'claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const at = (s) => new Date(Date.now() - s * 1000).toISOString();
    const P = 'mcp__claude-in-chrome__';
    const use = (id, name, input) => ({ type: 'tool_use', id, name: P + name, input });
    const lines = [
      { type: 'user', uuid: 'eeeeeeee-0000-0000-0000-000000000001', timestamp: at(60), cwd, customTitle: 'Check my inbox', message: { role: 'user', content: [{ type: 'text', text: 'Open my mail and tell me what is new.' }] } },
      { type: 'assistant', uuid: 'eeeeeeee-0000-0000-0000-000000000002', timestamp: at(55), cwd, message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [use('t1', 'navigate', { url: 'https://mail.example.com/inbox', tabId: 1 })] } },
      { type: 'user', uuid: 'eeeeeeee-0000-0000-0000-000000000003', timestamp: at(54), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Navigated to https://mail.example.com/inbox' }] }] } },
      { type: 'assistant', uuid: 'eeeeeeee-0000-0000-0000-000000000004', timestamp: at(50), cwd, message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [use('t2', 'computer', { action: 'screenshot', tabId: 1 })] } },
      { type: 'user', uuid: 'eeeeeeee-0000-0000-0000-000000000005', timestamp: at(49), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: fx.pngOf(480, 260).toString('base64') } }] }] } },
      { type: 'assistant', uuid: 'eeeeeeee-0000-0000-0000-000000000006', timestamp: at(45), cwd, message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [use('t3', 'read_page', { tabId: 1 })] } },
      { type: 'user', uuid: 'eeeeeeee-0000-0000-0000-000000000007', timestamp: at(44), cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: [{ type: 'text', text: 'Inbox (2)' }] }] } },
      { type: 'assistant', uuid: 'eeeeeeee-0000-0000-0000-000000000008', timestamp: at(40), cwd, message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: 'You have two new messages.' }] } },
    ];
    const file = path.join(dir, sid + '.jsonl');
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const then = new Date(Date.now() - 10 * 60 * 1000); fs.utimesSync(file, then, then);
  }

  async function open(type, opts) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + sid);
    await page.waitForSelector('#thread .msg');
    await wait(600);
    return { browser, page, errors };
  }
  async function settings(page) {
    const offscreen = () => page.$eval('#account-btn', (n) => { const r = n.getBoundingClientRect(); return r.right <= 0 || r.left >= window.innerWidth; });
    if (await offscreen()) {
      if (!(await page.$eval('#app', (a) => a.classList.contains('sidebar-open')))) await page.click('#sidebar-open');
      await until(async () => !(await offscreen()), 5000);
    }
    await page.click('#account-btn');
    await page.click('#account-menu >> text=Settings…');
    await page.waitForSelector('#set-chrome', { state: 'visible' });
    await until(() => page.isVisible('#set-chrome-card .chrome-line'), 5000);
  }
  const lines = (page) => page.$$eval('#set-chrome-card .chrome-line', (ns) => ns.map((n) => n.className.replace('chrome-line ', '') + ': ' + n.innerText.replace(/\s+/g, ' ')));
  const buttons = (page) => page.$$eval('#set-chrome-card .chrome-actions button', (ns) => ns.map((n) => n.textContent));

  const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });

  // 1. Chrome is there, the extension is not.
  await settings(page);
  const first = await lines(page);
  check('the card sees Chrome', first[0].startsWith('ok') && /Chrome/.test(first[0]), first.join(' | '));
  check('...says the extension is missing', first[1].startsWith('todo') && /Not installed/.test(first[1]), first.join(' | '));
  check('...and that nothing is connected', first[2].startsWith('todo') && /Not connected/.test(first[2]), first.join(' | '));
  check('Signed in for Chrome is fine on the own login', first[3]?.startsWith('ok') && /Signed in for Chrome/.test(first[3]), first.join(' | '));
  check('Get the extension and Check again are offered', (await buttons(page)).includes('Get the extension') && (await buttons(page)).includes('Check again'), (await buttons(page)).join(','));
  check('the switch is off', !(await page.$eval('#set-chrome-switch .toggle', (t) => t.classList.contains('on'))));
  await page.screenshot({ path: path.join(SHOTS, 'chrome-settings-missing.png') });

  // 2. The extension is added in Chrome; Check again sees it, and Connect appears.
  fs.mkdirSync(path.join(profile, 'Extensions', EXT, '1.0_0'), { recursive: true });
  await page.click('#set-chrome-card button:has-text("Check again")');
  check('Check again sees the extension', await until(async () => /^ok.*Claude extension/.test((await lines(page))[1] || ''), 5000), (await lines(page)).join(' | '));
  check('Connect is offered, Get the extension is not', await until(async () => { const b = await buttons(page); return b.includes('Connect') && !b.includes('Get the extension'); }, 3000), (await buttons(page)).join(','));
  await page.screenshot({ path: path.join(SHOTS, 'chrome-settings-extension.png') });

  // 3. Connect registers the host on the pretend computer.
  await page.click('#set-chrome-card button:has-text("Connect")');
  check('Connect turns the card ready', await until(async () => /^ok.*Connected to Claude Code/.test((await lines(page))[2] || '') && /^Ready/.test(await page.$eval('#set-chrome-card .chrome-says', (n) => n.textContent)), 8000), (await lines(page)).join(' | '));
  const reg = JSON.parse(fs.readFileSync(path.join(pc, 'registry.json'), 'utf8'));
  check('...by writing the registry key and the manifest the CLI writes', Object.keys(reg).some((k) => /Google\\Chrome\\NativeMessagingHosts\\com\.anthropic\.claude_code_browser_extension$/.test(k)) && fs.existsSync(path.join(pc, 'AppData', 'Roaming', 'Claude Code', 'ChromeNativeHost', 'com.anthropic.claude_code_browser_extension.json')));
  check('...and no Connect button is left', !(await buttons(page)).includes('Connect'), (await buttons(page)).join(','));
  await page.screenshot({ path: path.join(SHOTS, 'chrome-settings-ready.png') });

  // 4. The switch is remembered, by the app and by the session menu.
  await page.click('#set-chrome-switch .toggle');
  check('the Settings switch is remembered', await until(async () => (await get('/chrome')).enabled === true, 3000));
  check('...and a session starts out following it', (await get('/sessions/' + sid)).settings?.chrome === true);
  await page.keyboard.press('Escape');
  await page.reload(); await page.waitForSelector('#thread .msg'); await wait(500);
  await page.click('#session-menu-btn');
  await until(() => page.isVisible('#session-menu .menu-switch'), 3000);
  check('the session menu has a Use your Chrome switch, on', await page.$eval('#session-menu .menu-switch .toggle', (t) => t.classList.contains('on')));
  await page.click('#session-menu .menu-switch .toggle');
  check('turning it off there is remembered for that session only', await until(async () => (await get('/sessions/' + sid)).settings?.chrome === false, 3000) && (await get('/chrome')).enabled === true);
  await page.screenshot({ path: path.join(SHOTS, 'chrome-session-menu.png') });
  await page.keyboard.press('Escape'); await page.click('#thread', { position: { x: 5, y: 5 } }).catch(() => {});

  // 5. The transcript says what Claude did in Chrome.
  await page.click('#thread details.tool-group > summary');
  const rows = await page.$$eval('#thread details.tool-group .step > summary', (ns) => ns.map((n) => n.innerText.replace(/\s+/g, ' ').trim()));
  check('the group says it used Chrome', /Used Chrome 3 times/.test(await page.$eval('#thread details.tool-group > summary', (n) => n.textContent)));
  check('a page opened reads "Opened <site>"', rows.some((r) => /^Opened mail\.example\.com/.test(r)), rows.join(' | '));
  check('a screenshot reads as one', rows.some((r) => /^Took a screenshot of the page/.test(r)), rows.join(' | '));
  check('reading the page reads "Read the page"', rows.some((r) => /^Read the page/.test(r)), rows.join(' | '));
  // A step with a picture in its result opens by itself: the screenshot is the point of the row.
  check('the screenshot itself is shown', await until(() => page.$eval('#thread img.tool-img', (i) => i.complete && i.naturalWidth > 100), 5000), await page.$$eval('#thread img', (is) => is.map((i) => i.className + ' ' + i.src.slice(0, 90) + ' ' + i.naturalWidth).join(' | ')));
  await page.screenshot({ path: path.join(SHOTS, 'chrome-transcript.png') });
  check('no errors in the app', !errors.length, errors.join(' | '));
  await browser.close();

  // 6. On a phone, in Safari's engine: the card fits.
  {
    const { browser, page, errors } = await open(webkit, devices['iPhone 15 Pro Max']);
    await settings(page);
    const wide = await page.evaluate(() => [...document.querySelectorAll('#set-chrome, #set-chrome *')].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).map((n) => n.className || n.tagName));
    check('iphone: the Chrome card fits the screen', !wide.length, wide.join(', '));
    await page.locator('#set-chrome').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, 'chrome-settings-iphone.png') });
    check('iphone: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed · screenshots in test/ui/shots`);
  await Promise.race([app.stop(), wait(5000)]);
  await api.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
