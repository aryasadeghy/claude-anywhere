// Claude Anywhere — native shell (Tauri 2: WebView2 on Windows, WKWebView on macOS and
// iOS, WebKitGTK on Linux, the system WebView on Android).
//
// It starts the Node server that talks to the Claude Agent SDK, opens the chat
// in a native window already signed in, lives in the tray, can start with the
// machine, and turns permission requests / finished turns into system
// notifications. The phone keeps talking to the same server.

// On a phone this is only the window onto another computer: the Node server, the tray,
// start-at-login and the update installer below are desktop things that a phone build
// compiles but never calls. Gating every one of them would bury the desktop code in
// attributes, so the phone build is told not to mind instead.
#![cfg_attr(
    mobile,
    allow(dead_code, unused_imports, unused_variables, unreachable_code)
)]

use std::{
    fs,
    io::{BufRead, BufReader},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};
#[cfg(desktop)]
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
#[cfg(desktop)]
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

struct ServerState {
    child: Mutex<Option<Child>>,
    port: u16,
    token: String,
    env_file: PathBuf,
    spawn: Option<SpawnCfg>, // how to start the server again (None when we adopted a running one)
}

#[derive(Clone)]
struct SpawnCfg {
    node: PathBuf,
    root: PathBuf,
    data_dir: PathBuf,
    env_file: PathBuf,
    port: u16,
}

// The server exits with this code when the app asked it to restart (POST /api/restart):
// picks up new server code from the repo without touching the window.
const RESTART_CODE: i32 = 75;

// ---------- which computer this window is looking at ----------
// The window always shows a server, and the client it shows is the one that server
// serves. So "run it here" and "drive the machine in the other room" are the same app
// pointed at a different address, not two programs — the sessions, files and previews
// all belong to whichever machine is answering.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Connection {
    id: String,
    name: String,
    url: String,
    #[serde(default)]
    password: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Connections {
    active: String, // "local", or a connection id
    #[serde(default)]
    items: Vec<Connection>,
}

impl Default for Connections {
    fn default() -> Self {
        Connections {
            active: "local".into(),
            items: Vec::new(),
        }
    }
}

// The page the app carries with it, for choosing a computer. Captured at startup
// because its URL is `tauri://localhost` on some platforms and `http://tauri.localhost`
// on others, and guessing which is how this breaks on someone else's machine.
struct PickerUrl(Mutex<Option<tauri::Url>>);

// The last page that actually finished loading. A webview that refuses a page — macOS
// blocks plain http in web content unless the bundle says otherwise — shows a white
// rectangle and reports nothing, so this is how the shell notices.
struct LastLoaded(Mutex<Option<tauri::Url>>);

const SAME: fn(&tauri::Url, &tauri::Url) -> bool =
    |a, b| a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default();

/// A machine that is off refuses the connection at once, but one that is unplugged,
/// firewalled or gone from the network swallows the packet — and Windows then retries
/// for twenty seconds before admitting it. Nobody waits twenty seconds to be told that
/// a computer is not answering, so the connect gets its own, shorter limit.
fn quick_agent(connect: u64, total: u64) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(connect))
        .timeout(Duration::from_secs(total))
        .build()
}

/// Does that computer answer at all? Asked before the window is pointed at it, because
/// a page that never loads leaves nothing on screen to explain itself.
fn answers(base: &str) -> Result<(), String> {
    let base = base.trim_end_matches('/');
    quick_agent(3, 5)
        .get(&format!("{base}/api/config"))
        .call()
        .map(|_| ())
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("{base} answered {code}"),
            _ => format!("nothing answered at {base}"),
        })
}

/// Point the picker at a message. It is a page, so it has to be there to be told;
/// connect.js leaves `window.__caNote` behind for exactly this.
fn picker_says(app: &AppHandle, text: String) {
    show_picker(app);
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(900));
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval(&format!(
                "window.__caNote && window.__caNote({})",
                serde_json::to_string(&text).unwrap_or_else(|_| "''".into())
            ));
        }
    });
}

/// After pointing the window at a computer, make sure the page actually arrives. If it
/// does not, go back to the list with the reason rather than leaving a white window
/// whose only way out is the tray.
fn watch_load(app: &AppHandle, target: tauri::Url, id: String, name: String) {
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(15));
        let loaded = app
            .try_state::<LastLoaded>()
            .and_then(|s| s.0.lock().ok().and_then(|g| g.clone()));
        if loaded.map(|u| SAME(&u, &target)).unwrap_or(false) {
            return; // it arrived
        }
        // Two signals, and either one saying "it arrived" is enough — a false bounce
        // would take a working window away from someone. A page that loads sets both
        // (on_page_load, and the window's own URL); a request that never answers sets
        // neither, because a navigation that does not commit leaves the old URL behind.
        let where_it_is = app
            .get_webview_window("main")
            .and_then(|w| w.url().ok())
            .map(|u| SAME(&u, &target))
            .unwrap_or(false);
        if where_it_is {
            return;
        }
        if load_connections(&app).active != id {
            return; // somewhere else by now, on purpose
        }
        // The address only — the query carries the token that opens that computer, and
        // this sentence ends up on screen and in screenshots.
        let where_ = format!(
            "{}://{}{}",
            target.scheme(),
            target.host_str().unwrap_or("that computer"),
            target.port().map(|p| format!(":{p}")).unwrap_or_default()
        );
        picker_says(
            &app,
            format!(
                "{name} did not load. The address answered, but its page never arrived ({where_}). If that computer is fine, this app may be too old to open a plain http address — update it."
            ),
        );
    });
}

// Is this the page the app carries, rather than a server it is showing? The app's own
// origin is `tauri://localhost` on macOS and Linux and `http://tauri.localhost` on
// Windows, which is why it is recognised rather than assumed.
fn is_app_url(u: &tauri::Url) -> bool {
    u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost")
}

