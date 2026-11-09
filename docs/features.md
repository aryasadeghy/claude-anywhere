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

## The account row, and Settings

The foot of the sidebar is one line — avatar, your name, the account answering, a
chevron — and it opens a menu, the way Claude Desktop's does: **Settings…**,
*Which computer…*, *Connectors & plugins…*, *Switch Claude account…*, *Keep this
computer awake*, *Check for updates*, *About*.

Behind it is one **Settings** window with its sections down the left: *General*
(keep-awake, and what version this is with a Check now), *Account*, *Computers*,
*Connectors*, *About* (version, commit, platform, which computer, where its
sessions live, and the addresses it answers on). Those middle three used to be
three separate dialogs opened from three different places — the same things, in
one place you can find twice.

Searching the list and choosing how it is grouped moved out of the strip at the
top of the sidebar and onto the project rows, where Claude Desktop keeps them:
hover a project and it offers **+** (a session in that folder), search, and the
group/sort/filter menu, which opens under that row. On a phone, where there is
nothing to hover, the strip at the top still carries both.

## Files in a message

A file path written as inline code is a link: `out/clip.mp4` can be clicked, while
a bare name like `check.py` stays plain code. The separator is the whole rule — a
name on its own is being talked about, a path is being pointed at — and it is the
rule Claude Desktop follows, so the same session reads the same way in both.

Clicking a picture or a clip opens it over the page. Anything else opens in the Files
panel. A path that is only mentioned does not embed a player in the middle of the
message — media appears inline where it was actually handed over: a file sent to you,
or a picture Claude read.

Going the other way, a file reaches Claude by the **+** button, by pasting it, or by
dropping it on the window — up to ten at a time, 25 MB each. In the native app the
drop is the window's own, not the page's: it arrives as a path and the app reads it
from the computer you dropped it on. That is what makes dropping a screenshot on the
Mac work while the session it joins is running on the PC. A folder is declined by
name rather than ignored.

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
at once and multi-select both work. **Skip** leaves it unanswered — Claude is told it was
skipped, not refused, and goes on — and writing in the chat while it is open answers it there. What you choose
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
- **Effort is a chip beside the model**, as it is in Claude: press it and a slider runs
  from *Faster* to *Smarter* — Low, Medium, **High** (the default), Extra, Max, and
  **Ultracode** at the top for a model that takes Extra, which is xhigh effort plus
  standing workflow orchestration. Drag it, click a stop, or use the arrow keys; the knob
  travels and the name follows. A model with no effort levels has no chip.
- **The model menu is the CLI's own.** The list, the names, the descriptions and
  the prices come from `supportedModels()` — whatever Claude Code offers this
  account, including the *Default (recommended)* row and the 1M-context ones — so
  it cannot drift from Claude. The effort levels above come from the same answer, so
  switching to a model that does not take the level you had picked puts it back to the
  default rather than sending one that model has never heard of.
- **A new model arrives on its own.** The list is asked again when it is an hour old,
  when you open the menu, and whenever the Claude Code the app carries changes — that
  last one is what actually matters. A model's entry in Claude's catalog names a
  `min_claude_code_version`, and a CLI below it hides the model however often the list
  is refreshed: Opus 5.5 wanted 2.1.280, so an app carrying 2.1.274 had a menu that was
  correct, current, and a model short. The foot of the menu says when Claude Code last
  answered and has a **Refresh** that asks again while you watch, and a daily job opens
  a pull request whenever the package that carries the CLI moves — so the app catches
  up without anyone having to notice it was behind.
- **Fast mode** is a switch at the foot of the model menu, for a model that offers it
  (Opus 5.5): the same intelligence with significantly faster output, billed via usage
  credits. The chip says *Fast* while it is on. When Claude Code cannot serve it - no usage
  credits, a provider in between, an organisation that has it off - the chat says why.
- Permission prompts appear as a card with **Allow**, **Allow always** and
  **Deny**, answerable from the phone.
- The composer's stop button ends the turn. Background work is not killed by
  it — each task has its own Stop. A message typed mid-turn that Claude had not read yet
  comes back into the box rather than running after the Stop.

## The message box

- **`/` commands.** Typing `/` at the start opens Claude Code's own commands for this folder
  (skills and plugins included) and the app's: `/rename`, `/usage`, `/model`, `/mcp`, `/resume`,
  `/rewind`. Arrows and Enter pick one.
- **`@` files.** Typing `@` searches the project's files by name, dotfiles too, and inserts
  the path Claude Code understands.
- **`!` shell commands.** A message that starts with `!` runs in the session's folder (in the
  terminal pane when it is open); its output goes with your next message.
