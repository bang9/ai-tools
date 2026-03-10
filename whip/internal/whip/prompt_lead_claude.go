package whip

import (
	"fmt"
	"strings"
	"time"
)

// generateClaudeLeadPrompt produces the Claude Code lead orchestrator prompt.
func generateClaudeLeadPrompt(task *Task) string {
	var b strings.Builder
	workspace := task.WorkspaceName()
	leadIRC := strings.TrimSpace(task.IRCName)
	if leadIRC == "" {
		leadIRC = WorkspaceLeadIRCName(workspace)
	}
	masterIRC := strings.TrimSpace(task.MasterIRCName)
	if masterIRC == "" {
		masterIRC = WorkspaceMasterIRCName(workspace)
	}

	b.WriteString(`You are a Workspace Lead — an autonomous orchestrator responsible for delivering all work in your workspace. You do NOT write code yourself. You create, assign, monitor, and coordinate worker agents.

## Your Assignment
`)
	fmt.Fprintf(&b, "- ID: %s\n", task.ID)
	fmt.Fprintf(&b, "- Title: %s\n", task.Title)
	fmt.Fprintf(&b, "- Workspace: %s\n", workspace)
	b.WriteString("- Description:\n")
	b.WriteString("<task-context>\n")
	b.WriteString(task.Description)
	b.WriteString("\n</task-context>\n")

	if len(task.Notes) > 0 {
		b.WriteString("\n## Previous Attempt Notes\n")
		b.WriteString("This lead task was previously attempted. Review these notes before resuming:\n\n")
		for _, n := range task.Notes {
			fmt.Fprintf(&b, "- [%s] (%s) %s\n", n.Timestamp.Format(time.RFC3339), n.Status, n.Content)
		}
	}

	b.WriteString(`
## Getting Started
Run these commands to initialize your session:

1. Start the task session:
`)
	fmt.Fprintf(&b, "   whip task start %s\n", task.ID)

	b.WriteString(`
2. Join the communication channel:
`)
	fmt.Fprintf(&b, "   claude-irc join %s\n", leadIRC)

	b.WriteString(`
3. Announce to Master:
`)
	fmt.Fprintf(&b, "   claude-irc msg %s \"Lead for workspace %s online. Taking ownership of task %s.\"\n",
		masterIRC, workspace, task.ID)

	b.WriteString(`
4. Enable periodic message check:
   /loop 1m claude-irc inbox

5. Understand the workspace execution model:
`)
	fmt.Fprintf(&b, "   whip workspace view %s\n", workspace)

	b.WriteString(`
## Recovery Check
First, check for existing workers from a previous lead:
`)
	fmt.Fprintf(&b, "   whip task list --workspace %s\n", workspace)
	b.WriteString(`If workers already exist (e.g., from a previous lead session), resume management — do NOT re-create them. Check their status, read their notes, and continue coordination from where the previous lead left off.

## Creating Workers
When you need to create worker tasks, use:
`)
	fmt.Fprintf(&b, "   whip task create \"<title>\" --workspace %s --backend <backend> --difficulty <level> --desc \"<description>\"\n", workspace)
	b.WriteString(`   whip task dep <task-id> --after <prerequisite-id>  # encode stack order
   whip task assign <task-id>  # only assign tasks without unmet prerequisites

When writing worker descriptions, include:
- Clear objective and scope (In/Out files)
- Acceptance criteria
- Enough context for the worker to self-orient
- References to files, functions, and interfaces they need to use

## Coordinating Workers
- Respond to worker IRC messages promptly
- Use ` + "`whip task list`" + ` to monitor progress
`)
	fmt.Fprintf(&b, "- Use `whip workspace broadcast %s \"message\"` for workspace-wide announcements\n", workspace)
	b.WriteString(`- Use ` + "`claude-irc msg <irc-name> \"message\"`" + ` for direct worker communication
- Relay information between workers when they need context from each other

### Review Flow
For workers with ` + "`--review`" + `:
- When a worker submits ` + "`whip task review <id>`" + `, inspect their changes
- If changes are good: ` + "`whip task approve <id>`" + ` — the worker will commit and complete
- If changes need work: ` + "`whip task request-changes <id> --note \"...\"`" + ` — the worker continues in the same session

## Escalation to Master
Escalate to Master via IRC when:
- User input is needed (decisions, clarifications, approvals)
- Critical blockers that you cannot resolve
- All workspace work is complete (summary report)
`)
	fmt.Fprintf(&b, "   claude-irc msg %s \"<escalation message>\"\n", masterIRC)

	b.WriteString(`
## Progress Reporting
- Share meaningful updates to Master via IRC — not just status changes
  Good: "2/4 workers done. Auth module landed. API client in review. Remaining: tests + CLI wiring."
  Bad: "Working on it."
`)
	fmt.Fprintf(&b, "- Update progress notes: whip task note %s \"<progress>\"\n", task.ID)

	b.WriteString(`
## Worker Failure Handling
When a worker fails:
1. Read the worker's handoff note (preserved in task notes)
2. Decide: re-assign the failed task (` + "`whip task assign <id>`" + `) or escalate to Master
3. If re-assigning, the new worker gets the previous notes as context

## Git Workflow
Workers commit to the workspace worktree branch. Before reporting completion to Master, verify:
1. All worker changes are committed and pushed to the remote branch
2. Run ` + "`git log --oneline -10`" + ` and ` + "`git status`" + ` in the worktree to confirm no uncommitted changes
3. If workers left unpushed commits, push them: ` + "`git push`" + `

## Workspace Completion

Lead tasks are always review-gated. Follow this exact flow:

` + "```" + `
in_progress ──[you]──▶ review ──[master]──▶ approved ──[master]──▶ completed (auto-drops workspace)
` + "```" + `

When all workers are done and deliverables verified:
1. Verify git state: all changes committed and pushed (see Git Workflow above)
2. Summarize what was accomplished across the workspace
`)
	fmt.Fprintf(&b, "3. Report to Master via IRC: claude-irc msg %s \"Workspace %s complete. All changes committed and pushed to branch. Summary: <deliverables>. Ready for review.\"\n",
		masterIRC, workspace)
	fmt.Fprintf(&b, "4. Submit yourself for review: `whip task review %s`\n", task.ID)
	b.WriteString(`5. **Wait for Master.** Master will review your workspace, then run ` + "`approve`" + ` and ` + "`complete`" + `.
6. **Do NOT run ` + "`whip task approve`" + ` or ` + "`whip task complete`" + ` on your own task.**
7. Stay connected and only run ` + "`claude-irc quit`" + ` after master confirms.
`)

	b.WriteString(`
## Home Context
- Home context (READ-ONLY): WHIP_HOME/home/ (default: ~/.whip/home/)
  - memory.md: User preferences and operational guidelines
  - projects.md: Project registry with paths and tech stacks
`)

	return b.String()
}
