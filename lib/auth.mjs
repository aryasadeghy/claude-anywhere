// Which Claude account the app runs with. Three are available and the user
// switches between them at any time:
//   local     — the account Claude Code is signed into on this computer (nothing stored here)
//   token     — a token the user pasted (from `claude setup-token`, or a Console API key),
//               kept in data/auth.json (git-ignored) so it survives restarts.
//   provider  — somebody else's address for the same API: a gateway, a reseller, a
//               company's own proxy. Claude Code talks the Anthropic Messages API and
//               reads ANTHROPIC_BASE_URL, so a provider is a URL and a key rather than a
//               second kind of program. One that speaks only OpenAI's API cannot stand in
//               for it, and says so the moment the key is tested.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as claudeCode from './claude-code.mjs';

const DATA_DIR = process.env.CLAUDE_ANYWHERE_DATA_DIR || process.env.CLAUDE_REMOTE_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const FILE = path.join(DATA_DIR, 'auth.json');

let state = { active: 'local', token: null, provider: null };
// token:    { kind: 'oauth' | 'apikey', token, since }
// provider: { name, baseUrl, key, keyKind: 'bearer' | 'apikey', model, since }
try {
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (saved && typeof saved === 'object') {
    if (saved.kind && saved.token) state = { active: 'token', token: saved }; // old single-token format
    else state = { active: saved.active, token: saved.token || null, provider: saved.provider || null };
  }
} catch {}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state));
}

// The provider without its key: what the app may show on a screen or in a log.
const publicProvider = (p) => (p ? { name: p.name, baseUrl: p.baseUrl, keyKind: p.keyKind, model: p.model || '', since: p.since || 0 } : null);

export const getAuth = () => ({ active: activeAccount(), hasToken: !!state.token, tokenKind: state.token?.kind || '', tokenSince: state.token?.since || 0, provider: publicProvider(state.provider) });
export const activeAccount = () =>
  state.active === 'token' && state.token ? 'token'
  : state.active === 'provider' && state.provider ? 'provider'
  : 'local';

export function setActive(which) {
  state.active = (which === 'token' && state.token) || (which === 'provider' && state.provider) ? which : 'local';
  save();
  return activeAccount();
}
export function setProvider(p) {
  state.provider = { name: p.name, baseUrl: p.baseUrl, key: p.key, keyKind: p.keyKind === 'apikey' ? 'apikey' : 'bearer', model: p.model || '', since: Date.now() };
  state.active = 'provider';
  save();
}
export function clearProvider() {
  state.provider = null;
  if (state.active === 'provider') state.active = 'local';
  save();
}
export function setToken(token, kind) {
  state.token = { kind, token, since: Date.now() };
  state.active = 'token';
  save();
}
export function clearToken() {
  state.token = null;
  state.active = 'local';
  save();
}

export function classifyToken(t) {
  t = (t || '').trim();
  if (!t) return null;
  return /^sk-ant-api/i.test(t) ? 'apikey' : 'oauth';
}

// Environment for CLI/SDK calls on a given account ('local' or 'token'; default: the active one).
// Variables that are ours and would mean something else entirely to whatever
// Claude runs. PORT is the one that bites: `npm run dev` in a session inherited
// PORT=7777, so the project's own dev server took the app's port while the app
// was closed for a rebuild, and the phone's bookmark stopped working.
const OURS = ['PORT', 'HOST', 'REMOTE_PASSWORD', 'USER_NAME'];

export function envFor(which = activeAccount()) {
  const e = { ...process.env };
  for (const k of OURS) delete e[k];
  for (const k of Object.keys(e)) if (k.startsWith('CLAUDE_ANYWHERE_') || k.startsWith('CLAUDE_REMOTE_')) delete e[k];
  if (process.versions.electron) e.ELECTRON_RUN_AS_NODE = '1';
  if (which === 'token' && state.token) {
    delete e.CLAUDE_CODE_OAUTH_TOKEN; delete e.ANTHROPIC_API_KEY;
    e[state.token.kind === 'apikey' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'] = state.token.token;
  }
  if (which === 'provider' && state.provider) Object.assign(e, providerVars(state.provider));
  return e;
}

/// The whole of a provider: an address, a key and optionally which model to ask for.
/// Bearer or x-api-key is the provider's choice, not ours - a gateway that forwards to
/// Anthropic usually wants Bearer, one that impersonates the API wants x-api-key - so it
/// is asked for rather than guessed, and the wrong one fails loudly on the first turn.
function providerVars(p) {
  const e = {};
  e.ANTHROPIC_BASE_URL = String(p.baseUrl || '').replace(/\/+$/, '');
  if (p.keyKind === 'apikey') e.ANTHROPIC_API_KEY = p.key;
  else e.ANTHROPIC_AUTH_TOKEN = p.key;
  // A provider names its models its own way; without this the CLI asks for Claude's.
  // Every slot, not just the main one: the CLI also asks for a small fast model behind
  // your back - titles, classifiers - and a provider that serves one model id answers a
  // request for 'haiku' with a 404 nobody sees.
  if (p.model) { for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) e[k] = p.model; }
  return e;
}

/// The environment a provider would run in, before it is saved - what proves the key.
export function candidateProviderEnv(p) {
  const e = { ...process.env };
  delete e.CLAUDE_CODE_OAUTH_TOKEN; delete e.ANTHROPIC_API_KEY; delete e.ANTHROPIC_AUTH_TOKEN; delete e.ANTHROPIC_BASE_URL;
  return Object.assign(e, providerVars(p));
}
export const authEnv = () => envFor();

export function localSource() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN in .env';
  if (process.env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY in .env';
  return 'machine login';
}
export function authSource() {
  const which = activeAccount();
  if (which === 'token') return 'token entered in the app';
  if (which === 'provider') return state.provider.name + ' · ' + state.provider.baseUrl;
  return localSource();
}

// A token is only proven by a real request. One tiny turn on the cheapest model.
export async function verifyEnv(env, model = 'claude-haiku-4-5-20251001') {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 60000);
  try {
    for await (const msg of query({ prompt: 'Reply with the single word: ok', options: { env, abortController: abort, model, maxTurns: 1, tools: [], persistSession: false, cwd: path.dirname(FILE), ...claudeCode.spawnOptions() } })) {
      if (msg.type === 'result') return msg.is_error ? { ok: false, error: msg.result || 'The token was rejected.' } : { ok: true };
    }
    return { ok: false, error: 'No answer from Claude.' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally { clearTimeout(timer); }
}

export function candidateEnv(token, kind) {
  const e = { ...process.env };
  delete e.CLAUDE_CODE_OAUTH_TOKEN; delete e.ANTHROPIC_API_KEY;
  e[kind === 'apikey' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'] = token;
  return e;
}