- **Attach as context.** Text selected in the conversation, a file, lines of a file, a diff
  line or a terminal selection become a chip above the box, sent quoted with the next message.
  Hover a chip to read what it carries.
- **Pictures**: up to 20 a message, Ctrl/Cmd+U to pick files, and a click on a staged picture
  opens an editor to draw on it before it goes.
- **Dictation** with the microphone, where the browser offers speech recognition.
- **Queued messages** have *Edit in composer*, *Send now* and *Remove*, and drag into another
  order. A message sent when the plan's limit is reached waits above the box and goes by
  itself when the limit resets.

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

## Which computer

One computer answers the window at a time: its sessions, its files, its previews,
its Claude account. So the window says which one — the bottom of the sidebar names
the machine that is answering (`Work PC · BIG-PC`), and a chip appears beside the
session title whenever that machine is not this one. A project called
`claude-remote` exists on both of your computers; the name above the list is what
tells them apart.

Clicking either opens **Settings → Computers**: every computer you have added, with its
host name, the Claude account it is signed in with, how many turns are running on
it, and **Open** to point the window there. One that is switched off says *Not
answering* instead of vanishing. *Add or edit computers…* is the picker that holds
the list, and adding one starts with this computer's app password already filled
in — one password, typed once.

The row for the computer that is answering also shows **where to reach it from
another device**: the Tailscale address first (it works from anywhere), then the
one on this network, with a virtual adapter dimmed because nothing else can reach
it. Click an address to copy it — that is what you type on the phone or the Mac. If
the server is listening on this machine only, it says so instead of offering
addresses that cannot work; if there is no app password, it says that too.

Pointing the window at a computer never leaves you with a blank one. The shell asks
that machine whether it is there before it moves, and says so if it is not; if the
address answers but the page never arrives, the window returns to this list after
fifteen seconds with the reason. On macOS the bundle carries an App Transport
Security exception for web content, because a computer of your own, named by IP,
cannot have a certificate — without it the window simply showed white.

The list belongs to the device you are sitting at, not to any server, so it lives
in the app. A browser talks to exactly one computer, the one that served the page,
and says so. The page may ask the shell which computers exist and to switch to one;
it may not read their passwords (`src-tauri/permissions/computers.toml`).

## Accounts

Three accounts **on the computer that is answering**, switchable at any time from
*Settings → Account* — the pane names the machine, because from a Mac driving the
PC "this computer" is the PC:

- **This computer's login** — whatever `claude login` signed into.
- **A token** — from `claude setup-token`, or a Console API key, pasted into
  the app. It is proven with one small request and then kept in
  `data/auth.json`. Remove it from the same pane.
- **Another provider** — an address and a key: a gateway, a reseller, your
  company's own proxy. Claude Code speaks the Anthropic Messages API and reads
  `ANTHROPIC_BASE_URL`, so a provider is a URL rather than a second kind of
  program, and switching to it is the same click as switching to a token.

  The form asks for the address, the key, whether that key rides as
  `Authorization: Bearer` or `x-api-key` (a gateway that *forwards* to Anthropic
  usually wants the first, one that *impersonates* the API wants the second), and
  optionally the model id that provider uses — which becomes `ANTHROPIC_MODEL`,
  because a provider names its models its own way.

  It is proven the same way a token is: one tiny turn before it is saved, and
  whatever the endpoint says back is what you see. An endpoint that speaks only
  OpenAI's API answers with its own complaint, which is the honest answer to
  "can I use this here?" — Claude Code sends `/v1/messages`, so it needs an
  Anthropic-shaped endpoint, not merely a provider that hosts Claude models.

Whatever you send is billed to the active account; the sessions stay on this
computer either way. Plan usage (5-hour and weekly) is shown for an account
signed in on this machine; a `setup-token` account cannot read it, because that
token is not allowed to.

## Connectors and plugins

The **+** menu in the composer opens *Settings → Connectors*: the MCP servers
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

From *Settings → Connectors* → **App**:

- **Restart server** reloads `server.mjs`, `lib/` and `public/` from the
  checkout and reloads the window. Mid-turn it waits: the restart is queued and
  happens the moment the turn ends, so nothing in flight is lost. It works
  whether the app started that server or adopted the one a rebuild left running.
- **Rebuild app** is for changes to the Rust shell, **when the window is the
  build in this checkout**. It closes the window, runs `cargo tauri build` (1–3
  minutes) and opens it again; the log streams into the panel. The chat does not
  stop — the server is a separate process, so a turn in flight keeps running and
  the phone keeps working.

A banner appears by itself when the files on disk are newer than what is
running, and says which one you need.

