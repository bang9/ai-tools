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
    // True for a document-title change: pure title metadata that must NOT drive
    // the frontend's history push/replace classification. WKWebView reports a
    // title change as a settled (loading=false) event carrying the current URL;
    // without this flag the store treats it as a same-page redirect and collapses
    // the back stack (Tauri's canGoBack derives from the FE index).
    title_only: bool,
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

/// Payload for the `browser:grab` event emitted when the user picks an element
/// while grab mode is armed. `data` is the raw JSON string produced by the guest
/// picker (`GUEST_GRAB_SCRIPT`); the renderer parses and formats it.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserGrabPayload {
    tab_id: String,
    data: String,
}

/// Payload for the `browser:find` event emitted when the guest find helper
/// reports a search result. `active` is the 1-based ordinal of the current
/// match (0 when there are none); `total` is the match count.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserFindPayload {
    tab_id: String,
    active: u32,
    total: u32,
}

/// Payload for the `browser:find-open` event emitted when the user presses
/// Cmd/Ctrl+F over the page (the native webview has focus, so the app frame
/// never sees the keychord). The renderer opens its find bar in response.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserFindOpenPayload {
    tab_id: String,
}

/// Payload for the `browser:favicon` event emitted when the guest resolves the
/// page favicon. `page_url` associates it with the right history entry even if
/// a later navigation is already in flight.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserFaviconPayload {
    tab_id: String,
    page_url: String,
    favicon_url: String,
}

/// Schemes a page (or its subframes) may navigate to. `data`/`blob` are common
/// in embedded content; `file` backs local HTML previews opened from the file
/// viewer; everything else — notably custom app schemes like `tauri:` — is
/// blocked so untrusted pages can never reach app internals.
fn scheme_allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "about" | "data" | "blob" | "file")
}

/// Custom scheme the injected guest right-click menu navigates to in order to
/// call back into main for actions a sandboxed guest cannot perform itself
/// (Inspect Page, Open in Default Browser, Open Link in New Tab). The
/// navigation is always denied — it is a one-way message channel, not a real
/// load. Grove's guest webviews have zero IPC/preload access, so this denied
/// navigation is the only bridge from guest → main.
const GUEST_MENU_SCHEME: &str = "grovemenu";

/// Custom scheme the injected grab picker navigates to when the user clicks an
/// element while grab mode is armed, carrying the extracted element payload in a
/// `data` query param. Like `grovemenu://`, the navigation is always denied — it
/// is the guest → main message channel for delivering the picked element.
const GUEST_GRAB_SCHEME: &str = "grovegrab";

/// Custom scheme the injected find-in-page helper navigates to when it needs to
/// report a search result (`active`/`total` match counts) back to the app. Like
/// the other guest schemes, the navigation is always denied — it is the guest →
/// main channel carrying the result of `window.__groveFind`.
const GUEST_FIND_SCHEME: &str = "grovefind";

/// Custom scheme the injected favicon detector navigates to when it resolves the
/// page's favicon (WKWebView has no `page-favicon-updated` event). Like the
/// other guest schemes the navigation is always denied — it carries the favicon
/// URL and the page URL back to the app.
const GUEST_FAVICON_SCHEME: &str = "grovefavicon";

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

