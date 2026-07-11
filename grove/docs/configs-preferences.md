# Grove Configs and Preferences

**Date**: 2026-04-24

## Summary

Grove stores app-wide configuration in `~/.grove/config.json`.

`config.json` currently carries four top-level groups:

- `projects` — registered project metadata, including worktree ordering, stacked parent links, category assignment, and source settings
- `baseDir` — storage root for project source clones and worktrees
- `terminalTheme` — saved terminal theme override
- `preferences` — Grove-specific behavior preferences

`preferences` is the home for user-selectable Grove behavior such as link opening policy, project list view mode, org ordering, launcher menu shortcuts, and project category definitions. It is nested under `GroveConfig`, but `AppConfig` intentionally exposes only the app-wide envelope (`baseDir`, `terminalTheme`, `preferences`) and not the registered project list.

The preferences layer provides persistence, I/O, and a Zustand store (`usePreferencesStore`). Terminal link routing is wired via `terminalLinkOpenMode` (see [Terminal Link Open](open-link.md)). Grove exposes persisted preferences in the Preferences modal under General, Categories, and Terminal tabs. The Developer tab is runtime-only and does not persist to `config.json`; it currently exposes dev console / reload actions plus terminal GC diagnostics. Sidebar context menus use `ideMenuItems` and `gitGuiMenuItems` for ordered launcher actions.

## Storage Model

### Config file path

Grove always reads and writes app config at:

```text
~/.grove/config.json
```

This path is fixed by `config_path()` in `grove-core/src/config.rs`.

### `baseDir` vs `config.json`

`baseDir` is not the path to `config.json`.

- `config.json` stays under `~/.grove/`
- `baseDir` controls where Grove stores project source clones and worktrees

Example:

```json
{
  "baseDir": "/Volumes/work/grove-data",
  "preferences": {
    "terminalLinkOpenMode": "external-with-localhost-internal",
    "projectViewMode": "default",
    "ideMenuItems": [{ "id": "webstorm" }],
    "gitGuiMenuItems": [{ "id": "sourcetree" }]
  }
}
```

With that config:

- the config file still lives at `~/.grove/config.json`
- source clones and worktrees are created under `/Volumes/work/grove-data`

## Type Model

### `AppConfig`

`AppConfig` is the full app-wide config envelope.

```ts
interface AppConfig {
  baseDir: string;
  terminalTheme?: Partial<TerminalTheme>;
  preferences: GrovePreferences;
}
```

### `GrovePreferences`

`GrovePreferences` stores user-selectable Grove behavior.

```ts
type TerminalLinkOpenMode = "external" | "internal" | "external-with-localhost-internal";

type ProjectViewMode = "default" | "group-by-orgs";

interface IdeMenuItem {
  id: string;
  displayName?: string;
  openCommand?: string;
}

type GitGuiMenuItem = IdeMenuItem;

type ProjectCategoryIconId =
  | "sprout"
  | "folder"
  | "rocket"
  | "flame"
  | "bug"
  | "wrench"
  | "book"
  | "palette"
  | "database"
  | "bot"
  | "terminal"
  | "briefcase"
  | "star"
  | "package"
  | "code"
  | "gem";

type ProjectCategoryIcon =
  { type: "emoji"; value: string } | { type: "lucide"; value: ProjectCategoryIconId };

interface ProjectCategory {
  id: string;
  name: string;
  color: string;
  icon: ProjectCategoryIcon;
}

interface GrovePreferences {
  terminalLinkOpenMode: TerminalLinkOpenMode;
  projectViewMode: ProjectViewMode;
  collapsedProjectOrgs: string[];
  projectOrgOrder: string[];
  ideMenuItems: IdeMenuItem[];
  gitGuiMenuItems: GitGuiMenuItem[];
  projectCategories: ProjectCategory[];
}
```

The Rust and TypeScript wire format matches:

- enum values are kebab-case strings
- object fields are camelCase

## Defaults

If `preferences` is missing from `config.json`, Grove falls back to `GrovePreferences::default()`.

Current defaults:

- `terminalLinkOpenMode = "external-with-localhost-internal"`
- `projectViewMode = "default"`
- `collapsedProjectOrgs = []`
- `projectOrgOrder = []`
- `ideMenuItems = [{ "id": "webstorm" }]`
- `gitGuiMenuItems = [{ "id": "sourcetree" }]`
- `projectCategories = []`

This defaulting is applied when older config files are loaded and do not yet contain a `preferences` block.

## JSON Shape

Minimal persisted shape with current defaults:

```json
{
  "baseDir": "/Users/you/.grove",
  "preferences": {
    "terminalLinkOpenMode": "external-with-localhost-internal",
    "projectViewMode": "default",
    "ideMenuItems": [{ "id": "webstorm" }],
    "gitGuiMenuItems": [{ "id": "sourcetree" }]
  }
}
```

Full shape with optional launcher and category metadata:

```json
{
  "baseDir": "/Users/you/.grove",
  "terminalTheme": {
    "background": "#000000",
    "foreground": "#ffffff"
  },
  "preferences": {
    "terminalLinkOpenMode": "internal",
    "projectViewMode": "group-by-orgs",
    "collapsedProjectOrgs": ["sendbird"],
    "projectOrgOrder": ["bang9", "sendbird"],
    "ideMenuItems": [
      { "id": "xcode", "displayName": "Xcode" },
      { "id": "android-studio", "displayName": "Android Studio" },
      { "id": "cursor", "displayName": "Cursor", "openCommand": "cursor" }
    ],
    "gitGuiMenuItems": [
      { "id": "sourcetree", "displayName": "Sourcetree" },
      { "id": "fork", "displayName": "Fork" }
    ],
    "projectCategories": [
      {
        "id": "ops",
        "name": "Ops",
        "color": "#2dd4bf",
        "icon": { "type": "lucide", "value": "wrench" }
      }
    ]
  }
}
```

