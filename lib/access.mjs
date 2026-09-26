// Who may use this server from another device.
//
// Until now the only lock was REMOTE_PASSWORD in .env, and the only key was a hash of it
// - the same for every device, never expiring, impossible to take back from one phone
// without changing it for all, and guessable at any speed. That was tolerable on a LAN
// or Tailscale. A public address (dynamic DNS, a tunnel) is not a LAN, so:
//
//   - the password can be set from the app, and is kept as an scrypt hash;
//   - every sign-in gets its own random token, listed and revocable one by one;
//   - failed sign-ins are rate limited, per address and overall;
//   - this computer's own window has a key of its own (data/local.key), so setting a
//     password from the app never locks the app out of itself.
//
// The password-derived token still opens the door: the desktop shell and the phone app
// compute it from a saved password (token_for in src-tauri/src/lib.rs), and releases
// already in people's hands must keep working. Changing the password changes it.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const derived = (password, salt = 'claude-anywhere:') => sha(salt + (password || 'open'));
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export const MIN_PASSWORD = 10;

let dir = '', file = '';
// passwordHash: 'scrypt$salt$hash' for a password set in the app; derivedHash: sha of the
// token the shell would compute from it; devices: [{ id, hash, name, ip, createdAt, lastSeen }]
// remote: the switch - null until someone sets it (off, unless .env already had a password).
let state = { passwordHash: '', derivedHash: '', setAt: 0, devices: [], remote: null };
let envPassword = '';
let localKey = '';