/// Where the picker page lives. Reading it off the window at build time gave
/// `about:blank` — the navigation has not started yet — and navigating there later
/// left a white window that looks exactly like a crash. So: the value is taken when a
/// page has actually loaded, and if it was never taken, the platform's own origin is
/// used rather than whatever happened to be in the box.
fn picker_url(app: &AppHandle) -> Option<tauri::Url> {
    let stored = app
        .try_state::<PickerUrl>()
        .and_then(|s| s.0.lock().ok().and_then(|g| g.clone()));
    if let Some(u) = stored {
        if is_app_url(&u) {
            return Some(u);
        }
    }
    let base = if cfg!(windows) {
        "http://tauri.localhost/connect.html"
    } else {
        "tauri://localhost/connect.html"
    };
    tauri::Url::parse(base).ok()
}

fn remember_picker_url(app: &AppHandle, u: tauri::Url) {
    if !is_app_url(&u) {
        return;
    }
    if let Some(s) = app.try_state::<PickerUrl>() {
        if let Ok(mut g) = s.0.lock() {
            *g = Some(u);
        }
    }
}

fn connections_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("connections.json")
}

fn load_connections(app: &AppHandle) -> Connections {
    fs::read_to_string(connections_path(app))
        .ok()
        // Edited by hand in Notepad (or written by PowerShell) and the file starts with
        // a byte-order mark, which serde_json refuses — the list then reads as empty and
        // every computer quietly disappears.
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_default()
}

fn save_connections(app: &AppHandle, c: &Connections) {
    let p = connections_path(app);
    if let Some(d) = p.parent() {
        let _ = fs::create_dir_all(d);
    }
    if let Ok(s) = serde_json::to_string_pretty(c) {
        let _ = fs::write(p, s);
    }
}

// Same derivation as server.mjs, including its rule that the sample password means no
// password at all: a computer left on `change-me` answered every request with "the
// password does not match", because only the local path knew about that word.
fn token_for(password: &str) -> String {
    let password = if password.trim() == "change-me" {
        ""
    } else {
        password.trim()
    };
    hex::encode(Sha256::digest(format!(
        "claude-anywhere:{}",
        if password.is_empty() {
            "open"
        } else {
            password
        }
    )))
}

/// Start the local server if it is not running yet, and report where it is.
/// Used as a client only, the app never starts one — which is why a Mac that only
/// drives the PC does not need Node at all.
fn ensure_local(app: &AppHandle) -> Result<(u16, String), String> {
    #[cfg(mobile)]
    return Err(
        "A phone cannot run Claude itself. Add the computer that does, and open that one.".into(),
    );
    if let Some(s) = app.try_state::<ServerState>() {
        return Ok((s.port, s.token.clone()));
    }
    let state = start_server(app).map_err(|e| e.to_string())?;
    let out = (state.port, state.token.clone());
    app.manage(state);
    supervise_server(app.clone());
    Ok(out)
}

/// Where the window should point for a given connection id.
fn target_url(app: &AppHandle, id: &str) -> Result<tauri::Url, String> {
    if id == "local" {
        let (port, token) = ensure_local(app)?;
        return tauri::Url::parse(&format!("http://127.0.0.1:{port}/?auto={token}"))
            .map_err(|e| e.to_string());
    }
    let c = load_connections(app);
    let item = c
        .items
        .iter()
        .find(|x| x.id == id)
        .ok_or("That computer is not in the list any more.")?;
    let base = item.url.trim_end_matches('/');
    // Asked before the window moves: a computer that is asleep, renumbered or behind a
    // firewall used to become a blank window with no way back to this list.
    answers(base).map_err(|e| format!("{} is not answering — {e}.", item.name))?;
    tauri::Url::parse(&format!("{base}/?auto={}", token_for(&item.password)))
        .map_err(|_| format!("{} is not an address this can open.", item.url))
}

#[tauri::command]
fn connections_get(app: AppHandle) -> Connections {
    load_connections(&app)
}

#[tauri::command]
fn connections_save(app: AppHandle, items: Vec<Connection>) -> Connections {
    let mut c = load_connections(&app);
    c.items = items;
    if c.active != "local" && !c.items.iter().any(|x| x.id == c.active) {
        c.active = "local".into();
    }
    save_connections(&app, &c);
    refresh_tray(&app);
    c
}

/// Point the window at a computer and remember it for next time. Blocking: it asks that
/// computer whether it is there, and starting a local server waits for the port.
fn switch_to(app: &AppHandle, id: &str) -> Result<(), String> {
    let url = target_url(app, id)?;
    let mut c = load_connections(app);
    let name = c
        .items
        .iter()
        .find(|x| x.id == id)
        .map(|x| x.name.clone())
        .unwrap_or_else(|| "That computer".into());
    c.active = id.to_string();
    save_connections(app, &c);
    if let Some(w) = app.get_webview_window("main") {
        w.navigate(url.clone()).map_err(|e| e.to_string())?;
        let _ = w.show();
        let _ = w.set_focus();
        if id != "local" {
            watch_load(app, url, id.to_string(), name);
        }
    }
    refresh_tray(app);
    Ok(())
}

/// Async on purpose: a command that is not async runs on the main thread, and waiting
/// there for a computer to answer freezes the window — the button stuck on "Opening…",
/// which is the very state this was meant to explain.
#[tauri::command]
async fn connection_use(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || switch_to(&app, &id))
        .await
        .map_err(|e| e.to_string())?
}

/// Is anything answering there, and does the password fit? Told before it is saved,
/// because a wrong password shows up as a login screen with no explanation.
#[tauri::command]
async fn connection_test(url: String, password: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || connection_test_now(url, password))
        .await
        .map_err(|e| e.to_string())?
}