**An installed app is not rebuilt, it is replaced.** `cargo tauri build` compiles
into `src-tauri/target` and starts what it finds there, so pressing Rebuild while
a release is running spends three minutes and changes nothing you can see — the
second binary starts and single-instance closes it again. So the button is only
offered when the running window *is* the checkout's build; otherwise the panel
says plainly that shell changes arrive in the next release, and **Update
DESKTOP-…** below it is the button that does something. That is the ordinary
path: merge, CI builds and publishes, the app offers it within the hour.

## New versions

The **App** row is the About box: the version, the commit it was built from, when
it was built, and how long the server has been up. A packaged app has no checkout
to ask, so the shell carries its own version and commit — compiled in by the build
that made it.

The server asks GitHub whether the [latest release][releases] is newer — when the app
opens, when you ask it to, and otherwise at most every five minutes — and a banner offers
it. An hour was the first interval and it was wrong by exactly the width of the problem: a
merge publishes in about eight minutes, so a check landing five minutes early said "up to
date" for another fifty-five. *Check for updates* is in the command palette and in the
tray menu, where it answers with a notification whether the window is open or not. Nothing is sent anywhere; it is one
unauthenticated read of a public page, cached for every device pointed at this
server, and `CLAUDE_ANYWHERE_UPDATE_CHECK=off` in `.env` stops it asking at all.

**Two apps can be out of date at once**, and they are different files on
different machines: the app in your hands, and the app on the computer this
window is showing. From the Mac driving the PC, a single *Download* button used
to hand you the PC's Windows installer. So there are two offers, and the panel
shows whichever apply:

- **Download for this Mac · 101 MB** — the file for the device you are holding,
  chosen from the release's own assets by what this device is. A phone gets no
  such button, because there is nothing there to install.
- **Update DESKTOP-JAG2O5O** — that computer downloads its own installer, closes
  its window, installs and opens again, with the progress in the panel. It waits for the
  binary on disk to actually change before starting it: the installer hands off to a
  second stage and returns, and starting the app on that signal opened a half-written file
  that died immediately, leaving no window at all. It is the
  half you cannot do by tapping Download on a phone, and it is refused while
  Claude is working, because the app has to close to be replaced. Windows only so
  far; elsewhere it says to open the file on that machine.

Installing is never automatic. Replacing the app under a turn in flight is not
something to do behind your back.

Releases themselves are built by GitHub, never from a laptop: merging to `main`
runs CI, and a green run cuts the version, tags it, builds Windows, macOS and
Linux, and publishes them. [How that works](../CONTRIBUTING.md#releases).

[releases]: https://github.com/aryasadeghy/claude-anywhere/releases

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

The Files pane is the folder Claude is working in as a tree beside tabs: fuzzy find by name,
`?` to search what the files say, Ctrl/Cmd+F inside a file. Files open editable, with auto save
(off in the pane's menu); a save never overwrites a file that changed on disk meanwhile. A + by
a line, or a selection, adds a comment that goes with your next message. Markdown, tables,
PDFs, Word, Excel and PowerPoint files preview; an open file follows Claude's edits. The
right-click menu has Copy path, Attach as context, Open in terminal and Open in editor, and a
`#L5-L20` link in an answer opens its file at those lines. Earlier, the pane was a read-only
browser: folders, files with their sizes, text shown as text and images as images. The
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

## Terminal

Ctrl+` (or the session menu) opens a terminal pane in the session's folder, on the computer
that runs Claude: several tabs, a dot while a command runs, a question before closing one that
is busy, *Restart* for a shell that died, Minimize, and Copy, Paste and *Attach selection as
context* on right-click. Claude can open a tab itself and run a command in it — that one asks
first, like any command.

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

These are being built for the next release:

- Git from the app (commit and push, draft PRs, Auto-fix), routines, `/btw` side chats,
  nested sessions, split view and windows of their own, the session rail, sidebar sections,
  storage, phone notifications, Claude's own Browser tools, SSH/WSL environments.

And still open:

- Signed macOS and Linux builds. They are built and they run; until someone
  pays Apple, the first launch needs right-click → Open.

And one that is deliberately not built: **a model that is not Claude**. Another
*provider* works today — anything that answers the Anthropic Messages API, see
Accounts above — but GPT or Gemini answering the same session would need a
translating bridge in the server, rewriting every request and every stream
between the two APIs. Claude Code's prompts lean hard on tool calls, a model
that is weak at those loops instead of working, and a half-working translator
is worse than an honest refusal. A proxy that already does the translating
(LiteLLM, claude-code-router) can be added as a provider like any other.
