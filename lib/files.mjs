// Files pane: fuzzy find by name, search file contents (ripgrep if it is on PATH, a capped
// scan otherwise), and read-only previews for Office documents — all without a dependency,
// since a .docx/.xlsx/.pptx is just a zip of XML and node's own zlib inflates it.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';

// Folders whose contents are never what someone is hunting for, and which are the reason a
// naive recursive walk of a JS project never finishes.
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);

// A depth-first walk with a budget: a monorepo's node_modules would otherwise make "find a
// file" and "search contents" the same multi-minute operation. Both callers get back
// whatever was found plus `truncated`, instead of hanging until the budget trips a timeout
// somewhere else.
function walk(root, visit, { budgetMs = 1500, maxEntries = 40000 } = {}) {
  const t0 = Date.now();
  const stack = [root];
  let count = 0;
  let truncated = false;
  while (stack.length) {
    if (Date.now() - t0 > budgetMs || count > maxEntries) { truncated = true; break; }
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      count++;
      if (e.isDirectory()) { stack.push(p); visit(p, true); }
      else if (e.isFile()) visit(p, false);
      if (count > maxEntries) break;
    }
  }
  return { truncated };
}

// Subsequence match, case-insensitive, scored by how tightly the query's letters cluster in
// the name — "ap.js" beats "application.js" for the query "apjs" because the match is
// shorter, the way every fuzzy-find since Quicksilver has worked.
function fuzzyScore(name, q) {
  const n = name.toLowerCase(), s = q.toLowerCase();
  if (!s) return 0;
  let ni = 0, first = -1, last = -1;
  for (let si = 0; si < s.length; si++) {
    const idx = n.indexOf(s[si], ni);
    if (idx < 0) return -1;
    if (first < 0) first = idx;
    last = idx; ni = idx + 1;
  }
  const span = last - first + 1; // always >= s.length, so this is always >= 0
  const startPenalty = first === 0 ? 0 : 1; // a match starting at the first character wins ties
  return (span - s.length) * 2 + startPenalty;
}

export function findByName(root, query, { limit = 200 } = {}) {
  const hits = [];
  const { truncated } = walk(root, (p, isDir) => {
    const rel = path.relative(root, p);
    const score = fuzzyScore(path.basename(p), query);
    if (score >= 0) hits.push({ path: p, rel, isDir, score });
  });
  hits.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length || a.rel.localeCompare(b.rel));
  return { hits: hits.slice(0, limit), truncated: truncated || hits.length > limit };
}

// Files worth reading a line out of. Anything else (images, archives, compiled output) is
// either binary or noise either way.
const TEXT_EXT = /\.([mc]?[jt]sx?|json5?|ya?ml|toml|xml|html?|css|scss|less|md|markdown|mdx|txt|csv|tsv|log|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|ps1|sql|lua|r|dart|vue|svelte|ini|cfg|conf|env|gitignore|dockerfile)$/i;

let rgPath; // undefined = not checked yet, '' = not on PATH, else the binary name that worked
function ripgrep() {
  if (rgPath !== undefined) return rgPath;
  try { rgPath = spawnSync('rg', ['--version'], { windowsHide: true, timeout: 3000 }).status === 0 ? 'rg' : ''; }
  catch { rgPath = ''; }
  return rgPath;
}

function searchWithRipgrep(root, query, { limit, budgetMs }) {
  return new Promise((resolve) => {
    const rg = spawn(ripgrep(), ['--line-number', '--no-heading', '--fixed-strings', '--smart-case', '--max-count', '20', '--', query, root], { windowsHide: true });
    let buf = '', hits = [], truncated = false, done = false;
    const finish = () => { if (done) return; done = true; try { rg.kill(); } catch {} resolve({ hits: hits.slice(0, limit), truncated }); };
    const timer = setTimeout(() => { truncated = true; finish(); }, budgetMs);
    rg.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^(.*?):(\d+):(.*)$/);
        if (!m) continue;
        hits.push({ path: m[1], line: Number(m[2]), text: m[3].slice(0, 300) });
        if (hits.length >= limit) { truncated = true; clearTimeout(timer); return finish(); }
      }
    });
    rg.on('error', () => { clearTimeout(timer); finish(); });
    rg.on('close', () => { clearTimeout(timer); finish(); });
  });
}

function searchWithScan(root, query, { limit, budgetMs }) {
  const t0 = Date.now();
  const q = query.toLowerCase();
  const hits = [];
  let scanTruncated = false;
  const { truncated: walkTruncated } = walk(root, (p, isDir) => {
    if (isDir || hits.length >= limit || Date.now() - t0 > budgetMs) return;
    if (!TEXT_EXT.test(p)) return;
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.size > 1024 * 1024) return; // a megabyte of one file is enough to call it scanned
    let text; try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
    if (text.includes('\0')) return;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < limit; i++) {
      if (lines[i].toLowerCase().includes(q)) hits.push({ path: p, line: i + 1, text: lines[i].slice(0, 300) });
    }
    if (hits.length >= limit) scanTruncated = true;
  }, { budgetMs });
  return { hits, truncated: walkTruncated || scanTruncated };
}

export async function searchContents(root, query, { limit = 200, budgetMs = 8000 } = {}) {
  if (!query.trim()) return { hits: [], truncated: false };
  if (ripgrep()) return searchWithRipgrep(root, query, { limit, budgetMs });
  return searchWithScan(root, query, { limit, budgetMs });
}

