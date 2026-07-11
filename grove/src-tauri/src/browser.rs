//! Native-webview Browser tabs.
//!
//! Each browser tab is a child `Webview` overlaid on the main window. These
//! webviews load untrusted web content and therefore have ZERO IPC/preload
//! access to the app (no capability is granted to their labels in
//! `capabilities/default.json`).
//!
//! Commands are dispatched through the existing invoke bridge. All commands
//! except `browser_create` are silent no-ops (resolve `Ok`) when the `tab_id`
//! is unknown.

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl,
};

/// A live browser webview plus its last frontend-driven bounds, so native
/// code (e.g. the devtools detach sequence) can restore the frame without
/// asking the frontend.
pub struct BrowserEntry {
    webview: Webview,
    bounds: Option<Bounds>,
}

/// Map of `tabId` -> browser entry.
#[derive(Default)]
pub struct BrowserState(pub Mutex<HashMap<String, BrowserEntry>>);

/// Logical-pixel rectangle sent from the frontend. JS keys are lowercase single
/// words (`x`, `y`, `width`, `height`) so no rename is needed.
#[derive(serde::Deserialize, Clone, Copy)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Payload for the `browser:nav` event emitted to the main app frame.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNavPayload {
    tab_id: String,
    url: String,
    title: Option<String>,
    loading: bool,
    // Tauri does not expose a history API, so these are always `null`; the
    // frontend falls back to its own stack heuristic.
    can_go_back: Option<bool>,
    can_go_forward: Option<bool>,
}

/// Payload for the `browser:new-window` event emitted when a page requests a
/// new window (`target="_blank"` links, `window.open`). The native window
/// creation is always denied; the frontend opens a Grove browser tab instead.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserNewWindowPayload {
    opener_tab_id: String,
    url: String,
}

/// Schemes a page (or its subframes) may navigate to. `data`/`blob` are common
/// in embedded content; everything else — notably custom app schemes like
/// `tauri:` — is blocked so untrusted pages can never reach app internals.
fn scheme_allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "about" | "data" | "blob")
}

/// Custom scheme the injected guest right-click menu navigates to in order to
/// call back into main for actions a sandboxed guest cannot perform itself
/// (Inspect Page, Open in Default Browser, Open Link in New Tab). The
/// navigation is always denied — it is a one-way message channel, not a real
/// load. Grove's guest webviews have zero IPC/preload access, so this denied
/// navigation is the only bridge from guest → main.
const GUEST_MENU_SCHEME: &str = "grovemenu";

/// Injected into every browser guest before page scripts run. Suppresses
/// WebKit's native right-click menu and renders Grove's own menu inside a
/// closed shadow root (invisible to and un-restyleable by the page). Actions a
/// guest can do itself run inline (back/forward/reload/clipboard); the rest
/// post back over the `grovemenu://` channel. Kept as one self-contained IIFE
/// so re-injection on every navigation is idempotent.
const GUEST_CONTEXT_MENU_SCRIPT: &str = r#"
(function () {
  if (window.__groveCtxMenu) return;
  window.__groveCtxMenu = true;
  var SCHEME = 'grovemenu://a?';
  function send(action, extra) {
    var p = new URLSearchParams(extra || {});
    p.set('action', action);
    location.href = SCHEME + p.toString();
  }
  var host = null;
  function close() {
    if (host) { host.remove(); host = null; }
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('scroll', close, true);
    window.removeEventListener('blur', close, true);
    window.removeEventListener('resize', close, true);
  }
  function onDown(e) { if (!host || !host.contains(e.target)) close(); }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
    }
  }
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    close();
    var linkEl = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    var link = linkEl ? linkEl.href : '';
    var sel = window.getSelection ? String(window.getSelection()) : '';
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483647';
    var root = host.attachShadow({ mode: 'closed' });
    var menu = document.createElement('div');
    var bg = dark ? '#1f2023' : '#ffffff';
    var fg = dark ? '#e6e6e6' : '#1a1a1a';
    var bd = dark ? '#3a3b3f' : '#d8d8d8';
    var hv = dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)';
    menu.style.cssText =
      'position:fixed;min-width:200px;padding:4px;border-radius:8px;font:13px -apple-system,system-ui,sans-serif;' +
      'background:' + bg + ';color:' + fg + ';border:1px solid ' + bd + ';box-shadow:0 8px 28px rgba(0,0,0,0.28)';
    function item(label, fn, disabled) {
      var el = document.createElement('div');
      el.textContent = label;
      el.style.cssText =
        'padding:5px 10px;border-radius:5px;cursor:default;white-space:nowrap;' +
        (disabled ? 'opacity:0.4;pointer-events:none' : '');
      if (!disabled) {
        el.addEventListener('mouseenter', function () { el.style.background = hv; });
        el.addEventListener('mouseleave', function () { el.style.background = 'transparent'; });
        el.addEventListener('mouseup', function () { close(); fn(); });
      }
      menu.appendChild(el);
    }
    function sep() {
      var s = document.createElement('div');
      s.style.cssText = 'height:1px;margin:4px 6px;background:' + bd;
      menu.appendChild(s);
    }
    if (link) {
      item('Open Link in New Tab', function () { send('new-tab', { url: link }); });
      item('Copy Link Address', function () { copy(link); });
      sep();
    }
    if (sel) {
      item('Copy', function () { copy(sel); });
      sep();
    }
    item('Back', function () { history.back(); }, !(history.length > 1));
    item('Forward', function () { history.forward(); });
    item('Reload', function () { location.reload(); });
    sep();
    item('Copy Page URL', function () { copy(location.href); });
    item('Open Page in Default Browser', function () { send('open-external', { url: location.href }); });
    sep();
    item('Inspect Page', function () { send('inspect', {}); });
    root.appendChild(menu);
    (document.documentElement || document.body).appendChild(host);
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    var x = Math.min(e.clientX, window.innerWidth - mw - 4);
    var y = Math.min(e.clientY, window.innerHeight - mh - 4);
    menu.style.left = Math.max(4, x) + 'px';
    menu.style.top = Math.max(4, y) + 'px';
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('scroll', close, true);
    window.addEventListener('blur', close, true);
    window.addEventListener('resize', close, true);
  }, true);
})();
"#;