fn connection_test_now(url: String, password: String) -> Result<String, String> {
    let base = url.trim_end_matches('/');
    let cfg = quick_agent(4, 6)
        .get(&format!("{base}/api/config"))
        .call()
        .map_err(|e| format!("Nothing answered at {base}: {e}"))?
        .into_json::<serde_json::Value>()
        .map_err(|_| format!("{base} answered, but not as Claude Anywhere."))?;
    let needs = cfg["passwordRequired"].as_bool().unwrap_or(false);
    if needs && password.is_empty() {
        return Err("That computer has an app password. Put it in below.".into());
    }
    let ok = quick_agent(4, 6)
        .get(&format!("{base}/api/me"))
        .set("Authorization", &format!("Bearer {}", token_for(&password)))
        .call()
        .map_err(|_| "The password does not match that computer.".to_string())?
        .into_json::<serde_json::Value>()
        .unwrap_or_default();
    Ok(format!(
        "{} on {}",
        ok["userName"].as_str().unwrap_or("Claude"),
        ok["host"].as_str().unwrap_or("that computer")
    ))
}

/// Every computer this device knows, and what each one is doing right now — so the
/// window can ask "which computer?" before it asks "which account?".
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ComputerStatus {
    id: String,
    name: String,
    url: String,
    active: bool,
    local: bool,
    online: bool,
    host: String,
    account: String,
    plan: String,
    version: String,
    auth: String,
    live_runs: u64,
    error: String,
}

fn probe(
    id: String,
    name: String,
    url: String,
    password: Option<String>,
    active: bool,
    local: bool,
) -> ComputerStatus {
    let mut s = ComputerStatus {
        id,
        name,
        url: url.trim_end_matches('/').to_string(),
        active,
        local,
        online: false,
        host: String::new(),
        account: String::new(),
        plan: String::new(),
        version: String::new(),
        auth: String::new(),
        live_runs: 0,
        error: String::new(),
    };
    // No local server yet: say so rather than starting one. Listing computers must not
    // spawn Node on a Mac that is only ever used as a window onto the PC.
    let Some(password) = password else {
        s.error = "Not started yet".into();
        return s;
    };
    let token = if local {
        password
    } else {
        token_for(&password)
    };
    let get = |path: &str| {
        quick_agent(3, 4)
            .get(&format!("{}{path}", s.url))
            .set("Authorization", &format!("Bearer {token}"))
            .call()
            .ok()
            .and_then(|r| r.into_json::<serde_json::Value>().ok())
    };
    let Some(me) = get("/api/me") else {
        s.error = "Not answering".into();
        return s;
    };
    s.online = true;
    s.host = me["host"].as_str().unwrap_or_default().to_string();
    s.auth = me["active"].as_str().unwrap_or_default().to_string();
    let acc = &me["account"];
    s.account = acc["email"]
        .as_str()
        .map(|e| e.to_string())
        .unwrap_or_else(|| match acc["auth"].as_str() {
            Some("oauth_token") => "Token account".into(),
            _ if acc["loggedIn"] == serde_json::Value::Bool(false) => "Not signed in".into(),
            _ => "Signed in".into(),
        });
    s.plan = acc["plan"].as_str().unwrap_or_default().to_string();
    s.version = me["version"].as_str().unwrap_or_default().to_string();
    s.live_runs = get("/api/runs")
        .and_then(|v| v.as_array().map(|a| a.len() as u64))
        .unwrap_or(0);
    s
}

#[tauri::command]
async fn computers(app: AppHandle) -> Vec<ComputerStatus> {
    tauri::async_runtime::spawn_blocking(move || computers_now(app))
        .await
        .unwrap_or_default()
}

fn computers_now(app: AppHandle) -> Vec<ComputerStatus> {
    let c = load_connections(&app);
    let local = app
        .try_state::<ServerState>()
        .map(|s| (s.port, s.token.clone()));
    let mut jobs = vec![];
    let (local_url, local_token) = match local {
        Some((port, token)) => (format!("http://127.0.0.1:{port}"), Some(token)),
        None => (String::from("http://127.0.0.1"), None),
    };
    jobs.push((
        "local".to_string(),
        "This computer".to_string(),
        local_url,
        local_token,
        c.active == "local",
        true,
    ));
    for item in &c.items {
        jobs.push((
            item.id.clone(),
            item.name.clone(),
            item.url.clone(),
            Some(item.password.clone()),
            c.active == item.id,
            false,
        ));
    }
    // One thread each: a computer that is switched off must not hold up the list.
    let handles: Vec<_> = jobs
        .into_iter()
        .map(|(id, name, url, pw, active, local)| {
            thread::spawn(move || probe(id, name, url, pw, active, local))
        })
        .collect();
    handles.into_iter().filter_map(|h| h.join().ok()).collect()
}

/// Which computer the window is showing, without asking anything over the network —
/// the chat page wants this on every paint, and the answer is two fields.
#[derive(serde::Serialize)]
struct ActiveComputer {
    id: String,
    name: String,
    remote: bool,
}

#[tauri::command]
fn active_computer(app: AppHandle) -> ActiveComputer {
    let c = load_connections(&app);
    let item = c.items.iter().find(|x| x.id == c.active);
    ActiveComputer {
        remote: c.active != "local",
        name: match (&c.active[..], item) {
            ("local", _) => "This computer".into(),
            (_, Some(i)) => i.name.clone(),
            _ => "Another computer".into(),
        },
        id: c.active,
    }
}

/// What the app in front of you is — which is not what the server says when the window
/// is showing another computer. The page needs both to offer the right file: a Mac
/// looking at a PC can install a Mac build here and a Windows one over there.
#[derive(serde::Serialize)]
struct ThisApp {
    version: String,
    commit: String,
    platform: String,
}

