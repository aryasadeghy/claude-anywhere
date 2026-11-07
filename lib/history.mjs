// A session's whole conversation, the way Claude Desktop shows it: every line in the order it
// was written. The SDK's getSessionMessages() starts at the last compaction and follows parent
// links, so a compacted session lost everything before it, and lines off that chain never
// showed at all: a message answered by a second process while the first worked on, and the
// notices of background commands, which the CLI keeps "for the transcript only". Desktop reads
// the file in order, and so does this.
//
// Transcripts run to hundreds of MB, and opening one used to parse all of it. The file is read
// from its end instead, a page at a time, only as far back as someone scrolls - and after that
// only as it grows. Pictures in tool results are 90% of those bytes; a page carries a URL for
// each and the picture is read when it is drawn.

import fs from 'node:fs';
import { sessionFile } from './tail.mjs';

const STEP = 4 << 20;   // bytes read per step back through the file
const KEEP = 24;        // sessions whose index is kept, most recently used first
const indexes = new Map();

// What a line is on screen, or null when it is not shown at all.
//   u  a prompt            q  a message typed while Claude worked, folded into the turn
//   a  Claude's blocks     r  tool results            t  a background task's notice
//   c  a compaction        s  the summary a compaction left (shown under its marker)
//   n  a notice: safeguards stepping in, an error Claude could not answer past
export function kindOf(j) {
  if (!j || typeof j !== 'object' || j.isSidechain || j.teamName) return null;
  if (j.type === 'assistant') {
    if (!Array.isArray(j.message?.content)) return null;
    // "No response requested." is the CLI answering itself when it resumes; Desktop hides it.
    if (j.message.model === '<synthetic>') return j.isApiErrorMessage ? 'n' : null;
    return 'a';
  }
  if (j.type === 'user') {
    if (j.isCompactSummary) return 's';
    if (j.isMeta || j.isVisibleInTranscriptOnly) return null;
    const c = j.message?.content;
    if (j.origin?.kind === 'task-notification' || (typeof c === 'string' && c.startsWith('<task-notification>'))) return 't';
    if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) return 'r';
    return c == null ? null : 'u';
  }
  if (j.type === 'attachment') {
    const a = j.attachment;
    if (a?.type !== 'queued_command' || a.isMeta || a.prompt == null) return null;
    if (a.commandMode === 'task-notification' || (typeof a.prompt === 'string' && a.prompt.startsWith('<task-notification>'))) return 't';
    return 'q';
  }
  if (j.type === 'system') {
    if (j.subtype === 'compact_boundary') return 'c';
    if ((j.subtype === 'informational' || j.subtype === 'model_refusal_fallback') && j.content) return 'n';
  }
  return null;
}

// Every picture in a line's content, depth first - the page and the picture route must count
// them the same way, since a picture is asked for by its number.
function eachImage(content, fn, n = { i: 0 }) {
  if (!Array.isArray(content)) return content;
  return content.map((b) => {
    if (!b || typeof b !== 'object') return b;
    if (b.type === 'image' && b.source?.type === 'base64') return fn(b, n.i++);
    if (b.type === 'tool_result' && Array.isArray(b.content)) return { ...b, content: eachImage(b.content, fn, n) };
    return b;
  });
}

const tag = (xml, name) => ((xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1] || '').trim();
// A background task's notice: its status, a one-line summary, the tool call that started it.
// Desktop says "Background command completed · <the command's description>".
export function taskFrom(status, summary, toolUseId = '') {
  summary = String(summary || '').trim();
  const cmd = summary.match(/^Background command "([\s\S]*)" (completed|failed|was stopped|stopped|was killed|killed)\b/);
  if (!status && cmd) status = cmd[2] === 'completed' ? 'completed' : cmd[2] === 'failed' ? 'failed' : 'stopped';
  return { status: status === 'killed' ? 'stopped' : status || '', summary, command: cmd ? cmd[1] : '', toolUseId };
}
// <task-notification> as the CLI writes it into the transcript.
export const parseTask = (xml) => { xml = String(xml || ''); return taskFrom(tag(xml, 'status'), tag(xml, 'summary'), tag(xml, 'tool-use-id')); };