/// Handle a `grovemenu://` callback from the injected guest menu. Runs on the
/// Tauri main thread (the wry navigation handler fires there). `raw_url` is the
/// full denied navigation URL.
fn handle_guest_menu_action(app: &AppHandle, tab_id: &str, raw_url: &str) {
    let Ok(parsed) = Url::parse(raw_url) else {
        return;
    };
    let mut action: Option<String> = None;
    let mut target_url: Option<String> = None;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "action" => action = Some(value.into_owned()),
            "url" => target_url = Some(value.into_owned()),
            _ => {}
        }
    }
    match action.as_deref() {
        Some("inspect") => {
            let label = format!("browser-{tab_id}");
            if let Some(webview) = app.get_webview(&label) {
                open_detached_devtools(&webview, tab_id.to_string());
            }
        }
        Some("open-external") => {
            if let Some(url) = target_url {
                if matches!(Url::parse(&url).map(|u| u.scheme().to_string()).as_deref(), Ok("http") | Ok("https")) {
                    let _ = webbrowser::open(&url);
                }
            }
        }
        Some("new-tab") => {
            if let Some(url) = target_url {
                if matches!(Url::parse(&url).map(|u| u.scheme().to_string()).as_deref(), Ok("http") | Ok("https")) {
                    let _ = app.emit(
                        "browser:new-window",
                        BrowserNewWindowPayload {
                            opener_tab_id: tab_id.to_string(),
                            url,
                        },
                    );
                }
            }
        }
        _ => {}
    }
}

fn emit_nav(
    app: &AppHandle,
    tab_id: &str,
    url: String,
    title: Option<String>,
    loading: bool,
) {
    let _ = app.emit(
        "browser:nav",
        BrowserNavPayload {
            tab_id: tab_id.to_string(),
            url,
            title,
            loading,
            can_go_back: None,
            can_go_forward: None,
        },
    );
}

