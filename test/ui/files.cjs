// Files Claude sends, in a real browser: each is a card, and a click opens it the way it
// reads - a page in the Browser, a document rendered, a table as a table, data indented,
// code as code - with Download for all of it, including what cannot be shown. Before this,
// anything that was not a picture linked to /api/file and opened to "Not an image on this
// PC". Shots in test/ui/shots/.
//
//   npm i --no-save playwright && npx playwright install chromium
//   node test/ui/files.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const SHOTS = path.join(__dirname, 'shots');
const channel = process.env.PW_CHANNEL || undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail = '') { ok ? passed++ : failed++; console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail && !ok ? '  — ' + detail : '')); }
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(100); } return false; };

// A session in which Claude made six files and sent them.
function makeFilesSession(configDir, cwd, id = 'ffffffff-1111-2222-3333-444444444444') {
  fs.mkdirSync(cwd, { recursive: true });
  const files = {
    'page.html': '<!doctype html><title>Sent page</title><h1 id="hello">Hello from a sent page</h1>',
    'notes.md': '# Plan\n\n- first **bold** step\n- second step\n',
    'data.csv': 'name,age,city\n"Smith, Jo",41,Tehran\nAli,29,"Mashhad"\n',
    'config.json': '{"name":"demo","nested":{"a":1,"b":[1,2,3]}}',
    'script.py': 'def main():\n    print("hi")\n',
    'report.docx': Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0x14, 0, 0, 0]),
  };
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(cwd, n), c);
  const dir = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  const lines = [
    { type: 'user', uuid: id + '-u', timestamp: at(60), cwd, sessionId: id, message: { role: 'user', content: 'Make me a few files and send them.' } },
    { type: 'assistant', uuid: id + '-a1', timestamp: at(55), cwd, sessionId: id, message: { role: 'assistant', model: 'claude-opus-5-5', id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_send', name: 'mcp__claude-anywhere__SendUserFile', input: { files: Object.keys(files).map((n) => path.join(cwd, n)), caption: 'Here they are.' } }] } },
    { type: 'user', uuid: id + '-r1', timestamp: at(54), cwd, sessionId: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_send', content: [{ type: 'text', text: 'Sent' }] }] } },
    { type: 'assistant', uuid: id + '-a2', timestamp: at(53), cwd, sessionId: id, message: { role: 'assistant', model: 'claude-opus-5-5', id: 'msg_2', content: [{ type: 'text', text: 'Done.' }] } },
  ];
  lines.push({ type: 'custom-title', customTitle: 'Sent files', sessionId: id });
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const then = new Date(Date.now() - 10 * 60 * 1000); fs.utimesSync(file, then, then);
  return id;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-files-'));
  const cwd = path.join(tmp, 'project');
  const id = makeFilesSession(path.join(tmp, 'claude'), cwd);
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude') });
  const browser = await chromium.launch({ channel });
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 } });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + id);
    await page.waitForSelector('.sent-file', { timeout: 15000 });
    const cards = await page.$$eval('.sent-file', (els) => els.map((e) => e.querySelector('.sent-file-name').textContent + ' | ' + e.querySelector('.sent-file-kind').textContent));
    check('every file that is not a picture is a card', cards.length === 6, cards.join(', '));
    check('a card says what the file is', cards.includes('notes.md | Document · MD') && cards.includes('data.csv | Table · CSV') && cards.includes('report.docx | Word document · DOCX'), cards.join(', '));
    await page.screenshot({ path: path.join(SHOTS, 'files-cards.png') });

    const open = async (name) => { await page.click(`.sent-file[title$="${name}"]`); await wait(600); };
    await open('notes.md');
    check('Markdown opens rendered', await until(() => page.$eval('#fx-view .fx-md h1', (h) => h.textContent === 'Plan')));
    await page.screenshot({ path: path.join(SHOTS, 'files-markdown.png') });
    await page.click('#fx-view .fx-bar button:has-text("Source")');
    check('Source shows the text behind it', await until(() => page.$eval('#fx-view .fx-code:not(.hidden)', (p) => p.textContent.startsWith('# Plan'))));

    await open('data.csv');
    const cells = await page.$$eval('#fx-view .fx-table tr', (rows) => rows.map((r) => [...r.children].map((c) => c.textContent)));
    check('CSV is a table, quoted commas kept', JSON.stringify(cells[0]) === '["name","age","city"]' && cells[1]?.[0] === 'Smith, Jo' && cells.length === 3, JSON.stringify(cells));
    await page.screenshot({ path: path.join(SHOTS, 'files-csv.png') });

    await open('config.json');
    check('JSON is indented', await until(() => page.$eval('#fx-view .fx-code', (p) => p.textContent.includes('\n  "nested": {'))));

    await open('script.py');
    check('code is shown as code', await until(() => page.$eval('#fx-view .fx-code', (p) => p.textContent.startsWith('def main():'))));

    await open('report.docx');
    check('a file that cannot be shown says so, with Download', await until(() => page.$eval('#fx-view', (v) => /can.t be shown here/.test(v.textContent) && !!v.querySelector('.fx-bar button'))));
    await page.screenshot({ path: path.join(SHOTS, 'files-docx.png') });
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), page.click('#fx-view .fx-bar button:has-text("Download")')]);
    check('Download saves the file under its name', dl?.suggestedFilename() === 'report.docx', String(dl?.suggestedFilename()));

    // The server: everything but a picture goes out as a download, never inline.
    const head = async (name, extra = '') => page.evaluate(async ([u]) => { const r = await fetch(u); return { status: r.status, cd: r.headers.get('content-disposition') || '', csp: r.headers.get('content-security-policy') || '' }; }, [`/api/file?token=${encodeURIComponent(app.token)}&path=${encodeURIComponent(path.join(cwd, name))}${extra}`]);
    const h = await head('page.html');
    check('an HTML file from /api/file is an attachment, sandboxed', h.status === 200 && /attachment/.test(h.cd) && /sandbox/.test(h.csp), JSON.stringify(h));
    check('a file outside the projects is still refused', (await page.evaluate(async (u) => (await fetch(u)).status, `/api/file?token=${encodeURIComponent(app.token)}&path=${encodeURIComponent('/etc/hosts')}`)) === 403);

    await open('page.html');
    check('a page opens rendered in the Browser', await until(async () => { for (const f of page.frames()) { try { if (await f.$('#hello')) return true; } catch {} } return false; }, 12000));
    await page.screenshot({ path: path.join(SHOTS, 'files-html.png') });

    // The same cards on a phone.
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
    await phone.context().addInitScript((token) => { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); }, app.token);
    await phone.goto(app.base + '/#/s/' + id);
    await phone.waitForSelector('.sent-file', { timeout: 15000 });
    const wide = await phone.evaluate(() => [...document.querySelectorAll('.sent-file')].filter((c) => c.getBoundingClientRect().right > innerWidth + 1).length);
    check('390: every card fits the screen', wide === 0, wide + ' wider');
    await phone.screenshot({ path: path.join(SHOTS, 'files-phone.png') });
    check('no errors in the app', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed · screenshots in test/ui/shots`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
