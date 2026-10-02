# claude-anywhere — house rules

Everything an agent needs to work in this repo. The same rules a human
contributor gets are in [CONTRIBUTING.md](CONTRIBUTING.md); this file is the
short, operational version.

## Running and checking

```bash
npm install
npm start                                  # http://127.0.0.1:7777
PORT=7779 CLAUDE_ANYWHERE_DATA_DIR=/tmp/cr node server.mjs   # a second copy, own data
npm run desktop                            # native window (needs Rust + tauri-cli)
```

- **The client has no build step.** Edit `public/`, reload the page.
- **The server has no watcher.** Restart it after touching `server.mjs` or
  `lib/`. A stale process serving old code is the first thing to suspect when
  a change "does nothing".
- Before committing: `node --check` on every `.mjs`/`app.js` you touched, and
  `cargo check` in `src-tauri/` if you touched Rust. CI runs both.
- `npm test` runs the server-side tests against the real app, nothing to install.
  `npm run test:ui` walks the Browser pane in Chromium and WebKit (after
  `npm i --no-save playwright`) and leaves its screenshots in `test/ui/shots/`;
  CI runs both and keeps the screenshots as an artifact.

## Proving a change works

Screenshots, not assertions. Drive the app with Playwright against a dev
server, do the thing a person would do, and keep the screenshot:

```js
const { chromium } = require('playwright');
const b = await chromium.launch({ channel: 'chrome', headless: true });
const page = await b.newPage({ viewport: { width: 1380, height: 860 } });
await page.goto('http://127.0.0.1:7779/');
```

- Check the phone width (390 px) for anything visual, and WebKit when layout
  changed — this app is used from Safari on a Mac too.
- Real turns are cheap with `model: 'claude-haiku-4-5-20251001'` and a prompt
  that does one small thing.
- Turns without any account: `startFakeApi()` and `fakeApiEnv()` in `test/fixtures` point
  the real Claude Code at a fake Anthropic API — the CLI, the app and the page end to end,
  offline, free and the same every time (`test/ui/realtime.cjs`). It answers word by word,
  slowly on `[slow]`, and starts a background command on `[background]`.
- For the native window: it renders through WebView2, so take the shot with a
  DPI-aware script (`SetProcessDPIAware`) or the right-hand side is cut off and
  you will chase a bug that is not there.
- **The native window can be driven, not only photographed.** Start it with
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` and
  `chromium.connectOverCDP('http://127.0.0.1:9222')` attaches Playwright to the
  real window — the only way to test anything that calls the shell, since those
  commands do not exist in a browser.

## Style

- Comments explain **why**, never what. The reason is usually an SDK behaviour,
  a Windows detail, or a bug that came back — write that.
- Match the file you are in. Long one-line handlers are normal here.
- No new dependencies without a reason that survives being said out loud.
- Interface copy uses Claude Desktop's own words where an equivalent exists,
  and plain sentences everywhere else.
- `theme-desktop.css` grows in versioned blocks at the end
  (`/* ---------- v24: ... */`); do not reorganise the file.

## Traps that already cost a day

- **One `createSdkMcpServer` instance binds to one transport.** Build a fresh
  one per run or the second live session reports the connector as failed.
- **A message typed mid-turn must be yielded into the streaming input at once**;
  the CLI folds it in at the next tool boundary. Do not hold it until `result`.
- **`perTaskStopAffordance: true`** is what keeps a Stop from killing
  background agents. Absence fails closed.
- **`background_tasks_changed` replaces the set**; do not merge it edge by edge.
- **Tauri takes the drop instead of the page** — and `disable_drag_drop_handler()`
  does not hand it back: on macOS that leaves no drop at all, native or web. Keep
  its handler on and listen for `tauri://drag-drop`, which carries the *paths*
  (`core:event:allow-listen` in the capability, or the listener is refused). The
  file then has to be read by the shell, not the server: the window and the
  server are on different computers whenever the app is showing another one.
- **A new model needs a newer CLI, not a refresh.** Claude's catalog gives each model a
  `min_claude_code_version` (`~/.claude/cache/model-catalog/*-cc.json`), and a CLI below
  it hides the model — so `supportedModels()` answers correctly and still comes back
  short. The version that decides is the Claude Code that runs — `claudeCode.version()`,
  which `lib/models.mjs` keeps beside the cached list and treats as its expiry.
- **Claude Code can be newer than the SDK.** The SDK carries Claude Code as a native binary
  in a per-platform package (`@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`), and
  Settings › General › Claude Code fetches that package from npm at its newest version into
  `DATA_DIR/claude-code/` (`lib/claude-code.mjs`). Every `query()` spreads
  `claudeCode.spawnOptions()` — its `pathToClaudeCodeExecutable` — or it quietly runs the
  app's own, older one. The SDK's JavaScript stays as shipped and drives the newer binary.
- **A link in the page opens nothing by itself.** `target="_blank"` and `window.open`
  are ignored by the webview, so a link in a message looked broken and the address had
  to be copied. The page has to hand it to the shell — `opener.openUrl` — and that needs
  `opener:allow-open-url` in the capability, scoped to http and https. A missing
  permission and a URL outside the scope fail differently: "not allowed. Plugin not
  found" is the ACL, "Not allowed to open url …" is the scope.
- **The shell is a library, and a phone builds it too.** `src-tauri/src/lib.rs` is the
  app; `main.rs` is one line. Anything desktop-only — the tray and menu modules,
  autostart, single-instance, `unminimize`, the builder's `.decorations()`/`.shadow()` —
  has to sit behind `#[cfg(desktop)]` or the iOS and Android builds stop compiling, and
  nothing on a Windows machine will notice: the *Mobile* workflow is the only check.
