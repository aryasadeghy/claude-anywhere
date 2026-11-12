// The rail's Outputs card: files Claude wrote (Write/Edit/MultiEdit/NotebookEdit) or handed
// over with SendUserFile this session. A transcript can run to hundreds of MB (history.mjs's
// own comment above it), so this reads only the last slice of the file - recent output is what
// the card is for, and a full-file scan on every rail paint would be the slow kind of correct.
import fs from 'node:fs';
import { sessionFile } from './tail.mjs';

const TAIL_BYTES = 8 << 20; // last 8MB: generous for a session's own working set, bounded either way
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function sessionOutputs(id, limit = 50) {
  const file = sessionFile(id);
  if (!file) return [];
  let buf;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - TAIL_BYTES);
    const len = st.size - start;
    buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  } catch { return []; }
  const byPath = new Map(); // last mention wins - a file written twice shows once, at its latest
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.startsWith('{"parentUuid"')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'assistant' || !Array.isArray(j.message?.content)) continue;
    const at = Date.parse(j.timestamp || '') || 0;
    for (const b of j.message.content) {
      if (b.type !== 'tool_use') continue;
      if (b.name === 'SendUserFile' && Array.isArray(b.input?.files)) {
        for (const f of b.input.files) if (typeof f === 'string') byPath.set(f, { path: f, at, via: 'SendUserFile', caption: b.input.caption || '' });
      } else if (WRITE_TOOLS.has(b.name) && typeof b.input?.file_path === 'string') {
        byPath.set(b.input.file_path, { path: b.input.file_path, at, via: b.name });
      }
    }
  }
  return [...byPath.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}
