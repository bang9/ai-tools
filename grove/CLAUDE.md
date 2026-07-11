# Grove

Dual-platform macOS desktop app (Tauri v2 by default, Electron optional) — Git project manager + split terminal + diff viewer.

## Feature Docs

- [Grove Configs and Preferences](docs/configs-preferences.md) — `config.json` model, project metadata, category defaults, and app-wide preference I/O
- [Terminal Broadcast](docs/terminal-broadcast.md) — PiP, Mirror, consumer model, persistence policy
- [Terminal Resize Pipeline](docs/terminal-resize.md) — fit-stability loop, viewport preservation, PTY resize dedupe, flicker masks, regression checklist
- [Grove Hooks Runtime Design](docs/grove-hooks-runtime-design.md) — Claude/Codex hook parity, CODEX_HOME overlay delivery, status tracking architecture
- [Context Menu](docs/context-menu.md) — Sidebar right-click menu, launcher menu items, notes, and extending with extraItems
- [Terminal Link Open](docs/open-link.md) — URL interception via open wrapper, Unix socket routing, preference-based link handling
- [Preferences UI](docs/preferences-ui.md) — Modal structure, four-tab layout, heading hierarchy rules, file layout, data flow

## Stack

- **Backend**: Rust (Tauri v2, portable-pty, git2, plist)
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4
- **UI**: allotment (split panes), xterm.js (terminal), lucide-react (icons), Zustand (state)

## Commands

```bash
cd grove
pnpm install
pnpm lint              # oxlint for src (custom rules in lint/classname-plugin.js via .oxlintrc.json jsPlugins)
pnpm test              # Vitest
pnpm test:core         # grove-core Rust tests
pnpm dev:tauri         # Dev server + Tauri window (default)
pnpm build:tauri       # Production build (Tauri)
pnpm dev:electron      # Dev server + Electron window
pnpm build:electron    # Production build (Electron)
```

## Platform Abstraction

Dual-platform app: Tauri (default) and Electron. Build target selected by `GROVE_TARGET` env var.

```
src/lib/platform/
├── types.ts       # Platform interface (invoke, listen, isFullscreen, onResized)
├── index.ts       # Re-exports resolved platform
├── tauri.ts       # Tauri impl — @tauri-apps/api
└── electron.ts    # Electron impl — window.groveElectron bridge
```

- `@platform` Vite alias resolves to `src/lib/platform/${GROVE_TARGET}.ts` at build time (default: `tauri`)
- Both files export the same `platform` object + matching command wrappers
- Platform-specific code (drag region props, error sanitization) lives in each file, not shared

## Structure

```
src/
├── components/
│   ├── ui/                # Design system: Button, Input, Badge, Dialog, Toast
│   ├── sidebar/           # Project tree, worktree, mission management
│   ├── terminal/          # xterm.js + PTY + split panes + global terminal
│   ├── tab/               # AppTabBar, ChangesPanel, PipTerminal
│   └── diff/              # Commit list, file list, diff viewer, hunk actions
├── store/                 # Zustand: project, terminal, diff, toast, broadcast, mission, note, preferences, panel-layout, tab
├── hooks/                 # useProject, useTerminal, useDiff, useToast, useFullscreen, useMission, ...
├── lib/
│   ├── platform/          # Platform abstraction (see above)
│   ├── split-tree.ts      # Terminal layout tree operations (pure functions)
│   ├── terminal-*.ts      # Terminal subsystems (input, fonts, runtime, session, startup, command-pipeline)
│   ├── broadcast-*.ts     # Terminal broadcast (PiP, Mirror)
│   ├── overlay.tsx         # Overlay/modal system (Zustand queue)
│   ├── cn.ts              # clsx + tailwind-merge utility
│   └── sync-manager.ts    # State synchronization
├── types/                 # Shared TypeScript interfaces
├── Layout.tsx             # 3-panel allotment layout
└── App.tsx                # Root (Layout + ToastContainer)

src-tauri/src/             # Tauri v2 command router (thin layer over grove-core)
├── lib.rs                 # Tauri command definitions
├── main.rs                # Entry point
└── eventbus.rs            # Event broadcasting to frontend

src-electron/              # Electron runtime
├── main.ts                # Main process (IPC, window, native addon)
├── preload.ts             # Context isolation bridge
└── native/                # NAPI native addon bindings

grove-core/src/            # Shared Rust backend (used by both Tauri and Electron via NAPI)
├── config.rs              # App config + terminal layout persistence
├── git_project.rs         # Clone, worktree, project CRUD
├── git_diff.rs            # Diff, stage/unstage/discard (file/hunk/line)
├── ide.rs                 # IDE and Git GUI launcher resolution
├── note.rs                # Sidebar note persistence
├── pty.rs                 # PTY spawn, read, write, resize, close
├── terminal_theme.rs      # Terminal.app color auto-detection (AppleScript)
├── mission.rs             # Mission CRUD
├── tool_hooks.rs          # Claude/Codex hook execution
├── url_open.rs            # open-wrapper Unix socket listener
├── worktree_lifecycle.rs  # Worktree init/cleanup
├── process_env.rs         # Environment variable diagnostics
└── logger.rs              # Structured logging
```

