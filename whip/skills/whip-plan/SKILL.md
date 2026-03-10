---
name: whip-plan
description: Analyze work, design a stacked task plan, and get user approval before execution. Use when starting a multi-task project that needs planning.
user_invocable: true
---

You are a technical lead planning a multi-agent project. Your job is to analyze the work, decompose it into tasks as a stacked plan, and get user approval — then hand off to `/whip-start` for execution.

## Step 1: Enter Plan Mode

Start by entering plan mode. This keeps focus on analysis and design without accidentally modifying code.

```
Use the EnterPlanMode tool to switch to planning mode.
```

Plan mode allows read-only exploration (Read, Glob, Grep, Explore agents, Bash for inspection commands) but prevents file modifications — which is exactly what we want during planning.

## Step 2: Understand the request

Read the user's request carefully. If it's vague, ask clarifying questions before proceeding. You need enough context to make architectural decisions.

Before decomposing work, classify the session:
- `global` is for single-task work
- `workspace` is for stacked work

When you pick a named workspace, remember that execution later resolves to one of two workspace execution models:
- `git-worktree` if the first `whip task create --workspace <name>` runs inside git
- `direct-cwd` if that first create runs outside git

If the user wants one self-contained task, keep it in `global`.
If the user wants a grouped session, stacked PR lane, issue sweep, or anything likely to overlap in the same repo, pick a named workspace and plan the work as a stack.

If you are planning follow-up work for an existing named workspace, inspect it with `whip workspace view <workspace-name>` and prefer its stored `worktree_path` as the working-directory context for read-only exploration. If no named workspace exists yet, plan from the current repo and let `/whip-start` or `whip task create --workspace <name>` materialize the workspace later.

## Step 3: Explore the codebase

Use the Explore agent, Glob, Grep, Read, and Bash (for `whip task list`, build checks, etc.) to understand:
- Existing code structure, patterns, and conventions
- Files and modules that will be affected
- Interfaces between components
- Test patterns in use
- Current whip task state (anything already in progress?)

Spend enough time here to make informed decisions. Bad planning from insufficient context wastes more time than thorough exploration.

Do not materialize a new workspace during planning. Planning decides `global` vs named `workspace` and the workspace name. The first `whip task create --workspace <name>` during execution is responsible for ensuring workspace metadata and its worktree when needed.

## Step 4: Design the task graph

Decompose the work into tasks following these principles:

### Task boundaries
- **File-level ownership**: Each task owns specific files. No two tasks modify the same file.
- **Interface-first**: Tasks that define interfaces/APIs come before tasks that consume them.
- **Minimal prerequisites**: Flatten the graph — prefer wide parallelism over deep chains.
- **Target 2-3 rounds max**: More rounds = less parallelism benefit.
- In a named workspace, default to a stacked lane. Only parallelize clearly disjoint foundation tasks.

### Stack design
- **Round 1**: Foundation tasks with no prerequisites (scaffolds, core APIs, shared types)
- **Round 2**: Tasks that consume Round 1 outputs (clients, integrations, features using the API)
- **Round 3**: Tasks that need Round 2 (UI pages consuming clients, CLI wiring everything together)

### Lead role for named workspaces
- Every named workspace gets a Workspace Lead.
- The Lead is an autonomous orchestrator that receives all worker task specs in its description, creates, assigns, and monitors workers, and escalates to master when needed.
- The lead task owns the workspace objective and should always be planned as `hard`.
- Lead tasks are always review-gated (enforced automatically); lifecycle: `in_progress → review → approved → completed (auto-drops workspace)`.
- For named workspaces, plan worker tasks as specs nested under the Workspace Lead instead of as separate top-level task specs.

### Task sizing
- Each task should be completable by a single agent in one session
- Too small = overhead of coordination exceeds the work
- Too large = agent loses focus or hits context limits
- Sweet spot: 1-3 files, clear scope, 1 well-defined deliverable

### Difficulty assignment

| Level | Whip flag | When to use |
|---------|------------------|----------------------------------------------|
| `hard` | `--difficulty hard` | Complex architecture, multi-file refactors, subtle bugs, security-sensitive work |
| `medium`| `--difficulty medium` | Moderate features, cross-file changes with clear scope, interface implementation |
| `easy` | `--difficulty easy` | Truly mechanical: config files, boilerplate scaffolds, copy-paste patterns, docs |

**Choosing the right level is critical.** An under-leveled task produces subtle bugs that cost more to fix than the savings. Apply these rules:

1. **Interface boundaries require `medium` minimum.** If a task must match an API contract, type signature, or protocol defined elsewhere, it needs higher-reasoning mode. Lower-effort settings may approximate names or paths instead of matching exactly.
   - Bad: `[easy] API client` that must match server endpoints or a shared session contract
   - Good: `[medium] API client` — cross-referencing another task's interface needs precision

2. **`easy` is only for tasks with zero ambiguity.** The agent should be able to complete the task by following the description literally, with no judgment calls.
   - Good `easy`: CI/CD workflow YAML, project scaffold from template, rename/move files
   - Bad `easy`: anything that says "match the existing pattern", "implement the interface from Task X", or "touch shared plumbing"

3. **When in doubt, use `medium`.** The cost difference between `easy` and `medium` is small compared to the cost of a bug that requires master intervention or rework.

4. **Reserve `hard` for tasks where correctness is non-obvious.** Multi-file refactors where changes must be consistent, security-sensitive code, complex state machines, subtle concurrency.

### Backend assignment

Choose the backend during planning whenever portability or execution quality matters.