// Some thinking is meant to be read. The model's running narration to the reader arrives as a
// thinking block whose signature says so, and Desktop shows it as part of the answer while the
// rest of the thinking stays hidden. The signature is a protobuf: field 2, its field 1, that
// one's field 8 - the string "narration". (That is how Desktop tells them apart.)
function pbField(buf, want) {
  let i = 0, found;
  const varint = () => { let v = 0, m = 1; while (i < buf.length) { const b = buf[i++]; v += (b & 127) * m; if (!(b & 128)) return v; m *= 128; } return -1; };
  while (i < buf.length) {
    const key = varint(); if (key < 0) return undefined;
    const wire = key & 7, no = Math.floor(key / 8);
    if (wire === 0) { if (varint() < 0) return undefined; }
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) { const len = varint(); if (len < 0 || len > buf.length - i) return undefined; if (no === want) found = buf.subarray(i, i + len); i += len; }
    else return undefined;
  }
  return i === buf.length ? found : undefined;
}
export function isNarration(b) {
  if (b?.type !== 'thinking' || typeof b.signature !== 'string' || !b.signature) return false;
  try {
    const f2 = pbField(Buffer.from(b.signature, 'base64'), 2), f1 = f2 && pbField(f2, 1), f8 = f1 && pbField(f1, 8);
    return !!f8 && f8.toString('utf8') === 'narration';
  } catch { return false; }
}
// What of Claude's blocks the chat shows: narration as text, the rest of the thinking left out -
// unless the Thinking/Verbose transcript view asked for it, in which case every thinking block
// rides along as itself (not turned into text: the client draws it as a collapsible "Thought").
const shownBlocks = (content, thinking) => content.flatMap((b) => b?.type === 'thinking' ? (thinking ? [b] : isNarration(b) && b.thinking ? [{ type: 'text', text: b.thinking, narration: true }] : []) : b?.type === 'redacted_thinking' ? [] : [b]);

const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n\n') : '';

// One line as the chat draws it. Pictures become URLs on this session's picture route.
export function toMessage(j, k, sid, thinking = false) {
  const pic = (b, n) => ({ type: 'image', url: `/api/sessions/${sid}/image/${j.uuid}/${n}`, media_type: b.source.media_type || 'image/png' });
  const base = { uuid: j.uuid, timestamp: j.timestamp };
  switch (k) {
    case 'a': return { ...base, role: 'assistant', id: j.message.id, content: eachImage(shownBlocks(j.message.content, thinking), pic) };
    case 'r': return { ...base, role: 'user', content: eachImage(j.message.content, pic) };
    case 'u': { const c = j.message.content; return { ...base, role: 'user', content: Array.isArray(c) ? eachImage(c, pic) : [{ type: 'text', text: String(c) }] }; }
    case 'q': { const p = j.attachment.prompt; return { ...base, role: 'user', queued: true, content: Array.isArray(p) ? eachImage(p, pic) : [{ type: 'text', text: String(p) }] }; }
    case 't': return { ...base, role: 'task', ...parseTask(j.type === 'attachment' ? j.attachment.prompt : textOf(j.message?.content)) };
    case 'c': { const m = j.compactMetadata || {}; return { ...base, role: 'compact', trigger: m.trigger || '', preTokens: m.preTokens || 0, postTokens: m.postTokens || 0 }; }
    case 's': return { ...base, role: 'compact_summary', text: textOf(j.message?.content) };
    case 'n': return { ...base, role: 'notice', level: j.level || (j.isApiErrorMessage ? 'error' : 'info'), text: j.type === 'system' ? String(j.content) : textOf(j.message?.content) };
  }
  return null;
}

