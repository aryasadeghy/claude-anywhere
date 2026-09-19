# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — while the major is
0, a minor bump may change behaviour.

## [Unreleased]

### Fixed

- **An answered question stops being a form.** The options stayed on screen and
  stayed clickable after you had answered, so the card looked like it had not
  taken. It collapses now: the question, what you chose underneath it, and nothing
  left to press. Answering from another device collapses it here too.
- **Opening a session lands at the end of the chat, not in the middle of it.** The
  bars under the thread arrive after it is drawn — the branch, a running task, the
  update banner — and each one shrinks the window without moving the scroll, which
  on a phone left the last messages 180 to 240 pixels below the fold. The view now
  stays pinned while the page settles, and lets go the moment you scroll away.
- **A question from Claude is a question, not a permission.** `AskUserQuestion`
  arrived as a bare "Claude wants to use AskUserQuestion" with "(no summary)" and
  an Allow button, which meant answering something you were never shown. The card
  now carries the question, its options with their descriptions, and a box for an
  answer that is not on the list; what you pick rides back on the tool’s own
  `answers` field. Multiple questions and multi-select are handled, and the same
  request arriving twice after a reconnect no longer draws two cards.
- **A transcript reads the same here as it does in Claude Desktop.** A file path
  written as inline code is now a link you can click, and a bare file name stays
  plain code: Desktop links `out/clip.mp4` and leaves `check.py` alone, and the
  separator is all there is to the rule. Clicking a picture or a clip opens it
  over the page; anything else opens in the Files panel. A path merely mentioned
  no longer grows a video player underneath the message — which is what made the
  same session look so different in the two apps — and the harness’s own task
  notices are hidden here as they are there.

## [0.4.0] — 2026-09-19

### Added

- **Releases are cut and built on GitHub.** Actions → *Cut a release* takes a
  version, sets it everywhere, moves the changelog under it, tags and pushes;
  the tag builds Windows, both Macs and Linux into one draft whose notes are
  that version’s changelog section. Nothing is published from a laptop.
- **One app, either computer.** The window shows one machine at a time, and which
  one is now a choice: run Claude on this computer, or point the window at
  another that is running Claude Anywhere and drive that one instead. Its
  sessions, its files, its dev servers, its worktrees. There is no separate
  client: the page always comes from the machine that is answering, so a Mac
  used only as a window onto a PC never starts a server and does not need Node.
  Computers are added in the app, switched from the tray, and remembered.
- **Deleting a session puts it aside instead of destroying it.** The transcript
  moves to a trash folder and *Deleted sessions* in the funnel menu puts it back;
  only emptying the trash removes anything. The confirmation now names what is
  about to go and which projects it spans, and a Shift+click range stays inside
  the project it started in rather than sweeping across all of them.
- **Make a folder from the folder picker.** Typing a path that is not there yet
  offers to create it, and a *New folder* button makes one inside the folder you
  are looking at, so starting a new project no longer means creating its folder
  somewhere else first.
- **Several sessions at once.** Shift+click picks a range in the sidebar,
  Ctrl/Cmd+click adds or removes one, and on the phone "Select" in the
  long-press menu turns taps into picks. A bar above the list pins, archives or
  deletes them together (Delete asks once), the right-click menu on a picked row
  acts on all of them, and dragging one picked row moves the whole block within
  its project. Escape clears the pick.
- **Group, sort and filter the session list.** The funnel in the sidebar groups
  by project (your own dragged order, still the default), by date, or by
  activity; sorts manually, by most recent or by name; and can show archived
  sessions alongside the rest. Drag-and-drop belongs to the manual project
  order, so it switches off in the other views instead of quietly doing nothing.
- **Search inside transcripts.** The magnifier still filters titles as you type;
  **Search inside** also reads every transcript on this computer, newest first,
  under a time budget, and says if it ran out of time before the oldest ones.
  Matching sessions show the number of hits and the first one in context.
- **A file browser.** The session menu opens the folder Claude is working in:
  folders, files with sizes, text as text and images as images. Read-only, and
  only inside a folder some session has worked in.
- **Per-session git worktrees.** Make a second checkout of the repository on its
  own branch, beside the repository rather than inside it, and start a session
  there. Removing one leaves the branch alone and refuses while a turn is
  running in it.
- **The pull request for this branch, watched.** Its number, whether the checks
  pass, whether a review asked for changes, whether auto-merge is on — with the
  failing checks each linked to their run, the latest review comments, and a
  switch for *merge when the checks pass*. All of it from the `gh` CLI already
  signed in on this machine; the app holds no GitHub token.
