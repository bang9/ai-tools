package whip

func generateCodexLeadPrompt(task *Task) string {
	return replaceClaudeLoopWithManualInbox(generateClaudeLeadPrompt(task))
}
