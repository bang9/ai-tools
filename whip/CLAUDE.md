# whip - Claude Guide

Use `whip` when one Claude session should lead and dispatch work to agent sessions.

## Read This First

Prefer the CLI as the source of truth:

- `whip --help`
- `whip task --help`
- `whip workspace --help`
- `whip task lifecycle`
- `whip task <action> --help`

Do not memorize stale command lists from old docs. Use help output when in doubt.

## Core Model

- `global` is for one self-contained task.
- `workspace` is for a stacked lane of related tasks.
- For an existing named workspace, run `whip workspace view <name>` first.
- If `workspace view` shows a `worktree_path`, use that path for later repo inspection, tests, and review commands.

Workspace execution model:

- `git-worktree`: first `whip task create --workspace <name>` ran inside git, so whip maintains `WHIP_HOME/workspaces/<name>/worktree`.
- `direct-cwd`: first `whip task create --workspace <name>` ran outside git, so tasks keep using the provided cwd.

## Workspace Lead

Whip supports a 3-tier model: **master → lead → worker**.

- A **Workspace Lead** is a task created with `--role lead` inside a named workspace.
- The lead session autonomously decomposes work, spawns workers, coordinates them via IRC, manages reviews, and reports progress back to the master.
- The master creates and assigns the lead task; the lead handles everything else within the workspace.
- Only the master completes the lead task — the lead does not self-complete.
- Worker tasks in a lead-managed workspace route their master IRC to the lead automatically.

When to use the lead model:
- Multi-task workspaces where manual coordination is overhead
- When you want fire-and-forget orchestration from a single task
- When the master should not manage individual workers

## Task Lifecycle

Statuses:

- `created`
- `assigned`
- `in_progress`
- `review`
- `approved`
- `failed`
- `completed`
- `canceled`

Terminal statuses:

- `completed`
- `canceled`

Rules:

- Only lifecycle commands change status: `assign`, `start`, `review`, `request-changes`, `approve`, `complete`, `fail`, `cancel`
- Operational commands do not change status: `create`, `list`, `view`, `lifecycle`, `note`, `dep`, `clean`, `delete`
- `failed` is non-terminal; re-dispatch with `whip task assign <id>`
- Review tasks use `assign -> start -> review -> request-changes -> review -> approve -> complete`
- Non-review tasks can use `assign -> start -> complete`

## Typical Flow

```bash
# single-task work
claude-irc join wp-master
whip task create "Auth module" --difficulty medium --desc "Implement JWT auth"
whip task assign <task-id>
whip task list
```

```bash
# named workspace
claude-irc join wp-master-issue-sweep
whip workspace view issue-sweep
whip task create "Auth module" --workspace issue-sweep --difficulty medium --desc "Implement JWT auth"
whip task dep <deploy-id> --after <auth-id>
whip task assign <auth-id>
whip dashboard
claude-irc inbox
```

```bash
# lead-managed workspace — master delegates orchestration to a lead
claude-irc join wp-master-auth-refactor
whip task create "Refactor auth system" --workspace auth-refactor --role lead --desc "Refactor auth to middleware pattern, update tests, write docs"
whip task assign <lead-id>
# The lead autonomously creates workers, coordinates via IRC, and reports back
# Monitor via dashboard or claude-irc inbox
whip dashboard
```

Useful operational commands:

- `whip task note <id> "..."` for progress without state change
- `whip workspace broadcast <workspace> "..."` for workspace-wide announcements
- `whip task clean` to remove terminal tasks
- `whip workspace drop <name>` to remove a named workspace

## Remote Mode

- `whip remote` starts a master session plus HTTP access for the web dashboard.
- `tmux` is required.
- Use `whip remote --help` and the printed URL/OTP flow instead of relying on stale prose.

`~/.whip/home/` is persistent master context:

- `prompt.md`
- `memory.md`
- `projects.md`

Treat these as reference context, not task-local state.

## Code Conventions

- Prefer same-package file splits with stable prefixes such as `backend_*`, `prompt_*`, `dashboard_*`, `store_*`, `task_*`, `spawn_*`.
- Keep package boundaries small; extract a new package only when the shared API is clear.
- Keep tests split by subsystem instead of collapsing back into one catch-all file.
