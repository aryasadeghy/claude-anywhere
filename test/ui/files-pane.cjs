// The Files pane as Desktop's Code tab: a tree beside tabs, single-click preview tabs,
// multi-select and a richer right-click menu, fuzzy-find by name, "?" to search contents,
// edit in place with Auto save and a conflict refusal, comments on a line that attach as
// context, live refresh, Office previews (no viewer — the zip, read with zlib), review
// comments in the Changes diff, and a `#L5-L20` link that opens and highlights lines.
// Shots in test/ui/shots/.
//
//   npm i --no-save playwright && npx playwright install chromium webkit
//   node test/ui/files-pane.cjs          (PW_CHANNEL=chrome to use an installed Chrome)
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const SHOTS = path.join(__dirname, 'shots');
const channel = process.env.PW_CHANNEL || undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail = '') { ok ? passed++ : failed++; console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail && !ok ? '  — ' + detail : '')); }
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await wait(100); } return false; };

// ---------- a zip, built by hand: the same format lib/files.mjs reads with zlib ----------
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(files) {
  const localParts = [], central = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8'), data = Buffer.from(content, 'utf8'), comp = zlib.deflateRawSync(data), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const entry = Buffer.concat([local, nameBuf, comp]); localParts.push(entry);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf])); offset += entry.length;
  }
  const localBuf = Buffer.concat(localParts), centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}
function makeDocx() {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p>
    <w:p><w:r><w:t>Revenue was up this quarter.</w:t></w:r></w:p>
  </w:body></w:document>`;
  return makeZip({ 'word/document.xml': xml });
}
function makeXlsx() {
  const sst = `<?xml version="1.0"?><sst><si><t>Name</t></si><si><t>Age</t></si><si><t>Jo</t></si></sst>`;
  const rels = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>`;
  const wb = `<?xml version="1.0"?><workbook><sheets><sheet name="People" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const sheet1 = `<?xml version="1.0"?><worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A1" t="s"><v>2</v></c><c r="B1"><v>29</v></c></row>
  </sheetData></worksheet>`;
  return makeZip({ 'xl/workbook.xml': wb, 'xl/_rels/workbook.xml.rels': rels, 'xl/sharedStrings.xml': sst, 'xl/worksheets/sheet1.xml': sheet1 });
}
function makePptx() {
  const slide1 = `<?xml version="1.0"?><p:sld xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Welcome</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return makeZip({ 'ppt/slides/slide1.xml': slide1 });
}

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }

// A small project: nested folders, a dotfile, code to edit, a file to search inside, and a
// git repo so the Changes diff and its review comments have something to show.
function makeProject(dir) {
  fs.mkdirSync(path.join(dir, 'src', 'util'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Project\n\nFirst line.\n');
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'function main() {\n  return 1;\n}\nmodule.exports = main;\n');
  fs.writeFileSync(path.join(dir, 'src', 'util', 'helpers.js'), 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = add;\n');
  fs.writeFileSync(path.join(dir, 'needle.txt'), 'before\nthe-unique-needle-9f3\nafter\n');
  fs.writeFileSync(path.join(dir, 'report.docx'), makeDocx());
  fs.writeFileSync(path.join(dir, 'data.xlsx'), makeXlsx());
  fs.writeFileSync(path.join(dir, 'slides.pptx'), makePptx());
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@test']); git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'init']);
  // An uncommitted change, so the Changes pane has a diff to review.
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'function main() {\n  return 2;\n}\nmodule.exports = main;\n');
}

function makeSession(configDir, cwd, id) {
  fs.mkdirSync(cwd, { recursive: true });
  const dir = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  const lines = [
    { type: 'user', uuid: id + '-u', timestamp: at(60), cwd, message: { role: 'user', content: 'Point me at the helper.' } },
    { type: 'assistant', uuid: id + '-a', timestamp: at(55), cwd, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'It is here: `src/util/helpers.js#L2-L3`.' }] } },
  ];
  lines.push({ type: 'custom-title', customTitle: 'Files pane', sessionId: id });
  const file = path.join(dir, id + '.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const then = new Date(Date.now() - 10 * 60 * 1000); fs.utimesSync(file, then, then);
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const fx = await import(pathToFileURL(path.join(__dirname, '..', 'fixtures', 'index.mjs')).href);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ui-files-'));
  const cwd = path.join(tmp, 'project');
  const id = 'abcdabcd-1111-2222-3333-444444444444';
  makeProject(cwd);
  makeSession(path.join(tmp, 'claude'), cwd, id);
  const api = await fx.startFakeApi();
  const app = await fx.startApp({ port: await fx.freePort(), dataDir: path.join(tmp, 'data'), configDir: path.join(tmp, 'claude'), env: fx.fakeApiEnv(api) });

  async function open(type, opts) {
    const browser = await type.launch({ headless: true, ...(type === chromium && channel ? { channel } : {}) });
    const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
    await ctx.addInitScript((token) => { if (window.top === window) { localStorage.setItem('cr.accountChosen', '1'); localStorage.setItem('cr.token', token); } }, app.token);
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(app.base + '/#/s/' + id);
    await page.waitForSelector('#thread .msg');
    return { browser, ctx, page, errors };
  }
  const openFilesPane = async (page) => {
    await page.click('#session-menu-btn');
    await until(() => page.isVisible('#session-menu .menu-item'), 5000);
    await page.click('#session-menu .menu-item:has-text("Files")');
    await until(() => page.isVisible('#files-panel:not(.hidden)'), 5000);
  };

  // ======================= Desktop (Chromium) =======================
  const { browser, ctx, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openFilesPane(page);

  // 1. Tree, dotfiles, fuzzy find, content search.
  check('the tree lists top-level entries, dotfiles included', await until(() => page.isVisible('#fx-tree .fx-row') && page.$eval('#fx-tree', (t) => t.textContent.includes('.env'))), 'tree did not show .env');
  await page.click('#fx-tree .fx-row:has-text("src")'); // expand
  check('expanding a folder shows its children', await until(() => page.isVisible('#fx-tree .fx-row:has-text("index.js")')));
  await page.click('#fx-tree .fx-row:has-text("util")'); // expand the nested folder too, for helpers.js below
  await until(() => page.isVisible('#fx-tree .fx-row:has-text("helpers.js")'));
  await page.screenshot({ path: path.join(SHOTS, 'files-pane-tree.png') });

  await page.fill('#fx-search', 'helpjs');
  check('fuzzy find by name finds a nested file', await until(() => page.$eval('#fx-results', (r) => /helpers\.js/.test(r.textContent))), await page.$eval('#fx-results', (r) => r.textContent));
  await page.fill('#fx-search', '?the-unique-needle');
  check('a ? prefix searches file contents', await until(() => page.$eval('#fx-results', (r) => /needle\.txt/.test(r.textContent))), await page.$eval('#fx-results', (r) => r.textContent));
  await page.click('#fx-results .fx-row:has-text("needle.txt")');
  check('clicking a content hit opens the file, line selected', await until(() => page.$eval('#fx-editor-ta, .fx-editor-ta', (t) => t.value.includes('the-unique-needle-9f3') && t.selectionStart !== t.selectionEnd).catch(() => false)));
  await page.fill('#fx-search', '');

  // 2. Edit in place: a plain code file opens straight into an editable, line-numbered textarea.
  await page.click('#fx-tree .fx-row:has-text("index.js")');
  check('a code file opens editable, in place (no separate Edit click needed)', await until(() => page.$eval('.fx-editor-ta', (t) => t.value.includes('return 2'))));
  check('line numbers are drawn', await until(() => page.$eval('.fx-gutter-inner', (g) => g.children.length >= 4)));
  await page.click('.fx-editor-ta');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// edited');
  check('typing marks the tab dirty', await until(() => page.isVisible('.fx-tab-dot')));
  check('Auto save (on by default) saves a moment later', await until(async () => fs.readFileSync(path.join(cwd, 'src', 'index.js'), 'utf8').includes('// edited'), 4000));
  check('...and the dirty dot clears once saved', await until(() => !page.isVisible('.fx-tab-dot') || page.$eval('.fx-dirty', (d) => d.classList.contains('hidden'))));
  await page.screenshot({ path: path.join(SHOTS, 'files-pane-edit.png') });

  // 3. Turn Auto save off, then prove a save refused when the file changed on disk.
  await page.click('#fx-menu-btn');
  await until(() => page.isVisible('#fx-menu-pop .toggle'), 3000);
  await page.click('#fx-menu-pop .toggle');
  await page.click('#fx-close'); // closing and reopening is the simplest way to dismiss the menu
  await openFilesPane(page);
  await page.click('#fx-tree .fx-row:has-text("index.js")');
  await until(() => page.isVisible('.fx-editor-ta'));
  await page.click('.fx-editor-ta');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n// local edit, not yet saved');
  await wait(200);
  fs.writeFileSync(path.join(cwd, 'src', 'index.js'), 'function main() {\n  return 999; // changed elsewhere\n}\nmodule.exports = main;\n');
  const past = new Date(Date.now() + 5000); fs.utimesSync(path.join(cwd, 'src', 'index.js'), past, past);
  await page.keyboard.press('Control+s');
  check('a save is refused when the file changed on disk', await until(() => page.$eval('#fx-view', (v) => /weren.t saved because the file changed on disk/.test(v.textContent))));
  await page.screenshot({ path: path.join(SHOTS, 'files-pane-conflict.png') });
  await page.click('button:has-text("Reopen")');
  check('Reopen shows the latest version from disk', await until(() => page.$eval('.fx-editor-ta', (t) => t.value.includes('changed elsewhere') && !t.value.includes('local edit'))));

  // 4. Live refresh: an open preview catches up when the file changes, with no action taken.
  await page.click('#fx-tree .fx-row:has-text("README.md")');
  check('Markdown opens rendered (PR #30 is kept)', await until(() => page.$eval('#fx-view .fx-md h1', (h) => h.textContent === 'Project')));
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Updated\n\nChanged on disk.\n');
  check('the open preview refreshes on its own', await until(() => page.$eval('#fx-view .fx-md h1', (h) => h.textContent === 'Updated'), 5000));

  // 5. Comments on a line attach as context for the next message.
  await page.click('#fx-tree .fx-row:has-text("helpers.js")');
  await until(() => page.isVisible('.fx-editor-ta'));
  await page.hover('.fx-gline:nth-child(2)');
  await page.click('.fx-gline:nth-child(2) .fx-gadd');
  check('the + beside a line opens a comment box', await until(() => page.isVisible('.fx-comment-pop')));
  await page.fill('.fx-comment-ta', 'please add a type check here');
  await page.click('.fx-comment-row button:has-text("Add comment")');
  check('the comment is attached to the next message', await until(async () => {
    const v = await page.inputValue('#input');
    return v.includes('helpers.js#L2') && v.includes('please add a type check here');
  }), await page.inputValue('#input'));
  await page.fill('#input', '');
  await page.screenshot({ path: path.join(SHOTS, 'files-pane-comment.png') });

  // 6. Office previews: docx, xlsx, pptx — no viewer, the zip read with zlib.
  await page.click('#fx-tree .fx-row:has-text("report.docx")');
  check('a Word document shows its headings and paragraphs', await until(() => page.$eval('#fx-view .fx-office', (o) => /Quarterly report/.test(o.textContent) && /Revenue was up/.test(o.textContent))));
  await page.click('#fx-tree .fx-row:has-text("data.xlsx")');
  check('a spreadsheet shows its sheet as a table', await until(() => page.$eval('#fx-view .fx-office table', (t) => /Jo/.test(t.textContent) && /29/.test(t.textContent))));
  await page.click('#fx-tree .fx-row:has-text("slides.pptx")');
  check('a slide deck shows its slide text', await until(() => page.$eval('#fx-view .fx-office', (o) => /Welcome/.test(o.textContent))));
  await page.screenshot({ path: path.join(SHOTS, 'files-pane-office.png') });

  // 7. Right-click: Open, Copy path, Attach as context, Open in editor — no terminal item
  // here, since this build never defines openTerminalAt.
  await page.click('#fx-tree .fx-row:has-text("helpers.js")', { button: 'right' });
  check('the menu offers Open, Copy path, Attach as context, Open in editor', await until(() => page.isVisible('.menu .menu-item:has-text("Open in editor")')));
  const menuText = await page.$eval('body > .menu:last-of-type', (m) => m.textContent);
  check('...and no Open in terminal (the terminal package is not in this build)', !/Open in terminal/.test(menuText), menuText);
  await page.click('.menu .menu-item:has-text("Attach as context")');
  check('Attach as context quotes the file into the box', await until(async () => (await page.inputValue('#input')).includes('function add')));
  await page.fill('#input', '');

  // 8. A `#L5-L20` link in a message opens the file and highlights those lines.
  await page.click('#thread a.file-link:has-text("helpers.js")');
  check('a #L link opens the file, those lines selected', await until(() => page.$eval('.fx-editor-ta', (t) => {
    const sel = t.value.slice(t.selectionStart, t.selectionEnd);
    return sel.includes('return a + b');
  })), 'did not select the linked lines');
  await page.screenshot({ path: path.join(SHOTS, 'files-pane-link.png') });

  check('no errors in the app', !errors.length, errors.join(' | '));
  await browser.close();

  // ======================= Changes pane: review comments =======================
  {
    const { browser, page, errors } = await open(chromium, { viewport: { width: 1380, height: 860 } });
    await page.click('#session-menu-btn');
    await until(() => page.isVisible('#session-menu .menu-item'), 5000);
    await page.click('#session-menu .menu-item:has-text("Changes")');
    await until(() => page.isVisible('#changes-panel:not(.hidden)'), 5000);
    await until(() => page.isVisible('.ch-row'), 5000);
    await page.click('.ch-row:has-text("index.js")');
    await until(() => page.isVisible('.diff .dl'), 5000);
    await page.hover('.diff .dl.add');
    await page.click('.diff .dl.add .dl-add');
    check('a + on a diff line opens a review comment box', await until(() => page.isVisible('.fx-comment-pop')));
    await page.fill('.fx-comment-ta', 'why 999?');
    await page.click('.fx-comment-row button:has-text("Add comment")');
    check('the review comment is attached to the next message', await until(async () => (await page.inputValue('#input')).includes('why 999?')));
    check('...and shown under the line', await until(() => page.isVisible('.dl-comment')));
    await page.screenshot({ path: path.join(SHOTS, 'files-pane-review-comment.png') });
    await page.click('.dl-comment button:has-text("Resolve")');
    check('Resolve collapses it', await until(() => page.$eval('.dl-comment', (c) => c.classList.contains('resolved'))));
    check('Open in editor is offered from the diff view', await page.isVisible('#ch-open-editor:not(.hidden)'));
    check('no errors in the app', !errors.length, errors.join(' | '));
    await browser.close();
  }

  // ======================= Phone: WebKit, 390px, a full-screen sheet =======================
  {
    const { browser, page, errors } = await open(webkit, devices['iPhone 15 Pro Max']);
    await openFilesPane(page);
    check('iphone: the Files pane is a full-screen sheet', await until(() => page.$eval('#files-panel', (p) => p.getBoundingClientRect().width > 370)));
    await page.click('#fx-tree .fx-row:has-text("src")'); // expand, same as the desktop pass above
    await until(() => page.isVisible('#fx-tree .fx-row:has-text("index.js")'));
    await page.click('#fx-tree .fx-row:has-text("index.js")');
    await until(() => page.isVisible('.fx-editor-ta'));
    check('iphone: opening a file switches to the single-pane file view', await until(() => page.$eval('#files-panel', (p) => p.classList.contains('fx-file-open'))));
    check('iphone: a back button returns to the tree', await page.isVisible('#fx-back'));
    await page.click('.fx-editor-ta');
    await page.keyboard.type('x');
    check('iphone: typing still works with the editor focused (on-screen keyboard path)', await until(() => page.$eval('.fx-editor-ta', (t) => t.value.includes('x'))));
    const wide = await page.evaluate(() => [...document.querySelectorAll('#files-panel, #files-panel *')].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).map((n) => n.className));
    check('iphone: nothing in the pane overflows the screen', !wide.length, wide.join(', '));
    await page.screenshot({ path: path.join(SHOTS, 'files-pane-phone.png') });
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