// Parse one line of the file. Metadata lines (titles, modes, queue bookkeeping, file-history
// snapshots) start with their type and are skipped unread; some of them are large.
const SHOWN_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);
function parseLine(buf, s, e) {
  if (e - s > 9 && buf[s + 2] === 0x74 && buf.toString('latin1', s, s + 9) === '{"type":"') {
    const q = buf.indexOf(34, s + 9);
    if (q > 0 && q - s < 60 && !SHOWN_TYPES.has(buf.toString('latin1', s + 9, q))) return null;
  }
  try { return JSON.parse(buf.toString('utf8', s, e)); } catch { return null; }
}

// What paging needs to know about a shown line: where it is, when, and which tool calls it
// makes or answers - a page may begin mid-turn, but never between a call and its result.
function entry(j, k, off, len) {
  const e = { off, len, k, uuid: j.uuid, ts: Date.parse(j.timestamp) || 0 };
  const c = j.message?.content;
  if (k === 'a' && Array.isArray(c)) { const u = c.filter((b) => b?.type === 'tool_use').map((b) => b.id); if (u.length) e.uses = u; }
  if (k === 'r' && Array.isArray(c)) { const r = c.filter((b) => b?.type === 'tool_result').map((b) => b.tool_use_id); if (r.length) e.results = r; }
  return e;
}

function scan(buf, base, from, to) {
  const out = [];
  for (let s = from; s < to; ) {
    let e = buf.indexOf(10, s); if (e < 0 || e > to) e = to;
    if (e > s) { const j = parseLine(buf, s, e); const k = j && kindOf(j); if (k) out.push(entry(j, k, base + s, e - s)); }
    s = e + 1;
  }
  return out;
}

async function readAt(fh, pos, len) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) { const { bytesRead } = await fh.read(buf, got, len - got, pos + got); if (!bytesRead) break; got += bytesRead; }
  return got < len ? buf.subarray(0, got) : buf;
}

// The index of one file: `items` are the shown lines between `low` and `high` (byte offsets of
// line starts / the end of the last whole line), in file order.
class Index {
  constructor(id, file) { this.id = id; this.file = file; this.items = []; this.low = -1; this.high = 0; this.ino = 0; this.tail = null; this.busy = Promise.resolve(); }
  // One operation at a time: a page and its pictures are asked for together.
  run(fn) { const p = this.busy.then(fn, fn); this.busy = p.catch(() => {}); return p; }

  async open() {
    const fh = await fs.promises.open(this.file, 'r');
    try {
      const st = await fh.stat();
      if (this.low >= 0 && st.ino === this.ino && st.size >= this.high && this.tail && this.high >= this.tail.length) {
        const seen = await readAt(fh, this.high - this.tail.length, this.tail.length);
        if (seen.equals(this.tail)) { if (st.size > this.high) await this.grow(fh, st.size); return; }
      }
      // First look, or the file was replaced or cut short: start again from its end.
      this.items = []; this.ino = st.ino; this.tail = null;
      const end = await this.lastNewline(fh, st.size);
      this.low = this.high = end;
      this.setTail(await readAt(fh, Math.max(0, end - 64), Math.min(64, end)));
    } finally { await fh.close(); }
  }

  setTail(b) { this.tail = Buffer.from(b); }

  // The end of the last whole line: a line still being written is left for the next look.
  async lastNewline(fh, size) {
    for (let pos = size; pos > 0; ) {
      const start = Math.max(0, pos - 65536), b = await readAt(fh, start, pos - start);
      const i = b.lastIndexOf(10);
      if (i >= 0) return start + i + 1;
      pos = start;
    }
    return 0;
  }

  async grow(fh, size) {
    const b = await readAt(fh, this.high, size - this.high);
    const last = b.lastIndexOf(10);
    if (last < 0) return;
    for (const it of scan(b, this.high, 0, last)) this.items.push(it);
    this.high += last + 1;
    this.setTail(b.subarray(Math.max(0, last + 1 - 64), last + 1));
  }