#[tauri::command]
pub fn browser_create(
    app: AppHandle,
    state: State<'_, BrowserState>,
    tab_id: String,
    url: String,
    bounds: Bounds,
) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Refusing to load non-http(s) URL: {}", parsed));
    }

    let mut map = state.0.lock().map_err(|e| e.to_string())?;

    // Already exists → just navigate to the new URL.
    if let Some(entry) = map.get_mut(&tab_id) {
        entry.bounds = Some(bounds);
        return entry.webview.navigate(parsed).map_err(|e| e.to_string());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let label = format!("browser-{tab_id}");

    let load_app = app.clone();
    let load_tab = tab_id.clone();
    let title_app = app.clone();
    let title_tab = tab_id.clone();
    let new_window_app = app.clone();
    let new_window_tab = tab_id.clone();
    let nav_app = app.clone();
    let nav_tab = tab_id.clone();

    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed))
        // Injected before page scripts: renders Grove's right-click menu inside
        // the guest (see GUEST_CONTEXT_MENU_SCRIPT). The only guest→main bridge
        // available, since guests have no IPC/preload.
        .initialization_script(GUEST_CONTEXT_MENU_SCRIPT)
        // NOTE: on_navigation fires for subframe (iframe) navigations too, so
        // it must only filter — never emit nav events, or embedded frames
        // would overwrite the address bar. URL tracking happens in
        // on_page_load, which is main-frame only.
        .on_navigation(move |url| {
            // Intercept the guest menu's callback channel: handle the action and
            // always deny the navigation (it is a message, not a real load).
            if url.scheme() == GUEST_MENU_SCHEME {
                handle_guest_menu_action(&nav_app, &nav_tab, url.as_str());
                return false;
            }
            scheme_allowed(url)
        })
        .on_page_load(move |_webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            emit_nav(
                &load_app,
                &load_tab,
                payload.url().to_string(),
                None,
                loading,
            );
        })
        .on_document_title_changed(move |webview, title| {
            let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
            emit_nav(&title_app, &title_tab, url, Some(title), false);
        })
        // target="_blank" links / window.open: never create a native window —
        // the frontend opens a Grove browser tab instead (browser:new-window).
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                let _ = new_window_app.emit(
                    "browser:new-window",
                    BrowserNewWindowPayload {
                        opener_tab_id: new_window_tab.clone(),
                        url: url.to_string(),
                    },
                );
            }
            NewWindowResponse::Deny
        });

    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| e.to_string())?;

    map.insert(
        tab_id,
        BrowserEntry {
            webview,
            bounds: Some(bounds),
        },
    );
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(
    state: State<'_, BrowserState>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("Refusing to load non-http(s) URL: {}", parsed));
    }

    let map = state.0.lock().map_err(|e| e.to_string())?;
    match map.get(&tab_id) {
        Some(entry) => entry.webview.navigate(parsed).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn browser_go_back(state: State<'_, BrowserState>, tab_id: String) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    match map.get(&tab_id) {
        Some(entry) => entry.webview.eval("history.back()").map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn browser_go_forward(state: State<'_, BrowserState>, tab_id: String) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    match map.get(&tab_id) {
        Some(entry) => entry
            .webview
            .eval("history.forward()")
            .map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn browser_reload(state: State<'_, BrowserState>, tab_id: String) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    match map.get(&tab_id) {
        Some(entry) => entry.webview.reload().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn browser_set_bounds(
    state: State<'_, BrowserState>,
    tab_id: String,
    bounds: Bounds,
) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    let entry = match map.get_mut(&tab_id) {
        Some(entry) => entry,
        None => return Ok(()),
    };
    entry.bounds = Some(bounds);
    entry
        .webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    entry
        .webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_set_visible(
    state: State<'_, BrowserState>,
    tab_id: String,
    visible: bool,
) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let webview = match map.get(&tab_id) {
        Some(entry) => &entry.webview,
        None => return Ok(()),
    };
    if visible {
        webview.show().map_err(|e| e.to_string())
    } else {
        webview.hide().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn browser_close(state: State<'_, BrowserState>, tab_id: String) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    match map.remove(&tab_id) {
        Some(entry) => entry.webview.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Open the Web Inspector for a browser webview as a SEPARATE window.
///
/// A docked WKWebView inspector resizes the child webview to fill the window,
/// painting over the app UI. There is no public API for the dock mode, so on
/// macOS we go through WebKit's private `-[WKWebView _inspector]` →
/// `_WKInspector` and call `show` + `detach` to force a standalone inspector
/// window (WebKit remembers the detached state afterwards).
#[tauri::command]
pub fn browser_open_devtools(
    state: State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let Some(entry) = map.get(&tab_id) else {
        return Ok(());
    };
    open_detached_devtools(&entry.webview, tab_id);
    Ok(())
}

/// Open the Web Inspector for a browser webview as a SEPARATE (detached)
/// window. Shared by the `browser_open_devtools` command and the guest
/// right-click "Inspect Page" menu item.
///
/// A docked WKWebView inspector resizes the child webview to fill the window,
/// painting over the app UI. There is no public API for the dock mode, so on
/// macOS we go through WebKit's private `-[WKWebView _inspector]` →
/// `_WKInspector` and call `show` + `detach` to force a standalone inspector
/// window (WebKit remembers the detached state afterwards).
fn open_detached_devtools(webview: &Webview, tab_id: String) {
    #[cfg(target_os = "macos")]
    {
        // Sequence: connect (headless) → wait until the frontend is connected
        // → detach → show. Connecting first means the inspector never appears
        // docked: by the time it becomes visible its attachment state is
        // already "detached", so it opens as a standalone window. All
        // inspector calls are dispatched to the main thread via with_webview.
        let target = webview.clone();
        let restore_tab = tab_id.clone();
        std::thread::spawn(move || {
            use std::sync::mpsc;
            use std::time::Duration;

            /// Run an inspector call on the main thread and wait for its result.
            fn dispatch<T: Send + 'static>(
                webview: &Webview,
                f: impl Fn(*mut objc2::runtime::AnyObject) -> T + Send + 'static,
            ) -> Option<T> {
                let (tx, rx) = mpsc::channel::<Option<T>>();
                let ok = webview.with_webview(move |platform_webview| unsafe {
                    use objc2::msg_send;
                    use objc2::runtime::AnyObject;

                    let wk = platform_webview.inner() as *mut AnyObject;
                    if wk.is_null() {
                        let _ = tx.send(None);
                        return;
                    }
                    let responds: bool = msg_send![
                        &*wk,
                        respondsToSelector: objc2::sel!(_inspector)
                    ];
                    if !responds {
                        let _ = tx.send(None);
                        return;
                    }
                    let inspector: *mut AnyObject = msg_send![&*wk, _inspector];
                    if inspector.is_null() {
                        let _ = tx.send(None);
                        return;
                    }
                    let _ = tx.send(Some(f(inspector)));
                });
                if ok.is_err() {
                    return None;
                }
                rx.recv_timeout(Duration::from_millis(1500)).ok().flatten()
            }

            unsafe fn responds(inspector: *mut objc2::runtime::AnyObject, sel: objc2::runtime::Sel) -> bool {
                use objc2::msg_send;
                msg_send![&*inspector, respondsToSelector: sel]
            }

            // 1. Establish the connection without showing (fall back to show).
            let connected_start = dispatch(&target, |inspector| unsafe {
                use objc2::msg_send;
                if responds(inspector, objc2::sel!(connect)) {
                    let _: () = msg_send![&*inspector, connect];
                    true
                } else {
                    eprintln!("[grove:browser] devtools: no connect selector, using show");
                    let _: () = msg_send![&*inspector, show];
                    false
                }
            });
            if connected_start.is_none() {
                eprintln!("[grove:browser] devtools: private inspector unavailable, falling back");
                let _ = target.with_webview(|_| {});
                target.open_devtools();
                return;
            }

            // 2. Wait for the frontend connection (detach is ignored before it).
            let mut connected = false;
            for _ in 0..30 {
                std::thread::sleep(Duration::from_millis(100));
                if let Some(is_connected) = dispatch(&target, |inspector| unsafe {
                    use objc2::msg_send;
                    let c: bool = msg_send![&*inspector, isConnected];
                    c
                }) {
                    if is_connected {
                        connected = true;
                        break;
                    }
                }
            }
            eprintln!("[grove:browser] devtools: connected={connected}");

            // 3. Force detached state, then show as a standalone window.
            let _ = dispatch(&target, |inspector| unsafe {
                use objc2::msg_send;
                let _: () = msg_send![&*inspector, detach];
                let _: () = msg_send![&*inspector, show];
            });
            eprintln!("[grove:browser] devtools: detach+show sent");

            // 4. Safety net: if a transient docked phase mangled the webview
            // frame, restore the last frontend-driven bounds (read at restore
            // time so a concurrent resize isn't clobbered with stale values).
            let restore = target
                .app_handle()
                .state::<BrowserState>()
                .0
                .lock()
                .ok()
                .and_then(|map| map.get(&restore_tab).and_then(|entry| entry.bounds));
            if let Some(bounds) = restore {
                let _ = target.set_position(LogicalPosition::new(bounds.x, bounds.y));
                let _ = target.set_size(LogicalSize::new(bounds.width, bounds.height));
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    webview.open_devtools();
}

/// Close every browser webview. A freshly reloaded renderer calls this once to
/// clean up webviews orphaned by its previous session (tab state is in-memory).
#[tauri::command]
pub fn browser_close_all(state: State<'_, BrowserState>) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    for (_, entry) in map.drain() {
        let _ = entry.webview.close();
    }
    Ok(())
}
