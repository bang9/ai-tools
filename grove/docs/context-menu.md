# Context Menu

Right-click context menu for sidebar items. Built on `@radix-ui/react-context-menu` with a shared wrapper that provides common actions across all sidebar item types.

## Architecture

```
SidebarContextMenu (wrapper)
├── extraItems?          — component-specific items (rendered first)
├── ContextMenuSeparator — auto-inserted when extraItems present
├── Open in Finder       → reveal_in_finder (platform command)
├── Open in Global Terminal → addGlobalTerminalTab({ cwd })
├── Open in <IDE>...     → open_in_ide (ordered IDE menu items)
├── Open in <Git GUI>... → open_in_ide (ordered Git GUI menu items)
└── Note?                → note dialog when noteKey is provided
```

### Key Files

| File | Role |
|------|------|
| `src/components/ui/context-menu.tsx` | Radix primitive wrappers (base components) |
| `src/components/sidebar/SidebarContextMenu.tsx` | Shared wrapper with common menu items |
| `src/components/sidebar/NotePopover.tsx` | Note dialog and sidebar note indicator |
| `src/lib/platform/tauri.ts` · `electron.ts` | `revealInFinder()` / `openInIde()` platform commands |
| `src-tauri/src/lib.rs` | `reveal_in_finder` / `open_in_ide` Tauri commands |
| `src-electron/main.ts` | `reveal_in_finder` Electron handler + native invoke bridge |
| `grove-core/src/ide.rs` | IDE and Git GUI launcher resolution |
| `src/lib/ide-registry.ts` | Supported IDE menu item ids and display metadata |
| `src/lib/git-gui-registry.ts` | Supported Git GUI menu item ids and display metadata |
| `grove-core/src/note.rs` | Persisted note store under `~/.grove/notes.json` |

### Applied To

| Component | Path source |
|-----------|-------------|
| `DefaultBranchItem` (SOT) | `project.sourcePath` |
| `WorktreeItem` | `worktree.path` |
| `MissionItem` | `mission.missionDir` |
| `MissionProjectItem` | `project.path` |

## Extending

### Adding component-specific items

Pass `extraItems` to `SidebarContextMenu`. They render above common items with an automatic separator:

```tsx
<SidebarContextMenu
  path={worktree.path}
  extraItems={
    <>
      <ContextMenuItem onSelect={handleRename}>Rename</ContextMenuItem>
      <ContextMenuItem onSelect={handleRemove}>Remove</ContextMenuItem>
    </>
  }
>
  <SidebarLeafItem ... />
</SidebarContextMenu>
```

### Adding new common items

Add to `SidebarContextMenu.tsx` — all sidebar items get the new action automatically.

## Open in Launchers

Launcher actions are shown when `preferences.ideMenuItems` or `preferences.gitGuiMenuItems` contains one or more items.

- menu order is `Open in Finder` → `Open in Global Terminal` → selected IDE order → selected Git GUI order
- each item renders as `Open in Xcode`, `Open in Android Studio`, etc.
- `ideMenuItems[].openCommand` takes priority when present
- `gitGuiMenuItems[].openCommand` uses the same launcher path when present
- on macOS Grove uses `open -a <AppName>` or `open -b <bundleId>` defaults
- app icons come from static frontend assets, not runtime extraction

Supported IDE ids are `webstorm`, `vscode`, `xcode`, `android-studio`, `intellij`, `cursor`, and `sublime`.
Supported Git GUI ids are `sourcetree` and `fork`.

## Notes

When `noteKey` is supplied, the context menu adds a final `Note` item. Notes are also exposed by the inline note indicator on source, worktree, and mission rows.

Notes are stored in `~/.grove/notes.json` and keyed by logical sidebar identity rather than raw path. Empty note content deletes that key.

### SidebarLeafItem ref forwarding

`SidebarLeafItem` uses `forwardRef` so that `ContextMenuTrigger asChild` can attach to it. Any new leaf-style component used as a direct child of `SidebarContextMenu` must also forward refs.

## Global Terminal cwd

`GlobalTerminalTab` has an optional `cwd` field. When present, the PTY spawns with that directory instead of the default `baseDir`. This is used by the "Open in Global Terminal" action:

```ts
usePanelLayoutStore.getState().addGlobalTerminalTab({
  title: "my-branch",
  cwd: "/path/to/worktree",
});
```