/// Injected into every browser guest before page scripts run. Implements the
/// "grab" element picker: while armed, the hovered element is highlighted with a
/// fixed overlay and a click extracts a compact JSON payload (tag, selector,
/// text/html slices, rect, page url/title) and posts it back over the
/// `grovegrab://` channel. All styling is inline so the page cannot restyle or
/// observe it; the overlay uses `pointer-events:none` so hit-testing sees the
/// real element underneath. Kept as one idempotent IIFE so re-injection on every
/// navigation is safe.
const GUEST_GRAB_SCRIPT: &str = r#"
(function () {
  if (window.__groveGrab) return;
  window.__groveGrab = true;
  var SCHEME = 'grovegrab://g?';
  var armed = false;
  var overlay = null;
  var lastEl = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.style.cssText =
      'all:initial;position:fixed;z-index:2147483647;pointer-events:none;box-sizing:border-box;' +
      'outline:2px solid #3b82f6;background:rgba(59,130,246,0.18);border-radius:2px';
    return overlay;
  }
  function moveOverlay(el) {
    var r = el.getBoundingClientRect();
    var o = ensureOverlay();
    if (!o.isConnected) (document.documentElement || document.body).appendChild(o);
    o.style.left = r.left + 'px';
    o.style.top = r.top + 'px';
    o.style.width = r.width + 'px';
    o.style.height = r.height + 'px';
  }
  function esc(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }
  // Prefer a stable #id; otherwise a short nth-of-type path (up to 4 ancestors).
  function selectorFor(el) {
    if (el.id) return '#' + esc(el.id);
    var parts = [];
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      if (node.id) { parts.unshift('#' + esc(node.id)); break; }
      var tag = node.tagName.toLowerCase();
      var nth = 1;
      var sib = node;
      while ((sib = sib.previousElementSibling)) {
        if (sib.tagName === node.tagName) nth++;
      }
      parts.unshift(tag + ':nth-of-type(' + nth + ')');
      node = node.parentElement;
    }
    return parts.join('>');
  }
  function payloadFor(el) {
    var r = el.getBoundingClientRect();
    var cls = typeof el.className === 'string' ? el.className : '';
    return {
      tag: el.tagName.toLowerCase(),
      selector: selectorFor(el),
      text: (el.innerText || '').slice(0, 500),
      html: (el.outerHTML || '').slice(0, 2000),
      id: el.id || '',
      classes: cls.slice(0, 300),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      pageUrl: location.href,
      pageTitle: document.title
    };
  }
  function onMove(e) {
    if (!armed) return;
    var el = e.target;
    if (!el || el.nodeType !== 1 || el === overlay) return;
    lastEl = el;
    moveOverlay(el);
  }
  function onClick(e) {
    if (!armed) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target && e.target.nodeType === 1 && e.target !== overlay ? e.target : lastEl;
    if (!el) { disarm(); return; }
    var data;
    try { data = encodeURIComponent(JSON.stringify(payloadFor(el))); }
    catch (err) { disarm(); return; }
    disarm();
    location.href = SCHEME + 'data=' + data;
  }
  function onKey(e) {
    if (armed && e.key === 'Escape') { e.preventDefault(); disarm(); }
  }
  function arm() {
    if (armed) return;
    armed = true;
    (document.documentElement || document.body).style.cursor = 'crosshair';
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }
  function disarm() {
    armed = false;
    (document.documentElement || document.body).style.cursor = '';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (overlay && overlay.isConnected) overlay.remove();
    lastEl = null;
  }
  window.__groveGrabArm = arm;
  window.__groveGrabDisarm = disarm;
})();
"#;

