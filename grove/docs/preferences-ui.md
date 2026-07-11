# Preferences UI

Unified settings modal accessed via gear icon in AppTabBar. Six tabs: General, Categories, Terminal, Browser, Developer, Permissions.

## Heading Hierarchy

All preference components must follow this heading hierarchy for visual and semantic consistency.

| Level       | Tag       | Class                                                                    | Usage                                                                                                                     |
| ----------- | --------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Page title  | `<h3>`    | `text-sm font-semibold text-foreground`                                  | Tab name — "General", "Project Categories", "Terminal", "Developer"                                                       |
| Section     | `<h4>`    | `text-[12px] font-medium text-foreground`                                | Setting group — "Project view mode", "IDE menu items", "Git GUI menu items", "Categories", "Link Open Mode", "Appearance" |
| Sub-section | `<h5>`    | `text-[11px] font-medium text-muted-foreground uppercase tracking-wider` | Within a section — "Menu Preview", "Available IDEs", "Available Git GUIs", "Presets", "Font", "Colors", "Preview"         |
| Field label | `<label>` | `text-[11px] text-muted-foreground`                                      | Individual input label — "Font Family", "Font Size"                                                                       |
| Description | `<p>`     | `text-[11px] text-muted-foreground/70`                                   | Helper text below a section heading                                                                                       |

Rules:

- Tags must descend semantically: `h3` > `h4` > `h5` > `label`. Never use `h3` inside `h4`.
- Sections with a description use `h4` + `p` + control. Sections without description use `h4` + control directly.
- Sub-sections are only used when a section contains multiple grouped settings (e.g., Appearance has Presets, Font, Colors).
- All `className` values use `cn()` per project convention.

## File Structure

```
src/components/preferences/
├── PreferencesModal.tsx      # Modal shell: Dialog + tab navigation
├── GeneralTab.tsx            # General tab: Project view mode + ordered IDE/Git GUI menu editors
├── CategoriesTab.tsx         # Categories tab shell
├── ProjectCategoriesPanel.tsx # Category create/edit/delete + optional project assignment
├── TerminalTab.tsx           # Terminal tab: Link Open Mode + Appearance
├── DeveloperTab.tsx          # Developer tab: runtime window actions + terminal GC diagnostics
├── PermissionsTab.tsx        # Permissions tab: live macOS TCC statuses + request/open-settings actions
├── dev-permission-rows.ts    # Permissions tab: pure row definitions + status label/badge helpers
└── TerminalAppearance.tsx    # Appearance section: theme presets, font, colors, preview
```

## Data Flow

Most preferences auto-persist on change — no save button needed for app preferences. Terminal theme changes still use the explicit Apply button in the Appearance section.

```
User interaction → Zustand store setter → Platform layer → Tauri/Electron command → config.json
```

- Preferences (project view mode, IDE, Git GUI, link mode): `usePreferencesStore` → `saveGrovePreferences()`
- Category definitions: `usePreferencesStore.setProjectCategories()` → `saveGrovePreferences()`
- Project category assignment: `useProjectStore.setProjectCategory()` → `set_project_category` command → `projects[].categoryId`
- Category deletion: `usePreferencesStore.deleteProjectCategory()` → `delete_project_category` command → removed category plus remapped project assignments
- Terminal theme: `useTerminalStore` → `saveAppConfig()` (requires explicit Apply button)
- Developer window actions: local component state → platform command → current renderer window
- Developer diagnostics: local component state → `run_terminal_gc` command → optional in-memory terminal store cleanup

## General Tab Notes

- `Project view mode` controls how the Projects sidebar is grouped.
- `IDE menu items` is an ordered list editor for sidebar context menus.
- `Git GUI menu items` is a separate ordered list editor for Sourcetree/Fork launchers.
- The IDE preview mirrors the first runtime section order: Finder, Global Terminal, then the selected IDE items.
- Reordering happens inside the preview list.
- Add and remove actions live in `Available IDEs` and `Available Git GUIs`.
- Each IDE/Git GUI row shows the actual product icon from repo assets when available.

## Categories Tab Notes

- The default category exists in code and is not persisted in `preferences.projectCategories`.
- Custom categories are stored in `preferences.projectCategories`.
- Project assignment is stored separately on project metadata as `projects[].categoryId`.
- Assign-only mode is reused by the project category dialog opened from a project row.
- Deleting a custom category also remaps any assigned projects back to the default category.
- Category colors are random 24-bit hex values, with best-effort avoidance of currently used colors.

## Permissions Tab Notes

- Statuses are read live from macOS TCC via the `dev_permissions_status` platform command on mount, on window focus, and via the manual Refresh button. Nothing is persisted in `config.json`.
- Each row's action (`dev_permissions_request`) either triggers the OS prompt, nudges the relevant subsystem, or opens the matching System Settings Privacy pane, then re-reads status.
- Full Disk Access is the fix for repeated per-folder prompts when terminals or file views touch macOS-protected folders (Desktop, Documents, Downloads).
- The whole surface is macOS-only; on other platforms every row reports `unsupported` and its action button is disabled.
