// This package's own small store: the default Transcript view, whether Claude may classify a
// session's status itself, and the chapters/status each session has. Kept in a file of its own
// (not prefs.json) so this agent's work and another's never collide writing the same file.
import fs from 'node:fs';

const FILE = (process.env.CLAUDE_ANYWHERE_DATA_DIR || process.env.CLAUDE_REMOTE_DATA_DIR || new URL('../data', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) + '/conversation.json';
const defaults = () => ({ transcriptView: 'normal', autoClassify: false, chapters: {}, status: {} });

export function readConvSettings() {
  try { return { ...defaults(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { return defaults(); }
}
export function writeConvSettings(s) {
  try { fs.mkdirSync(FILE.replace(/[\\/][^\\/]+$/, ''), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s)); } catch {}
}
