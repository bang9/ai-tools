# whip - Claude Usage Guide

## When to Use

Use `whip` when one Claude session should act as a lead and dispatch work to other Claude sessions.

- Split a larger task into parallel sub-tasks
- Track ownership, status, and stack order between tasks
- Resume or retry agent sessions with preserved context
- Coordinate a team through `claude-irc`

For ad hoc execution, use the CLI directly. For guided planning and dispatch, prefer `/whip-plan` and `/whip-start`. To capture a completed run as a reusable case study, use `/whip-lesson-learn`.

## Workspace Model

- `global` is for single-task work.
- `workspace` is for stacked work.
- A named workspace should be planned as a stacked lane of related tasks, not as an arbitrary flat bag of concurrent tasks.
- `whip task create --workspace <name>` ensures the named workspace on first use.
- Workspace execution model:
  - `git-worktree` when the current cwd is inside git; the workspace keeps its isolated checkout at `WHIP_HOME/workspaces/<name>/worktree`
  - `direct-cwd` when the current cwd is not inside git; tasks keep using that cwd and may not have a worktree path
- `whip workspace show <name>` reports the workspace execution model together with repo/worktree metadata.
- When continuing a named workspace, prefer the stored workspace worktree as the working-directory context for repo commands.
- `~/.whip/home/` remains shared reference context. Task state is namespaced by workspace.
- `claude-irc` remains a shared bus. Master identity is scoped by workspace:
  - `global` → `whip-master`
  - `<workspace>` → `whip-master-<workspace>`

## Typical Workflow

```bash
# Single-task work in global
claude-irc join whip-master
whip task create "Auth module" --difficulty medium --desc "Implement JWT auth"
whip task assign <auth-id>
```

```bash
# Stacked work in a named workspace
claude-irc join whip-master-issue-sweep

whip task create "Auth module" --workspace issue-sweep --difficulty medium --desc "Implement JWT auth"
whip task create "Deploy" --workspace issue-sweep --difficulty easy --desc "Deploy after auth"
whip task dep <deploy-id> --after <auth-id>   # lower-level command that encodes stack order
whip task assign <auth-id>
whip task list
whip workspace show issue-sweep
whip dashboard
claude-irc inbox
```

## Remote Mode

`whip remote` spawns a master Claude Code session in tmux and starts `claude-irc serve` for HTTP API access. This enables the web dashboard to display the master session's terminal output in real-time with direct keyboard input.

```bash
# Basic usage (requires tmux)
whip remote

# Workspace-specific remote master
whip remote --workspace issue-sweep

# With options
whip remote --workspace issue-sweep --backend codex --difficulty medium --port 8585 --tunnel irc.bang9.dev
```

**Flags:**
- `--backend` — AI backend: `claude` (default) or `codex`
- `--difficulty` — Model effort level: `easy`, `medium`, `hard` (default)
- `--workspace` — named workspace for stacked work (default: `global`)
- `--port` — Serve port (default 8585)
- `--tunnel` — Cloudflare tunnel hostname for remote access

Tunnel and port settings are saved to `~/.whip/config.json` for reuse. Ctrl+C stops the serve process; the master tmux session persists for reattach.

### TUI Dashboard

Press `R` in the task list view to configure and start/stop remote mode. The dashboard footer shows serve status, URL, and master session health when active.

### Web Dashboard

The web dashboard at the configured URL includes a **Terminal** tab that renders the master session's tmux output with full ANSI color support (via xterm.js) and allows sending keyboard input directly.

## Whip Home

`whip remote` seeds and reuses `~/.whip/home/` as persistent context for the master session.

- `prompt.md` is the master system prompt used by remote mode. It is only seeded when missing, so local edits persist across sessions.
- `memory.md` stores durable user preferences, operational patterns, and judgment criteria that the master can update as it learns.
- `projects.md` stores a lightweight project registry with paths, stacks, status, and short notes that the master can keep current.

Sub-agents may reference `~/.whip/home/memory.md` and `~/.whip/home/projects.md` as read-only context.

## Code Conventions

- Prefer splitting large files by responsibility using stable prefixes such as `backend_*`, `prompt_*`, `dashboard_*`, `store_*`, `task_*`, and `spawn_*`.
- Keep package boundaries small and avoid premature subpackage splits; prefer same-package file splits first, then extract a package only when the shared API is clear.
- Split tests by subsystem as the production code grows. Avoid returning to single catch-all files like `backend_test.go` or `server_test.go`.

## Help

Run `whip task --help`, `whip workspace --help`, and `whip --help` for the full command list. For guided usage, see `/whip-plan`, `/whip-start`, and `/whip-lesson-learn`.

## Notes

- `whip task assign` only works for tasks in `created` status whose stack prerequisites are already complete.
- `whip task create --workspace <name>` stores tasks under a named workspace and ensures its workspace metadata. In `git-worktree`, it also ensures the workspace worktree before saving the task `cwd`.
- `whip task dep` is still the compatibility command for wiring `stacked` order. Treat it as a low-level mechanism, not the primary user-facing concept.
- Downstream stack tasks auto-assign when their prerequisites become `completed`.
- `whip workspace drop <name>` is the cleanup entry point for named workspace tasks, metadata, and worktree state.
- `tmux` is the preferred runner because it allows dashboard capture and attach.
- `whip remote` requires `tmux` to be installed (`brew install tmux` on macOS).