function save() {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function init(dataDir, fromEnv) {
  dir = dataDir; file = path.join(dataDir, 'access.json');
  envPassword = (fromEnv || '').trim() === 'change-me' ? '' : (fromEnv || '').trim();
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const keyFile = path.join(dataDir, 'local.key');
  try { localKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch {}
  if (!localKey) { localKey = randomBytes(32).toString('hex'); fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(keyFile, localKey, { mode: 0o600 }); }
}

// .env wins: whoever wrote it there meant it, and the app cannot rewrite it.
export const source = () => (envPassword ? 'env' : state.passwordHash ? 'app' : 'none');
export const passwordRequired = () => source() !== 'none';
export const getLocalKey = () => localKey;
// The desktop app's own window: it never signs in, and may set or clear the password
// without knowing the old one - the person at this computer owns it.
export const isAppKey = (t) => !!t && same(String(t), localKey);

// Without a password only this computer may use the server. "This computer" is a direct
// connection from loopback with nothing forwarding it: a tunnel, tailscale serve or a
// reverse proxy also connects from loopback, but says on whose behalf.
const FORWARDED = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'tailscale-user-login', 'ngrok-skip-browser-warning'];
export function isLocal(req) {
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (peer !== '127.0.0.1' && peer !== '::1') return false;
  const h = req.headers || {};
  return !FORWARDED.some((k) => h[k] !== undefined);
}
// Remote access is a switch, off until it is turned on, and it cannot be on without a
// password. A password already in .env meant "reachable" before the switch existed, so
// it starts on for those - an update must not cut anybody off.
export const remoteAllowed = () => passwordRequired() && (state.remote ?? source() === 'env');
export function setRemote(on) {
  if (on && !passwordRequired()) throw new Error('Set an app password first: remote access needs one.');
  state.remote = !!on; save();
  return remoteAllowed();
}

export function checkPassword(p) {
  if (typeof p !== 'string') return false;
  if (envPassword) return same(p, envPassword);
  if (!state.passwordHash) return true;
  const [, salt, hash] = state.passwordHash.split('$');
  return same(scryptSync(p, Buffer.from(salt, 'hex'), 32).toString('hex'), hash);
}

// The token a device that knows the password computes for itself (see the header).
function derivedMatches(t) {
  if (envPassword) return same(t, derived(envPassword)) || same(t, derived(envPassword, 'claude-remote:'));
  if (state.passwordHash) return !!state.derivedHash && same(sha(t), state.derivedHash);
  return same(t, derived('')) || same(t, derived('', 'claude-remote:')); // no password: the open token, as before
}

let lastSeenWrite = 0;
export function knownToken(t) {
  if (!t) return false;
  t = String(t);
  if (same(t, localKey)) return true;
  if (derivedMatches(t)) return true;
  const h = sha(t);
  const d = state.devices.find((x) => same(x.hash, h));
  if (!d) return false;
  d.lastSeen = Date.now();
  if (Date.now() - lastSeenWrite > 60000) { lastSeenWrite = Date.now(); try { save(); } catch {} }
  return true;
}

// A sign-in: its own token, remembered by hash only. Without a password there is nothing
// to sign in to, and the open token is what everybody gets, as before.
export function issue({ name, ip }) {
  if (!passwordRequired()) return derived('');
  const token = randomBytes(32).toString('hex');
  state.devices.push({ id: randomBytes(6).toString('hex'), hash: sha(token), name: String(name || 'Browser').slice(0, 80), ip: ip || '', createdAt: Date.now(), lastSeen: Date.now() });
  state.devices = state.devices.slice(-50);
  save();
  return token;
}
export const devices = (current) => state.devices.map((d) => ({ id: d.id, name: d.name, ip: d.ip, createdAt: d.createdAt, lastSeen: d.lastSeen, current: !!current && same(sha(current), d.hash) }));
export function revoke(id) { const n = state.devices.length; state.devices = state.devices.filter((d) => d.id !== id); save(); return n !== state.devices.length; }

// Set, change or clear the app's own password. Every device signs in again - except the
// one doing it, which gets a fresh token back so it does not lock itself out.
export function setPassword(p, { name, ip, fromApp = false } = {}) {
  if (envPassword) throw new Error('The password is set in .env (REMOTE_PASSWORD); change it there.');
  if (p) {
    if (p.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
    const salt = randomBytes(16);
    state.passwordHash = 'scrypt$' + salt.toString('hex') + '$' + scryptSync(p, salt, 32).toString('hex');
    state.derivedHash = sha(derived(p));
  } else { state.passwordHash = ''; state.derivedHash = ''; state.remote = false; }
  state.setAt = Date.now(); state.devices = [];
  save();
  // The desktop app keeps its own key: it is not a device that signed in, and must never
  // be asked for the password it just set.
  if (fromApp) return localKey;
  return p ? issue({ name, ip }) : derived('');
}

// ---------- failed sign-ins ----------
// Per address: five tries, then a lock that doubles each time (1 min … 30 min). Overall:
// behind a tunnel every request comes from localhost and the forwarded address is only
// as honest as the header, so a ceiling across all addresses stops a guesser who
// rotates it. The recent failures are kept to show in the app.
const byIp = new Map(); // ip -> { fails, until, locks }
let overall = []; // timestamps of failures in the last hour
const recent = []; // { ip, at }
export function clientIp(req) {
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  // Only a proxy on this computer (a tunnel, tailscale serve) is believed about who is behind it.
  if (peer === '127.0.0.1' || peer === '::1') {
    const fwd = String(req.get('cf-connecting-ip') || '').trim() || String(req.get('x-forwarded-for') || '').split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (fwd) return fwd;
  }
  return peer;
}
export function locked(ip) {
  const now = Date.now();
  overall = overall.filter((t) => now - t < 3600000);
  if (overall.length >= 50) return Math.ceil((overall[0] + 3600000 - now) / 1000);
  const e = byIp.get(ip);
  return e && e.until > now ? Math.ceil((e.until - now) / 1000) : 0;
}
export function failed(ip) {
  const now = Date.now();
  overall.push(now); recent.unshift({ ip, at: now }); recent.length = Math.min(recent.length, 20);
  const e = byIp.get(ip) || { fails: 0, until: 0, locks: 0 };
  e.fails++;
  if (e.fails >= 5) { e.locks++; e.fails = 0; e.until = now + Math.min(60000 * 2 ** (e.locks - 1), 30 * 60000); }
  byIp.set(ip, e);
}
export const succeeded = (ip) => byIp.delete(ip);
export const failures = () => recent.slice();
