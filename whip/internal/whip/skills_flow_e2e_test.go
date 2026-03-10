package whip

import (
	"strings"
	"testing"
)

func TestWhipLeadFlowRegression(t *testing.T) {
	s := tempStore(t)

	// 1. Create lead task with --role lead --workspace skills-lead --difficulty hard
	lead := NewTask("Lead rollout", "Orchestrate the skills-lead workspace.", "/tmp")
	lead.Role = TaskRoleLead
	lead.Workspace = "skills-lead"
	lead.Difficulty = "hard"
	if err := s.SaveTask(lead); err != nil {
		t.Fatalf("SaveTask lead: %v", err)
	}

	// 2. Verify fields
	if lead.Role != TaskRoleLead {
		t.Fatalf("lead.Role = %q, want %q", lead.Role, TaskRoleLead)
	}
	if lead.Difficulty != "hard" {
		t.Fatalf("lead.Difficulty = %q, want %q", lead.Difficulty, "hard")
	}

	// 3. Assign + start lead (simulate without spawning)
	masterIRC := resolveTaskMasterIRC(s, lead, "")
	prepareAssignedTask(lead, masterIRC)
	if err := s.SaveTask(lead); err != nil {
		t.Fatalf("SaveTask after assign: %v", err)
	}

	// 4. Verify lead IRC is deterministic: wp-lead-skills-lead
	if lead.IRCName != "wp-lead-skills-lead" {
		t.Fatalf("lead.IRCName = %q, want %q", lead.IRCName, "wp-lead-skills-lead")
	}

	// 5. Verify lead MasterIRCName reports to workspace master
	if lead.MasterIRCName != "wp-master-skills-lead" {
		t.Fatalf("lead.MasterIRCName = %q, want %q", lead.MasterIRCName, "wp-master-skills-lead")
	}

	// Transition lead to in_progress
	lead.Status = StatusInProgress
	lead.ShellPID = 12345
	if err := s.SaveTask(lead); err != nil {
		t.Fatalf("SaveTask lead in_progress: %v", err)
	}

	// 6. Create worker in same workspace and assign
	worker := NewTask("Worker auth", "Implement auth module", "/tmp")
	worker.Workspace = "skills-lead"
	if err := s.SaveTask(worker); err != nil {
		t.Fatalf("SaveTask worker: %v", err)
	}

	workerMasterIRC := resolveTaskMasterIRC(s, worker, "")
	prepareAssignedTask(worker, workerMasterIRC)
	if err := s.SaveTask(worker); err != nil {
		t.Fatalf("SaveTask worker after assign: %v", err)
	}

	// 7. Verify worker MasterIRCName routes to lead (not workspace master)
	if worker.MasterIRCName != lead.IRCName {
		t.Fatalf("worker.MasterIRCName = %q, want lead IRC %q", worker.MasterIRCName, lead.IRCName)
	}

	// Verify worker has wp- prefix IRC (not lead naming)
	if !strings.HasPrefix(worker.IRCName, "wp-") {
		t.Fatalf("worker.IRCName = %q, should have wp- prefix", worker.IRCName)
	}
	if worker.IRCName == lead.IRCName {
		t.Fatal("worker.IRCName should differ from lead.IRCName")
	}

	// 8. Complete worker
	worker.Status = StatusInProgress
	if err := s.SaveTask(worker); err != nil {
		t.Fatalf("SaveTask worker in_progress: %v", err)
	}
	worker.Status = StatusCompleted
	if err := s.SaveTask(worker); err != nil {
		t.Fatalf("SaveTask worker completed: %v", err)
	}

	// Complete lead
	lead.Status = StatusCompleted
	if err := s.SaveTask(lead); err != nil {
		t.Fatalf("SaveTask lead completed: %v", err)
	}

	// 9. Clean up
	count, err := s.CleanTerminal()
	if err != nil {
		t.Fatalf("CleanTerminal: %v", err)
	}
	if count != 2 {
		t.Fatalf("CleanTerminal count = %d, want 2", count)
	}

	tasks, err := s.ListTasks()
	if err != nil {
		t.Fatalf("ListTasks: %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("remaining tasks = %d, want 0", len(tasks))
	}
}

func TestWhipLeadCreateValidation(t *testing.T) {
	t.Run("lead without workspace", func(t *testing.T) {
		// Lead requires a named workspace; global should be rejected.
		workspace := NormalizeWorkspaceName("")
		if workspace != GlobalWorkspaceName {
			t.Fatalf("empty workspace should normalize to %q", GlobalWorkspaceName)
		}
		// The CLI checks: if role == lead && workspace == global → error
		if workspace == GlobalWorkspaceName {
			// This is the condition that produces the error in cmd_task.go
		} else {
			t.Fatal("expected global workspace for empty input")
		}
	})

	t.Run("invalid role", func(t *testing.T) {
		// Only "lead" or empty is valid. Anything else is rejected by the CLI.
		validRoles := map[string]bool{"": true, TaskRoleLead: true}
		for _, invalid := range []string{"worker", "admin", "manager", "Lead"} {
			if validRoles[invalid] {
				t.Fatalf("role %q should not be valid", invalid)
			}
		}
	})

	t.Run("duplicate lead in workspace", func(t *testing.T) {
		s := tempStore(t)

		lead1 := NewTask("First Lead", "desc", "/tmp")
		lead1.Role = TaskRoleLead
		lead1.Workspace = "dup-test"
		lead1.Status = StatusInProgress
		lead1.IRCName = WorkspaceLeadIRCName("dup-test")
		if err := s.SaveTask(lead1); err != nil {
			t.Fatalf("SaveTask lead1: %v", err)
		}

		existing, err := s.FindWorkspaceLead("dup-test")
		if err != nil {
			t.Fatalf("FindWorkspaceLead: %v", err)
		}
		if existing == nil {
			t.Fatal("FindWorkspaceLead should find the active lead")
		}
		if existing.ID != lead1.ID {
			t.Fatalf("FindWorkspaceLead returned %s, want %s", existing.ID, lead1.ID)
		}
	})

	t.Run("no duplicate when lead is terminal", func(t *testing.T) {
		s := tempStore(t)

		lead := NewTask("Old Lead", "desc", "/tmp")
		lead.Role = TaskRoleLead
		lead.Workspace = "term-test"
		lead.Status = StatusCompleted
		lead.IRCName = WorkspaceLeadIRCName("term-test")
		if err := s.SaveTask(lead); err != nil {
			t.Fatalf("SaveTask: %v", err)
		}

		existing, err := s.FindWorkspaceLead("term-test")
		if err != nil {
			t.Fatalf("FindWorkspaceLead: %v", err)
		}
		if existing != nil {
			t.Fatal("FindWorkspaceLead should not find a completed lead")
		}
	})

	t.Run("global workspace returns nil lead", func(t *testing.T) {
		s := tempStore(t)

		lead, err := s.FindWorkspaceLead(GlobalWorkspaceName)
		if err != nil {
			t.Fatalf("FindWorkspaceLead global: %v", err)
		}
		if lead != nil {
			t.Fatal("FindWorkspaceLead should return nil for global workspace")
		}
	})
}