- **Keep this computer awake**, off, while Claude is working, or always. The
  middle one means a long turn started from your phone does not die because the
  PC went to sleep, and the machine sleeps again the moment the turn ends.
- **A command palette and shortcuts.** Ctrl/Cmd+K lists everything the app can
  do, and the sessions themselves, so one box both runs a thing and goes to a
  chat. Ctrl/Cmd+F searches, Ctrl/Cmd+B shows or hides the list, Ctrl/Cmd+N
  starts a session.
- **macOS and Linux builds of the native window.** The shell finds Node where
  those machines actually keep it, keeps the system title bar instead of drawing
  its own, and is built and released for both alongside Windows. They are not
  signed yet, so the first launch needs right-click → Open.
- **The sidebar and the right-hand panels can be dragged wider or narrower.**
  A handle on the sidebar's inner edge and on the inner edge of the Tasks,
  Changes and Preview panels; double-click puts the default back. Remembered
  per device. The phone layout is unchanged.
- **Preview panel.** Whatever the project's dev server is serving, shown inside
  the app and therefore on your phone, which cannot reach the PC's localhost by
  itself. Ports are discovered with the process behind them; everything is
  proxied through the app's own origin so relative and absolute URLs, redirects
  and the hot-reload socket keep working, and frame-busting headers are dropped.
  Localhost only, by construction.

### Fixed

- **The preview panel is a browser now, and its list is useful.** Its server
  picker was a menu that opened upward from the very top of the window, so it
  was drawn off-screen and could not be read at all; and it listed every
  listening port on the machine, which on Windows is thirty of them, so it
  opened on a GPU monitor's web interface instead of the project. Each port is
  now asked once whether it actually serves a page, and the ones that do are
  grouped into the servers behind your projects and the other pages on the
  machine, each labelled with the page's own title. In place of the port chip
  and path box there is a browser bar: back, forward, reload, home and an
  address you can type into.
- **Links inside a previewed page stay in the preview.** A page served at
  `/preview/5173/` that linked to `/about` navigated the frame to this app's
  own `/about`, and the hop after that had nothing left to go on, so the panel
  filled with the app itself. Pages are now rewritten as they pass through:
  links, forms, assets, `history.pushState` and the hot-reload socket all keep
  the preview in front of them. A page that asked for no referer, which used to
  come back blank because its scripts were answered with this app's HTML, works
  too.
- **Opening two sessions in a row could show one under the other's name.**
  Opening a session fetches and renders its whole transcript, which takes
  seconds for a big one; opening another before that finished let the slow one
  land last, so the header, the messages and the live stream belonged to the
  first session while the sidebar and the address bar said the second, and a
  message typed there went to the second. A load now gives up as soon as a newer
  open has started, and a stream never writes into another session's thread.
- **The session list no longer jumps to the top** every time it refreshes.
- **Images in a session open full size again.** They called `window.open`,
  which does nothing inside the app's WebView, so tapping one left it sitting
  there; markdown images had no handler at all. All of them now open in a
  lightbox that scales a small image up to fit (never past 3x), shows it at its
  own size on a second tap, and closes on Escape or a tap outside.
- **The app's own `PORT` no longer leaks into what Claude runs.** A session that
  started a dev server inherited `PORT=7777` and `HOST=0.0.0.0` from the app, so
  the project's dev server took the app's port while the app was closed for a
  rebuild — and the phone's bookmark stopped working. Our variables are stripped
  from the environment Claude Code is given.
- **Rebuild app could never finish, and the reason had no name.** On the GNU
  toolchain tauri-build copies `WebView2Loader.dll` into `target/release` on
  every build; the running app has that DLL loaded, and so does every
  `msedgewebview2.exe` it spawned, which outlive their host by a few seconds.
  Overwriting a loaded DLL is `os error 32`, which tauri-build reports without
  a path — so every build after closing the window failed on a file nobody
  could identify. The rebuild now waits for that file to be writable, and ends
  the leftover webview processes if they are the ones still holding it.
- **A build that worked was announced as a failure.** `Start-Process -PassThru`
  leaves `ExitCode` empty until the process has been waited on, so the script
  read nothing and assumed the worst — while the installer it had just produced
  sat on disk.
