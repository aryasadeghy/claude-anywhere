// Did this session put this file in front of the person? A picture Claude saved to Downloads, a
// file it sent from the Desktop, a screenshot in a folder no session works in: /api/file only hands
// out files inside the folders sessions work in, so these were refused - on a phone or another
// browser, where nothing else can read them, they never showed. A file outside those folders is
// served when its own session's transcript names its exact path, and only then.
import fs from 'node:fs';

const CHUNK = 8 << 20;
const cache = new Map(); // `${file}\n${path}` -> { size, found }

// The forms a path takes in a transcript line: as JSON (backslashes doubled), with forward
// slashes, and as written on Windows with either separator.
function needles(p) {
  const forms = new Set([p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')]);
  return [...forms].flatMap((f) => [JSON.stringify(f).slice(1, -1), f]).filter(Boolean).map((s) => Buffer.from(s));
}

// Searched from the end, a few MB at a time: a picture is shown soon after it is made, and a
// transcript can be hundreds of MB.
export function transcriptMentions(file, p) {
  let st; try { st = fs.statSync(file); } catch { return false; }
  const key = file + '\n' + p, hit = cache.get(key);
  if (hit && (hit.found || hit.size === st.size)) return hit.found;
  const ns = needles(p), longest = Math.max(...ns.map((n) => n.length));
  let found = false, fd;
  try {
    fd = fs.openSync(file, 'r');
    for (let end = st.size; end > 0 && !found; end -= CHUNK) {
      const start = Math.max(0, end - CHUNK), len = Math.min(st.size, end + longest) - start;
      const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, start);
      found = ns.some((n) => buf.indexOf(n) !== -1);
    }
  } catch { found = false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  if (cache.size > 2000) cache.clear();
  cache.set(key, { size: st.size, found });
  return found;
}

// The Browser pane asks for a file by its path alone, on an origin of its own that carries no
// session, so it cannot run the transcript check above: a mockup Claude sent from the Desktop
// showed in the chat and was refused in the pane. Files a session put in front of the person -
// sent with SendUserFile, or served above by its transcript - are remembered here (on disk, so
// a restarted server still opens them) and the pane may open those exact files.
import path from 'node:path';
const SHOWN_MAX = 2000;
let shownFile = '', shown = null;
const keyOf = (p) => { const n = path.normalize(p); return process.platform === 'win32' ? n.toLowerCase() : n; };
function shownSet() {
  if (shown) return shown;
  try { shown = new Set(JSON.parse(fs.readFileSync(shownFile, 'utf8'))); } catch { shown = new Set(); }
  return shown;
}
export function initShown(dataDir) { shownFile = path.join(dataDir, 'shown-files.json'); shown = null; }
export function markShown(p) {
  const s = shownSet(), k = keyOf(p);
  if (s.has(k)) return;
  s.add(k);
  while (s.size > SHOWN_MAX) s.delete(s.values().next().value);
  if (shownFile) try { fs.writeFileSync(shownFile, JSON.stringify([...s])); } catch {}
}
export function wasShown(p) { return shownSet().has(keyOf(p)); }
