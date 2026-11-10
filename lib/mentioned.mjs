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
