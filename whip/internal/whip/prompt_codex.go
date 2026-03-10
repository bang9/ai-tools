package whip

import "strings"

func generateCodexPrompt(task *Task) string {
	prompt := replaceClaudeLoopWithManualInbox(generateClaudePrompt(task))
	if task.Review {
		prompt += `

## Codex Review Handoff
Because this backend may not stay attached through approval/finalization, treat the review report as a real handoff.
- Do not leave the lead guessing what to commit, what to verify, or what remains risky.
- If the lead requests changes, keep the same session, continue from the task's returned in_progress state, and send a fresh review handoff after the rework.
- If approval arrives later, great — finish it yourself.
- If the lead takes over, your review message and review note should already contain everything needed to finalize safely.
`
	}
	return prompt
}

func replaceClaudeLoopWithManualInbox(prompt string) string {
	old := `
4. Enable periodic message check:
   /loop 1m claude-irc inbox
`
	new := `
4. Check for new messages manually throughout the task:
   - Run claude-irc inbox now
   - Run claude-irc inbox after each meaningful chunk of work
   - Run claude-irc inbox before status changes or when you think the lead replied
`
	return strings.Replace(prompt, old, new, 1)
}
