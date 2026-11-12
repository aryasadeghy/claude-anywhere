// Saved environments: a folder plus the worktree/branch preference and environment variables a
// person wants every session there to start with - "Save as environment" on a session, picked
// again from the new-session folder menu or Settings. Not tied to a running process (unlike
// lib/awake.mjs): this is only ever read back into a new run's options.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

let FILE = null;
let store = { environments: {} };

function save() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(store)); } catch {} }

export function init(dataDir) {
  FILE = path.join(dataDir, 'environments.json');
  try { store = { environments: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { store = { environments: {} }; }
}

export function list() { return Object.values(store.environments).sort((a, b) => b.createdAt - a.createdAt); }
export function get(id) { return store.environments[id] || null; }

export function create({ name, folder, worktree, env }) {
  const row = {
    id: randomUUID(),
    name: String(name || '').trim() || path.basename(folder) || 'Environment',
    folder: String(folder || ''),
    worktree: worktree ? { prefer: true, branch: String(worktree.branch || '') } : null,
    env: env && typeof env === 'object' ? env : {},
    createdAt: Date.now(),
  };
  store.environments[row.id] = row;
  save();
  return row;
}

export function remove(id) {
  const had = !!store.environments[id];
  delete store.environments[id];
  save();
  return had;
}
