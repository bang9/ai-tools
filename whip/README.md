# whip

Task orchestrator for Claude Code. Use `whip task ...` for task lifecycle, `whip workspace ...` for workspace lifecycle, and the dashboard or remote mode for monitoring.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/bang9/ai-tools/main/whip/install.sh | bash
```

Or via Claude Code Plugin:

```bash
/plugin marketplace add bang9/ai-tools
/plugin install whip
```

## Quick Start

```bash
# Single-task work in global
whip task create "Auth module" --desc "Implement JWT authentication"
whip task assign <auth-id>

# Stacked work in a named workspace
whip task create "API endpoints" --workspace issue-sweep --desc "Build REST API for users"
whip workspace show issue-sweep
whip dashboard
```

## Task Commands

| Command | Description |
|---------|-------------|
| `task create <title> [--desc/--file/stdin] [--workspace <name>]` | Create a task in `global` or a named workspace |
| `task list` | List all tasks with status |
| `task show <id>` | Show task details |
| `task assign <id> [--master-irc <name>]` | Spawn agent session |
| `task unassign <id>` | Kill session, reset to created |
| `task status <id> [new-status] [--note]` | Get/set status with notes |
| `task dep <id> --after <id>` | Wire stack prerequisites |
| `task broadcast "message"` | Message all active sessions |
| `task retry <id>` | Retry failed task |
| `task resume <id>` | Resume task session interactively |
| `task kill <id>` | Force kill a task session |
| `task clean` | Remove completed/failed tasks |
| `task delete <id>` | Delete a task |

## Workspace Commands

| Command | Description |
|---------|-------------|
| `workspace list` | List named workspaces |
| `workspace show <name>` | Show workspace metadata, execution model, and tasks |
| `workspace drop <name>` | Drop workspace tasks, metadata, and worktree |

## Other Commands

| Command | Description |
|---------|-------------|
| `dashboard` | Live TUI dashboard |
| `remote` | Start remote mode with web dashboard |
| `upgrade` | Upgrade whip to the latest version |
| `version` | Print version |
## Task Lifecycle

```
created → assigned → in_progress → completed
                                 → failed
```

- `global` tasks stay on the legacy path: `WHIP_HOME/tasks/<id>/task.json` (default `~/.whip/tasks/<id>/task.json`)
- Named workspace tasks are stored under `WHIP_HOME/workspaces/<name>/tasks/<id>/task.json`
- `whip task assign` spawns a tmux session (or Terminal.app tab) with Claude Code
- `whip task dep` remains the compatibility command for encoding stack order inside a workspace
- Downstream stack tasks auto-assign when prerequisites complete
- Sessions communicate via shared `claude-irc`, while master identity is scoped by workspace

## Workspace Model

- Workspace model:
  - `global` for single-task work
  - `workspace` for stacked named lanes
- Workspace execution model:
  - `git-worktree` when the first `whip task create --workspace <name>` runs inside a git repository
  - `direct-cwd` when the first `whip task create --workspace <name>` runs outside git
- `whip task create --workspace <name>` is the authoritative ensure step for a named workspace.
- In `git-worktree`, whip ensures `WHIP_HOME/workspaces/<name>/worktree` and resolves each task `cwd` inside that worktree.
- In `direct-cwd`, workspace tasks keep using the provided `cwd` and `worktree_path` may be empty.
- `whip workspace show <name>` reports the workspace execution model together with repo/worktree metadata.
- Once a workspace has a resolved worktree, continue repo inspection, testing, and review commands against that stored workspace path rather than the original checkout.
- `whip workspace drop <name>` removes the workspace's tasks, metadata, and worktree together.

## Dashboard

`whip dashboard` — live TUI with task list, status indicators, blocked-by tracking, and auto-refresh.

## Remote Mode

`whip remote` starts a master agent session + HTTP API server for remote access.

```bash
# Requires tmux and cloudflared
whip remote
whip remote --workspace issue-sweep
whip remote --workspace issue-sweep --tunnel your-tunnel.example.com
whip remote --workspace issue-sweep --backend codex --difficulty medium --port 8585
```

| Flag | Description |
|------|-------------|
| `--backend` | `claude` (default) or `codex` |
| `--difficulty` | `easy`, `medium`, `hard` (default) |
| `--workspace` | named workspace for stacked work (default: `global`) |
| `--port` | Serve port (default 8585) |
| `--tunnel` | Cloudflare tunnel hostname |

Settings are saved to `~/.whip/config.json` for reuse. With a tunnel, a **short URL** and **QR code** are generated for quick mobile access.

### Web Dashboard

- **Tasks** — real-time task list with status and detail view
- **Chat** — IRC messaging with agent peers
- **Terminal** — live master session output with keyboard input, fullscreen mode, mobile touch scroll

## Skills

| Skill | Description |
|-------|-------------|
| `/whip-plan` | Decompose work into a `global` task or a stacked workspace plan |
| `/whip-start` | Dispatch agents in `global` or a named workspace |
| `/whip-lesson-learn` | Write a real-world whip case-study under `.whip/lesson-learn/` |

## How It Works

1. Master session creates tasks via `whip task create` in `global` or a named workspace
2. Each task spawns a tmux session running Claude Code with a prompt file
3. Sessions coordinate via shared `claude-irc`, using workspace-scoped master identities
4. On completion, downstream stack tasks auto-assign and the workspace master is notified

See [Workflow Guide (EN)](docs/workflow-en.md) | [워크플로우 가이드 (KO)](docs/workflow-ko.md)

## Build from Source

```bash
cd whip && make build
```

## License

MIT