  // Read further back until `want` more shown lines are indexed before `off`, or the file's start.
  async back(fh, want) {
    let got = 0, step = STEP;
    while (this.low > 0 && got < want) {
      const start = Math.max(0, this.low - step);
      const b = await readAt(fh, start, this.low - start);
      let from = 0;
      if (start > 0) {
        const nl = b.indexOf(10);
        if (nl < 0) { step *= 2; continue; } // one line longer than the step: a very large picture
        from = nl + 1;
      }
      const older = scan(b, start, from, b.length);
      this.items = older.concat(this.items);
      this.low = start + from; got += older.length; step = STEP;
    }
  }
}

function indexFor(id) {
  const file = sessionFile(id);
  if (!file) return null;
  let ix = indexes.get(id);
  if (!ix || ix.file !== file) ix = new Index(id, file);
  indexes.delete(id); indexes.set(id, ix);
  while (indexes.size > KEEP) indexes.delete(indexes.keys().next().value);
  return ix;
}

// Where a page may begin, once it holds enough: at a line from which on every tool result has
// its call in the page too (a result drawn without its call has nowhere to go). Walking back
// from the end, `need` holds the calls that results in the page answer but the page lacks.
// A result whose call never turns up must not pull the whole file in: after a while any line
// that is not itself a result will do.
function startOf(items, end, lines, bytes) {
  const need = new Set();
  let n = 0, size = 0, loose = -1;
  for (let i = end - 1; i >= 0; i--) {
    const it = items[i];
    if (it.results) for (const r of it.results) need.add(r);
    if (it.uses) for (const u of it.uses) need.delete(u);
    n++; size += it.len;
    if (n < lines && size < bytes) continue;
    if (it.k === 'r' || it.k === 's') continue;
    if (!need.size) return i;
    if (loose < 0) loose = i;
    if (n >= lines * 4 || size >= bytes * 3) return loose;
  }
  return 0;
}

/**
 * One page of the conversation, oldest first.
 * @param before  a byte offset from a previous page: only lines that start before it
 * @param until   ms: leave out lines from this time on (a turn still running here streams them)
 */
export async function historyPage(id, { before = Infinity, until = 0, lines = 150, bytes = 6 << 20, thinking = false } = {}) {
  const ix = indexFor(id);
  if (!ix) return null;
  return ix.run(async () => {
    await ix.open();
    const fh = await fs.promises.open(ix.file, 'r');
    try {
      let end = ix.items.length;
      if (before !== Infinity) { let lo = 0, hi = end; while (lo < hi) { const m = (lo + hi) >> 1; if (ix.items[m].off < before) lo = m + 1; else hi = m; } end = lo; }
      // `until` is when the turn under way began, on this machine's clock like the transcript's:
      // its lines come after it. (A margin of 1.5 s here dropped the turn before, when the next
      // one began within it: neither the transcript nor the run's replay had it any more.)
      if (until) while (end > 0 && ix.items[end - 1].ts >= until) end--;
      // Enough lines behind the page's end to fill it and to find where it may begin.
      if (end < lines * 2 && ix.low > 0) {
        const had = ix.items.length; await ix.back(fh, lines * 2 - end + 50); end += ix.items.length - had;
      }
      let start = startOf(ix.items, end, lines, bytes);
      // Walked to the start of what is indexed without finding a place to begin: read further.
      while (start === 0 && ix.low > 0 && end > 0) { const had = ix.items.length; await ix.back(fh, lines); end += ix.items.length - had; start = startOf(ix.items, end, lines, bytes); if (ix.items.length === had) break; }
      const page = ix.items.slice(start, end);
      // Rewinding forks the session through the SDK, which knows only what follows the last
      // compaction; a prompt from before it is marked so the page offers no rewind there.
      let lastCompact = -1;
      for (let i = ix.items.length - 1; i >= start; i--) if (ix.items[i].k === 'c') { lastCompact = ix.items[i].off; break; }
      const messages = [];
      if (page.length) {
        const from = page[0].off, to = page[page.length - 1].off + page[page.length - 1].len;
        const b = await readAt(fh, from, to - from);
        for (const it of page) {
          const j = parseLine(b, it.off - from, it.off - from + it.len);
          const m = j && toMessage(j, it.k, id, thinking);
          if (!m) continue;
          if (it.off < lastCompact && m.role === 'user') m.old = true;
          messages.push(m);
        }
      }
      const first = page[0];
      return { messages, before: first ? first.off : before === Infinity ? ix.low : before, more: start > 0 || ix.low > 0, midTurn: !!first && first.k !== 'u' && first.k !== 'c' };
    } finally { await fh.close(); }
  });
}

