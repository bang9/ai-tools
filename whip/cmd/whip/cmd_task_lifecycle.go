package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"

	"github.com/bang9/ai-tools/whip/internal/whip"
	"github.com/spf13/cobra"
)

func reviewCmd() *cobra.Command {
	var note string

	cmd := &cobra.Command{
		Use:     "review <id>",
		Short:   "Move an in-progress task into review",
		Long:    lifecycleHelp("review"),
		GroupID: "lifecycle",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			id, err := store.ResolveID(args[0])
			if err != nil {
				return err
			}

			task, err := whip.ReviewTask(store, id, whip.LaunchSource{Actor: "cli", Command: "review"}, note)
			if err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Task %s -> %s\n", task.ID, task.Status)
			return nil
		},
	}

	cmd.Flags().StringVar(&note, "note", "", "Attach a review handoff note")
	return cmd
}

func requestChangesCmd() *cobra.Command {
	var note string

	cmd := &cobra.Command{
		Use:     "request-changes <id>",
		Short:   "Return a reviewed task to active work",
		Long:    lifecycleHelp("request-changes"),
		GroupID: "lifecycle",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			id, err := store.ResolveID(args[0])
			if err != nil {
				return err
			}

			task, err := whip.RequestChangesTask(store, id, whip.LaunchSource{Actor: "cli", Command: "request-changes"}, note)
			if err != nil {
				return err
			}

			msg := fmt.Sprintf("Task %s needs changes. Status is now in_progress. Continue working, record a progress note for the rework, and resubmit with `whip task review %s --note \"...\"` when ready.", id, id)
			if note != "" {
				msg = fmt.Sprintf("Task %s needs changes. Status is now in_progress. Review feedback: %s. Continue working, record a progress note for the rework, and resubmit with `whip task review %s --note \"...\"` when ready.", id, note, id)
			}
			warn := "Warning: request-changes recorded, but IRC notification failed: %v\n"
			missing := fmt.Sprintf("Warning: task %s has no IRC target; request-changes recorded without agent notification\n", id)
			notifyAssignee(task, msg, warn, missing)

			fmt.Fprintf(os.Stderr, "Task %s -> %s\n", task.ID, task.Status)
			return nil
		},
	}

	cmd.Flags().StringVar(&note, "note", "", "Attach review feedback for the rework")
	return cmd
}

func approveCmd() *cobra.Command {
	var note string

	cmd := &cobra.Command{
		Use:     "approve <id>",
		Short:   "Approve reviewed work for finalization",
		Long:    lifecycleHelp("approve"),
		GroupID: "lifecycle",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			id, err := store.ResolveID(args[0])
			if err != nil {
				return err
			}

			task, err := whip.ApproveTask(store, id, whip.LaunchSource{Actor: "cli", Command: "approve"}, note)
			if err != nil {
				return err
			}

			msg := fmt.Sprintf("Task %s approved. Status is now approved. Commit your changes and run `whip task complete %s --note \"...\"` to finalize.", id, id)
			warn := "Warning: approval recorded, but IRC notification failed: %v\n"
			missing := fmt.Sprintf("Warning: task %s has no IRC target; approval recorded without agent notification\n", id)
			notifyAssignee(task, msg, warn, missing)

			fmt.Fprintf(os.Stderr, "Task %s -> %s\n", task.ID, task.Status)
			return nil
		},
	}

	cmd.Flags().StringVar(&note, "note", "", "Attach an approval note")
	return cmd
}

