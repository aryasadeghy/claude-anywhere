// Cut a release: set the version everywhere, move the changelog's Unreleased
// section under it, commit and tag. Pushing the tag is what starts the build.
//
//   npm run release -- 0.4.0
//   git push && git push origin v0.4.0
//
// The release workflow refuses to build when package.json, tauri.conf.json and
// the tag disagree, so this is the only sanctioned way to change the version.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2];
const run = (...args) => execFileSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8' }).trim();

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version || '')) {
  console.error('usage: npm run release -- 1.2.3');
  process.exit(1);
}
if (run('git', 'status', '--porcelain')) {
  console.error('the working tree is dirty; commit or stash first');
  process.exit(1);
}

// A release whose commit landed but whose tag was refused (0.14.2: the tag's push came back
// "remote rejected ... (failed)" after the commit was already on main) left main saying the new
// version with no tag, and every later run stopped below at "nothing to change". When the files
// already say this version and the changelog already has its section, the tag is all that is missing.
const at = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
if (JSON.parse(at('package.json')).version === version && at('CHANGELOG.md').includes(`## [${version}]`)) {
  run('git', 'tag', '-a', `v${version}`, '-m', `v${version}`);
  console.log(`already ${version}: tagged v${version} on the current commit`);
  process.exit(0);
}

const edit = (rel, fn) => {
  const p = path.join(root, rel);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) { console.error(`${rel}: nothing to change - is it already ${version}?`); process.exit(1); }
  fs.writeFileSync(p, after);
  console.log('  ' + rel);
};

console.log(`version ${version}`);
edit('package.json', (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
edit('src-tauri/tauri.conf.json', (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
// The crate's own version is what the built binary reports back to the server as
// the app version, so it cannot be left behind: it was, for all of 0.4.0.
edit('src-tauri/Cargo.toml', (s) => s.replace(/^(version = ")[^"]+(")/m, `$1${version}$2`));

// Keep a Changelog: today's release takes what is under Unreleased, and the
// link block at the bottom gains a line for it.
const today = new Date().toISOString().slice(0, 10);
edit('CHANGELOG.md', (s) => {
  const repo = 'https://github.com/aryasadeghy/claude-anywhere';
  const previous = (s.match(/^## \[(\d+\.\d+\.\d+)\]/m) || [])[1];
  return s
    .replace(/## \[Unreleased\]\n/, `## [Unreleased]\n\n## [${version}] — ${today}\n`)
    .replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${repo}/compare/v${version}...HEAD`)
    .replace(/^(\[Unreleased\]: .*)$/m, `$1\n[${version}]: ${repo}/${previous ? `compare/v${previous}...v${version}` : `releases/tag/v${version}`}`);
});

// Cargo.lock carries the version too, and a stale one fails `cargo check --locked` in
// CI. `cargo update --precise` will not do it — it exits happily without touching a
// local package, which is how 0.4.0 shipped a lockfile still saying 0.3.0 — so the one
// line it would have changed is written here. CI's `cargo check --locked` is the proof.
edit('src-tauri/Cargo.lock', (s) => s.replace(/(name = "claude-anywhere"\r?\nversion = ")[^"]+(")/, `$1${version}$2`));

run('git', 'add', '-A');
run('git', 'commit', '-m', `release ${version}`);
run('git', 'tag', '-a', `v${version}`, '-m', `v${version}`);
console.log(`\ntagged v${version}. Review it, then:\n  git push && git push origin v${version}`);
