// The model menu, as the CLI itself describes it.
//
// Hard-coding the list meant the app drifted from Claude the moment a model was
// added or an effort level appeared: ours offered low/medium/high for everything
// while the CLI had low/medium/high/xhigh/max for some models and none at all for
// Haiku. So the list comes from the CLI — the same answer Claude Code and Claude
// Desktop show — and the app only renders it.
//
// Asking costs a CLI process, not a model call: the query is opened with an input
// that never yields, `supportedModels()` answers over the control protocol, and the
// process is closed again. The answer is cached in memory and on disk, so the menu
// paints instantly and refreshes behind it.

import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { authEnv } from './auth.mjs';
import * as claudeCode from './claude-code.mjs';

const HOUR = 60 * 60 * 1000;

// The Claude Code that answers: the app's own, or a newer one taken in Settings. A model
// can be newer than it: the catalog entry says `min_claude_code_version`, and a CLI below
// that hides the model rather than offering something it cannot run - Opus 5.5 wanted
// 2.1.280 while the app shipped 2.1.274, so the menu was correct and still missing a
// model. That makes this version, not the clock, the thing worth watching.
const cliVersion = claudeCode.version;

// What to fall back to when the CLI cannot be asked (no login yet, an older CLI).
// Deliberately plain: a wrong-looking menu is better than an empty one.
export const FALLBACK = [
  { value: 'default', displayName: 'Default (recommended)', description: 'The model Claude Code picks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
];

// Omitting the level runs the model's own default, which is 'high'.
export const DEFAULT_EFFORT = 'high';

let cache = { at: 0, models: null, error: '', from: '', cli: '' };
let inFlight = null;
let cachePath = '';

export function useCache(dir) {
  cachePath = path.join(dir, 'models.json');
  try {
    const disk = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Array.isArray(disk.models) && disk.models.length) cache = { at: disk.at || 0, models: disk.models, error: '', from: disk.from === 'provider' ? 'provider' : 'disk', cli: disk.cli || '' };
  } catch {}
}

// A provider's menu is the provider's, not Claude's: the CLI's supportedModels() only
// knows Claude's catalog, and every id on it is one a gateway like hy24 answers with a
// 404. So the list is read from the provider itself and shown whole - no filter, since
// which of its models suit a turn is the provider's business, not ours.
// `/v1/models` is the Anthropic-shaped answer; a gateway that mounts the Anthropic API
// under `/anthropic` (hy24 does) often lists only on its OpenAI side, at `/openai/v1/models`.
export async function fromProvider({ baseUrl, key, keyKind }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const headers = keyKind === 'apikey' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: 'Bearer ' + key, 'anthropic-version': '2023-06-01' };
  const urls = [base + '/v1/models'];
  if (/\/anthropic$/i.test(base)) urls.push(base.replace(/\/anthropic$/i, '/openai') + '/v1/models');
  let last = '', refused = 0;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (r.status === 401 || r.status === 403) refused = r.status;
      if (!r.ok) { last = url + ' answered ' + r.status; continue; }
      const body = await r.json();
      const rows = (Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []).filter((m) => m && (m.id || m.slug));
      if (!rows.length) { last = url + ' listed no models'; continue; }
      const prices = await pricesFor(base);
      const offered = rows.map((m) => { const id = String(m.id || m.slug), displayName = String(m.display_name || m.name || id); return { value: id, displayName, description: prices[id]?.text || '', supportsEffort: false, group: familyOf(id + ' ' + displayName), ...(prices[id]?.discount ? { discount: prices[id].discount, discountNote: prices[id].note } : {}) }; });
      // Sorted here, not in the page: the menu numbers its rows, and the numbers have to
      // be the order the rows are drawn in. The sort is stable, so each family keeps the
      // provider's own order.
      return offered.sort((a, b) => FAMILIES.indexOf(a.group) - FAMILIES.indexOf(b.group));
    } catch (e) { last = url + ': ' + (e?.message || e); }
  }
  // A refused key is the one answer worth naming plainly; the rest is for whoever debugs it.
  throw Object.assign(new Error(refused ? 'The provider did not accept that key (' + refused + ')' : 'Could not read the provider\'s models (' + last + ')'), { refused });
}

// A gateway with thirty models is a list to be read in families. The ids are the
// provider's own (`google/gemini-3-8-flash`, `code/claude-opus-5-5`, `code/gpt-5-5`), so
// the family is read off the id and the name; codex is OpenAI's.
const FAMILIES = ['GPT', 'Claude', 'Google', 'Other'];
function familyOf(text) {
  if (/gemini|gemma|google/i.test(text)) return 'Google';
  if (/claude|anthropic/i.test(text)) return 'Claude';
  if (/gpt|openai|codex/i.test(text)) return 'GPT';
  return 'Other';
}

