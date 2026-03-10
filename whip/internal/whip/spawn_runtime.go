package whip

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func BroadcastMessage(tasks []*Task, message string) (int, error) {
	sent := 0
	var errs []string
	for _, t := range tasks {
		if !t.Status.IsActive() || t.IRCName == "" {
			continue
		}
		cmd := exec.Command("claude-irc", "msg", t.IRCName, message)
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", t.ID, err))
			continue
		}
		sent++
	}
	if len(errs) > 0 {
		return sent, fmt.Errorf("some messages failed: %s", strings.Join(errs, "; "))
	}
	return sent, nil
}

func AutoAssignDependents(store *Store, completedID string) ([]string, error) {
	cfg, err := store.LoadConfig()
	if err != nil {
		return nil, err
	}

	dependents, err := store.GetDependents(completedID)
	if err != nil {
		return nil, err
	}

	var assigned []string
	for _, dep := range dependents {
		if dep.Status != StatusCreated {
			continue
		}

		met, _, err := store.AreDependenciesMet(dep)
		if err != nil || !met {
			continue
		}

		var masterIRC string
		if dep.WorkspaceName() != GlobalWorkspaceName && dep.Role != TaskRoleLead {
			lead, err := store.FindWorkspaceLead(dep.WorkspaceName())
			if err == nil && lead != nil && lead.IRCName != "" {
				masterIRC = lead.IRCName
			}
		}
		if masterIRC == "" {
			masterIRC = WorkspaceMasterIRCName(dep.WorkspaceName())
			if dep.WorkspaceName() == GlobalWorkspaceName {
				masterIRC = DefaultMasterIRCName(cfg)
			}
		}

		dep, err = AssignTask(store, dep.ID, LaunchSource{Actor: "auto", Command: "auto-assign"}, masterIRC)
		if err != nil {
			continue
		}

		assigned = append(assigned, dep.ID)

		msg := fmt.Sprintf("Auto-assigned task %s (%s) — dependencies met", dep.ID, dep.Title)
		exec.Command("claude-irc", "msg", dep.MasterIRCName, msg).Run()
	}

	return assigned, nil
}
