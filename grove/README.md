# Grove

Git project manager with split terminal and diff viewer for macOS. Each project gets its own source clone and worktrees, including nested stacked worktrees, and each worktree gets persistent split terminal sessions. Tracks Claude Code and Codex AI session status in real-time with visual indicators. Supports project categories, mission grouping, notes, and line-level staging, unstaging, and discarding.

## Features

- **Multi-project sidebar** — Add git projects by URL, drag to reorder, manage top-level and stacked worktrees per project
- **Project categories** — Assign projects to custom categories and filter the sidebar by one or more categories
- **Missions** — Group projects into missions for cross-repo workflows
- **Split terminal** — Horizontal/vertical splits with persistent layouts per worktree
- **Terminal broadcast** — Mirror terminal output across panes, Picture-in-Picture floating terminal
- **Tabbed panels** — Switch between changes, diff, and terminal views per worktree
- **Diff viewer** — Commit history, file diffs, hunk/line-level stage/unstage/discard
- **Context actions** — Open sidebar items in Finder, Global Terminal, IDEs, Git GUIs, or attach notes
- **AI status tracking** — Real-time running/idle/attention indicators for Claude Code and Codex sessions
- **Terminal themes** — Preset themes + auto-detect from Terminal.app
- **Merge tracking** — Merge default branch with behind-remote indicators

## Workflow

1. **Add a project** — Clone a git repo by URL. Grove keeps a source clone aligned with the remote default branch or the configured base branch.
2. **Create worktrees** — Branch off into git worktrees for parallel work, then stack child worktrees from existing worktrees when a branch needs its own follow-up lane.
3. **Categorize and group** — Assign projects to categories for sidebar filtering, then organize related projects into missions for cross-repo work.
4. **Split terminals** — Each worktree gets its own split terminal layout that persists across restarts. Broadcast output via Mirror or PiP.
5. **Review changes** — Use tabbed panels to browse commits, stage/unstage hunks or individual lines, and discard changes.
6. **Track AI sessions** — Claude Code and Codex sessions running in terminals show live status badges in the sidebar.

## App Data

App metadata lives under `~/.grove/`. Project source clones and worktrees live under the configured `baseDir`, which defaults to `~/.grove/`.

```
~/.grove/
├── config.json                              # Projects, preferences, terminal theme, baseDir
├── terminal-layouts.json                    # Split tree per worktree
├── terminal-session-snapshots.json          # Scrollback/CWD per pane
├── panel-layouts.json                       # 3-panel size ratios
├── notes.json                               # Sidebar notes
└── <host>/<org>/<repo>/
    ├── source/                              # Source clone (remote default/base branch)
    └── worktrees/<name>/                    # Git worktrees
```

## Stack

- **Backend**: Rust (Tauri v2, portable-pty, git2, plist)
- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4
- **UI**: allotment (split panes), xterm.js (terminal), Zustand (state)

## Installation

```bash
cd grove
bash install-local.sh          # Tauri (default)
bash install-local.sh electron # Electron
bash install-local.sh all      # Both
```

## Development

```bash
cd grove
pnpm install
pnpm tauri dev         # Dev server + Tauri window
pnpm lint              # ESLint
pnpm test              # Vitest
```
