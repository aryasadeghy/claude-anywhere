// Notifications on any device, the aside, the shortcuts panel and Stop on the Servers card, as a
// person meets them, with the real Claude Code talking to the fake Anthropic API (test/fixtures):
//   - Settings > Notifications turns Web Push on for a device (the browser's push service is a
//     stand-in this test runs: it takes the POST and decrypts it with the device's own keys), and
//     a push arrives after a turn ends - not while the page is in front, and for a question and a
//     background task as well;
//   - the service worker shows what it is sent, and a click opens that session;
//   - a message sent while Claude works gets an aside under it, and Claude is told what it said;
//     none when it fails or is slow or the setting is off;
//   - Ctrl+/ opens the shortcuts panel, searchable, closed by Esc;
//   - Stop on the Servers card ends a dev server this test started, and refuses the app's own port.
// Shots in test/ui/shots.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/notify.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const SHOTS = path.join(__dirname, 'shots');
const channel = process.env.PW_CHANNEL || undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail = '') { ok ? passed++ : failed++; console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail && !ok ? '  — ' + detail : '')); }
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(50); } return false; };
const b64u = (b) => Buffer.from(b).toString('base64url');

// The browser's push service: takes what the server POSTs, and - being the device - decrypts it
// (RFC 8291, written out here again rather than imported, so the server's side is checked by a second reading).
function startPushService() {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const got = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    let message = null;
    try {
      const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
      const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(asPub), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
      const d = crypto.createDecipheriv('aes-128-gcm', Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
      d.setAuthTag(ct.subarray(ct.length - 16));
      message = JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString().replace(/\x02$/, ''));
    } catch (e) { message = { error: e.message }; }
    got.push({ at: Date.now(), headers: req.headers, message });
    res.writeHead(201); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    endpoint: `http://127.0.0.1:${server.address().port}/push/device-1`, p256dh: b64u(ua.getPublicKey()), auth: b64u(auth), got, close: () => server.close(),
  })));
}

// A dev server in a process of its own: Stop must end it without ending this test.
function startServerProcess(port) {
  const child = spawn(process.execPath, ['-e', `require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<title>Test dev server</title><h1>up</h1>')}).listen(${port},'127.0.0.1')`], { stdio: 'ignore' });
  return child;
}
const listening = (port) => new Promise((r) => { const q = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => { res.resume(); r(true); }); q.on('error', () => r(false)); q.on('timeout', () => { q.destroy(); r(false); }); });

