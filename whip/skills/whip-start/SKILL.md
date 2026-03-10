---
name: whip-start
description: Spawn whip agent sessions to handle tasks. Dispatch a single agent or assemble a small team with explicit backend, scope, and ownership.
user_invocable: true
---

You are the lead. Dispatch work to agent sessions via whip.

## Inputs

- If the user provides a plan file path, read that file first.
- Treat the plan file as the source of truth for task titles, descriptions, difficulty, stack prerequisites, and execution order.
- If the plan file includes an `## Execution` section with `/whip-start <path>`, that is an instruction to use this skill with the same file path, not content to send to `whip`.

## Workspace model

- `global` is for single-task work.
- `workspace` is for stacked work.
- When executing grouped work, keep all related tasks in the same named workspace.
- Use the workspace master identity:
  - `global` → `wp-master`
  - `<workspace>` → `wp-master-<workspace>`

## Workspace execution model

- `git-worktree`: the first `whip task create --workspace <workspace-name>` runs inside git, so whip ensures `WHIP_HOME/workspaces/<workspace-name>/worktree` and stores task `cwd` inside it.
- `direct-cwd`: the first `whip task create --workspace <workspace-name>` runs outside git, so tasks keep using the provided `cwd` and `worktree_path` may be empty.
- `whip workspace view <workspace-name>` reports the current execution model.

## Workspace preparation

- If you are continuing an existing named workspace, inspect it first with `whip workspace view <workspace-name>`.
- If that workspace reports a stored `worktree_path`, use that path as the working-directory context for subsequent repo inspection, git, test, and review commands.
- If the named workspace does not exist yet, `whip task create --workspace <workspace-name>` is the authoritative ensure step.
- In `git-worktree`, the first `whip task create --workspace <workspace-name>` ensures `WHIP_HOME/workspaces/<workspace-name>/worktree` and resolves task `cwd` inside that worktree.
- In `direct-cwd`, the workspace falls back to the current `cwd` and may not have a `worktree_path`.
- Do not rely on a one-shot `cd` in a child shell. Keep using the resolved workspace path as the working-directory context for each repo command you run.

## Step 0: Health check (always run first)

Every invocation starts here. Check live state before doing anything:

```bash
# 1. Ensure IRC is connected
claude-irc join <workspace-master> 2>/dev/null
# If this fails: claude-irc quit 2>/dev/null && claude-irc join <workspace-master>

# 2. Live status
whip task list
claude-irc inbox

# 3. If continuing a named workspace, inspect its stored metadata
whip workspace view <workspace-name>
```

Review the output before proceeding:
- Are there active or in-progress agents? Note their status.
- Are there unread messages? Read and respond first.
- Are there completed agents with deliverables to review?
- If `claude-irc inbox` truncates a message, read the full entry before acting.
- Do not assume the user can see master IRC traffic. Relay important agent messages back into the main chat yourself.

In Claude Code, prefer near-real-time inbox monitoring with:

```text
/loop 1m claude-irc inbox
```

If slash commands are unavailable, poll manually:

```bash
claude-irc inbox
```

## Decide Mode

Look at the user's request:
- **Lead-managed workspace**: Named workspace with multiple tasks or a stacked lane → Lead Flow
- **Solo agent**: One clear, self-contained piece of work → Solo Flow
- **Direct team**: `global` workspace or explicit request to manage multiple agents directly → Team Flow
- **Ambiguous**: Default to solo. If the user wants a named workspace, prefer Lead Flow over direct team management.

Named workspaces should default to Lead Flow. Keep Team Flow for `global` work or when the user explicitly wants direct control of worker tasks from the master session.

## Choose Backend

Pick the backend before creating tasks, and make it explicit on each task with `--backend`.

- If the user explicitly asks for `claude` or `codex`, use that.
- If the user does not specify a backend, default to `claude` in this skill.
- Always persist the final choice on the task with `--backend`.
- Valid values are `claude` and `codex`.
- Do not mix backends across tightly coupled tasks unless there is a clear reason.

Whip owns backend-specific prompt, model, effort, and session tracking behavior. Do not describe raw backend CLI flags in the task description unless the user explicitly asked for that.

---

## Solo Flow

Dispatch without heavy planning, but define clear scope and acceptance criteria in the description.