#[tauri::command]
fn app_version() -> ThisApp {
    ThisApp {
        version: env!("CARGO_PKG_VERSION").into(),
        commit: env!("CA_COMMIT").chars().take(7).collect(),
        platform: std::env::consts::OS.into(), // "windows" | "macos" | "linux"
    }
}

/// The bytes of a file dropped on this window. Tauri takes the drop itself and gives the
/// page paths rather than data (see the drag-drop listener in app.js), and the file is on
/// the machine the window is on - which is not the machine running the server when this
/// app is showing another computer. So the shell reads it and the page sends it on, the
/// same way it sends a file picked from the disk.
///
/// Async on purpose: a #[tauri::command] that is not async runs on the main thread, and a
/// 20 MB read there freezes the window mid-drop.
#[tauri::command]
async fn dropped_file(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            return Err("is a folder".into());
        }
        if meta.len() > 25 * 1024 * 1024 {
            return Err("is larger than 25 MB".into());
        }
        fs::read(&p)
            .map(tauri::ipc::Response::new)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The app password of this computer, so adding another one can reuse it instead of
/// asking for a second password nobody wanted to invent.
#[tauri::command]
fn default_password(app: AppHandle) -> String {
    let Ok(dir) = app.path().app_data_dir() else {
        return String::new();
    };
    let (password, _) = read_env(&dir.join(".env"));
    if password == "change-me" {
        String::new()
    } else {
        password
    }
}

/// Ask this computer's server to look now, and say what it found. The server holds the
/// answer for a few minutes so every device shares one call to GitHub; this is the way to
/// jump that queue when you have just merged something.
fn check_for_updates(app: AppHandle) {
    thread::spawn(move || {
        let Some(state) = app.try_state::<ServerState>() else {
            return;
        };
        let (port, token) = (state.port, state.token.clone());
        let answer = quick_agent(3, 12)
            .post(&format!("http://127.0.0.1:{port}/api/update/check"))
            .set("Authorization", &format!("Bearer {token}"))
            .set("Content-Type", "application/json")
            .send_string("{}")
            .ok()
            .and_then(|r| r.into_json::<serde_json::Value>().ok());
        let (title, body) = match answer {
            Some(v) if v["newer"] == serde_json::Value::Bool(true) => (
                format!(
                    "Claude Anywhere {} is available",
                    v["latest"].as_str().unwrap_or("")
                ),
                format!(
                    "You have {}. Open the window to install it.",
                    v["current"].as_str().unwrap_or("an older build")
                ),
            ),
            Some(v) if v["latest"].is_string() => (
                "Up to date".to_string(),
                format!(
                    "{} is the latest release.",
                    v["latest"].as_str().unwrap_or("")
                ),
            ),
            _ => (
                "Could not check".to_string(),
                "GitHub did not answer. Try again in a moment.".to_string(),
            ),
        };
        let _ = app.notification().builder().title(title).body(body).show();
    });
}

/// Show the built-in page for choosing a computer.
#[tauri::command]
fn open_picker(app: AppHandle) {
    show_picker(&app);
}

fn show_picker(app: &AppHandle) {
    if let (Some(url), Some(w)) = (picker_url(app), app.get_webview_window("main")) {
        let _ = w.navigate(url);
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // One window per machine and a start at login are desktop ideas: a phone opens one
    // app per icon and starts nothing by itself. Both plugins are desktop-only crates.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ));
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            connections_get,
            connections_save,
            connection_use,
            connection_test,
            computers,
            active_computer,
            app_version,
            dropped_file,
            default_password,
            open_picker
        ]);
    #[cfg(mobile)]
    let builder = builder.setup(mobile_setup);
    #[cfg(desktop)]
    let builder = builder
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(PickerUrl(Mutex::new(None)));
            app.manage(LastLoaded(Mutex::new(None)));
            let conns = load_connections(&handle);
            let hidden = std::env::args().any(|a| a == "--hidden");

            // The window is built on the picker page so its URL can be read for what it
            // actually is on this platform, then sent where it belongs. The reading has
            // to wait for a page to load: straight after build() the window says
            // `about:blank`, and that is what used to be saved.
            let win =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("connect.html".into()))
                    .on_page_load(|w, _| {
                        if let Ok(u) = w.url() {
                            if let Some(s) = w.app_handle().try_state::<LastLoaded>() {
                                if let Ok(mut g) = s.0.lock() {
                                    *g = Some(u.clone());
                                }
                            }
                            remember_picker_url(w.app_handle(), u);
                        }
                    })
                    .title("Claude")
                    .inner_size(1200.0, 820.0)
                    .min_inner_size(380.0, 600.0)
                    // On Windows there is no caption bar: the page draws the title bar and
                    // the minimise / maximise / close buttons itself, as Claude Desktop
                    // does. macOS and Linux keep their own — the traffic lights belong
                    // where every other window on that machine puts them.
                    .decorations(!cfg!(windows))
                    .shadow(true)
                    // Tauri's own drag-drop handler stays on: turning it off was meant to
                    // give the page ordinary HTML5 drops, and on macOS that produced no
                    // drop at all — neither the native one nor the web one. What it does
                    // emit is `tauri://drag-drop` carrying the paths, which the page picks
                    // up (see app.js). Paths beat bytes here: the file is on this machine.
                    .visible(false)
                    .build()?;
            if let Ok(u) = win.url() {
                remember_picker_url(&handle, u); // about:blank at this point is ignored
            }
            let _ = win.set_title("Claude");

            // Pointed at another computer: no server of our own, so this machine needs
            // neither Node nor a Claude login to be a window onto that one.
            if conns.active != "local" {
                match target_url(&handle, &conns.active) {
                    Ok(url) => {
                        let name = conns
                            .items
                            .iter()
                            .find(|x| x.id == conns.active)
                            .map(|x| x.name.clone())
                            .unwrap_or_else(|| "That computer".into());
                        let _ = win.navigate(url.clone());
                        watch_load(&handle, url, conns.active.clone(), name);
                    }
                    Err(e) => {
                        let _ = win.eval(&format!(
                            "window.__caError={}",
                            serde_json::to_string(&e).unwrap_or_else(|_| "null".into())
                        ));
                    }
                }
                if !hidden {
                    let _ = win.show();
                }
                build_tray(&handle)?;
                spawn_notifier(handle.clone());
                return Ok(());
            }

            let state = match start_server(&handle) {
                Ok(s) => s,
                // No server here — most often a Mac with no Node, bought into this app to
                // be a window onto the PC. Quitting told it "could not start" and left it
                // no way to say which computer it wanted; the picker is already on screen,
                // so the reason goes there and the list stays reachable.
                Err(e) => {
                    if let Ok(dir) = app.path().app_data_dir() {
                        let _ = fs::write(
                            dir.join("startup-error.txt"),
                            format!("{e}\nPATH={}\n", std::env::var("PATH").unwrap_or_default()),
                        );
                    }
                    let _ = win.eval(&format!(
                        "window.__caError={}",
                        serde_json::to_string(&format!(
                            "{e}\n\nThis computer cannot run Claude itself. Add the one that can, below."
                        ))
                        .unwrap_or_else(|_| "null".into())
                    ));
                    let _ = win.show();
                    let _ = win.set_focus();
                    build_tray(&handle)?;
                    spawn_notifier(handle.clone());
                    return Ok(());
                }
            };
            let url = format!("http://127.0.0.1:{}/?auto={}", state.port, state.token);
            app.manage(state);
            let _ = win.navigate(url.parse()?);
            if !hidden {
                let _ = win.show();
            }

            build_tray(&handle)?;
            spawn_notifier(handle.clone());
            supervise_server(handle.clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the server (and the phone) alive; Quit is in the tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        });
    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_server(app);
            }
        });
}

