package main

import (
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/bang9/ai-tools/whip/internal/whip"
	"github.com/spf13/cobra"
)

func statusCmd() *cobra.Command {
	var note string

	cmd := &cobra.Command{
		Use:   "status <id> [new-status]",
		Short: "Get or set task status",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			id, err := store.ResolveID(args[0])
			if err != nil {
				return err
			}

			task, err := store.LoadTask(id)
			if err != nil {
				return err
			}
			if len(args) == 1 && !cmd.Flags().Changed("note") {
				fmt.Printf("%s (%s): %s\n", task.ID, task.Title, task.Status)
				if task.Note != "" {
					fmt.Printf("Note: %s\n", task.Note)
				}
				return nil
			}

			var newStatus whip.TaskStatus
			if len(args) == 2 {
				newStatus = whip.TaskStatus(args[1])
				if err := task.ValidateTransition(newStatus); err != nil {
					return err
				}
			}

			task, err = store.UpdateTask(id, func(task *whip.Task) error {
				if len(args) == 2 {
					if err := task.ValidateTransition(newStatus); err != nil {
						return err
					}
					from := task.Status
					task.Status = newStatus
					if newStatus == whip.StatusCompleted || newStatus == whip.StatusFailed {
						now := time.Now()
						task.CompletedAt = &now
					}
					task.RecordEvent("cli", "status", "status_change", from, task.Status, "")
				}

				if cmd.Flags().Changed("note") {
					task.AddNote(note)
					task.RecordEvent("cli", "status", "note", task.Status, task.Status, note)
				}
				task.UpdatedAt = time.Now()
				return nil
			})
			if err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Task %s → %s\n", id, task.Status)

			if task.Status == whip.StatusCompleted {
				assigned, err := whip.AutoAssignDependents(store, task.ID)
				if err != nil {
					fmt.Fprintf(os.Stderr, "Warning: auto-assign error: %v\n", err)
				}
				for _, aid := range assigned {
					fmt.Fprintf(os.Stderr, "Auto-assigned dependent: %s\n", aid)
				}
			}

			if task.Status.IsTerminal() && task.ShellPID > 0 {
				if err := whip.ScheduleTaskTermination(task); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: schedule termination for %s: %v\n", id, err)
				}
			}

			return nil
		},
	}

	cmd.Flags().StringVar(&note, "note", "", "Progress note")
	return cmd
}

func approveCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "approve <id>",
		Short: "Mark a review task approved and notify the assignee to finalize",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			id, err := store.ResolveID(args[0])
			if err != nil {
				return err
			}

			task, err := store.UpdateTask(id, func(task *whip.Task) error {
				if task.Status != whip.StatusReview {
					return fmt.Errorf("task %s is %s, must be 'review' to approve", id, task.Status)
				}
				from := task.Status
				task.Status = whip.StatusApprovedPendingFinalize
				task.UpdatedAt = time.Now()
				task.RecordEvent("cli", "approve", "approved", from, task.Status, "review approved; awaiting finalize")
				return nil
			})
			if err != nil {
				return err
			}

			if task.IRCName != "" {
				commitMsg := fmt.Sprintf("Task %s approved. Status is now approved_pending_finalize. Commit your changes and run `whip task status %s completed --note \"...\"` to finalize.", id, id)
				ircCmd := exec.Command("claude-irc", "msg", task.IRCName, commitMsg)
				ircCmd.Stderr = os.Stderr
				if err := ircCmd.Run(); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: approval state recorded, but IRC notification failed: %v\n", err)
				}
			} else {
				fmt.Fprintf(os.Stderr, "Warning: task %s has no IRC target; approval state recorded without agent notification\n", id)
			}

			fmt.Fprintf(os.Stderr, "Task %s → %s (approval recorded; finalization still requires a later completed/failed transition)\n", id, task.Status)
			return nil
		},
	}
}