- **Rebuild app never started anything.** The server spawned its script with
  `detached: true`, and a detached PowerShell child on Windows gets no console
  and exits immediately, silently — so the panel sat on an empty log, which the
  client rendered as "Waiting…". It is now started through a short-lived
  launcher that hands the script to `Start-Process`, so it both starts and
  outlives the window it closes.
- The App panel says when a rebuild log is from, instead of showing a finished
  log from an hour ago as if it had just happened.
- **Rebuild now waits for the window to actually exit** before compiling, and
  starts whatever binary the build produced instead of a hard-coded name — the
  rename made that name wrong, so a failed build left no window at all. A build
  that fails on a locked file (os error 32, a leftover from the compile before
  it) clears that crate's build directory and goes again once.
- **Restart server queues instead of refusing** while Claude is working: the
  server exits the moment the last turn ends and the window reloads itself. It
  used to answer 409 and leave the update banner up with nothing to press.
- The page retries for 45 seconds while the server is coming back, instead of
  showing "fetch failed" until the whole app was closed and reopened.

## [0.3.0] — 2026-09-18

First public release. The project is called **Claude Anywhere** from this
version; it was `claude-remote` while it was a personal tool. An installation
from before the rename keeps working: the server still accepts the old
`CLAUDE_REMOTE_*` variables and the token they produced, and the app copies its
settings across.

### Added

- **Tasks panel.** Every command, subagent and workflow a turn runs is listed
  with its elapsed time, tool uses, tokens, live output and its own Stop. A
  foreground task can be sent to the background (the CLI's Ctrl+B), and the
  session's process stays alive until background work finishes.
- **Changes panel.** Every file that differs from `HEAD` in the session's
  folder, with per-file counts and a diff with old and new line numbers.
- **Rewind to here** on any earlier message: a fork of the session up to just
  before it, with that message back in the composer.
- **Attention dots** in the sidebar — waiting for approval, failed, or finished
  while you were elsewhere — with *Mark as read* / *Mark as unread*. The unread
  mark survives a restart.
- **A sidebar order that stays put**, changed only by drag and drop (or *Move
  up* / *Move down* on a phone) and shared across devices.
- **The app's own title bar**: no Windows frame, minimise / maximise / close
  drawn by the page, the header row drags the window.

### Changed

- A message typed while Claude works is handed to Claude Code immediately, so
  it is read at the next tool boundary instead of after the whole turn.
- Connectors and plugins moved from the header into the composer's **+** menu,
  where Claude Desktop keeps them.
- *Rebuild app* closes the window, compiles, and opens it again, instead of
  waiting for Claude to be idle first — which never happened when the person
  pressing the button was mid-turn in the app itself. The chat keeps running
  throughout, because the server is a separate process.

### Fixed

- The in-process MCP server is built per run; sharing one instance made the
  second live session report the `claude-anywhere` connector as failed.
- Static files are served `Cache-Control: no-cache`; WebView2 was serving the
  page it first loaded, so restarts looked like they had done nothing.
- Opening a session created a second earlier returned 404 before its transcript
  existed on disk.
- Header icons no longer stack when the window is narrow.
- Untracked files counted one line too many in the diff totals.

## [0.2.0] — 2026-09-17

### Added

- Native Windows shell (Tauri 2 + WebView2) replacing an Electron prototype:
  tray icon, start with Windows, system notifications, a phone-connection
  dialog.
- Account switching between this computer's `claude login` and a pasted token.
- Connectors & plugins panel with per-server switches, and plan usage.
- Model, permission mode and effort remembered per session and changeable
  mid-turn.
- Update banner with *Restart server* and *Rebuild app*, both usable from a
  phone.
- Images: attach, paste and drop; media in answers plays inline; `SendUserFile`
  cards.
- Phone layout: one-row top bar, long-press menus as sheets, Add to Home
  Screen.

### Fixed

- Restarts no longer kill a running turn: a busy server stays up and the next
  app instance adopts it.

## [0.1.0] — 2026-09-17

- First working version: list, read and continue local Claude Code sessions
  from a browser, with live streaming, permission prompts and a new-session
  flow.

[Unreleased]: https://github.com/aryasadeghy/claude-anywhere/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/aryasadeghy/claude-anywhere/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/aryasadeghy/claude-anywhere/releases/tag/v0.3.0
[0.2.0]: https://github.com/aryasadeghy/claude-anywhere/releases/tag/v0.2.0
[0.1.0]: https://github.com/aryasadeghy/claude-anywhere/releases/tag/v0.1.0