// ---------- a phone ----------
// A phone runs no Claude of its own - no Node, no server, no tray. It is a window onto a
// computer that does: the picker until one is chosen, that computer's chat after.
#[cfg(mobile)]
fn mobile_setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    app.manage(PickerUrl(Mutex::new(None)));
    app.manage(LastLoaded(Mutex::new(None)));
    // The same bookkeeping as the desktop window, so a computer that answers but never
    // sends its page still brings the picker back with a reason (see watch_load).
    let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("connect.html".into()))
        .on_page_load(|w, _| {
            if let Ok(u) = w.url() {
                if let Some(s) = w.app_handle().try_state::<LastLoaded>() {
                    if let Ok(mut g) = s.0.lock() {
                        *g = Some(u.clone());
                    }
                }
                remember_picker_url(w.app_handle(), u);
            }
        })
        .build()?;
    // "local" is the desktop's default and means this machine's own server. A phone has
    // none, so a fresh install stays on the picker until a computer is added.
    let conns = load_connections(&handle);
    if conns.active != "local" {
        match target_url(&handle, &conns.active) {
            Ok(url) => {
                let name = conns
                    .items
                    .iter()
                    .find(|x| x.id == conns.active)
                    .map(|x| x.name.clone())
                    .unwrap_or_else(|| "That computer".into());
                let _ = win.navigate(url.clone());
                watch_load(&handle, url, conns.active.clone(), name);
            }
            Err(e) => {
                let _ = win.eval(&format!(
                    "window.__caError={}",
                    serde_json::to_string(&e).unwrap_or_else(|_| "null".into())
                ));
            }
        }
    }
    Ok(())
}

// ---------- the Node server ----------