func completeCmd() *cobra.Command {
	var note string

	cmd := &cobra.Command{
		Use:     "complete <id>",
		Short:   "Mark work as completed",
		Long:    lifecycleHelp("complete"),
		GroupID: "lifecycle",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			id, err := store.ResolveID(args[0])
			if err != nil {
				return err
			}

			task, err := whip.CompleteTask(store, id, whip.LaunchSource{Actor: "cli", Command: "complete"}, note)
			if err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Task %s -> %s\n", task.ID, task.Status)

			assigned, err := whip.AutoAssignDependents(store, task.ID)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Warning: auto-assign error: %v\n", err)
			}
			for _, aid := range assigned {
				fmt.Fprintf(os.Stderr, "Auto-assigned dependent: %s\n", aid)
			}

			if task.ShellPID > 0 {
				if err := whip.ScheduleTaskTermination(task); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: schedule termination for %s: %v\n", id, err)
				}
			}

			// Auto-drop workspace when a lead task completes
			if task.Role == whip.TaskRoleLead && task.WorkspaceName() != whip.GlobalWorkspaceName {
				wsName := task.WorkspaceName()
				count, err := whip.DropWorkspace(store, wsName, false)
				if err != nil {
					fmt.Fprintf(os.Stderr, "Warning: auto-drop workspace %s failed: %v\n", wsName, err)
				} else {
					fmt.Fprintf(os.Stderr, "Auto-dropped workspace %s (%d task(s))\n", wsName, count)
				}
			}

			return nil
		},
	}

	cmd.Flags().StringVar(&note, "note", "", "Attach a completion summary")
	return cmd
}

func failCmd() *cobra.Command {
	var note string

	cmd := &cobra.Command{
		Use:     "fail <id>",
		Short:   "Mark the current attempt as failed",
		Long:    lifecycleHelp("fail"),
		GroupID: "lifecycle",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			id, err := store.ResolveID(args[0])
			if err != nil {
				return err
			}

			task, err := whip.FailTask(store, id, whip.LaunchSource{Actor: "cli", Command: "fail"}, note)
			if err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Task %s -> %s\n", task.ID, task.Status)
			return nil
		},
	}

	cmd.Flags().StringVar(&note, "note", "", "Attach a failure handoff note")
	return cmd
}

func cancelCmd() *cobra.Command {
	var note string

	cmd := &cobra.Command{
		Use:     "cancel <id>",
		Short:   "Cancel a task permanently",
		Long:    lifecycleHelp("cancel"),
		GroupID: "lifecycle",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			id, err := store.ResolveID(args[0])
			if err != nil {
				return err
			}

			task, err := whip.CancelTask(store, id, whip.LaunchSource{Actor: "cli", Command: "cancel"}, note)
			if err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Task %s -> %s\n", task.ID, task.Status)
			return nil
		},
	}

	cmd.Flags().StringVar(&note, "note", "", "Attach a cancel reason")
	return cmd
}

func noteCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:     "note <id> <message>",
		Short:   "Add a note without changing task status",
		GroupID: "operations",
		Args:    cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			id, err := store.ResolveID(args[0])
			if err != nil {
				return err
			}

			task, err := whip.AddTaskNote(store, id, whip.LaunchSource{Actor: "cli", Command: "note"}, args[1])
			if err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Added note to task %s (%s)\n", task.ID, task.Status)
			return nil
		},
	}
	return cmd
}

func notifyAssignee(task *whip.Task, message string, warnFormat string, missingMessage string) {
	if task.IRCName != "" {
		if err := exec.Command("claude-irc", "msg", task.IRCName, message).Run(); err != nil {
			fmt.Fprintf(os.Stderr, warnFormat, err)
		}
		return
	}
	fmt.Fprint(os.Stderr, missingMessage)
}

func lifecycleCmd() *cobra.Command {
	var format string

	cmd := &cobra.Command{
		Use:     "lifecycle [id]",
		Short:   "Show the task lifecycle and available state transitions",
		GroupID: "operations",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			specs := whip.TaskLifecycleActionSpecs()
			var task *whip.Task

			if len(args) == 1 {
				store, err := whip.NewStore()
				if err != nil {
					return err
				}
				id, err := store.ResolveID(args[0])
				if err != nil {
					return err
				}
				task, err = store.LoadTask(id)
				if err != nil {
					return err
				}
			}

			switch format {
			case "text":
				renderLifecycleText(specs, task)
				return nil
			case "json":
				return renderLifecycleJSON(specs, task)
			default:
				return fmt.Errorf("unsupported --format %q (expected text or json)", format)
			}
		},
	}

	cmd.Flags().StringVar(&format, "format", "text", "Output format: text or json")
	return cmd
}