## App Data

- `~/.grove/config.json` — project entries, baseDir, terminal theme override, preferences
- `~/.grove/terminal-layouts.json` — split tree structure + size ratios per worktree
- `~/.grove/terminal-session-snapshots.json` — terminal scrollback/CWD snapshots per pane
- `~/.grove/panel-layouts.json` — main panel and global terminal ratios
- `~/.grove/missions.json` — mission metadata and project membership
- `~/.grove/notes.json` — sidebar notes keyed by source, worktree, and mission ids
- `~/.grove/missions/<id>/` — mission worktree roots
- `<baseDir>/<host>/<org>/<repo>/source/` — SOT clone synced to the remote default branch or configured base branch
- `<baseDir>/<host>/<org>/<repo>/worktrees/<name>/` — git worktrees

Project metadata in `config.json` carries `worktreeOrder`, `stackedParents`, optional `baseBranch`, collapsed state, optional `categoryId`, and optional `envSync` settings. Project category definitions live in `preferences.projectCategories`; individual project assignments live on each project entry.

## Code Style

### Production subprocess PATH

- Grove production builds run as GUI apps, so backend Rust code cannot assume the ambient process `PATH` matches an interactive shell
- When backend code spawns user-facing tools or resolves binaries (`claude`, `codex`, `bun`, `gh`, etc.), use `grove_core::process_env::enriched_path()` or `grove_core::process_env::subprocess_env_pairs()`
- Do not rely on plain `which`, `command -v`, or `Command::new(...)` inheriting the app process `PATH` for production-only flows
- If the code needs shell-derived values, use the helpers in `grove-core/src/process_env.rs` instead of re-deriving environment state locally

### Formatter output

- If you run the project formatter and it rewrites nearby files, treat those edits as part of your change
- Do not revert formatter-produced hunks just to keep a commit narrower unless the user explicitly asks for that split
- Do not describe formatter output from your own command as someone else's change; stage and commit it with the functional fix

### `cn()` for className composition

- If `className` has multiple classes, wrap it in `cn(...)`
- Use object syntax for conditional classes
- Do not use ternary expressions inside `cn(...)`

```tsx
// ❌
className={`flex ${isActive ? "bg-blue-500" : "text-gray-500"}`}
className="flex items-center gap-2"
className={cn("flex", isActive ? "bg-blue-500" : "text-gray-500")}
className={cn("flex", isActive && "bg-blue-500")}

// ✅
className={cn("flex items-center gap-2")}
className={cn("flex", {
  "bg-blue-500": isActive,
  "text-gray-500": !isActive,
})}
```

### UI primitives

```tsx
import { Button } from "../ui/button";
<Button variant="default" size="sm">
  Save
</Button>;
// Variants: default, secondary, ghost, outline, destructive, link
// Sizes: default, sm, lg, icon, icon-sm, icon-lg
```

Prefer shared primitives for app actions and standard form fields. Raw semantic controls are still used in focused UI internals such as tab buttons, segmented controls, color/range inputs, and Radix wrapper composition when the local markup needs custom behavior.

Available: `Button`, `IconButton`, `Input`, `Textarea`, `Badge`, `Dialog`, `Toast`/`Toaster`, `Popover`, `Tooltip`, `ContextMenu`, `Separator`, `Skeleton`, `Spinner`, `ResizablePanelGroup`.

### Layout sizes — 0-1 ratios, not pixels

```json
{ "sizes": [0.3, 0.7] }
```

### Zustand selectors — snapshots must be stable

- `useShallow(...)` selectors must return a top-level primitive or array/object whose shallow members stay stable for unchanged state
- Do not return `{ items: [] }`, `{ statuses: computedArray }`, or other object-wrapped freshly allocated arrays from store selectors
- If a selector naturally produces a list, return the list directly and let `useShallow(...)` compare that array
- For empty results, prefer a shared constant like `EMPTY_*` when the selector may run before any data exists
- When adding a selector around `useTerminalStore` or another Zustand store, add a regression test if an unchanged store state could still allocate new snapshot values

### State polling — use `sync-manager`

- All periodic background refresh must register a job with `lib/sync-manager.ts` (`registerSyncJob` / `unregisterSyncJob`), which runs on a single 1s tick and guards against overlapping runs via a per-job `running` flag
- Do not add raw `setInterval` for data polling inside components or hooks — it bypasses dedup, fragments the refresh surface, and hides behind component mount/unmount lifecycles
- Event-driven refresh is preferred over polling when the trigger is known (window focus, user action, mutation). Use `runJobNow(key)` to fire an existing job on demand — the `running` guard automatically dedups against an in-flight polling run
- `setInterval` is still fine for non-data concerns (animation, UI tickers, redraw scheduling)

### Tests — write alongside features

Before closing work, run `pnpm lint && pnpm test`.