fn server_dir(app: &AppHandle, env_file: &Path) -> PathBuf {
    // CLAUDE_ANYWHERE_SERVER_DIR in the app's .env: run the server straight from a checkout,
    // so edits (and "Restart server" from the phone) take effect without a rebuild.
    if let Ok(text) = fs::read_to_string(env_file) {
        for line in text.lines() {
            // The old name is still in .env files written before 0.3.0.
            if let Some(v) = line
                .strip_prefix("CLAUDE_ANYWHERE_SERVER_DIR=")
                .or_else(|| line.strip_prefix("CLAUDE_REMOTE_SERVER_DIR="))
            {
                let p = PathBuf::from(v.trim());
                if p.join("server.mjs").exists() {
                    return p;
                }
            }
        }
    }
    // Packaged: resources/server. Development: the repository root next to src-tauri.
    if let Ok(res) = app.path().resource_dir() {
        let packaged = res.join("server");
        if packaged.join("server.mjs").exists() {
            return packaged;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn ensure_env_file(env_file: &Path, server_root: &Path) -> std::io::Result<()> {
    if env_file.exists() {
        return Ok(());
    }
    if let Some(dir) = env_file.parent() {
        fs::create_dir_all(dir)?;
    }
    let dev = server_root.join(".env");
    if dev.exists() {
        fs::copy(&dev, env_file)?;
        return Ok(());
    }
    // USERNAME on Windows, USER everywhere else; the greeting says it back to you.
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "there".into());
    fs::write(
        env_file,
        format!("# Optional app password. Empty = no password (keep the PC on a network you trust).\nREMOTE_PASSWORD=\nHOST=0.0.0.0\nPORT=7777\nUSER_NAME={user}\n"),
    )
}

fn read_env(env_file: &Path) -> (String, u16) {
    let text = fs::read_to_string(env_file).unwrap_or_default();
    let mut password = String::new();
    let mut port = 7777u16;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("REMOTE_PASSWORD=") {
            password = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("PORT=") {
            port = v.trim().parse().unwrap_or(7777);
        }
    }
    (password, port)
}

// Node refuses the verbatim prefix Windows canonicalisation adds, so it comes off again.
fn tidy(path: PathBuf) -> PathBuf {
    let path = path.canonicalize().unwrap_or(path);
    PathBuf::from(path.to_string_lossy().trim_start_matches(r"\\?\"))
}

fn local_key(data_dir: &Path) -> Option<String> {
    fs::read_to_string(data_dir.join("data").join("local.key"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn start_server(app: &AppHandle) -> Result<ServerState, Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&data_dir)?;
    let env_file = data_dir.join(".env");
    let root = server_dir(app, &env_file);
    ensure_env_file(&env_file, &root)?;
    let (password, port) = read_env(&env_file);
    let password = if password == "change-me" {
        String::new()
    } else {
        password
    };
    // Same derivation as server.mjs: no password means the fixed word "open".
    let token = hex::encode(Sha256::digest(format!(
        "claude-anywhere:{}",
        if password.is_empty() {
            "open"
        } else {
            &password
        }
    )));
    // The server's own key for this computer's window (data/local.key, written by
    // lib/access.mjs) opens it whatever the password is: one set from inside the app is
    // not in .env, and the token derived from .env would be refused. There is none
    // before a server has ever run here; the derived token stands in until then.
    let token = local_key(&data_dir).unwrap_or(token);

    // Already running with our password (the server of a previous app instance that is
    // still finishing a turn, another copy, or `npm start`)? Adopt it and carry on.
    // Something else on that port (a dev server with a different password)? Pick a free one.
    let mut port = port;
    if port_open(port) {
        if server_accepts(port, &token) {
            let _ = ureq::post(&format!("http://127.0.0.1:{port}/api/adopt"))
                .set("Authorization", &format!("Bearer {token}"))
                .set("Content-Type", "application/json")
                .timeout(Duration::from_secs(3))
                // The version too: this server was started by the app we replaced, and
                // until it is restarted it would otherwise keep reporting that one.
                .send_string(&format!(
                    "{{\"pid\":{},\"version\":\"{}\",\"commit\":\"{}\"}}",
                    std::process::id(),
                    env!("CARGO_PKG_VERSION"),
                    env!("CA_COMMIT")
                ));
            // Knowing how to start a server matters even when we did not start this one.
            // After a rebuild the app comes back to a server that outlived it on purpose,
            // adopts it, and "Restart server" then has to be able to put one back —
            // without this it killed the server and nothing ever replaced it.
            return Ok(ServerState {
                child: Mutex::new(None),
                port,
                token,
                env_file: env_file.clone(),
                spawn: find_node(&root).map(|node| SpawnCfg {
                    node,
                    root: tidy(root),
                    data_dir: data_dir.clone(),
                    env_file,
                    port,
                }),
            });
        }
        port = (port + 1..port + 20)
            .find(|p| !port_open(*p))
            .ok_or("No free port near the configured one")?;
    }

    let node = find_node(&root).ok_or("Node.js was not found: this copy of the app has no Node of its own and none is on PATH. Install Node 20 or newer from nodejs.org, or reinstall Claude Anywhere, and start it again.")?;
    let cfg = SpawnCfg {
        node,
        root: tidy(root),
        data_dir: data_dir.clone(),
        env_file: env_file.clone(),
        port,
    };
    let child = spawn_server(&cfg)?;
    let _ = fs::remove_file(data_dir.join("startup-error.txt"));
    // A first run: the server has just written its key.
    let token = local_key(&data_dir).unwrap_or(token);
    Ok(ServerState {
        child: Mutex::new(Some(child)),
        port,
        token,
        env_file,
        spawn: Some(cfg),
    })
}

fn spawn_server(cfg: &SpawnCfg) -> Result<Child, Box<dyn std::error::Error>> {
    let SpawnCfg {
        node,
        root,
        data_dir,
        env_file,
        port,
    } = cfg;
    let port = *port;
    let mut log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("server.log"))
        .ok();
    if let Some(f) = log.as_mut() {
        use std::io::Write;
        let _ = writeln!(
            f,
            "[claude-anywhere] node={} root={} port={port}",
            node.display(),
            root.display()
        );
    }
    let log_err = log.as_ref().and_then(|f| f.try_clone().ok());
    let mut cmd = Command::new(node);
    cmd.arg(root.join("server.mjs"))
        .current_dir(root)
        .env("CLAUDE_ANYWHERE_DATA_DIR", data_dir.join("data"))
        .env("CLAUDE_ANYWHERE_ENV_FILE", env_file)
        .env(
            "CLAUDE_ANYWHERE_APP_EXE",
            std::env::current_exe()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
        )
        // What this window actually is, for the About line and for deciding whether
        // a release on GitHub is newer. An installed app has no checkout to ask.
        .env("CLAUDE_ANYWHERE_APP_VERSION", env!("CARGO_PKG_VERSION"))
        .env("CLAUDE_ANYWHERE_APP_COMMIT", env!("CA_COMMIT"))
        .env("HOST", "0.0.0.0")
        .env("PORT", port.to_string())
        .env("CLAUDE_ANYWHERE_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(log.map(Stdio::from).unwrap_or_else(Stdio::null))
        .stderr(log_err.map(Stdio::from).unwrap_or_else(Stdio::null));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start Node (is it installed and on PATH?): {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(30);
    while !port_open(port) {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "Node exited right away ({status}). See {}",
                data_dir.join("server.log").display()
            )
            .into());
        }
        if Instant::now() > deadline {
            return Err(format!(
                "The server did not come up on port {port}. See {}",
                data_dir.join("server.log").display()
            )
            .into());
        }
        thread::sleep(Duration::from_millis(200));
    }
    Ok(child)
}

// Watches the server. Exit code 75 means "restart me" (new code from the repo): spawn it
// again and reload the window. Anything else is a crash: restart too, but say so.
//
// A server we adopted rather than spawned gives us no Child to wait on — and that is the
// common case, because a rebuild leaves the old server running on purpose and the new app
// picks it up. The port is the only signal then, so watch that instead; otherwise "Restart
// server" told the server to exit and nothing ever put one back.
fn supervise_server(app: AppHandle) {
    let mut misses = 0u8;
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(700));
        let Some(state) = app.try_state::<ServerState>() else {
            continue;
        };
        let Some(cfg) = state.spawn.clone() else {
            continue;
        };
        // Some(true) = gone and worth a word, Some(false) = gone as asked, None = alive.
        let exited = {
            let mut guard = match state.child.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            match guard.as_mut().map(|c| c.try_wait()) {
                Some(Ok(Some(status))) => {
                    *guard = None;
                    Some(status.code() != Some(RESTART_CODE))
                }
                Some(_) => None,
                // Adopted: two misses in a row, since a server on its way out answers
                // nothing for a moment and we have no exit code to tell why it went.
                None => {
                    if port_open(cfg.port) {
                        misses = 0;
                        None
                    } else {
                        misses += 1;
                        (misses >= 2).then(|| {
                            misses = 0;
                            false
                        })
                    }
                }
            }
        };
        let Some(say_so) = exited else { continue };
        if say_so {
            let _ = app
                .notification()
                .builder()
                .title("Claude Anywhere server stopped")
                .body("Restarting it.")
                .show();
        }
        match spawn_server(&cfg) {
            Ok(child) => {
                if let Ok(mut guard) = state.child.lock() {
                    *guard = Some(child);
                }
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.eval("setTimeout(() => location.reload(), 300)");
                }
            }
            Err(e) => {
                let _ = app
                    .notification()
                    .builder()
                    .title("Claude Anywhere server did not come back")
                    .body(format!("{e}"))
                    .show();
                thread::sleep(Duration::from_secs(5));
            }
        }
    });
}

