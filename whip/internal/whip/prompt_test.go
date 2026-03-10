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

func TestClaudeBackend_GenerateLeadPrompt(t *testing.T) {
	b := &ClaudeBackend{}
	task := NewTask("Lead Task", "## Worker Tasks\n### Worker 1: Auth module\n- Backend: claude\n- Difficulty: medium", "/tmp")
	task.Role = TaskRoleLead
	task.Workspace = "my-ws"
	task.IRCName = "wp-lead-my-ws"
	task.MasterIRCName = "wp-master-my-ws"

	prompt := b.GeneratePrompt(task)

	for _, want := range []string{
		"Workspace Lead",
		"whip task create",
		"whip task assign",
		"whip task list --workspace my-ws",
		"whip workspace broadcast my-ws",
		"whip task approve <id>",
		"whip task request-changes <id> --note",
		"Do NOT run `whip task approve` or `whip task complete` on your own task",
		"whip task review",
		"in_progress",
		"review",
		"approved",
		"completed",
		"memory.md: User preferences and operational guidelines",
		"projects.md: Project registry with paths and tech stacks",
		"/loop 1m claude-irc inbox",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("lead prompt missing %q", want)
		}
	}

	if !strings.Contains(prompt, "resume management — do NOT re-create them") {
		t.Fatalf("lead prompt should include the recovery check")
	}
	if strings.Contains(prompt, "You are an agent working under a lead session") {
		t.Fatalf("lead prompt should NOT contain worker intro")
	}
}

func TestClaudeBackend_GenerateLeadPrompt_FallsBackToWorkspaceIRCNames(t *testing.T) {
	task := NewTask("Lead Task", "Worker specs here", "/tmp")
	task.Role = TaskRoleLead
	task.Workspace = "fallback-ws"

	prompt := (&ClaudeBackend{}).GeneratePrompt(task)

	if !strings.Contains(prompt, "claude-irc join wp-lead-fallback-ws") {
		t.Fatalf("lead prompt should fall back to workspace lead IRC name")
	}
	if !strings.Contains(prompt, "claude-irc msg wp-master-fallback-ws") {
		t.Fatalf("lead prompt should fall back to workspace master IRC name")
	}
}

func TestCodexBackend_GenerateLeadPrompt(t *testing.T) {
	b := &CodexBackend{}
	task := NewTask("Lead Task", "Worker specs here", "/tmp")
	task.Role = TaskRoleLead
	task.Workspace = "my-ws"
	task.IRCName = "wp-lead-my-ws"
	task.MasterIRCName = "wp-master-my-ws"

	prompt := b.GeneratePrompt(task)

	if !strings.Contains(prompt, "Workspace Lead") {
		t.Error("codex lead prompt should contain 'Workspace Lead'")
	}
	if strings.Contains(prompt, "/loop 1m claude-irc inbox") {
		t.Error("codex lead prompt should NOT contain loop command")
	}
	if !strings.Contains(prompt, "Run claude-irc inbox now") {
		t.Error("codex lead prompt should contain manual polling guidance")
	}
}

func TestWorkerPromptUnchangedWhenLeadExists(t *testing.T) {
	worker := NewTask("Worker task", "Implement the feature", "/tmp")
	worker.IRCName = "wp-abc12345"
	worker.MasterIRCName = "wp-lead-issue-sweep"

	claudePrompt := (&ClaudeBackend{}).GeneratePrompt(worker)
	if strings.Contains(claudePrompt, "Workspace Lead") {
		t.Fatal("worker prompt should NOT use the lead identity even when MasterIRCName is a lead")
	}
	if !strings.Contains(claudePrompt, "You are an agent working under a lead session") {
		t.Fatal("worker prompt should still contain worker intro")
	}
	if !strings.Contains(claudePrompt, "wp-lead-issue-sweep") {
		t.Fatal("worker prompt should reference the lead as its master IRC")
	}

	codexPrompt := (&CodexBackend{}).GeneratePrompt(worker)
	if strings.Contains(codexPrompt, "Workspace Lead") {
		t.Fatal("Codex worker prompt should NOT use the lead identity")
	}
	if !strings.Contains(codexPrompt, "You are an agent working under a lead session") {
		t.Fatal("Codex worker prompt should still contain worker intro")
	}
}

func TestGeneratePrompt_LeadDispatch(t *testing.T) {
	lead := NewTask("Lead Dispatch", "desc", "/tmp")
	lead.Role = TaskRoleLead
	lead.Workspace = "test-ws"
	lead.IRCName = "wp-lead-test-ws"
	lead.MasterIRCName = "wp-master-test-ws"

	lead.Backend = "claude"
	prompt := GeneratePrompt(lead)
	if !strings.Contains(prompt, "Workspace Lead") {
		t.Error("dispatched lead prompt should contain lead intro")
	}
	if strings.Contains(prompt, "You are an agent working under a lead session") {
		t.Error("Claude lead dispatch should NOT produce worker prompt")
	}

	lead.Backend = "codex"
	prompt = GeneratePrompt(lead)
	if !strings.Contains(prompt, "Workspace Lead") {
		t.Error("codex dispatched lead prompt should contain lead intro")
	}
	if strings.Contains(prompt, "/loop 1m") {
		t.Error("codex dispatched lead prompt should not contain /loop")
	}
	if !strings.Contains(prompt, "Run claude-irc inbox now") {
		t.Error("codex dispatched lead prompt should use manual inbox")
	}

	lead.Backend = ""
	prompt = GeneratePrompt(lead)
	if !strings.Contains(prompt, "Workspace Lead") {
		t.Error("default backend lead dispatch should produce lead prompt")
	}
}

func TestTaskIsLead(t *testing.T) {
	task := NewTask("Test", "", "/tmp")
	if task.IsLead() {
		t.Error("new task should not be lead")
	}
	task.Role = TaskRoleLead
	if !task.IsLead() {
		t.Error("task with lead role should be lead")
	}
	task.Role = "other"
	if task.IsLead() {
		t.Error("task with non-lead role should not be lead")
	}
}

func TestWorkspaceLeadIRCName(t *testing.T) {
	if name := WorkspaceLeadIRCName("issue-sweep"); name != "wp-lead-issue-sweep" {
		t.Errorf("WorkspaceLeadIRCName(issue-sweep) = %q, want %q", name, "wp-lead-issue-sweep")
	}
	if name := WorkspaceLeadIRCName("issue-sweep"); name != WorkspaceLeadIRCName("issue-sweep") {
		t.Error("WorkspaceLeadIRCName should be deterministic")
	}
	if name := WorkspaceLeadIRCName(GlobalWorkspaceName); name != "" {
		t.Errorf("WorkspaceLeadIRCName(global) = %q, want empty", name)
	}
	if name := WorkspaceLeadIRCName(""); name != "" {
		t.Errorf("WorkspaceLeadIRCName(\"\") = %q, want empty (normalizes to global)", name)
	}
	if name := WorkspaceLeadIRCName("My-Workspace"); name != "wp-lead-my-workspace" {
		t.Errorf("WorkspaceLeadIRCName(My-Workspace) = %q, want %q", name, "wp-lead-my-workspace")
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
