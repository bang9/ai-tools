package whip

import (
	"fmt"
	"strings"
	"time"
)

// generateClaudePrompt produces the Claude Code agent prompt for a task.
func generateClaudePrompt(task *Task) string {
	var b strings.Builder

	b.WriteString(`You are an agent working under a lead session. You own this task but coordinate with the lead on key decisions.

## Your Task
`)
	fmt.Fprintf(&b, "- ID: %s\n", task.ID)
	fmt.Fprintf(&b, "- Title: %s\n", task.Title)
	b.WriteString("- Description:\n")
	b.WriteString("<task-context>\n")
	b.WriteString(task.Description)
	b.WriteString("\n</task-context>\n")

	if len(task.Notes) > 0 {
		b.WriteString("\n## Previous Attempt Notes\n")
		b.WriteString("This task was previously attempted. Review these notes from prior agent(s) before starting:\n\n")
		for _, n := range task.Notes {
			fmt.Fprintf(&b, "- [%s] (%s) %s\n", n.Timestamp.Format(time.RFC3339), n.Status, n.Content)
		}
	}

	b.WriteString(`
## Getting Started
Run these commands to initialize your session:

1. Register yourself (this records your shell PID from $WHIP_SHELL_PID):
`)
	fmt.Fprintf(&b, "   whip task heartbeat %s\n", task.ID)

	b.WriteString(`
2. Join the communication channel:
`)
	fmt.Fprintf(&b, "   claude-irc join %s\n", task.IRCName)

	b.WriteString(`
3. Announce that you're starting:
`)
	fmt.Fprintf(&b, "   claude-irc msg %s \"Acknowledged. Taking ownership of task %s: %s\"\n",
		task.MasterIRCName, task.ID, task.Title)

	b.WriteString(`
4. Enable periodic message check:
   /loop 1m claude-irc inbox

## Checkpoint: Share your plan
Before diving in, share your approach with the lead:
`)
	fmt.Fprintf(&b, "   claude-irc msg %s \"Plan for %s: <your approach in 2-3 sentences>\"\n",
		task.MasterIRCName, task.ID)
	b.WriteString(`Then proceed — no need to wait for approval unless the task is ambiguous.

## How You Work
`)
	fmt.Fprintf(&b, "- Work in: %s\n", task.CWD)
	fmt.Fprintf(&b, "- Coordinate with the lead session (%s) via claude-irc\n", task.MasterIRCName)
	b.WriteString("  when you need alignment on cross-cutting decisions.\n")
	b.WriteString("- Home context (READ-ONLY): WHIP_HOME/home/ (default: ~/.whip/home/)\n")
	b.WriteString("  - memory.md: User preferences and operational guidelines\n")
	b.WriteString("  - projects.md: Project registry with paths and tech stacks\n")
	b.WriteString("- If you need user input, escalate to the lead first. If urgent and the lead is unresponsive, use webform to collect it directly.\n")
	b.WriteString(`
## When to ask the lead
- Ambiguous requirements or multiple valid approaches — ask which direction
- Changes that affect files other agents might be working on
- Anything not covered in the task description

## Reporting
- Share meaningful progress updates, not just status changes.
  Good: "Auth module done. JWT + refresh token implemented. Moving to middleware."
  Bad: "Working on it."
`)
	fmt.Fprintf(&b, "- Update progress notes: whip task status %s in_progress --note \"your progress here\"\n", task.ID)
	b.WriteString(`- If blocked, say what you need specifically so it can be unblocked fast.
- When you receive a message from the lead session, acknowledge and respond promptly.

## Handling Failure
If you cannot complete the task, do NOT just mark it failed silently. Before giving up:

1. Write a detailed handoff note explaining:
   - What was accomplished so far
   - What went wrong / why it failed
   - What remains to be done and where the next agent should pick up
2. Notify the lead:
`)
	fmt.Fprintf(&b, "   claude-irc msg %s \"Task %s failed: <reason>. Handoff note written.\"\n",
		task.MasterIRCName, task.ID)
	b.WriteString("3. claude-irc quit\n")
	fmt.Fprintf(&b, "4. whip task status %s failed --note \"<detailed handoff note>\"\n", task.ID)
	b.WriteString(`   (this will auto-terminate the session)

The handoff note is critical — it will be preserved and shown to the next agent assigned to this task after retry.

## Completing Your Task
Before marking complete, verify your work (run tests, build checks, or whatever the task requires).

`)
	if task.Review {
		b.WriteString("**IMPORTANT: This task requires review before completion.**\n")
		b.WriteString("- Do NOT commit your changes.\n")
		b.WriteString("- When your work is ready, report for review instead of marking completed.\n")
		b.WriteString("- Your review handoff must be good enough for the lead to finish or hand off the task without reopening your whole session.\n\n")
		b.WriteString("Your review summary and note must include:\n")
		b.WriteString("- changed files\n")
		b.WriteString("- verification you ran (or what you could not run)\n")
		b.WriteString("- suggested commit message\n")
		b.WriteString("- remaining risks or follow-ups\n")
		b.WriteString("- exact next step for the lead if they need to take over\n\n")
		fmt.Fprintf(&b, "1. claude-irc msg %s \"Task %s ready for review. Delivered: <summary>. Files: <files>. Verification: <checks>. Suggested commit: <message>. Risks/follow-ups: <items>. Takeover note: <what the lead should do next>.\"\n",
			task.MasterIRCName, task.ID)
		fmt.Fprintf(&b, "2. whip task status %s review --note \"Delivered: <summary>. Files: <files>. Verification: <checks>. Suggested commit: <message>. Risks/follow-ups: <items>. Takeover note: <what the lead should do next>.\"\n", task.ID)
		b.WriteString("3. Wait for the lead to approve. You will receive an IRC message when approved.\n")
		b.WriteString("4. After receiving approval: commit your changes, then run:\n")
		b.WriteString("   When committing:\n")
		b.WriteString("   - Only stage files you actually modified: `git add <file1> <file2> ...`\n")
		b.WriteString("   - Do NOT use `git add .`, `git add -A`, or `git add --all`\n")
		b.WriteString("   - Use conventional commit format: `type(scope): description`\n")
		b.WriteString("     Examples: `feat(auth): add JWT refresh token`, `fix(api): handle null response`\n")
		b.WriteString("   - Write a concise commit message that describes what changed and why\n")
		b.WriteString("   claude-irc quit\n")
		fmt.Fprintf(&b, "   whip task status %s completed --note \"final summary\"\n", task.ID)
		b.WriteString("   (this will auto-terminate the session)\n")
	} else if task.Difficulty == "easy" {
		b.WriteString("**IMPORTANT: You must commit your changes before marking complete.**\n\n")
		b.WriteString("When committing:\n")
		b.WriteString("- Only stage files you actually modified: `git add <file1> <file2> ...`\n")
		b.WriteString("- Do NOT use `git add .`, `git add -A`, or `git add --all`\n")
		b.WriteString("- Use conventional commit format: `type(scope): description`\n")
		b.WriteString("  Examples: `feat(auth): add JWT refresh token`, `fix(api): handle null response`\n")
		b.WriteString("- Write a concise commit message that describes what changed and why\n\n")
		b.WriteString("1. Commit your changes as described above.\n")
		fmt.Fprintf(&b, "2. claude-irc msg %s \"Task %s complete. Here's what I delivered: <concrete summary>\"\n",
			task.MasterIRCName, task.ID)
		b.WriteString("3. claude-irc quit\n")
		fmt.Fprintf(&b, "4. whip task status %s completed --note \"final summary of what was delivered\"\n", task.ID)
		b.WriteString("   (this will auto-terminate the session)\n")
	} else {
		b.WriteString("**IMPORTANT: Commit your changes before marking complete.**\n\n")
		b.WriteString("When committing:\n")
		b.WriteString("- Only stage files you actually modified: `git add <file1> <file2> ...`\n")
		b.WriteString("- Do NOT use `git add .`, `git add -A`, or `git add --all`\n")
		b.WriteString("- Use conventional commit format: `type(scope): description`\n")
		b.WriteString("  Examples: `feat(auth): add JWT refresh token`, `fix(api): handle null response`\n")
		b.WriteString("- Write a concise commit message that describes what changed and why\n\n")
		b.WriteString("1. Commit your changes as described above.\n")
		fmt.Fprintf(&b, "2. claude-irc msg %s \"Task %s complete. Here's what I delivered: <concrete summary>\"\n",
			task.MasterIRCName, task.ID)
		b.WriteString("3. claude-irc quit\n")
		fmt.Fprintf(&b, "4. whip task status %s completed --note \"final summary of what was delivered\"\n", task.ID)
		b.WriteString("   (this will auto-terminate the session)\n")
	}

	return b.String()
}
