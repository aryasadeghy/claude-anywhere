// Pictures and files a session shows from outside every session's folder - a screenshot saved to
// Downloads, a file sent from the Desktop - were refused by /api/file, so on a phone or another
// browser they never appeared. Now a session's own transcript naming the exact path is enough, and
// nothing else is.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, makeSession, startApp, PIXEL } from './fixtures/index.mjs';

let tmp, app, configDir, outside, picture, other;
const SID = 'abababab-1111-2222-3333-444444444444', OTHER = 'cdcdcdcd-1111-2222-3333-444444444444';

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-outside-'));
  configDir = path.join(tmp, 'claude');
  // Outside the temp folder (which is always allowed) and outside every session's folder - and in a
  // hidden one, as a "No folder" chat's ~/.claude-anywhere/chats/<id> is: express refused those.
  outside = fs.mkdtempSync(path.join(os.homedir(), '.ca-outside-'));
  picture = path.join(outside, 'shot.png'); fs.writeFileSync(picture, Buffer.from(PIXEL, 'base64'));
  other = path.join(outside, 'secret.png'); fs.writeFileSync(other, Buffer.from(PIXEL, 'base64'));
  const cwd = path.join(tmp, 'project'); fs.mkdirSync(cwd, { recursive: true });
  makeSession(configDir, cwd, SID);
  makeSession(configDir, cwd, OTHER);
  // Claude's answer in SID names the picture, the way a Markdown image in an answer does.
  const file = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), SID + '.jsonl');
  fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: SID + '-pic', timestamp: new Date().toISOString(), cwd, sessionId: SID, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: `Saved it: ![shot](${picture})` }] } }) + '\n');
  app = await startApp({ port: await freePort(), dataDir: path.join(tmp, 'data'), configDir });
});
after(async () => {
  await app?.stop();
  for (const d of [tmp, outside]) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
});

const get = (p, sid) => fetch(`${app.base}/api/file?token=${encodeURIComponent(app.token)}&path=${encodeURIComponent(p)}${sid ? '&sid=' + sid : ''}`);

test('a picture outside every folder is shown in the session that names it', async () => {
  const r = await get(picture, SID);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /image\/png/);
});

test('...and refused without a session, or in a session that never named it', async () => {
  assert.equal((await get(picture)).status, 403);
  assert.equal((await get(picture, OTHER)).status, 403);
});

test('...and a file next to it that no session names stays refused', async () => {
  assert.equal((await get(other, SID)).status, 403);
});

// The Browser pane asks for a file by its path alone, with no session to check: a mockup Claude
// sent from the Desktop showed in the chat and the pane answered "outside the project folders".
test('the Browser pane opens a file a session showed, and only that one', async () => {
  const grant = await (await fetch(app.base + '/api/preview/grant', { headers: { authorization: 'Bearer ' + app.token } })).json();
  const pane = (p) => fetch(app.base + '/files/' + grant.key + '/' + p.replace(/\\/g, '/').split('/').filter(Boolean).map(encodeURIComponent).join('/'));
  assert.equal((await get(picture, SID)).status, 200); // the chat showed it
  assert.equal((await pane(picture)).status, 200);
  assert.equal((await pane(other)).status, 403);
});
