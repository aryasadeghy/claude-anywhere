# What it does

## Sessions

- The sidebar lists every session across every project, grouped by folder,
  including the ones started in the VS Code extension or a terminal.
- **The order is yours.** A new project goes to the bottom once, a new session
  to the top of its project once, and after that only you move them: drag and
  drop on a desktop, *Move up* / *Move down* from the long-press menu on a
  phone. Nothing re-sorts because a session was written to. The order lives on
  the server, so every device sees the same one.
- Pin a session to keep it in its own group at the top.
- The row menu (right-click, or long-press on a phone) has Open, Move up/down,
  Mark as read/unread, Pin, Rename, Fork, Archive, Delete.
- **Dots.** A pulsing dot means the session is waiting for your approval; red
  means its last turn failed; blue means it finished while you were looking
  somewhere else. Opening it clears the dot, and the unread mark survives a
  restart (`data/attention.json`).

## Which computer this window shows

The window shows one machine at a time: its sessions, its files, its dev
servers, its worktrees. Which machine is a choice.

- **This computer** runs Claude here, as the app always has.
- **Another computer** points the window at a machine that is running Claude
  Anywhere — over Tailscale or your own network — and everything you do belongs
  to that machine instead.

There is no separate client application. The page always comes from whichever
server is answering, so both modes are the same app and the same code. A Mac
used only as a window onto a PC never starts a server of its own, and does not
need Node installed at all.

Computers are added from the app's own picker, which the tray opens under
*Computers…*: an address, a name, and the app password if that machine has one.
**Test** says who answered before anything is saved, because a wrong password
otherwise shows up as a login screen with no explanation. Switching is a click
in the tray, and the choice is remembered for next time.

Sessions live on the machine running the server, so this is not a merged list:
connect to the PC and you see the PC's sessions. That is the point of it.

## Files in a message

A file path written as inline code is a link: `out/clip.mp4` can be clicked, while
a bare name like `check.py` stays plain code. The separator is the whole rule — a
name on its own is being talked about, a path is being pointed at — and it is the
rule Claude Desktop follows, so the same session reads the same way in both.

Clicking a picture or a clip opens it over the page. Anything else opens in the Files
panel. A path that is only mentioned does not embed a player in the middle of the
message — media appears inline where it was actually handed over: a file sent to you,
or a picture Claude read.

## Deleting, and undoing it

Delete moves a session’s transcript to a trash folder inside the app’s data
directory and takes it out of the list. **Deleted sessions**, in the funnel menu
or the command palette, puts one back. Only *Empty the trash* removes anything
for good.

The confirmation names the sessions it is about to take and says how many
projects they span, and a Shift+click range stays inside the group it started
in, because the quiet way to delete far more than you meant is a range that
crossed a project boundary without saying so.

## Reading and continuing

- Open a session to read it: text, thinking, tool calls with input and result,
  images and video the assistant produced.
- Send a message to continue it; the reply streams. It is the same session on
  disk, so `claude --resume` in a terminal picks it up afterwards.
- A turn keeps running when the phone screen goes off. Reopening the chat
  replays what was missed.
- **Rewind to here** under any earlier message of yours: a new session that is
  this one up to just before that message, with the message back in the
  composer to change and send again. The original is untouched.

## When Claude asks you something

Some tools ask rather than act. `AskUserQuestion` is one, and it arrives through the
same channel as a permission request, so it used to appear as "Claude wants to use
AskUserQuestion" with nothing to read and an Allow button.

It is now shown as what it is: the question, each option with its description as a
button, and a box underneath for an answer that is not on the list. Several questions
at once and multi-select both work. **Skip** declines the question. What you choose
travels back on the tool’s own `answers` field, so Claude receives the answer rather
than mere permission to ask.

Once you answer, the card collapses to the question and your answer. Leaving the
options up invites a second answer that nothing is listening for.

## While Claude works

- A status line under the last message says what is happening ("Thinking…",
  "Running Bash…", "Waiting for your approval"), with seconds elapsed and
  output tokens. Thinking streams live and collapses to "Thought for 4s".
- **Messages typed mid-turn are handed over at once** and Claude reads them
  after the current step, at the next tool boundary — not after the whole turn.
  The bubble stays dashed until the turn takes it up.
- Permission mode (Manual / Accept edits / Plan / Auto / Bypass), model and
  effort can all be changed mid-turn. Shift+Tab cycles the mode like the CLI,
  1–5 pick one directly.
- Permission prompts appear as a card with **Allow**, **Allow always** and
  **Deny**, answerable from the phone.
