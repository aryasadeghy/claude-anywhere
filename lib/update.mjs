// Is there a newer build on the Releases page?
//
// The app asks GitHub; nothing reports the other way. One unauthenticated call every
// few minutes at most, to the repository named in package.json — so a fork checks its own releases
// — and the answer is cached for every device pointed at this server. Set
// CLAUDE_ANYWHERE_UPDATE_CHECK=off in .env and it never asks at all.
//
// The check only reads. Installing is a download the person starts, because
// replacing a running app while a turn is in flight is not something to do behind
// someone's back.

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
// How long an answer is kept. An hour was too long by exactly the width of the problem:
// a merge builds and publishes in about eight minutes, and a check that lands five
// minutes before the release then says "up to date" for another fifty-five. Five minutes
// is twelve unauthenticated calls an hour against a limit of sixty, shared by every
// device pointed at this server.
const FRESH_FOR = 5 * 60 * 1000;

let cache = { at: 0, release: null, error: '' };
let inFlight = null;

export const parseRepo = (url) => {
  const m = String(url || '').match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  return m ? `${m[1]}/${m[2]}` : '';
};

// Our tags are v1.2.3, but a fork's may be anything; take the version out of the tag
// and offer nothing at all when there is none, rather than comparing against 0.0.0.
const VERSION_IN = /\d+\.\d+\.\d+(?:-[\w.]+)?/;
export const versionOf = (tag) => (String(tag || '').match(VERSION_IN) || [''])[0];

// Only the three digits matter; a -beta.2 sorts before the release it leads to.
const parts = (v) => String(v || '').replace(/^v/, '').split(/[.-]/);
const nums = (v) => parts(v).slice(0, 3).map((n) => Number(n) || 0);
export function newer(candidate, current) {
  const [a, b] = [nums(candidate), nums(current)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  const pre = (v) => (parts(v).length > 3 ? 0 : 1); // a plain version beats a pre-release of it
  return pre(candidate) > pre(current);
}

// What to offer this computer. One file per platform, and the name is what the
// bundler produced, so match loosely rather than pinning the exact filename.
const WANTED = {
  win32: [/-setup\.exe$/i, /\.exe$/i, /\.msi$/i],
  darwin: [/\.dmg$/i, /\.app\.tar\.gz$/i],
  linux: [/\.deb$/i, /\.AppImage$/i, /\.rpm$/i],
};
export function assetFor(assets, platform) {
  for (const want of WANTED[platform] || []) {
    const hit = (assets || []).find((a) => want.test(a.name || ''));
    if (hit) return { name: hit.name, url: hit.browser_download_url, size: hit.size };
  }
  return null;
}

// Every platform's file, not only this computer's: the person reading this may be
// sitting at a Mac looking at a PC, and the app they can install is the Mac one.
export function assetsFor(assets) {
  const out = {};
  for (const platform of Object.keys(WANTED)) {
    const hit = assetFor(assets, platform);
    if (hit) out[platform] = hit;
  }
  return out;
}

async function fetchLatest(repo) {
  const res = await fetch(`${API}/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-anywhere' },
    signal: AbortSignal.timeout(8000),
  });
  // A repository with no published release answers 404, which is an answer, not a fault.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

function refresh(repo) {
  if (inFlight) return inFlight;
  inFlight = fetchLatest(repo)
    .then((release) => { cache = { at: Date.now(), release, error: '' }; })
    .catch((e) => { cache = { at: Date.now(), release: cache.release, error: String(e.message || e) }; })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * The cached answer, and a refresh started in the background when it is old.
 * Never waits: /api/version is polled every thirty seconds and must stay instant.
 */
export function status({ repo, version, platform, force = false } = {}) {
  if ((process.env.CLAUDE_ANYWHERE_UPDATE_CHECK || '').trim().toLowerCase() === 'off') return { off: true };
  if (!repo) return { off: true, error: 'no repository in package.json' };
  const stale = Date.now() - cache.at > FRESH_FOR;
  if (force || stale) refresh(repo);
  const r = cache.release;
  if (!r) return { checkedAt: cache.at || null, error: cache.error, current: version };
  const latest = versionOf(r.tag_name);
  return {
    checkedAt: cache.at,
    error: cache.error,
    current: version,
    latest: latest || String(r.tag_name || ''),
    tag: String(r.tag_name || ''),
    newer: !!latest && newer(latest, version),
    url: r.html_url,
    publishedAt: r.published_at ? Date.parse(r.published_at) : null,
    notes: String(r.body || '').slice(0, 4000),
    download: assetFor(r.assets, platform), // what this computer would install
    downloads: assetsFor(r.assets), // and what every other kind of device would
  };
}

/** Ask now and wait for it — the Check again button, and nothing else. */
export async function checkNow({ repo, version, platform } = {}) {
  if ((process.env.CLAUDE_ANYWHERE_UPDATE_CHECK || '').trim().toLowerCase() === 'off') return { off: true };
  cache = { ...cache, at: 0 };
  await refresh(repo);
  return status({ repo, version, platform });
}
