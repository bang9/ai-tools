# Terminal Link Open Policy

**Date**: 2026-04-02

## Summary

Grove intercepts URL opens from terminal processes via a shell wrapper and routes them through a Unix domain socket. This gives Grove control over how URLs are opened (external browser vs. future internal browser tab), based on the `terminalLinkOpenMode` preference.

The socket-backed `open` wrapper path is currently wired by the Tauri runtime. Electron still uses the same frontend `openUrl()` preference routing for xterm link clicks, but the Electron main process does not currently start the Grove URL socket listener.

## Architecture

```
Terminal process (Claude Code, shell, etc.)
  └─ open https://example.com
       └─ ~/.grove/bin/open (wrapper, shadows /usr/bin/open)
            └─ Unix socket (~/.grove/open-url.sock)
                 └─ grove-core url_open listener
                      └─ Tauri event "grove:open-url"
                           └─ Frontend url-open.ts → preference routing
```

## Two Link-Click Paths

| Context                                      | Handler        | Path                                                                |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------- |
| **Claude Code** (fullscreen, `NO_FLICKER=1`) | `open` wrapper | Claude Code mouse click → `open` command → wrapper → socket → Grove |
| **Regular terminal / Codex**                 | WebLinksAddon  | xterm click handler → `openUrl()` → preference routing              |

The WebLinksAddon handler checks `aiSessions[ptyId].tool`; when the active tool is `"claude"`, the addon skips opening (the wrapper handles it) to avoid duplicates.

## Preference: `terminalLinkOpenMode`

Stored in `~/.grove/config.json` under `preferences.terminalLinkOpenMode`. Default: `external-with-localhost-internal`.

| Mode                               | Behavior                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| `external`                         | All URLs open in system browser                                                            |
| `internal`                         | All URLs open in Grove (not yet implemented, falls back to external)                       |
| `external-with-localhost-internal` | localhost/127.0.0.1/::1 open in Grove (not yet implemented), others open in system browser |

## Components

### Shell wrapper (`~/.grove/bin/open`)

- Installed by `grove-core/src/tool_hooks.rs` via `ensure_installed()`
- `~/.grove/bin` is prepended to PATH by `build_enriched_path()` in `process_env.rs`
- Matches HTTP(S) URLs → sends to socket → exits 0
- Non-URL args → passes through to `/usr/bin/open`
- Falls back to `/usr/bin/open` if socket is unavailable

### Socket listener (`grove-core/src/url_open.rs`)

- Binds `~/.grove/open-url.sock` at app startup via `eventbus::init()`
- 2-second read timeout per connection
- Emits `grove:open-url` Tauri event with the URL string
- Cleans up socket file on `RunEvent::Exit`

### Frontend handler (`src/lib/url-open.ts`)

- `initUrlOpenPipe()` — subscribes to `grove:open-url` events (initialized in `App.tsx`)
- `openUrl(url)` — reads cached `terminalLinkOpenMode`, routes accordingly
- `isSafeExternalUrl(uri)` — protocol allowlist (http, https, mailto), used by WebLinksAddon

### WebLinksAddon (`src/lib/terminal-runtime.ts`)

- Provides visual link underlines in terminal
- Handler skips when `aiSessions[ptyId].tool === "claude"` (wrapper handles)
- Otherwise calls `openUrl(uri)` for preference-based routing