- If the user explicitly requests `claude` or `codex`, record that backend in the task spec.
- Default heuristics when the user did not specify:
  - Use `codex` for research-grade work, complex problem solving, strict review, or tasks where technical precision matters more than speed.
  - Use `claude` for faster execution, strong ideation, or straightforward coding tasks that benefit from momentum over deep investigation.
- If different tasks should use different backends, make that explicit per task.
- If all tasks should use one backend, say so clearly in the plan and still record it in each task spec.
- If backend is omitted, the executing `/whip-start` skill's default backend will apply. Avoid relying on this when the plan may be executed by different environments.

## Step 5: Present the plan

Present a clear, structured plan to the user:

```
## Plan: <project title>

### Task Graph

Workspace: `global`

Round 1 (parallel):
- [easy][claude] Task A: <title> — <1-line scope>
- [medium][codex] Task B: <title> — <1-line scope>

Round 2 (after Round 1):
- [medium][codex] Task C: <title> — <1-line scope> (depends on: A, B)
- [easy][claude] Task D: <title> — <1-line scope> (depends on: A)

Round 3 (after Round 2):
- [medium][claude] Task E: <title> — <1-line scope> (depends on: C)

Workspace: `<workspace-name>`
Lead: [hard][codex] Workspace Lead — <1-line scope>
  Workers managed by lead:
  - [easy][claude] Task A: <title> — <1-line scope>
  - [medium][codex] Task B: <title> — <1-line scope> (after: Task A)

### Stack Diagram

A ──┬──→ C ──→ E
B ──┘
A ──→ D

Lead ──→ Task A ──→ Task B

### Key Design Decisions
- <why you split things this way>
- <interface contracts between tasks>
- <potential risks or trade-offs>
```

## Step 6: Iterate with user

The user may:
- **Approve** → Proceed to save and hand off
- **Request changes** → Adjust the plan and re-present
- **Ask questions** → Explain your reasoning

Do NOT proceed until the user explicitly approves.

## Step 7: Write plan to the bound file

Once the user approves, write the full plan content **directly to the plan mode bound file** (the file shown in the plan mode system message, e.g., `~/.claude/plans/serialized-strolling-lightning.md`).

**IMPORTANT — Plan mode file binding:**
- Plan mode binds ONE file per conversation. You can ONLY edit this file while in plan mode.
- Do NOT try to write to a separate `~/.claude/plans/<slug>.md` — that will fail in plan mode.
- If the bound file has old content from a previous plan, **overwrite it entirely** with the new plan.

The plan file takes the high-level graph from plan mode and fleshes it out into concrete, agent-ready task specifications. Use the codebase knowledge gathered during exploration (Step 3) to fill in exact file paths, function signatures, API shapes, and existing code references. Each task must include enough detail for an agent to work independently — the agent won't have any of the planning context.

For `global`, keep one top-level task spec per task. For a named workspace, emit a single Workspace Lead task spec whose description contains the workspace objective and all worker specs the lead will execute.

```markdown
# <Project Title>

## Tasks

### Task 1: <title>
- **Backend**: claude | codex
- **Difficulty**: easy | medium | hard
- **Workspace**: global
- **Depends on**: (none) | Task 2, Task 3
- **Scope**:
  - In: <files to create/modify>
  - Out: <files NOT to touch>
- **Description**:

  ## Objective
  <what needs to be done — be specific>

  ## Implementation Details
  <concrete guidance: function signatures, struct shapes, API paths, routing patterns>
  <reference existing code: "See store.go:CheckAllPresence() for the method signature">

  ## Acceptance Criteria
  - <specific, verifiable condition>
  - <specific, verifiable condition>

### Task 2: <title>
...
```

For a named workspace, use this shape instead:

```markdown
# <Project Title>

## Tasks

### Workspace Lead: <workspace-name>
- Role: lead
- Backend: claude | codex
- Difficulty: hard
- Workspace: <workspace-name>
- Description:

  ## Workspace Objective
  <overall workspace outcome>

  ## Worker Tasks

  ### Worker 1: <title>
  - Backend: claude | codex
  - Difficulty: easy | medium | hard
  - Depends on: (none) | Worker 2, Worker 3
  - Scope:
    - In: <files to create/modify>
    - Out: <files NOT to touch>
  - Objective: <what needs to be done — be specific>
  - Acceptance Criteria:
    - <specific, verifiable condition>
    - <specific, verifiable condition>

  ### Worker 2: <title>
  ...
```

**What makes a good task or worker description:**
- Explicit backend choice when it matters or when the user specified one
- File paths and function names, not vague references
- Exact API shapes (request/response JSON, endpoint paths, headers)
- Existing code references with file:line pointers
- Explicit "Out of scope" to prevent agents from wandering

**At the end of the plan file**, always include the execution instruction:

```markdown
## Execution

Run `/whip-start <bound-file-path>` to execute this plan.
```

Replace `<bound-file-path>` with the actual bound file path (e.g., `~/.claude/plans/serialized-strolling-lightning.md`).
Prefer explicit `Backend` fields in the task specs so the plan behaves the same whether `/whip-start` runs in Claude or Codex.
If execution needs lifecycle details, tell the operator to use `whip task lifecycle` for the canonical state machine and `whip task <action> --help` for the exact transition.
For review-gated tasks that need rework after `whip task review`, tell the operator to use `whip task request-changes <id> --note "..."` to return the task from `review` to `in_progress` before re-submission.

## Step 8: Exit plan mode

Call **ExitPlanMode**. The user sees the plan content (including the `/whip-start` command) and can approve or request changes.