- The composer's stop button ends the turn. Background work is not killed by
  it — each task has its own Stop.

## Tasks

Every command, subagent and workflow a turn runs is a task. A bar above the
composer says how many are running; it opens a panel on the right, or a
full-screen sheet on a phone:

- what it is (Command, Agent · explore, Workflow · spec), how long it has run,
  tool uses and tokens for agents, and a one-line progress summary;
- its **live output**, tailed while it runs;
- its own **Stop**;
- **Run in background** on a foreground command or agent — the CLI's Ctrl+B —
  so Claude carries on without waiting for it.

The session's process stays alive until background work finishes, and each
finished task stays listed with its result until you clear it.

## Changes

The `+n −m` in the bar above the composer (and *Changes* in the session menu)
opens a panel listing every file that differs from `HEAD` in the session's
folder — modified, added, deleted, renamed — with per-file line counts. Tap a
file for its diff with old and new line numbers; untracked files show as fully
added. It refreshes when a turn ends.

## Preview

*Preview* in the session menu shows whatever the project's dev server is
serving, inside the app — and therefore on your phone, which cannot reach the
PC's localhost by itself.

It behaves like a browser: back, forward, reload, home, and an address bar you
can type into. `5173`, `localhost:5173`, `localhost:5173/settings` and a bare
`/deep/page` all work, and the bar follows along as you click through the page.

- **The list only offers things that serve a page.** A listening port is not a
  web server — a normal Windows machine has thirty of them, and offering that
  list meant the panel opened on a GPU monitor. Each candidate is asked once
  whether it speaks HTTP, and what comes back is grouped into the servers behind
  your projects and the other pages on the machine, each labelled with the
  page's own title: "localhost:5173 — Vite + React". Everything else is behind
  *Show everything listening*.
- Everything is proxied through the app's own origin, so a page that sets
  `X-Frame-Options` still appears. Pages are rewritten on the way through so
  that links, forms, assets, `history.pushState` and the hot-reload socket all
  stay inside the preview instead of landing back on this app.
- The arrow at the top right opens the same page in a full tab.
- Localhost only, by construction: the proxy takes a port, and the host is
  always `127.0.0.1`. Type anything that is not this machine and it says so
  rather than fetching it. It is a window onto what is already running on your
  machine, never a way to browse the internet through it.
- **One limit worth knowing.** Pages live under `/preview/<port>/`, and a
  finished single-page app whose router reads the path for itself can answer
  with its own "page not found". The menu offers to open that server directly
  instead, which works on the computer itself.

## Watching your other windows

Open a session that VS Code, a terminal or Claude Desktop is working on and the
app follows its transcript file: each finished block appears as the other
window writes it, the header says "Working in another window", and the composer
stays locked until that turn ends. Sessions written to in the last 45 seconds
carry a dot.

> Do not *continue* a session from here while it is mid-turn somewhere else —
> two processes would append to the same transcript. Reading is always safe.

## Starting a project in a new folder

The folder chip on a new session opens a picker. Typing a path that does not
exist yet offers to create it, and **New folder** makes one inside the folder
you are looking at, so the folder for a new project can be made here rather than
somewhere else first.

## Accounts

Two accounts, switchable at any time from the bottom of the sidebar:

- **This computer's login** — whatever `claude login` signed into.
- **A token** — from `claude setup-token`, or a Console API key, pasted into
  the app. It is proven with one small request and then kept in
  `data/auth.json`. Remove it from the same dialog.

Whatever you send is billed to the active account; the sessions stay on this
computer either way. Plan usage (5-hour and weekly) is shown for an account
signed in on this machine; a `setup-token` account cannot read it, because that
token is not allowed to.

## Connectors and plugins

The **+** menu in the composer opens *Connectors & plugins*: the MCP servers
from this computer's Claude Code config (user, project and `.mcp.json`) with a
switch each — off applies to the next turn, or immediately in a running one —
and the plugins from `~/.claude/settings.json`.

## The native window

The app is a small Tauri (Rust) shell on the webview the machine already has —
WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux: a few megabytes,
light on memory. It starts the same Node server inside itself, opens the chat
already signed in, lives in the tray (closing the window hides it), can start
with the machine, and raises a system notification when Claude asks for a
permission or finishes a turn while the window is not in front.

On Windows it has **no title bar**. The page draws its own: the header row and
the top of the sidebar drag the window, double-clicking maximises, and minimise,
maximise and close sit at the top right. macOS and Linux keep their own title
bar, because a Mac without its traffic lights in the usual place is a Mac nobody
can close. In a browser none of those buttons appear.