/// Injected into every browser guest before page scripts run. Implements
/// find-in-page entirely in the guest, since WKWebView exposes no wry search
/// API. Matches are highlighted with the CSS Custom Highlight API — which paints
/// ranges WITHOUT mutating the DOM, so it never disturbs the page's own layout
/// or a framework's virtual DOM. `window.__groveFind(query, forward, findNext)`
/// searches (or steps to the next/previous match) and reports `{active,total}`
/// back over the `grovefind://` channel; `window.__groveFindStop()` clears it.
/// One self-contained IIFE so re-injection on every navigation is idempotent.
const GUEST_FIND_SCRIPT: &str = r#"
(function () {
  if (window.__groveFind) return;
  var SCHEME = 'grovefind://f?';
  var HL = 'grove-find';
  var HL_ACTIVE = 'grove-find-active';
  // CSS Custom Highlight API (WKWebView / Safari 17.2+). Absent → find still
  // counts and scrolls, just without the paint.
  var supported = !!(window.CSS && CSS.highlights && window.Highlight);
  var state = { query: '', ranges: [], index: -1 };

  function ensureStyle() {
    if (document.getElementById('__grove_find_style__')) return;
    var s = document.createElement('style');
    s.id = '__grove_find_style__';
    s.textContent =
      '::highlight(' + HL + '){background:#ffe27a;color:#111}' +
      '::highlight(' + HL_ACTIVE + '){background:#ff9632;color:#111}';
    (document.head || document.documentElement).appendChild(s);
  }
  function clearHighlights() {
    if (!supported) return;
    CSS.highlights.delete(HL);
    CSS.highlights.delete(HL_ACTIVE);
  }
  // Collect a Range per case-insensitive match. Matches within a single text
  // node only (no cross-node spanning) — enough for ordinary page search.
  function collect(query) {
    var ranges = [];
    if (!query) return ranges;
    var needle = query.toLowerCase();
    var nlen = needle.length;
    var root = document.body || document.documentElement;
    if (!root) return ranges;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || node.nodeValue.toLowerCase().indexOf(needle) === -1) {
          return NodeFilter.FILTER_REJECT;
        }
        var p = node.parentNode;
        while (p) {
          var t = p.nodeName;
          if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      var hay = node.nodeValue.toLowerCase();
      var from = 0;
      var idx;
      while ((idx = hay.indexOf(needle, from)) !== -1) {
        try {
          var r = document.createRange();
          r.setStart(node, idx);
          r.setEnd(node, idx + nlen);
          ranges.push(r);
        } catch (e) {}
        from = idx + nlen;
      }
    }
    return ranges;
  }
  function paint() {
    if (!supported) return;
    if (state.ranges.length === 0) { clearHighlights(); return; }
    ensureStyle();
    var all = new Highlight();
    for (var i = 0; i < state.ranges.length; i++) all.add(state.ranges[i]);
    CSS.highlights.set(HL, all);
    if (state.index >= 0 && state.index < state.ranges.length) {
      var active = new Highlight();
      active.add(state.ranges[state.index]);
      CSS.highlights.set(HL_ACTIVE, active);
    } else {
      CSS.highlights.delete(HL_ACTIVE);
    }
  }
  function scrollActive() {
    var r = state.ranges[state.index];
    if (!r) return;
    var rect = r.getBoundingClientRect();
    var vh = window.innerHeight || 0;
    var vw = window.innerWidth || 0;
    if (rect.top < 0 || rect.bottom > vh || rect.left < 0 || rect.right > vw) {
      var el = r.startContainer.parentElement || r.startContainer.parentNode;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
    }
  }
  function report() {
    var total = state.ranges.length;
    var active = total > 0 && state.index >= 0 ? state.index + 1 : 0;
    location.href = SCHEME + 'active=' + active + '&total=' + total;
  }
  window.__groveFind = function (query, forward, findNext) {
    query = query || '';
    if (!query) { state = { query: '', ranges: [], index: -1 }; clearHighlights(); report(); return; }
    if (findNext && query === state.query && state.ranges.length > 0) {
      var n = state.ranges.length;
      state.index = ((state.index + (forward ? 1 : -1)) % n + n) % n;
    } else {
      state.query = query;
      state.ranges = collect(query);
      state.index = state.ranges.length > 0 ? 0 : -1;
    }
    paint();
    scrollActive();
    report();
  };
  window.__groveFindStop = function () {
    state = { query: '', ranges: [], index: -1 };
    clearHighlights();
  };
  // The native webview has keyboard focus while browsing, so a Cmd/Ctrl+F
  // pressed over the page never reaches the app frame. Intercept it here and
  // ask the app to open its find bar (grovefind://o channel, open=1).
  document.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      location.href = SCHEME + 'open=1';
    }
  }, true);
})();
"#;

