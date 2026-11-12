// Output styles: Claude Code's own built-ins plus whatever .md files a project or the user has
// dropped in .claude/output-styles - the same two places skills live, read the same way (a
// frontmatter name/description, no YAML dependency for two fields).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Shipped with Claude Code itself - not files on disk, so they have to be named here. The CLI's
// own `/output-style` command offers exactly these three plus whatever .md files it finds.
export const BUILTIN = [
  { id: 'default', name: 'Default', source: 'built-in', description: 'Claude\'s normal style.' },
  { id: 'Explanatory', name: 'Explanatory', source: 'built-in', description: 'Educational asides explain implementation choices along the way.' },
  { id: 'Learning', name: 'Learning', source: 'built-in', description: 'Collaborative, asks you to write small pieces yourself with TODO(human) markers.' },
];

function scan(dir, source) {
  let names; try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    let text; try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '';
    const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '') || '';
    const id = name.replace(/\.md$/, '');
    out.push({ id: field('name') || id, name: field('name') || id, source, description: field('description') || '' });
  }
  return out;
}

/** Every style available to a session in this folder: built-in, then project, then user. */
export function list(cwd) {
  const project = cwd ? scan(path.join(cwd, '.claude', 'output-styles'), 'project') : [];
  const user = scan(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'output-styles'), 'user');
  return [...BUILTIN, ...project, ...user];
}