*Rebuild app* is Windows-only, because the script that does it knows how the
Windows app locks its own files; elsewhere the button is not shown and the way
to rebuild is `npx tauri build`.

Its settings live in `%APPDATA%\com.arya.claude-anywhere\.env` (on macOS
`~/Library/Application Support/com.arya.claude-anywhere/.env`), its data (pins,
order, attention marks, an optional token) next to them. Point
`CLAUDE_ANYWHERE_SERVER_DIR` at a checkout and the app serves that working copy,
which is what makes the next section work.

## Updating without going to the PC

From *Connectors & plugins* → **App**:

- **Restart server** reloads `server.mjs`, `lib/` and `public/` from the
  checkout and reloads the window. It refuses while Claude is mid-turn, since
  that would kill the turn.
- **Rebuild app** is for changes to the Rust shell. It closes the window,
  runs `cargo tauri build` (1–3 minutes) and opens it again; the log streams
  into the panel. The chat does not stop — the server is a separate process, so
  a turn in flight keeps running and the phone keeps working.

A banner appears by itself when the files on disk are newer than what is
running, and says which one you need.

## Finding things

The magnifier filters the list by title as you type. **Search inside** also asks
the server to read the transcripts themselves — every session on this computer,
newest first, under a time budget. Matching sessions grow a second line with the
number of hits and the first one in context, and the note says if the oldest
transcripts were not reached before the budget ran out.

The funnel next to it groups the list by **project** (your own dragged order,
the default), by **date** (today, yesterday, previous 7 and 30 days, then by
month) or by **activity** (needs input, working, failed, unread, archived,
idle); sorts manually, by most recent, or by name; and shows archived sessions
alongside the rest, dimmed. Drag-and-drop belongs to the manual project order,
so it is switched off in the other views rather than quietly doing nothing.

## Files

The session menu opens a read-only browser of the folder Claude is working in:
folders, files with their sizes, text shown as text and images as images. The
server only opens paths inside a folder some session has worked in, plus the
worktrees this app made and the temp folder, so the panel cannot wander off into
the rest of the disk.

## Worktrees

A worktree is a second checkout of the same repository on its own branch.
**Worktrees…** in the session menu lists what git knows about, starts a new
session in any of them, and makes new ones: give a branch name and the checkout
appears *beside* the repository, in `<repo>-worktrees/<branch>`, never inside it.
Removing one leaves the branch alone, and refuses while a turn is running there.

## The pull request

When the session's branch has a pull request, the bar above the composer shows
it: its number, whether the checks pass, whether a review asked for changes, and
whether auto-merge is on. Red beats amber beats green, so what needs a person is
what you see. Opening the chip lists the failing checks — each one a link to its
run — the latest review comments, and a switch for *merge when the checks pass*.

All of it comes from the `gh` CLI that is already signed in on this machine. The
app holds no GitHub token and makes no request of its own.

## Keep this computer awake

Off, **while Claude is working**, or always. The middle one is the useful one: a
long turn started from your phone does not die because the PC went to sleep, and
the machine is free to sleep the moment the turn ends. It holds a system request
while it is on — `SetThreadExecutionState` on Windows, `caffeinate` on macOS,
`systemd-inhibit` on Linux — and nothing in your own power settings is touched.

## Commands and shortcuts

**Ctrl/Cmd+K** opens everything this app can do, by name, along with the sessions
themselves, so the same box both runs a thing and goes to a chat. Typing the
actual word wins over scattered letters, and scattered letters still work:
`gsd` finds *Group sessions by date*.

| | |
|---|---|
| Ctrl/Cmd+K | Commands |
| Ctrl/Cmd+F | Search sessions |
| Ctrl/Cmd+B | Show or hide the list |
| Ctrl/Cmd+N | New session |
| Shift+Tab | Next permission mode |
| Escape | Close the menu, clear a selection |

## Not there yet

Honest gaps against Claude Desktop's Code tab, roughly in the order they are
worth doing:

- Fast mode.
- Preview tools for Claude itself: reading the previewed page's console,
  network errors and DOM, the way Claude Desktop's `preview_*` tools do.
- A terminal pane, and split view.
- Signed macOS and Linux builds. They are built and they run; until someone
  pays Apple, the first launch needs right-click → Open.

And one that is further out than the rest: **other providers** — adding an
OpenAI or Google account next to your Claude one and continuing the same
session on GPT or Gemini. The transcript and the tool protocol are Claude
Code's, so it needs a translation layer; see the roadmap in the README.