// A picture from a line, by the line's uuid and its number in that line (see eachImage).
export async function historyImage(id, uuid, n) {
  const ix = indexFor(id);
  if (!ix) return null;
  return ix.run(async () => {
    await ix.open();
    let it = ix.items.find((x) => x.uuid === uuid);
    const fh = await fs.promises.open(ix.file, 'r');
    try {
      // Pages only ever hand out URLs for lines they indexed, but a server restart forgets.
      while (!it && ix.low > 0) { const had = ix.items.length; await ix.back(fh, 500); it = ix.items.slice(0, ix.items.length - had).find((x) => x.uuid === uuid); }
      if (!it) return null;
      const b = await readAt(fh, it.off, it.len);
      const j = parseLine(b, 0, b.length);
      let found = null;
      const c = j?.type === 'attachment' ? j.attachment?.prompt : j?.message?.content;
      eachImage(c, (img, i) => { if (i === n) found = img.source; return img; });
      return found ? { type: found.media_type || 'image/png', data: Buffer.from(found.data, 'base64') } : null;
    } finally { await fh.close(); }
  });
}

// The text a line offers the find bar - the same words the chat shows, not the JSON around them.
function searchableText(j, k) {
  if (k === 'a') return (j.message?.content || []).filter((b) => b?.type === 'text' || b?.type === 'thinking').map((b) => b.text || b.thinking || '').join('\n');
  if (k === 'u' || k === 'q') { const c = k === 'q' ? j.attachment?.prompt : j.message?.content; return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''; }
  if (k === 'n') return j.type === 'system' ? String(j.content || '') : textOf(j.message?.content);
  return '';
}
/**
 * Text anywhere in one session, newest first: Ctrl/Cmd+F's server side. Pages further back
 * through the same index a history page uses, so a 430 MB transcript is still never read whole -
 * `more` says there may be older hits a bigger `limit` (or a second call past the last one) would reach.
 */
export async function searchSession(id, query, { limit = 200, maxScan = 20000 } = {}) {
  const ix = indexFor(id);
  if (!ix) return { hits: [], more: false };
  return ix.run(async () => {
    await ix.open();
    const fh = await fs.promises.open(ix.file, 'r');
    try {
      const needle = query.toLowerCase();
      const hits = [];
      let end = ix.items.length, scanned = 0;
      while (hits.length < limit && scanned < maxScan) {
        if (end <= 0) {
          if (ix.low <= 0) break;
          const had = ix.items.length; await ix.back(fh, 300); end += ix.items.length - had;
          if (ix.items.length === had) break; // nothing older came in
          continue;
        }
        const it = ix.items[end - 1];
        if (it.k === 'a' || it.k === 'u' || it.k === 'q' || it.k === 'n') {
          const b = await readAt(fh, it.off, it.len);
          const j = parseLine(b, 0, b.length);
          const text = j && searchableText(j, it.k);
          const at = text ? text.toLowerCase().indexOf(needle) : -1;
          if (at >= 0) hits.push({ uuid: it.uuid, ts: it.ts, before: it.off + it.len, role: it.k === 'a' ? 'assistant' : 'user', snippet: text.slice(Math.max(0, at - 40), at + needle.length + 60).trim() });
        }
        end--; scanned++;
      }
      return { hits, more: hits.length >= limit && (end > 0 || ix.low > 0) };
    } finally { await fh.close(); }
  });
}