async function main() {
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-notify-'));
  const cwd = path.join(tmp, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const api = await fx.startFakeApi();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });
  fs.mkdirSync(SHOTS, { recursive: true });
  const sid = fx.makeSession(path.join(tmp, 'claude'), cwd, 'ffffffff-1111-2222-3333-444444444444');
  const push = await startPushService();
  const H = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  const j = async (p, opts) => (await fetch(app.base + '/api' + p, { headers: H, ...opts })).json();
  const children = [];

  async function open(type, opts, { granted = true } = {}) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
    if (granted && type === chromium) await ctx.grantPermissions(['notifications'], { origin: app.base });
    // Headless Chromium has no push service to subscribe to: the browser's subscribe() answers with
    // this test's own, and everything after it - the server, the encryption, the worker - is real.
    await ctx.addInitScript(({ token, sub }) => {
      if (window.top !== window) return;
      localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token);
      window.__focus = true; document.hasFocus = () => window.__focus; // the page says whether it is in front
      if (window.PushManager) {
        const fake = () => ({ endpoint: sub.endpoint, toJSON: () => ({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }), unsubscribe: async () => { localStorage.removeItem('t.sub'); return true; } });
        PushManager.prototype.subscribe = async () => { localStorage.setItem('t.sub', '1'); return fake(); };
        PushManager.prototype.getSubscription = async () => (localStorage.getItem('t.sub') ? fake() : null);
      }
    }, { token: app.token, sub: push });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + sid);
    await page.waitForSelector('#thread .msg');
    await wait(600);
    return { browser, ctx, page, errors };
  }
  const threadText = (page) => page.$eval('#thread', (t) => t.innerText);
  async function send(page, text) { await page.fill('#input', text); await page.press('#input', 'Enter'); }
  const idle = (page) => until(async () => (await page.$eval('#send', (b) => b.title)) === 'Send', 40000);
  const titles = () => push.got.map((g) => g.message?.title);

  const { browser, ctx, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });

  // 1. Settings > Notifications: Desktop's words, then on.
  await page.evaluate(() => document.querySelector('#account-btn').click());
  await page.click('#account-menu .menu-item:has-text("Notifications")');
  check('Settings opens on Notifications', await until(() => page.isVisible('.set-pane[data-pane="notifications"].on'), 5000));
  // Desktop has a sentence for each state: CI's headless Chromium blocks notifications outright,
  // a local Chrome asks - whichever this browser is in, its own sentence is the one shown.
  const blocked = (await page.evaluate(() => (typeof Notification === 'undefined' ? 'denied' : Notification.permission))) === 'denied';
  const desktopSays = blocked ? 'Enable notifications in your browser settings to get updates when tasks complete.' : 'Get notified when your tasks complete so you don’t have to keep checking back.';
  check('it says what Desktop says', await until(async () => (await page.textContent('#nf-desc')) === desktopSays, 5000), await page.textContent('#nf-desc'));
  await page.screenshot({ path: path.join(SHOTS, 'notify-settings-off.png') });
  await page.click('#nf-toggle .toggle');
  check('turning it on subscribes this device', await until(async () => (await j('/push')).devices.length === 1, 8000));
  const devs = (await j('/push')).devices;
  check('...under the push service\'s own address', devs[0]?.endpoint === push.endpoint, JSON.stringify(devs));
  check('...and the setting says it is enabled', await until(async () => (await page.textContent('#nf-name')) === 'Notifications enabled', 5000));
  check('the worker is registered', await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration('/'))?.active));
  await page.click('#nf-test');
  check('"Send a test notification" reaches the device', await until(() => push.got.length === 1, 8000));
  check('...encrypted for it and signed with VAPID', push.got[0]?.message?.title === 'Notifications are on' && /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(push.got[0].headers.authorization || '') && push.got[0].headers['content-encoding'] === 'aes128gcm', JSON.stringify(push.got[0]));
  await page.screenshot({ path: path.join(SHOTS, 'notify-settings-on.png') });
  await page.click('#settings-close');

  // 2. A turn ends. The page is in front: the device is not buzzed.
  await send(page, 'Q1 hello');
  check('a turn runs', await until(async () => (await threadText(page)).includes('Answer to: Q1'), 30000));
  await idle(page); await wait(2500);
  check('in front: no push for a turn that ended', push.got.length === 1, titles().join(' | '));
  // Out of sight: it is told.
  await page.evaluate(() => { window.__focus = false; window.dispatchEvent(new Event('blur')); });
  await wait(600);
  const t0 = Date.now();
  await send(page, 'Q2 again');
  check('the turn ends in the page', await until(async () => (await threadText(page)).includes('Answer to: Q2'), 30000));
  check('away: a push arrives when the turn ends', await until(() => push.got.length === 2, 15000), titles().join(' | '));
  const done = push.got[1]?.message || {};
  check('...saying the task is complete, with the answer, for this session', done.title === 'Task complete' && /Answer to: Q2/.test(done.body) && done.url === '/#/s/' + sid, JSON.stringify(done));
  check('...after the turn, not before it', push.got[1]?.at > t0);
  await idle(page);

  // 3. A question waits for you.
  await send(page, 'Q3 [ask] pick a colour');
  check('a question card appears', await until(() => page.isVisible('.question-card .q-opt'), 25000));
  check('away: the question is pushed', await until(() => titles().includes('Claude has a question'), 15000), titles().join(' | '));
  await page.keyboard.press('1');
  await page.click('.question-card:not(.answered) .permission-actions button:has-text("Answer")');
  await idle(page);

  // 4. A command runs in the background and ends.
  await send(page, 'Q4 [background] render it');
  check('a background task finishes: pushed', await until(() => titles().includes('Background task finished'), 60000), titles().join(' | '));
  await idle(page);

  // 5. The service worker shows what it is sent; a click opens that session.
  const cdp = await ctx.newCDPSession(page);
  const regs = []; cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
  await cdp.send('ServiceWorker.enable'); await wait(500);
  const reg = regs.find((r) => r.scopeURL.startsWith(app.base));
  check('the browser knows the worker', !!reg);
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: app.base, registrationId: reg.registrationId, data: JSON.stringify({ title: 'Task complete', body: 'Report and PDF · All done', url: '/#/s/' + sid, tag: 'session-' + sid, sessionId: sid }) });
  const shown = await until(async () => (await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length)) === 1, 8000);
  check('the worker shows the notification', shown);
  const note = await page.evaluate(async () => { const n = (await (await navigator.serviceWorker.ready).getNotifications())[0]; return n && { title: n.title, body: n.body, tag: n.tag, url: n.data?.url }; });
  check('...with its title, words and the session it opens', note?.title === 'Task complete' && note.body === 'Report and PDF · All done' && note.url === '/#/s/' + sid, JSON.stringify(note));
  await page.evaluate(() => { location.hash = '#/'; window.__focus = true; });
  await wait(400);
  const sw = ctx.serviceWorkers()[0];
  await sw.evaluate(async () => { const [n] = await self.registration.getNotifications(); self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n })); });
  check('a click opens that session in the open app', await until(async () => (await page.evaluate(() => location.hash)) === '#/s/' + sid, 8000), await page.evaluate(() => location.hash));
  check('...and closes the notification', await until(async () => (await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length)) === 0, 5000));

  // 6. The aside.
  await idle(page);
  const asides = () => api.bodies.filter((b) => JSON.stringify(b.system || '').includes('an aside: a short reply in your voice')).length;
  await send(page, 'Q5 [summary] build it');
  check('a long turn is under way', await until(async () => (await page.$$('#send')).length && (await page.$eval('#send', (b) => b.title)) !== 'Send', 15000));
  await send(page, 'Q6 how far along are you?');
  check('the message waits, dashed', await until(() => page.isVisible('#thread .msg.user.queued'), 8000));
  check('an aside appears under it, as a quick reply', await until(() => page.isVisible('#thread .msg.user:has-text("Q6") .aside'), 15000));
  const asideText = await page.$eval('#thread .msg.user:has-text("Q6") .aside', (a) => a.innerText);
  check('...in a line or two, from the small model', /Quick reply/i.test(asideText) && /Still working on it/.test(asideText), asideText);
  await page.screenshot({ path: path.join(SHOTS, 'notify-aside.png') });
  check('the message itself went to Claude as it was', await until(() => api.bodies.some((b) => JSON.stringify(b.messages).includes('Q6 how far along are you?')), 30000));
  check('Claude was told what the aside said', await until(() => api.bodies.some((b) => JSON.stringify(b.messages).includes('instant reply to their message') && JSON.stringify(b.messages).includes('Still working on it')), 30000));
  check('the note is not drawn in the chat', !(await threadText(page)).includes('instant reply to their message'));
  check('the aside ran on the small model, no tools', api.bodies.filter((b) => JSON.stringify(b.system || '').includes('an aside: a short reply')).every((b) => /haiku/.test(b.model) && !(b.tools || []).length), JSON.stringify(api.bodies.filter((b) => JSON.stringify(b.system || '').includes('an aside')).map((b) => [b.model, (b.tools || []).length])));
  await idle(page);
  // A failing aside shows nothing; a slow one is not waited for.
  const before = asides();
  await send(page, 'Q7 [summary] again');
  await until(async () => (await page.$eval('#send', (b) => b.title)) !== 'Send', 15000);
  await send(page, 'Q8 [aside-fail] and this?');
  check('an aside that fails shows nothing', await until(() => asides() > before, 15000) && (await wait(1500), !(await page.isVisible('#thread .msg.user:has-text("Q8") .aside'))));
  await idle(page);
  await send(page, 'Q9 [summary] once more');
  await until(async () => (await page.$eval('#send', (b) => b.title)) !== 'Send', 15000);
  await send(page, 'Q10 [aside-slow] and this?');
  await wait(10500);
  check('an aside later than 8 s shows nothing', !(await page.isVisible('#thread .msg.user:has-text("Q10") .aside')));
  await idle(page);
  // Off: no aside is even asked for.
  await j('/aside', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  const n0 = asides();
  await send(page, 'Q11 [summary] third');
  await until(async () => (await page.$eval('#send', (b) => b.title)) !== 'Send', 15000);
  await send(page, 'Q12 anything?');
  await wait(2500);
  check('with the setting off, no aside is asked for', asides() === n0 && !(await page.isVisible('#thread .msg.user:has-text("Q12") .aside')));
  await idle(page);
  await j('/aside', { method: 'POST', body: JSON.stringify({ enabled: true }) });

  // 7. Keyboard shortcuts.
  await page.click('#thread', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+/');
  check('Ctrl+/ opens the shortcuts panel', await until(() => page.isVisible('#shortcuts-modal .sc-card'), 3000));
  const groups = await page.$$eval('#sc-list .sc-group-name', (ns) => ns.map((n) => n.textContent));
  check('...in groups', groups.includes('General') && groups.includes('Message box') && groups.length >= 5, groups.join(', '));
  await page.screenshot({ path: path.join(SHOTS, 'notify-shortcuts.png') });
  await page.fill('#sc-search', 'rewind');
  check('the search narrows it to the one that rewinds', await until(async () => (await page.$$('#sc-list .sc-row')).length === 1, 3000) && /^1 shortcut found/.test(await page.textContent('#sc-count')), await page.textContent('#sc-count'));
  await page.fill('#sc-search', 'zzzz');
  check('nothing matching says so', (await page.textContent('#sc-list')).includes('No matching shortcuts'));
  await page.keyboard.press('Escape');
  check('Esc closes it', await until(async () => !(await page.isVisible('#shortcuts-modal .sc-card')), 3000));
  await page.keyboard.press('Control+k');
  check('what it lists works: Ctrl+K opens the palette', await until(() => page.isVisible('#palette:not(.hidden)'), 3000));
  await page.fill('#palette-input', 'keyboard');
  check('the palette offers it too', await until(async () => (await page.$$eval('#palette-list .nm', (ns) => ns.map((n) => n.textContent))).includes('Keyboard shortcuts'), 3000));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+n');
  check('...and Ctrl+N starts a new session', await until(async () => (await page.evaluate(() => location.hash)) === '#/', 3000));
  await page.evaluate(async (id) => { location.hash = '#/s/' + id; }, sid);
  await page.waitForSelector('#thread .msg');
  await page.click('#account-btn');
  check('the account menu has it', await until(() => page.isVisible('#account-menu .menu-item:has-text("Keyboard shortcuts")'), 3000));
  await page.keyboard.press('Escape'); await page.click('#thread', { position: { x: 5, y: 5 } }).catch(() => {});

  // 8. Stop on the Servers card.
  const port = await fx.freePort();
  const dev = startServerProcess(port); children.push(dev);
  check('a dev server is running', await until(() => listening(port), 8000));
  await page.evaluate(() => localStorage.setItem('cr.rail', '1'));
  await page.reload(); await page.waitForSelector('#thread .msg'); await wait(800);
  check('the Servers card lists it', await until(() => page.isVisible(`.rail-row:has-text("localhost:${port}") .rail-stop`), 15000));
  await page.screenshot({ path: path.join(SHOTS, 'notify-servers-stop.png') });
  const refused = await fetch(app.base + '/api/preview/stop', { method: 'POST', headers: H, body: JSON.stringify({ port: Number(new URL(app.base).port) }) });
  check('the app\'s own port is refused', refused.status === 400 && /uses itself/.test((await refused.json()).error));
  let asked = '';
  page.once('dialog', async (d) => { asked = d.message(); await d.accept(); });
  await page.click(`.rail-row:has-text("localhost:${port}") .rail-stop`);
  check('Stop asks first, naming the port', await until(() => asked.includes('localhost:' + port), 3000), asked);
  check('...and the server is gone', await until(async () => !(await listening(port)), 10000));
  check('...and so is its row', await until(async () => !(await page.isVisible(`.rail-row:has-text("localhost:${port}")`)), 10000));
  check('only that server: the app still answers', (await fetch(app.base + '/api/config')).ok);
  check('no errors in the app', !errors.length, errors.join(' | '));
  await browser.close();

  // 9. On an iPhone, in Safari's engine: the panel and the setting fit, and say why push is not on yet.
  {
    const { browser, page, errors } = await open(webkit, devices['iPhone 15 Pro Max']);
    await page.evaluate(() => document.getElementById('app').classList.add('sidebar-open'));
    await page.click('#account-btn');
    await until(() => page.isVisible('#account-menu .menu-item:has-text("Keyboard shortcuts")'), 5000);
    await page.click('#account-menu .menu-item:has-text("Keyboard shortcuts")');
    check('iphone: the shortcuts panel opens', await until(() => page.isVisible('#shortcuts-modal .sc-card'), 5000));
    const over = await page.evaluate(() => [...document.querySelectorAll('#shortcuts-modal .sc-card, #shortcuts-modal .sc-card *')].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).map((n) => n.className || n.tagName));
    check('iphone: it fits the screen', !over.length, over.join(', '));
    await page.screenshot({ path: path.join(SHOTS, 'notify-shortcuts-iphone.png') });
    await page.click('#shortcuts-modal .sc-close');
    await page.evaluate(() => document.getElementById('app').classList.add('sidebar-open'));
    await page.click('#account-btn');
    await page.click('#account-menu .menu-item:has-text("Notifications")');
    check('iphone: notifications say what it takes (Home Screen)', await until(async () => /Home Screen/.test(await page.textContent('#nf-desc')), 5000), await page.textContent('#nf-desc'));
    const over2 = await page.evaluate(() => [...document.querySelectorAll('.set-pane[data-pane="notifications"] *')].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).map((n) => n.className || n.tagName));
    check('iphone: the setting fits the screen', !over2.length, over2.join(', '));
    await page.screenshot({ path: path.join(SHOTS, 'notify-settings-iphone.png') });
    check('iphone: no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed · screenshots in test/ui/shots`);
  for (const c of children) try { c.kill(); } catch {}
  push.close();
  await Promise.race([app.stop(), wait(5000)]);
  await api.close();
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