// Neither models list carries a price; hy24 publishes them, keyless, in its own catalog
// beside the compat mounts. Rates are micro-units per 1K tokens and the micro-per-cent
// ratio is the admin's to change, so it is read rather than assumed. This is the list
// price - the plan's discount is applied at billing and is not public. Best effort: a
// provider without this catalog simply shows no prices.
async function pricesFor(base) {
  if (!/\/anthropic$/i.test(base)) return {};
  const root = base.replace(/\/anthropic$/i, '');
  try {
    const get = (p) => fetch(root + p, { signal: AbortSignal.timeout(10000) }).then((r) => (r.ok ? r.json() : null));
    const [groups, config] = await Promise.all([get('/model-groups?type=chat&surface=api'), get('/config/public').catch(() => null)]);
    if (!Array.isArray(groups)) return {};
    const perDollar = (config?.credits?.microcreditsPerCent || 10000) * 100;
    const usd = (n) => '$' + n.toFixed(n >= 1 ? 2 : n >= 0.01 ? 3 : 4);
    const out = {};
    const line = (g, m) => usd(g.costPerInputTokenMicro * m * 1000 / perDollar) + ' in · ' + usd(g.costPerOutputTokenMicro * m * 1000 / perDollar) + ' out per 1M tokens';
    for (const g of groups) {
      if (!g?.slug || g.costPerInputTokenMicro == null || g.costPerOutputTokenMicro == null) continue;
      // A multiplier under 1 is a discount on the official price - the rule hy24's own
      // pricing page badges by. Above 1 is its margin, which is not a thing to announce.
      const m = typeof g.priceMultiplier === 'number' && g.priceMultiplier > 0 ? g.priceMultiplier : 1;
      const discount = Math.round((1 - m) * 100);
      out[g.slug] = { text: line(g, m), ...(discount > 0 ? { discount, note: discount + '% off the official price of ' + line(g, 1) } : {}) };
    }
    return out;
  } catch { return {}; }
}

const providerOf = (env) => env?.ANTHROPIC_BASE_URL ? { baseUrl: env.ANTHROPIC_BASE_URL, key: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY, keyKind: env.ANTHROPIC_AUTH_TOKEN ? 'bearer' : 'apikey' } : null;

async function ask(env) {
  env = env || authEnv();
  const prov = providerOf(env);
  if (prov) return { models: await fromProvider(prov), from: 'provider' };
  const never = (async function* () { await new Promise(() => {}); })();
  const q = query({ prompt: never, options: { env, ...claudeCode.spawnOptions() } });
  try {
    const models = await q.supportedModels();
    return Array.isArray(models) && models.length ? { models, from: 'cli' } : null;
  } finally {
    // Ending the generator is what closes the subprocess (stdin EOF, then grace).
    // interrupt() only stops a turn, and there is no turn here — it would leave a
    // CLI process behind on every refresh.
    try { await q.return(undefined); } catch {}
  }
}

function refresh(env) {
  if (inFlight) return inFlight;
  inFlight = ask(env)
    .then((got) => {
      if (!got) return;
      const { models, from } = got;
      cache = { at: Date.now(), models, error: '', from, cli: cliVersion() };
      if (cachePath) { try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); fs.writeFileSync(cachePath, JSON.stringify({ at: cache.at, cli: cache.cli, from, models }, null, 2)); } catch {} }
    })
    .catch((e) => { cache = { ...cache, error: String(e?.message || e) }; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** The cached list, with a refresh started behind it when it may have moved on. */
export function list({ env, force = false } = {}) {
  const stale = !cache.models || Date.now() - cache.at > HOUR || cache.cli !== cliVersion();
  if (force || stale) refresh(env);
  return { models: cache.models || FALLBACK, at: cache.at, cli: cache.cli, from: cache.models ? cache.from : 'fallback', error: cache.error, defaultEffort: DEFAULT_EFFORT };
}

/** Ask now and wait, for the Refresh row in the menu: a background refresh would hand
 *  back the same list it was pressed about. */
export async function refreshNow(env) {
  await refresh(env);
  return list({ env });
}

/** Forget the list. The models are the account's - another login offers another menu,
 *  and a stale one would offer a model the new account cannot run. */
export function forget() {
  cache = { at: 0, models: null, error: '', from: '', cli: '' };
  if (cachePath) { try { fs.rmSync(cachePath, { force: true }); } catch {} }
}

/** Ask now and wait — used once at startup so the first menu is already the real one. */
export async function warm({ env } = {}) {
  await refresh(env);
  return list({ env });
}

/**
 * The row a saved id belongs to. A persisted wire id like `claude-sonnet-5` is the
 * `resolvedModel` of the alias row `sonnet`, which is what the CLI expects back.
 */
export function rowFor(id, models) {
  if (!id) return null;
  return (models || []).find((m) => m.value === id) || (models || []).find((m) => m.resolvedModel === id) || null;
}

/** Is this an id the CLI offered? Anything else must not be sent to it. */
export function known(id, models) {
  return !!rowFor(id, models);
}

/**
 * The id to send the CLI for what the client asked for, or '' to refuse it — and a
 * saved wire id comes back as the alias row that covers it, which is what the CLI
 * wants to hear. Before the list has arrived nothing can be checked against it, and
 * refusing every model until it does would silently run the wrong one, so the id is
 * passed through for the CLI itself to judge.
 */
export function acceptable(id) {
  if (!id) return '';
  if (!cache.models) return id;
  return rowFor(id, cache.models)?.value || '';
}

/** The model a provider turn runs when none was picked: the CLI's own default is a
 *  Claude id, which a provider that serves its own models answers with a 404. */
export const providerDefault = () => (cache.from === 'provider' ? cache.models?.[0]?.value || '' : '');

/** What is known right now, without asking for a refresh. */
export const cached = () => cache.models;

/** The effort levels that model allows, empty when it has none. */
export function effortsFor(id, models) {
  const row = rowFor(id, models);
  if (!row || row.supportsEffort === false) return [];
  return row.supportedEffortLevels || [];
}