// Atomic write: a crash or a second write mid-flight never leaves a half-written file, since
// the rename is the only step that touches the real name. `expectedMtimeMs` is the file's
// mtime when the editor loaded it — if the file moved on since, the edit is refused rather
// than silently clobbering whatever changed it (Claude, most likely), same as Desktop:
// "Your changes to {name} weren't saved because the file changed on disk."
export function writeFileChecked(p, text, expectedMtimeMs) {
  if (expectedMtimeMs != null && fs.existsSync(p)) {
    const st = fs.statSync(p);
    if (Math.round(st.mtimeMs) !== Math.round(expectedMtimeMs)) return { ok: false, conflict: true, mtimeMs: st.mtimeMs };
  }
  const tmp = p + '.cr-tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, p);
  const st = fs.statSync(p);
  return { ok: true, mtimeMs: st.mtimeMs, size: st.size };
}

// ---------- a zip is all a .docx/.xlsx/.pptx is — read it with zlib, not a dependency ----------
// The End Of Central Directory record is found by scanning back from the end (a zip may carry
// a comment of up to 64KB after it), then the central directory gives exact offsets and sizes
// for every entry — reliable even when the streaming bit (general-purpose flag bit 3) means the
// local header's own sizes are zero.
function findEOCD(buf) {
  const max = Math.min(buf.length, 65557);
  for (let i = buf.length - 22; i >= buf.length - max; i--) {
    if (i < 0) break;
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}
function readZip(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
// Only the entries a caller actually asked for are inflated — a slide deck's media is most
// of the archive and none of a text preview.
function unzipEntries(buf, want) {
  const entries = readZip(buf).filter((e) => want(e.name));
  const out = new Map();
  for (const e of entries) {
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const dataStart = e.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + e.compSize);
    out.set(e.name, e.method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
  }
  return out;
}
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

function docxPreview(buf) {
  const files = unzipEntries(buf, (n) => n === 'word/document.xml');
  const xml = files.get('word/document.xml')?.toString('utf8') || '';
  const body = (xml.match(/<w:body>([\s\S]*)<\/w:body>/) || [, xml])[1];
  const blocks = [];
  const re = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  const textOf = (s) => (s.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g) || []).map((t) => unesc(t.replace(/<[^>]+>/g, ''))).join('');
  let m, n = 0;
  while ((m = re.exec(body)) && n++ < 500) {
    const chunk = m[0];
    if (chunk.startsWith('<w:tbl')) {
      const rows = (chunk.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || []).map((r) => (r.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || []).map(textOf));
      blocks.push({ type: 'table', rows });
    } else {
      const style = (chunk.match(/<w:pStyle\s+w:val="([^"]+)"/) || [, ''])[1];
      const heading = /^Heading(\d)/i.exec(style);
      const text = textOf(chunk);
      if (text || blocks.length === 0) blocks.push({ type: heading ? 'heading' : 'p', level: heading ? Number(heading[1]) : 0, text });
    }
  }
  return { kind: 'docx', blocks, truncated: n >= 500 };
}

function xlsxPreview(buf) {
  const files = unzipEntries(buf, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const wbXml = files.get('xl/workbook.xml')?.toString('utf8') || '';
  const relsXml = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const sstXml = files.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const shared = (sstXml.match(/<si>[\s\S]*?<\/si>/g) || []).map((si) => unesc((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  const rels = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/>/g)) rels.set(m[1], m[2]);
  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = m[1];
    const name = (attrs.match(/\bname="([^"]*)"/) || [, 'Sheet'])[1];
    const rid = (attrs.match(/r:id="([^"]*)"/) || [, ''])[1];
    const target = rels.get(rid);
    if (target) sheets.push({ name, target: target.replace(/^\/?/, '').replace(/^xl\//, '') });
  }
  const out = [];
  for (const sheet of sheets.slice(0, 8)) {
    const sheetXml = files.get('xl/' + sheet.target)?.toString('utf8') || '';
    const rows = [];
    for (const rowM of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= 100) break;
      const row = [];
      for (const cellM of rowM[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g)) {
        const attrs = cellM[1] || cellM[3] || '', inner = cellM[2] || '';
        const t = (attrs.match(/\bt="([^"]*)"/) || [, ''])[1];
        let v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [, ''])[1];
        if (t === 's') v = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') v = unesc((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [, ''])[1]);
        else v = unesc(v);
        row.push(v);
      }
      rows.push(row);
    }
    out.push({ name: sheet.name, rows });
  }
  return { kind: 'xlsx', sheets: out };
}

function pptxPreview(buf) {
  const all = readZip(buf).map((e) => e.name).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  all.sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const files = unzipEntries(buf, (n) => all.includes(n));
  const slides = all.slice(0, 200).map((name) => {
    const xml = files.get(name)?.toString('utf8') || '';
    const texts = (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || [])
      .map((p) => (p.match(/<a:t>([\s\S]*?)<\/a:t>/g) || []).map((t) => unesc(t.replace(/<[^>]+>/g, ''))).join(''))
      .filter(Boolean);
    return { texts };
  });
  return { kind: 'pptx', slides };
}

export function officePreview(p) {
  // Read whole to unzip it: past 50 MB it is a deck full of videos, not a document to preview, and
  // the server's memory is what every running turn lives in.
  if (fs.statSync(p).size > 50 * 1024 * 1024) throw new Error('Too large to preview here; download it to open it.');
  const buf = fs.readFileSync(p);
  if (/\.docx$/i.test(p)) return docxPreview(buf);
  if (/\.xlsx$/i.test(p)) return xlsxPreview(buf);
  if (/\.pptx$/i.test(p)) return pptxPreview(buf);
  throw new Error('Not an Office file this app can preview');
}