/// Injected into every browser guest before page scripts run. WKWebView has no
/// `page-favicon-updated` event, so the favicon is resolved in the guest:
/// prefer the largest declared `<link rel~="icon">`, else fall back to the
/// origin `/favicon.ico`. The result (http(s)/data only, so the app chrome can
/// render it in an <img>) is posted back over `grovefavicon://`. A Mutation
/// observer on <head> re-reports when SPAs swap their icon after load. One
/// self-contained IIFE so re-injection on every navigation is idempotent.
const GUEST_FAVICON_SCRIPT: &str = r#"
(function () {
  if (window.__groveFavicon) return;
  window.__groveFavicon = true;
  var SCHEME = 'grovefavicon://f?';
  var last = '';
  function pick() {
    var links = document.querySelectorAll(
      'link[rel~="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"],link[rel="apple-touch-icon-precomposed"]'
    );
    var best = '';
    var bestSize = -1;
    for (var i = 0; i < links.length; i++) {
      var href = links[i].href;
      if (!href) continue;
      var sizes = links[i].getAttribute('sizes') || '';
      var m = sizes.match(/(\d+)x\d+/);
      var size = m ? parseInt(m[1], 10) : 16;
      if (size > bestSize) { bestSize = size; best = href; }
    }
    if (!best) {
      try { best = location.origin + '/favicon.ico'; } catch (e) {}
    }
    return best;
  }
  function report() {
    var href = pick();
    if (!href || href === last) return;
    if (!/^(https?:|data:image\/)/i.test(href)) return;
    last = href;
    try {
      location.href = SCHEME + 'favicon=' + encodeURIComponent(href) +
        '&page=' + encodeURIComponent(location.href);
    } catch (e) {}
  }
  function schedule() { setTimeout(report, 0); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }
  window.addEventListener('load', schedule);
  try {
    var mo = new MutationObserver(schedule);
    var head = document.head || document.documentElement;
    if (head) {
      mo.observe(head, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['href', 'rel', 'sizes']
      });
    }
  } catch (e) {}
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
    title_only: bool,
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
            title_only,
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
    if !matches!(parsed.scheme(), "http" | "https" | "file") {
        return Err(format!("Refusing to load non-http(s)/file URL: {}", parsed));
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
        // Injected before page scripts: the grab element picker (see
        // GUEST_GRAB_SCRIPT). Armed/disarmed via browser_set_grab_mode; picked
        // elements post back over the grovegrab:// channel below.
        .initialization_script(GUEST_GRAB_SCRIPT)
        // Injected before page scripts: find-in-page (see GUEST_FIND_SCRIPT).
        // Driven by browser_find/browser_stop_find; reports match counts back
        // over the grovefind:// channel below.
        .initialization_script(GUEST_FIND_SCRIPT)
        // Injected before page scripts: favicon resolver (see
        // GUEST_FAVICON_SCRIPT). Reports the page favicon over the
        // grovefavicon:// channel below.
        .initialization_script(GUEST_FAVICON_SCRIPT)
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
            // Grab picker delivering a picked element: forward the raw JSON to
            // the renderer and deny the navigation (it is a message, not a load).
            if url.scheme() == GUEST_GRAB_SCHEME {
                let data = url
                    .query_pairs()
                    .find(|(key, _)| key == "data")
                    .map(|(_, value)| value.into_owned())
                    .unwrap_or_default();
                let _ = nav_app.emit(
                    "browser:grab",
                    BrowserGrabPayload {
                        tab_id: nav_tab.clone(),
                        data,
                    },
                );
                return false;
            }
            // Find helper reporting a search result: forward the counts to the
            // renderer and deny the navigation (it is a message, not a load).
            if url.scheme() == GUEST_FIND_SCHEME {
                let mut active = 0u32;
                let mut total = 0u32;
                let mut open = false;
                for (key, value) in url.query_pairs() {
                    match key.as_ref() {
                        "active" => active = value.parse().unwrap_or(0),
                        "total" => total = value.parse().unwrap_or(0),
                        "open" => open = value == "1",
                        _ => {}
                    }
                }
                if open {
                    let _ = nav_app.emit(
                        "browser:find-open",
                        BrowserFindOpenPayload {
                            tab_id: nav_tab.clone(),
                        },
                    );
                } else {
                    let _ = nav_app.emit(
                        "browser:find",
                        BrowserFindPayload {
                            tab_id: nav_tab.clone(),
                            active,
                            total,
                        },
                    );
                }
                return false;
            }
            // Favicon resolver reporting the page icon: forward it and deny the
            // navigation (it is a message, not a load).
            if url.scheme() == GUEST_FAVICON_SCHEME {
                let mut favicon_url = String::new();
                let mut page_url = String::new();
                for (key, value) in url.query_pairs() {
                    match key.as_ref() {
                        "favicon" => favicon_url = value.into_owned(),
                        "page" => page_url = value.into_owned(),
                        _ => {}
                    }
                }
                if !favicon_url.is_empty() {
                    let _ = nav_app.emit(
                        "browser:favicon",
                        BrowserFaviconPayload {
                            tab_id: nav_tab.clone(),
                            page_url,
                            favicon_url,
                        },
                    );
                }
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
                false,
            );
        })
        .on_document_title_changed(move |webview, title| {
            let url = webview.url().map(|u| u.to_string()).unwrap_or_default();
            // title_only=true: pure title metadata, never a navigation. See
            // BrowserNavPayload::title_only.
            emit_nav(&title_app, &title_tab, url, Some(title), false, true);
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

/// Give the main window an OPAQUE backing so the browser "punchout" never
/// bleeds the desktop. The window is created `transparent: true` (which makes
/// the main webview composite transparently — required for the punchout hole),
/// but a transparent window has no backing, so any transparent hole with no
/// browser behind it (e.g. while switching mission↔project) would reveal the
/// desktop. Setting the NSWindow opaque with a dark background color puts a
/// solid layer behind everything: the hole shows the browser when present, or
/// this color otherwise — never the desktop. macOS only; call once at startup.
pub fn install_opaque_window_backing(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let Some(win) = app.get_webview_window("main") else {
            return;
        };
        let _ = win.with_webview(|platform_webview| unsafe {
            use objc2::runtime::AnyObject;
            use objc2::{class, msg_send};

            let wk = platform_webview.inner() as *mut AnyObject;
            if wk.is_null() {
                return;
            }
            let ns_window: *mut AnyObject = msg_send![&*wk, window];
            if ns_window.is_null() {
                return;
            }
            let color: *mut AnyObject = msg_send![
                class!(NSColor),
                colorWithSRGBRed: 0.09f64, green: 0.09f64, blue: 0.10f64, alpha: 1.0f64
            ];
            let _: () = msg_send![&*ns_window, setBackgroundColor: color];
            let _: () = msg_send![&*ns_window, setOpaque: true];
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Move a child browser webview to the BACK (`behind = true`) or FRONT
/// (`behind = false`) of its superview — the macOS half of the "punchout"
/// overlay.
///
/// LANDMINE: the browser webview must sit in FRONT by default, or the page is
/// unclickable — with the browser behind the transparent main webview, mouse
/// events land on the React layer (macOS routes input by subview order, not
/// visual transparency), not the page. So we only move it BEHIND while a DOM
/// overlay (the address dropdown) is open — you're interacting with the overlay
/// then, not the page — and move it back to FRONT when the overlay closes. See
/// `browser_set_behind` + the caller in BrowserPanel.
fn reorder_browser_webview(webview: &Webview, behind: bool) {
    #[cfg(target_os = "macos")]
    {
        let _ = webview.with_webview(move |platform_webview| unsafe {
            use objc2::msg_send;
            use objc2::runtime::AnyObject;

            let wk = platform_webview.inner() as *mut AnyObject;
            if wk.is_null() {
                return;
            }
            let superview: *mut AnyObject = msg_send![&*wk, superview];
            if superview.is_null() {
                return;
            }
            // NSWindowBelow = -1 (back), NSWindowAbove = 1 (front); relativeTo nil.
            let ordering: isize = if behind { -1 } else { 1 };
            let nil: *mut AnyObject = std::ptr::null_mut();
            let _: () =
                msg_send![&*superview, addSubview: wk, positioned: ordering, relativeTo: nil];
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (webview, behind);
}

/// Move a tab's browser webview behind the transparent main webview (so a DOM
/// overlay composites over the page) or back in front (so the page is
/// clickable). Silent no-op for an unknown tab.
#[tauri::command]
pub fn browser_set_behind(
    state: State<'_, BrowserState>,
    tab_id: String,
    behind: bool,
) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = map.get(&tab_id) {
        reorder_browser_webview(&entry.webview, behind);
    }
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(
    state: State<'_, BrowserState>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https" | "file") {
        return Err(format!("Refusing to load non-http(s)/file URL: {}", parsed));
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

/// Arm or disarm the guest grab element picker for a tab. Silent no-op for an
/// unknown tab. The guest disarms itself after a pick, so the frontend only
/// needs to call this to enter pick mode (or to cancel it).
#[tauri::command]
pub fn browser_set_grab_mode(
    state: State<'_, BrowserState>,
    tab_id: String,
    enabled: bool,
) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let Some(entry) = map.get(&tab_id) else {
        return Ok(());
    };
    let script = if enabled {
        "window.__groveGrabArm&&window.__groveGrabArm()"
    } else {
        "window.__groveGrabDisarm&&window.__groveGrabDisarm()"
    };
    entry.webview.eval(script).map_err(|e| e.to_string())
}

/// Run find-in-page in a tab's guest. `find_next` steps to the next/previous
/// match of the SAME query (honouring `forward`); otherwise it starts a fresh
/// search. The guest reports `{active,total}` back over the `browser:find`
/// event. Silent no-op for an unknown tab.
#[tauri::command]
pub fn browser_find(
    state: State<'_, BrowserState>,
    tab_id: String,
    query: String,
    forward: bool,
    find_next: bool,
) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    let Some(entry) = map.get(&tab_id) else {
        return Ok(());
    };
    // JSON-encode the query so it is a safe JS string literal (quotes, escapes).
    let query_lit = serde_json::to_string(&query).map_err(|e| e.to_string())?;
    let script = format!(
        "window.__groveFind&&window.__groveFind({query_lit},{forward},{find_next})"
    );
    entry.webview.eval(&script).map_err(|e| e.to_string())
}

/// Clear a tab's find-in-page highlights and reset its search state. Silent
/// no-op for an unknown tab.
#[tauri::command]
pub fn browser_stop_find(state: State<'_, BrowserState>, tab_id: String) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    match map.get(&tab_id) {
        Some(entry) => entry
            .webview
            .eval("window.__groveFindStop&&window.__groveFindStop()")
            .map_err(|e| e.to_string()),
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

/// Detect installed browsers whose cookies Grove can import.
#[tauri::command]
pub fn detect_installed_browsers() -> Vec<grove_core::browser_cookies::DetectedBrowser> {
    grove_core::browser_cookies::detect_installed_browsers_impl()
}

/// Import cookies from `family` (optionally scoped to `host`) into WebKit's
/// shared cookie store so the embedded browser is logged in. Decryption +
/// Keychain access run on this command thread; the objc2 cookie injection is
/// hopped to the main thread (WebKit objects are not thread-safe).
#[tauri::command]
pub fn browser_import_cookies(
    app: AppHandle,
    family: String,
    host: Option<String>,
) -> Result<usize, String> {
    let cookies = grove_core::browser_cookies::read_browser_cookies_impl(&family, host.as_deref())?;
    if cookies.is_empty() {
        return Ok(0);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let count = crate::browser_cookie_inject::set_cookies(&cookies);
        let _ = tx.send(count);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())
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