- **Android release builds refuse plain http.** The generated Gradle file sets
  `usesCleartextTraffic` true for debug only, and the phone reaches the PC at
  `http://…:7777`, so a release APK opens white. `scripts/mobile.mjs` flips it after
  every `init`; `src-tauri/gen/` is not committed, so do it there, not by hand.
- **The mobile projects call the CLI back the way it was started.** Gradle's Rust step
  and Xcode's build phase run whatever `init` recorded: `npm run -- tauri` when npm
  started it, `cargo tauri` when cargo did. The first Android CI build died on
  `Missing script: "tauri"`. Keep going through `npm run tauri` (package.json fetches
  the CLI with npx — it is not a dependency, which would ship in the desktop bundle).
- **macOS blocks plain http in a web view.** A window pointed at
  `http://<ip>:7777` shows white and reports nothing; the bundle needs
  `NSAllowsArbitraryLoadsInWebContent` (`src-tauri/Info.plist`, referenced by
  `bundle.macOS.infoPlist` — which takes a path, not an inline object).
- **A `#[tauri::command]` that is not `async` runs on the main thread.** Put a
  network call in one and the window freezes — buttons stick mid-label and it
  reads as a crash. `async fn` + `spawn_blocking` for anything that waits.
- **A dead host swallows the SYN and Windows retries for ~20 s.** `ureq`'s
  per-request `.timeout()` does not shorten that; build an agent with
  `timeout_connect`.
- **The chat page is a remote origin to Tauri**, even when the server is this
  computer's: app commands answer `not allowed. Plugin not found` until they are
  listed in `src-tauri/permissions/*.toml` and a capability with a matching
  `remote.urls`. Put nothing password-bearing in that list.
- **A server the app adopted has no `Child` to wait on.** After a rebuild the
  window comes back to the server it deliberately left running, so anything that
  watches the server has to watch the port too — a handle-only watchdog makes
  Restart server a one-way trip.
- **WebView2 caches hard** — static files go out `Cache-Control: no-cache`.
- **The running app locks `target/release`**: a rebuild closes the window
  first. Never wait for "no live runs" before building — the person pressing
  Rebuild is usually mid-turn in this very app, and that waits for itself.
- **`os error 32` from tauri-build is `WebView2Loader.dll`.** On the GNU
  toolchain the build script copies it into `target/release` every time, and the
  running app — plus every `msedgewebview2.exe` it spawned, which outlive it by
  seconds — has it loaded. The error names no path, so check that file is
  writable before suspecting anything else.
- **Windows paths in heredocs**: `\U`, `\a` and friends get mangled. Write a
  file with the Write tool or a PowerShell here-string instead.
- **A preview under a path prefix breaks every client router.** Served at
  `/preview/5173/`, an app's router reads that prefix in `location.pathname` and
  draws its own "not found", however well the HTML and sockets are rewritten; and
  on the app's origin the page can read the app's token out of `localStorage`. The
  Browser serves each dev server at the root of a port of its own
  (`lib/preview.mjs`); the prefix path is only the fallback behind `tailscale serve`.
- **An upgrade's head bytes go to the other side.** In a WebSocket proxy, what the
  dev server sent right behind its 101 arrives as `upHead` — write it to the page.
  `socket.unshift(upHead)` sent it back to the dev server, and a first HMR message
  (Vite's "connected") vanished about one time in ten.
- **`getSessionMessages()` is not the history.** It starts at the last compaction and
  follows parent links, so a compacted session lost its past, and lines off that chain never
  showed: a message a second process answered, background-task notices the CLI keeps "for
  the transcript only", messages typed mid-turn (`queued_command` attachments). Desktop
  shows the transcript in file order; `lib/history.mjs` reads it that way, from the end, a
  page at a time (`/api/sessions/:id/history`), pictures as URLs. Opening a 430 MB session
  is one 150-line page.
- **Some thinking is text.** A thinking block whose signature — a protobuf, field 2 > 1 > 8
  — says `narration` is the model talking to the reader; Desktop shows it as part of the
  answer and hides the rest of the thinking. `lib/history.mjs` and `app.js` both check it.
- **The chat keeps its own scroll anchor.** An older page goes in above the reader and its
  pictures settle a frame later; browser anchoring is not in every Safari and has to be
  paused while a page is placed, which is when the pictures land. `#scroll` has
  `overflow-anchor: none` and `app.js` holds the element at the top of the view in place.
- **Claude Code rests between turns.** A run's process stays up ten minutes after its
  answer, so the next message goes straight in (on a 430 MB session: 2.6 s to the first
  word before, 0.1 s now). `live` is "the process runs"; `busy` is "at work" — a turn, a
  queued message, a background task. Whatever waits for nothing to be running (restart,
  leaving with the app, removing a worktree, the sidebar's dot) means `busy`. A resting
  process another window has written past is closed, never fed: it no longer knows the
  conversation.
- **A message's id is the page's.** The page draws its bubble under an id it made and sends
  it along; the server uses it for the `queued` and `prompt` events, and the CLI keeps it as
  the transcript line's uuid. Find a bubble by id, never by its words: matching dashed
  bubbles by text showed a message twice whenever only a background task was running.

## Git

- Branch, then a pull request. Commit subjects are lower case, no trailing
  period, and say what now happens.
- Never commit `.env`, `data/`, or anything under `src-tauri/target/`.
- Check `git status --short` and the staged diffstat before every commit: the
  file count must be the change you meant to make.