```bash
whip task create "<title>" --backend <chosen-backend> --difficulty <level> --desc "## Objective
<what needs to be done>

## Scope
- In: <files/areas to modify>
- Out: <what NOT to touch>

## Acceptance Criteria
- <specific, verifiable condition>
- <specific, verifiable condition>

## Context
<any additional context the agent needs>"
whip task assign <task-id>
```

Monitor the agent: review its initial plan when it arrives, respond to questions, and check progress via `whip task list`. Do not run `claude-irc quit`; stay connected for future dispatches.

---

## Team Flow

Use Team Flow only for `global` work or when the user explicitly wants direct master control over worker tasks. For named workspaces, prefer Lead Flow.

### Step 1: Assemble the team

Define each agent's role and scope. Each agent should:
- Have a clear, specific responsibility
- Be able to work independently
- Have minimal cross-task coupling with other agents

Avoid central implementation planning, but do enough scoping to define ownership, interfaces, and acceptance criteria. Include enough context in descriptions for agents to self-orient. Present the team composition to the user before proceeding.

Parallelization guardrails:
- If two tasks need to edit the same file, shared interface, or session plumbing, do not parallelize that part.
- Create a single owner task for shared files or contracts first, then make downstream stack tasks consume the result.
- If a task says "match Task X" or "implement the shared interface", that task is `medium` minimum and usually should wait for the owner task to land.

### Step 2: Create and deploy agents

Create all tasks, encode stack order if needed, then assign independent tasks. Downstream stack tasks auto-assign when their prerequisites complete.

If you are using a named workspace for direct team control, inspect it first with `whip workspace view <workspace-name>`. If it already has a `worktree_path`, use that path as the working-directory context for your own repo commands. If it does not exist yet, the first `whip task create --workspace <workspace-name>` below will ensure it. For `global`, skip this step and omit `--workspace`.

```bash
whip task create "<agent role/title>" [--workspace <workspace-name>] --backend <chosen-backend> --difficulty <level> --desc "## Objective
<what needs to be done>

## Scope
- In: <files/areas to modify>
- Out: <what NOT to touch>

## Acceptance Criteria
- <specific, verifiable condition>
- <specific, verifiable condition>

## Context
<any additional context the agent needs>"
whip task dep <task-id> --after <prerequisite-id>  # only if needed; this encodes stack order
whip task assign <task-id>  # only assign tasks without unmet prerequisites
```

### Step 3: Coordinate

As team lead:
- Respond to agent messages promptly
- When an agent needs user input, relay the question to the user and pass the answer back
- Use `whip task list` to monitor overall progress
- Use `whip workspace broadcast <workspace-name> "message"` for team-wide announcements
- Use `claude-irc msg <irc-name> "message"` for direct communication with a specific agent
- Relay information between agents when they need context from each other
- Mirror important decisions, blockers, and review requests into the main user chat

### Step 4: Handle completion

As agents complete:
- Review their deliverables
- Dependent agents auto-deploy when prerequisites are met
- If an agent failed and you want to preserve context, notes, or session history, use `whip task assign <id>` to re-dispatch the failed task
- If work must stop permanently, use `whip task cancel <id> --note "..."`
- Run `whip task lifecycle` or `whip task <action> --help` whenever you need the exact state transition rules

### Step 5: Wrap up

When all agents are done, summarize what was accomplished across the team. If this named workspace was temporary and the user wants it removed, run `whip workspace drop <workspace-name>` after all deliverables are accepted. Do not run `claude-irc quit`; stay connected for future dispatches.

---

## Lead Flow

Use Lead Flow when the work belongs in a named workspace with multiple tasks. Create one lead task, give it the full workspace objective plus worker specs, and let that lead create, assign, and monitor workers inside the workspace. Lead tasks are always review-gated (enforced automatically — `--review` is implicit).

### Step 1: Create the lead task

If you are continuing an existing named workspace, inspect it first with `whip workspace view <workspace-name>`. If it already has a `worktree_path`, use that path as the working-directory context for your own repo commands. If it does not exist yet, the first `whip task create --workspace <workspace-name>` below will ensure it.