`ideMenuItems` may be empty.
`gitGuiMenuItems` may be empty.
`projectCategories` may be empty. The built-in default category is not persisted and uses id `default`.

`collapsedProjectOrgs` is omitted from `config.json` when it is empty.
`projectOrgOrder` is omitted from `config.json` when it is empty.
`gitGuiMenuItems` and `projectCategories` are omitted from `config.json` when they are empty.

Project category normalization is shared between Rust and TypeScript conventions:

- category ids must be non-empty and cannot be `default`
- names are trimmed and limited to 10 characters
- colors must be 6-digit hex strings and are lowercased by the Rust normalizer
- emoji icon values are trimmed and limited to 4 characters
- lucide icon ids must be one of the supported frontend category icons

## I/O Interfaces

### Rust core

`grove-core/src/config.rs` exposes two layers:

- full config
  - `load_app_config()`
  - `save_app_config(...)`
  - `get_app_config_impl()`
- preference-only
  - `load_grove_preferences()`
  - `save_grove_preferences(...)`
  - `get_grove_preferences_impl()`

`save_grove_preferences(...)` updates only `preferences` and preserves existing `projects`, `baseDir`, and `terminalTheme`.

### Tauri commands

`src-tauri/src/lib.rs` exposes:

- `get_app_config`
- `save_app_config`
- `get_grove_preferences`
- `save_grove_preferences`

### Electron bridge

Electron exposes the same command surface through:

- `src-electron/native/src/lib.rs`
- `src-electron/main.ts`

The Electron main process treats `get_grove_preferences` as a JSON-returning command and serializes `save_grove_preferences` arguments before calling the native addon.

### Frontend wrappers

`src/lib/platform/{tauri,electron}.ts` exports:

- `getAppConfig()`
- `saveAppConfig(config)`
- `getGrovePreferences()`
- `saveGrovePreferences(preferences)`

Use `get/saveGrovePreferences()` when only behavior preferences are needed. Use `get/saveAppConfig()` when a caller needs to read or update the full app config envelope.

## Effective vs Persisted Config

`getAppConfig()` returns an effective app config, not a byte-for-byte mirror of `config.json`.

In particular:

- `baseDir` is defaulted to `~/.grove` when absent
- `preferences` is defaulted to `GrovePreferences::default()` when absent
- `terminalTheme` falls back to detected Terminal.app theme when no saved override exists

`getGrovePreferences()` returns the persisted-or-defaulted preference view only.

## Current Implementation Status

Persisted and exposed:

- terminal link open policy
- project view mode selection (`default`, `group-by-orgs`)
- project org ordering
- ordered IDE menu selection
- ordered Git GUI menu selection
- custom project category definitions
- Preferences UI for persisted General, Categories, and Terminal settings

Implemented:

- source/worktree/mission/mission-project sidebar `Open in <IDE>` actions using `ideMenuItems`
- source/worktree/mission/mission-project sidebar `Open in <Git GUI>` actions using `gitGuiMenuItems`
- project category assignment through `projects[].categoryId`; deleting a category remaps assigned projects to the built-in default category
- multi-select category filtering in the Projects sidebar; category filter state is in-memory UI state, not persisted to `config.json`

Launcher behavior:

- `ideMenuItems[].openCommand` is used first when present
- on macOS Grove uses `open -a <AppName>` defaults and `open -b <bundleId>` fallbacks for multi-edition JetBrains IDEs
- built-in macOS `open` launchers wait for process exit so missing apps or bundle IDs fail loudly and fallback candidates still run
- on non-macOS platforms Grove uses built-in editor CLI launcher candidates

Preferences UX:

- the General tab shows a curated list of IDE menu items with static product icons
- the General tab also shows a curated Git GUI selector for Sourcetree and Fork
- users can add multiple IDEs or Git GUIs and reorder them within their sections
- the Categories tab manages custom categories and project assignment
- sidebar menu order is Finder, Global Terminal, chosen IDEs, then chosen Git GUIs

## Relevant Files

| File                                                    | Role                                                     |
| ------------------------------------------------------- | -------------------------------------------------------- |
| `grove-core/src/config.rs`                              | Config schema, defaults, persistence, legacy loading     |
| `grove-core/src/lib.rs`                                 | Re-export of config-facing types                         |
| `src/types/index.ts`                                    | Frontend type definitions                                |
| `src-tauri/src/lib.rs`                                  | Tauri command surface                                    |
| `src-electron/native/src/lib.rs`                        | Electron native command surface                          |
| `src-electron/main.ts`                                  | Electron IPC JSON routing                                |
| `src/lib/platform/tauri.ts`                             | Tauri frontend wrappers                                  |
| `src/lib/platform/electron.ts`                          | Electron frontend wrappers                               |
| `src/store/preferences.ts`                              | Zustand store with init/save                             |
| `src/components/sidebar/SidebarContextMenu.tsx`         | Shared sidebar menu with ordered launcher and note items |
| `src/components/preferences/ProjectCategoriesPanel.tsx` | Category create/edit/delete and project assignment UI    |
| `src/components/sidebar/ProjectCategoryFilterBar.tsx`   | Multi-select category filter bar                         |
| `src/lib/project-categories.tsx`                        | Category defaults, id generation, color/icon helpers     |
| `grove-core/src/ide.rs`                                 | IDE launcher resolution and execution                    |
| `src/lib/url-open.ts`                                   | Runtime consumer of `terminalLinkOpenMode`               |