func renderLifecycleText(specs []whip.TaskLifecycleActionSpec, task *whip.Task) {
	fmt.Println("States:")
	for _, status := range []whip.TaskStatus{
		whip.StatusCreated,
		whip.StatusAssigned,
		whip.StatusInProgress,
		whip.StatusReview,
		whip.StatusApproved,
		whip.StatusFailed,
		whip.StatusCompleted,
		whip.StatusCanceled,
	} {
		kind := ""
		switch {
		case status.IsTerminal():
			kind = " (terminal)"
		case status.IsActive():
			kind = " (active)"
		}
		fmt.Printf("  - %s%s\n", status, kind)
	}

	fmt.Println("\nActions:")
	for _, spec := range specs {
		fmt.Printf("  - %-8s %s\n", spec.Name, whip.FormatTaskLifecycleTransition(spec))
	}

	if task != nil {
		fmt.Printf("\nTask %s\n", task.ID)
		fmt.Printf("  current: %s\n", task.Status)
		fmt.Println("  available:")
		for _, spec := range specs {
			if taskAllowsAction(task, spec) {
				fmt.Printf("    - %-8s %s\n", spec.Name, whip.FormatTaskLifecycleTransition(spec))
			}
		}
	}
}

func renderLifecycleJSON(specs []whip.TaskLifecycleActionSpec, task *whip.Task) error {
	type statusInfo struct {
		Name     whip.TaskStatus `json:"name"`
		Terminal bool            `json:"terminal"`
		Active   bool            `json:"active"`
	}
	type actionInfo struct {
		Name        string            `json:"name"`
		Summary     string            `json:"summary"`
		From        []whip.TaskStatus `json:"from"`
		To          whip.TaskStatus   `json:"to"`
		SideEffects []string          `json:"side_effects,omitempty"`
	}
	payload := struct {
		States  []statusInfo `json:"states"`
		Actions []actionInfo `json:"actions"`
		Task    any          `json:"task,omitempty"`
	}{
		States: []statusInfo{
			{Name: whip.StatusCreated, Terminal: false, Active: false},
			{Name: whip.StatusAssigned, Terminal: false, Active: true},
			{Name: whip.StatusInProgress, Terminal: false, Active: true},
			{Name: whip.StatusReview, Terminal: false, Active: true},
			{Name: whip.StatusApproved, Terminal: false, Active: true},
			{Name: whip.StatusFailed, Terminal: false, Active: false},
			{Name: whip.StatusCompleted, Terminal: true, Active: false},
			{Name: whip.StatusCanceled, Terminal: true, Active: false},
		},
	}
	for _, spec := range specs {
		payload.Actions = append(payload.Actions, actionInfo{
			Name:        spec.Name,
			Summary:     spec.Summary,
			From:        spec.From,
			To:          spec.To,
			SideEffects: spec.SideEffects,
		})
	}
	if task != nil {
		available := make([]actionInfo, 0)
		for _, spec := range specs {
			if taskAllowsAction(task, spec) {
				available = append(available, actionInfo{
					Name:        spec.Name,
					Summary:     spec.Summary,
					From:        spec.From,
					To:          spec.To,
					SideEffects: spec.SideEffects,
				})
			}
		}
		payload.Task = struct {
			ID               string          `json:"id"`
			Status           whip.TaskStatus `json:"status"`
			AvailableActions []actionInfo    `json:"available_actions"`
		}{
			ID:               task.ID,
			Status:           task.Status,
			AvailableActions: available,
		}
	}

	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}

func taskAllowsAction(task *whip.Task, spec whip.TaskLifecycleActionSpec) bool {
	if task == nil {
		return false
	}
	status := task.Status
	if task.Review && spec.Name == "complete" && status == whip.StatusInProgress {
		return false
	}
	for _, from := range spec.From {
		if status == from {
			return true
		}
	}
	return false
}