```bash
whip task create "<workspace lead title>" --role lead --workspace <workspace-name> --backend <chosen-backend> --difficulty hard --desc "## Workspace Objective
<overall outcome>

## Worker Tasks

### Worker 1: <title>
- Backend: claude | codex
- Difficulty: easy | medium | hard
- Depends on: (none) | Worker 2, Worker 3
- Scope:
  - In: <files/areas to modify>
  - Out: <what NOT to touch>
- Objective: <specific deliverable>
- Acceptance Criteria:
  - <specific, verifiable condition>
  - <specific, verifiable condition>

### Worker 2: <title>
..."
```

### Step 2: Assign the lead

```bash
whip task assign <lead-id>
```

### Step 3: Monitor the lead

- Start `/loop 1m claude-irc inbox` so lead escalations surface while you work.
- Use `whip task list` to monitor overall workspace state.
- Review lead updates and answer questions promptly.

### Step 4: Handle escalations from the lead

- The Workspace Lead is autonomous for worker creation, assignment, coordination, and review handoffs.
- If the lead needs user input, cross-task alignment, or policy decisions, answer it and let the lead continue.
- Mirror important lead decisions or blockers into the main user chat.

### Step 5: Review and complete the lead

Lead tasks follow this lifecycle: `in_progress → review → approved → completed`.

When the lead submits itself for review (`whip task review <lead-id>`), inspect the workspace changes, then:

```bash
# If changes look good:
whip task approve <lead-id>    # review → approved
whip task complete <lead-id>   # approved → completed (auto-drops workspace)

# If changes need rework:
whip task request-changes <lead-id> --note "..."  # review → in_progress (lead continues)
```

The Lead cannot self-approve or self-complete; only the master/user runs these commands. Completing the lead auto-drops the workspace when all tasks are terminal.

Do not run `claude-irc quit`; stay connected for future dispatches.

---

## Difficulty Classification

Set `--difficulty` when creating tasks to control the agent's model and reasoning effort. Omit it only when you intentionally want the configured backend default.

| Level | Whip flag | When to use |
|---------|------------------|----------------------------------------------|
| `hard` | `--difficulty hard` | Complex architecture, multi-file refactors, subtle bugs, security-sensitive work |
| `medium`| `--difficulty medium` | Moderate features, cross-file changes with clear scope, non-trivial but well-defined work |
| `easy` | `--difficulty easy` | Simple and mechanical tasks: config changes, rename, boilerplate, docs, formatting |
| *(omit)* | *(none)* | Only when you intentionally want the configured backend default |

Backend mapping is owned by whip. The same `difficulty` may map to different model and effort settings on Claude vs Codex, so do not hardcode backend CLI flags in this skill.

Choosing the right level is critical:

1. Interface boundaries require `medium` minimum. If a task must match an API contract, type signature, or protocol defined by another task, it needs higher-reasoning mode.
   - Bad: `[easy] API client` that must match server endpoints or a shared session contract
   - Good: `[medium] API client` or session integration task

2. `easy` is only for tasks with zero ambiguity. The agent should be able to finish by following the description literally, with no judgment calls.
   - Good `easy`: CI workflow YAML, project scaffold from template, rename or move files
   - Bad `easy`: anything that says "match the existing pattern", "implement the interface from Task X", or "touch shared plumbing"

3. When in doubt, use `medium`.

4. Reserve `hard` for tasks where correctness is non-obvious: multi-file refactors, security-sensitive code, complex state machines, subtle concurrency.

---

## Review Flow

For tasks where you want to review changes before the agent commits, use `--review`. This is only available for `medium` and `hard`.

### How it works

1. Create with review: `whip task create "title" --backend <chosen-backend> --difficulty medium --review --desc "..."`
2. Agent works: the prompt instructs it to avoid committing and to report via `whip task review <id>` when done
3. Review: inspect the agent's changes in the task `cwd` or the workspace worktree when one exists
4. Request changes when needed: `whip task request-changes <id> --note "..."` returns the task to `in_progress` so the same agent can continue rework and resubmit with `whip task review <id>`
5. Approve: `whip task approve <id>` notifies the agent to commit and finish the task
   - Approval does not directly mark the task `completed`; the agent still needs to commit and run `whip task complete <id> --note "..."`

### When to use review

- Tasks that modify shared or critical code paths
- When you want to verify changes before they are committed
- Complex refactors where output quality matters

### When NOT to use review

- `easy` tasks
- Tasks with no difficulty set
- When speed matters more than review
