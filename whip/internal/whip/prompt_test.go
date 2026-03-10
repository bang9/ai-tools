package whip

import (
	"strings"
	"testing"
)

func TestCodexBackend_GeneratePrompt(t *testing.T) {
	b := &CodexBackend{}
	task := NewTask("Test Prompt", "Build the auth module", "/tmp")
	task.IRCName = "whip-abc12"
	task.MasterIRCName = "whip-master"

	prompt := b.GeneratePrompt(task)

	if !strings.Contains(prompt, "Run claude-irc inbox now") {
		t.Fatalf("prompt should contain Codex inbox guidance")
	}
	if strings.Contains(prompt, "/loop 1m claude-irc inbox") {
		t.Fatalf("prompt should not contain Claude-only loop command")
	}
	if !strings.Contains(prompt, "Home context (READ-ONLY): WHIP_HOME/home/ (default: ~/.whip/home/)") {
		t.Fatalf("prompt should include whip home guidance")
	}
	if !strings.Contains(prompt, "memory.md: User preferences and operational guidelines") {
		t.Fatalf("prompt should reference memory.md")
	}
	if !strings.Contains(prompt, "projects.md: Project registry with paths and tech stacks") {
		t.Fatalf("prompt should reference projects.md")
	}
	if strings.Contains(prompt, "Workspace Lead") {
		t.Fatalf("worker prompt should not use the lead identity")
	}
}

func TestClaudeBackend_GeneratePrompt(t *testing.T) {
	b := &ClaudeBackend{}
	task := NewTask("Test Prompt", "Build the auth module", "/tmp")
	task.IRCName = "whip-abc12"
	task.MasterIRCName = "whip-master"

	prompt := b.GeneratePrompt(task)

	if !strings.Contains(prompt, "Test Prompt") {
		t.Error("prompt should contain task title")
	}
	if !strings.Contains(prompt, "Build the auth module") {
		t.Error("prompt should contain task description")
	}
	if !strings.Contains(prompt, "whip-abc12") {
		t.Error("prompt should contain IRC name")
	}
	if !strings.Contains(prompt, "whip-master") {
		t.Error("prompt should contain master IRC name")
	}
	if !strings.Contains(prompt, "Home context (READ-ONLY): WHIP_HOME/home/ (default: ~/.whip/home/)") {
		t.Error("prompt should include whip home guidance")
	}
	if !strings.Contains(prompt, "memory.md: User preferences and operational guidelines") {
		t.Error("prompt should reference memory.md")
	}
	if !strings.Contains(prompt, "projects.md: Project registry with paths and tech stacks") {
		t.Error("prompt should reference projects.md")
	}
	if strings.Contains(prompt, "Workspace Lead") {
		t.Error("worker prompt should not use the lead identity")
	}
}

func TestGeneratePrompt_DispatchesByBackend(t *testing.T) {
	task := NewTask("Dispatch Test", "desc", "/tmp")
	task.Backend = "claude"
	task.IRCName = "whip-test"
	task.MasterIRCName = "whip-master"

	prompt := GeneratePrompt(task)
	if !strings.Contains(prompt, "Dispatch Test") {
		t.Error("dispatched prompt should contain task title")
	}

	task.Backend = ""
	prompt = GeneratePrompt(task)
	if !strings.Contains(prompt, "Dispatch Test") {
		t.Error("default-dispatched prompt should contain task title")
	}
}

func TestReviewPrompt_IncludesRequestChangesFlow(t *testing.T) {
	task := NewTask("Review Prompt", "Build the auth module", "/tmp")
	task.Review = true
	task.IRCName = "whip-abc12"
	task.MasterIRCName = "whip-master"

	claudePrompt := (&ClaudeBackend{}).GeneratePrompt(task)
	if !strings.Contains(claudePrompt, "review -> request-changes -> review -> approve -> complete") {
		t.Fatalf("Claude review prompt should describe the request-changes loop")
	}
	if !strings.Contains(claudePrompt, "whip task request-changes <id>") {
		t.Fatalf("Claude review prompt should mention the request-changes command")
	}
	if !strings.Contains(claudePrompt, "do NOT run `whip task start` again") {
		t.Fatalf("Claude review prompt should explain how rework resumes")
	}

	codexPrompt := (&CodexBackend{}).GeneratePrompt(task)
	if !strings.Contains(codexPrompt, "continue from the task's returned in_progress state") {
		t.Fatalf("Codex review prompt should mention resuming after request-changes")
	}
}

func TestClaudeBackend_GeneratePrompt_LeadTask(t *testing.T) {
	b := &ClaudeBackend{}
	task := NewTask("Workspace rollout", "Break this work into worker tasks and manage the workspace.", "/tmp")
	task.Role = TaskRoleLead
	task.Workspace = "issue-sweep"
	task.IRCName = WorkspaceLeadIRCName(task.Workspace)
	task.MasterIRCName = WorkspaceMasterIRCName(task.Workspace)

	prompt := b.GeneratePrompt(task)

	for _, want := range []string{
		"Workspace Lead",
		"whip workspace view issue-sweep",
		"whip task list --workspace issue-sweep",
		"whip task create \"<title>\" --workspace issue-sweep",
		"whip task dep <downstream-task-id> --after <upstream-task-id>",
		"whip task assign <task-id>",
		"whip task approve <task-id>",
		"whip task request-changes <task-id> --note",
		"Do NOT run `whip task complete` on your own task",
		"memory.md: User preferences and operational guidelines",
		"projects.md: Project registry with paths and tech stacks",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("lead prompt missing %q", want)
		}
	}

	if !strings.Contains(prompt, "resume management — do NOT re-create them") {
		t.Fatalf("lead prompt should include the recovery check")
	}
}

func TestCodexBackend_GeneratePrompt_LeadTask(t *testing.T) {
	b := &CodexBackend{}
	task := NewTask("Workspace rollout", "Break this work into worker tasks and manage the workspace.", "/tmp")
	task.Role = TaskRoleLead
	task.Workspace = "issue-sweep"
	task.IRCName = WorkspaceLeadIRCName(task.Workspace)
	task.MasterIRCName = WorkspaceMasterIRCName(task.Workspace)

	prompt := b.GeneratePrompt(task)

	if !strings.Contains(prompt, "Workspace Lead") {
		t.Fatalf("lead prompt should use the lead identity")
	}
	if !strings.Contains(prompt, "Run claude-irc inbox now") {
		t.Fatalf("Codex lead prompt should include manual inbox guidance")
	}
	if strings.Contains(prompt, "/loop 1m claude-irc inbox") {
		t.Fatalf("Codex lead prompt should not contain Claude-only loop command")
	}
}