// The installer's own Node first (runtime/, fetched by scripts/fetch-node.mjs): asking
// people to install Node before the app would start was the one setup step the app
// could not do for them. Then Node from PATH, or the usual install folder, for a build
// without one; resolved here so the log says which one ran. A macOS app launched from
// Finder gets a bare PATH with no Homebrew in it, and a Linux one started from a
// desktop entry is not much better, so the known places are tried as well.
const NODE_BIN: &str = if cfg!(windows) { "node.exe" } else { "node" };

fn find_node(root: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![root.join("runtime").join(NODE_BIN)];
    if let Some(p) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&p).map(|d| d.join(NODE_BIN)));
    }
    if cfg!(windows) {
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push(Path::new(&pf).join("nodejs").join(NODE_BIN));
        }
        if let Ok(la) = std::env::var("LOCALAPPDATA") {
            candidates.push(
                Path::new(&la)
                    .join("Programs")
                    .join("nodejs")
                    .join(NODE_BIN),
            );
        }
    } else {
        for dir in [
            "/opt/homebrew/bin", // Apple silicon Homebrew
            "/usr/local/bin",    // Intel Homebrew, and most manual installs
            "/usr/bin",
            "/snap/bin",
        ] {
            candidates.push(Path::new(dir).join(NODE_BIN));
        }
        // nvm and fnm keep versions under the home directory; take the newest that is there.
        if let Some(home) = std::env::var_os("HOME") {
            let versions = Path::new(&home).join(".nvm").join("versions").join("node");
            if let Ok(entries) = fs::read_dir(&versions) {
                let mut dirs: Vec<PathBuf> =
                    entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
                dirs.sort();
                for d in dirs.into_iter().rev() {
                    candidates.push(d.join("bin").join(NODE_BIN));
                }
            }
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn port_open(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn server_accepts(port: u16, token: &str) -> bool {
    ureq::get(&format!("http://127.0.0.1:{port}/api/me"))
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(Duration::from_secs(3))
        .call()
        .is_ok()
}

fn stop_server(app: &AppHandle) {
    if let Some(state) = app.try_state::<ServerState>() {
        // Claude mid-turn? Leave the server alone: it finishes the work on its own and
        // exits when idle, and the next app instance adopts it.
        let busy = ureq::get(&format!("http://127.0.0.1:{}/api/runs", state.port))
            .set("Authorization", &format!("Bearer {}", state.token))
            .timeout(Duration::from_secs(2))
            .call()
            .ok()
            .and_then(|r| r.into_json::<serde_json::Value>().ok())
            .map(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false))
            .unwrap_or(false);
        if let Ok(mut guard) = state.child.lock() {
            if let Some(mut child) = guard.take() {
                if busy {
                    return;
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

// ---------- window, tray, dialogs ----------

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        #[cfg(desktop)]
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// The menu is rebuilt whenever the computers change, so the tick is always against the
// one the window is actually showing.
#[cfg(desktop)]
fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let conns = load_connections(app);
    let open = MenuItem::with_id(app, "open", "Open Claude", true, None::<&str>)?;
    let phone = MenuItem::with_id(app, "phone", "Phone connection…", true, None::<&str>)?;
    let computers = MenuItem::with_id(app, "computers", "Computers…", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "updates", "Check for updates…", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        if cfg!(target_os = "macos") {
            "Start at login"
        } else if cfg!(windows) {
            "Start with Windows"
        } else {
            "Start at login"
        },
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let local = CheckMenuItem::with_id(
        app,
        "conn:local",
        "This computer",
        true,
        conns.active == "local",
        None::<&str>,
    )?;
    let mut remotes: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
    for c in &conns.items {
        remotes.push(CheckMenuItem::with_id(
            app,
            format!("conn:{}", c.id),
            if c.name.trim().is_empty() {
                c.url.clone()
            } else {
                c.name.clone()
            },
            true,
            conns.active == c.id,
            None::<&str>,
        )?);
    }

    let sep = PredefinedMenuItem::separator(app)?;
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![&open, &sep, &local];
    for r in &remotes {
        items.push(r);
    }
    items.push(&computers);
    items.push(&sep);
    items.push(&updates);
    items.push(&phone);
    items.push(&autostart);
    items.push(&sep);
    items.push(&quit);
    Menu::with_items(app, &items)
}

#[cfg(desktop)]
fn refresh_tray(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id("main"), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

// A phone has no tray; the computers it knows are in the picker instead.
#[cfg(mobile)]
fn refresh_tray(_app: &AppHandle) {}

#[cfg(desktop)]
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray_menu(app)?;
    let icon = app.default_window_icon().cloned().expect("window icon");
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Claude Anywhere")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref().to_string();
            if let Some(which) = id.strip_prefix("conn:") {
                let which = which.to_string();
                let app = app.clone();
                // Starting a server can take a moment; the menu should not sit open for it.
                thread::spawn(move || {
                    if let Err(e) = switch_to(&app.clone(), &which) {
                        app.dialog()
                            .message(e)
                            .title("Could not switch computer")
                            .kind(MessageDialogKind::Error)
                            .show(|_| {});
                    }
                });
                return;
            }
            match id.as_str() {
                "open" => show_main(app),
                "phone" => show_phone_info(app),
                "computers" => show_picker(app),
                "updates" => check_for_updates(app.clone()),
                "autostart" => {
                    let on = app.autolaunch().is_enabled().unwrap_or(false);
                    let _ = if on {
                        app.autolaunch().disable()
                    } else {
                        app.autolaunch().enable()
                    };
                    refresh_tray(app);
                }
                "quit" => {
                    stop_server(app);
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_phone_info(app: &AppHandle) {
    let Some(state) = app.try_state::<ServerState>() else {
        // Used as a window onto another computer, this one is serving nothing.
        app.dialog()
            .message("This computer is not serving anything right now. Switch to This computer in the tray, then the addresses for your phone will be here.")
            .title("Claude on your phone")
            .kind(MessageDialogKind::Info)
            .show(|_| {});
        return;
    };
    let (password, port) = read_env(&state.env_file);
    let mut lines = Vec::new();
    let url = format!("http://127.0.0.1:{}/api/addresses", port);
    if let Ok(resp) = ureq::get(&url)
        .set("Authorization", &format!("Bearer {}", state.token))
        .call()
    {
        if let Ok(json) = resp.into_json::<serde_json::Value>() {
            for a in json.as_array().cloned().unwrap_or_default() {
                let addr = a["address"].as_str().unwrap_or("");
                let name = a["name"].as_str().unwrap_or("");
                let ts = a["tailscale"].as_bool().unwrap_or(false);
                lines.push(format!(
                    "http://{addr}:{port}   ({})",
                    if ts { "Tailscale" } else { name }
                ));
            }
        }
    }
    if lines.is_empty() {
        lines.push("(no network address found)".into());
    }
    let password_line = if password.is_empty() || password == "change-me" {
        "No app password is set: anyone who can open this address can use Claude on this PC. Use Tailscale, or set REMOTE_PASSWORD in the settings file.".to_string()
    } else {
        format!("Password: {password}")
    };
    let text = format!(
        "Open one of these on your phone:\n\n{}\n\n{}\n\nOn the phone use \"Add to Home Screen\" to install it.\nSettings file: {}",
        lines.join("\n"),
        password_line,
        state.env_file.display()
    );
    app.dialog()
        .message(text)
        .title("Claude on your phone")
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

// Follows the server's notification stream and raises a system notification
// when the window is not in front: a permission to answer, or a finished turn.
/// Base address and token of whatever the window is looking at, so notifications come
/// from the machine doing the work rather than always from this one.
fn active_base(app: &AppHandle) -> Option<(String, String)> {
    let conns = load_connections(app);
    if conns.active == "local" {
        let s = app.try_state::<ServerState>()?;
        return Some((format!("http://127.0.0.1:{}", s.port), s.token.clone()));
    }
    let c = conns.items.into_iter().find(|x| x.id == conns.active)?;
    Some((
        c.url.trim_end_matches('/').to_string(),
        token_for(&c.password),
    ))
}

fn spawn_notifier(app: AppHandle) {
    thread::spawn(move || loop {
        let Some((base, token)) = active_base(&app) else {
            thread::sleep(Duration::from_secs(1));
            continue;
        };
        let url = format!("{base}/api/notify?token={token}");
        match ureq::get(&url).call() {
            Ok(resp) => {
                let reader = BufReader::new(resp.into_reader());
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    let Some(json) = line.strip_prefix("data: ") else {
                        continue;
                    };
                    let Ok(ev) = serde_json::from_str::<serde_json::Value>(json) else {
                        continue;
                    };
                    let focused = app
                        .get_webview_window("main")
                        .map(|w| w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false))
                        .unwrap_or(false);
                    if focused {
                        continue;
                    }
                    let (title, body) = match ev["t"].as_str() {
                        Some("permission") => (
                            format!(
                                "Claude wants to use {}",
                                ev["tool"].as_str().unwrap_or("a tool")
                            ),
                            ev["summary"]
                                .as_str()
                                .unwrap_or("Open the app to review")
                                .to_string(),
                        ),
                        Some("turn_done") => (
                            if ev["isError"].as_bool().unwrap_or(false) {
                                "Claude hit an error".to_string()
                            } else {
                                "Claude finished".to_string()
                            },
                            ev["text"]
                                .as_str()
                                .unwrap_or("Open the app to read the answer")
                                .to_string(),
                        ),
                        _ => continue,
                    };
                    let _ = app.notification().builder().title(title).body(body).show();
                }
            }
            Err(_) => thread::sleep(Duration::from_secs(3)),
        }
    });
}
