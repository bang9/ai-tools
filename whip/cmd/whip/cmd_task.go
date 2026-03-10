package main

import (
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/bang9/ai-tools/whip/internal/whip"
	"github.com/spf13/cobra"
)

func createCmd() *cobra.Command {
	var desc, file, cwd, difficulty, backend, workspace, role string
	var review bool

	cmd := &cobra.Command{
		Use:     "create <title>",
		Short:   "Create a new task",
		GroupID: "operations",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			title := args[0]

			if difficulty != "" && difficulty != "hard" && difficulty != "medium" && difficulty != "easy" {
				return fmt.Errorf("invalid difficulty %q: must be hard, medium, or easy", difficulty)
			}
			if review && difficulty != "medium" && difficulty != "hard" {
				return fmt.Errorf("--review requires --difficulty medium or hard")
			}
			if backend != "" {
				if _, err := whip.GetBackend(backend); err != nil {
					return err
				}
			}
			if err := whip.ValidateWorkspaceName(workspace); err != nil {
				return err
			}
			if role != "" && role != whip.TaskRoleLead {
				return fmt.Errorf("invalid role %q: must be \"lead\" or omitted", role)
			}
			if role == whip.TaskRoleLead {
				if whip.NormalizeWorkspaceName(workspace) == whip.GlobalWorkspaceName {
					return fmt.Errorf("--role lead requires a named workspace (use --workspace)")
				}
				if difficulty == "" {
					difficulty = "hard"
				}
				review = true // lead tasks are always review-gated
			}

			description, err := resolveDescription(desc, file)
			if err != nil {
				return err
			}

			if cwd == "" {
				cwd, err = os.Getwd()
				if err != nil {
					return fmt.Errorf("cannot determine working directory: %w", err)
				}
			}

			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			workspace = whip.NormalizeWorkspaceName(workspace)
			if workspace != whip.GlobalWorkspaceName {
				_, resolvedCWD, err := store.EnsureWorkspace(workspace, cwd)
				if err != nil {
					return err
				}
				cwd = resolvedCWD
			}

			if role == whip.TaskRoleLead {
				existingLead, err := store.FindWorkspaceLead(workspace)
				if err != nil {
					return err
				}
				if existingLead != nil {
					return fmt.Errorf("workspace %q already has an active lead task %s", workspace, existingLead.ID)
				}
			}

			task := whip.NewTask(title, description, cwd)
			task.Workspace = workspace
			task.Difficulty = difficulty
			task.Review = review
			task.Role = role
			task.Backend = backend
			task.RecordEvent("cli", "create", "created", "", task.Status, title)
			if err := store.SaveTask(task); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Created task %s: %s\n", task.ID, task.Title)
			fmt.Print(task.ID)
			return nil
		},
	}

	cmd.Flags().StringVar(&desc, "desc", "", "Task description")
	cmd.Flags().StringVar(&file, "file", "", "Read description from file")
	cmd.Flags().StringVar(&cwd, "cwd", "", "Working directory (default: current)")
	cmd.Flags().StringVar(&workspace, "workspace", "", "Workspace name (default: global)")
	cmd.Flags().StringVar(&difficulty, "difficulty", "", "Task difficulty (hard, medium, easy)")
	cmd.Flags().Lookup("difficulty").Shorthand = "d"
	cmd.Flags().BoolVar(&review, "review", false, "Require review before completion (medium/hard only; always enabled for --role lead)")
	cmd.Flags().StringVar(&backend, "backend", "", "AI backend (default: claude)")
	cmd.Flags().StringVar(&role, "role", "", `Task role: "lead" creates a Workspace Lead that autonomously manages workers (requires --workspace)`)

	return cmd
}

func listCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Short:   "List all tasks",
		Aliases: []string{"ls"},
		GroupID: "operations",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			tasks, err := store.ListTasks()
			if err != nil {
				return err
			}
			if len(tasks) == 0 {
				fmt.Println("No tasks.")
				return nil
			}

			w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "ID\tWORKSPACE\tROLE\tTITLE\tSTATUS\tIRC\tPID\tUPDATED")
			for _, t := range tasks {
				pid := formatShellPID(t)
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
					t.ID,
					t.WorkspaceName(),
					t.Role,
					truncate(t.Title, 30),
					t.Status,
					t.IRCName,
					pid,
					timeAgo(t.UpdatedAt),
				)
			}
			w.Flush()
			return nil
		},
	}
}

func viewCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "view <id>",
		Short:   "View task details",
		GroupID: "operations",
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

			task, err := store.LoadTask(id)
			if err != nil {
				return err
			}

			fmt.Printf("ID:          %s\n", task.ID)
			fmt.Printf("Workspace:   %s\n", task.WorkspaceName())
			fmt.Printf("Title:       %s\n", task.Title)
			fmt.Printf("Status:      %s\n", task.Status)
			diff := task.Difficulty
			if diff == "" {
				diff = "default"
			}
			fmt.Printf("Difficulty:  %s\n", diff)
			if task.Review {
				fmt.Printf("Review:      yes\n")
			}
			if task.Role != "" {
				fmt.Printf("Role:        %s\n", task.Role)
			}
			fmt.Printf("CWD:         %s\n", task.CWD)
			backend := task.Backend
			if backend == "" {
				backend = "default (claude)"
			}
			fmt.Printf("Backend:     %s\n", backend)
			if task.Runner != "" {
				fmt.Printf("Runner:      %s\n", task.Runner)
			}
			if task.SessionID != "" {
				fmt.Printf("Session ID:  %s\n", task.SessionID)
			}
			fmt.Printf("IRC:         %s\n", task.IRCName)
			fmt.Printf("Master IRC:  %s\n", task.MasterIRCName)
			if task.ShellPID > 0 {
				fmt.Printf("Shell PID:   %s\n", formatShellPID(task))
			}
			if len(task.DependsOn) > 0 {
				fmt.Printf("Blocked by:  %s\n", strings.Join(task.DependsOn, ", "))
			}
			fmt.Printf("Created:     %s\n", task.CreatedAt.Format(time.RFC3339))
			fmt.Printf("Updated:     %s\n", task.UpdatedAt.Format(time.RFC3339))
			if task.AssignedAt != nil {
				fmt.Printf("Assigned:    %s\n", task.AssignedAt.Format(time.RFC3339))
			}
			if task.HeartbeatAt != nil {
				fmt.Printf("Heartbeat:   %s\n", task.HeartbeatAt.Format(time.RFC3339))
			}
			if task.CompletedAt != nil {
				label := "Completed"
				if task.Status == whip.StatusCanceled {
					label = "Canceled"
				}
				fmt.Printf("%-12s %s\n", label+":", task.CompletedAt.Format(time.RFC3339))
			}

			if len(task.Notes) > 0 {
				fmt.Printf("\n--- Notes ---\n")
				for _, n := range task.Notes {
					fmt.Printf("[%s] (%s) %s\n", n.Timestamp.Format(time.RFC3339), n.Status, n.Content)
				}
			} else if task.Note != "" {
				fmt.Printf("Note:        %s\n", task.Note)
			}

			if task.Description != "" {
				fmt.Printf("\n--- Description ---\n%s\n", task.Description)
			}
			if len(task.Events) > 0 {
				fmt.Printf("\n--- Events ---\n")
				for _, e := range task.Events {
					fmt.Printf("[%s] actor=%s command=%s action=%s", e.Timestamp.Format(time.RFC3339), e.Actor, e.Command, e.Action)
					if e.FromStatus != "" || e.ToStatus != "" {
						fmt.Printf(" %s→%s", e.FromStatus, e.ToStatus)
					}
					if e.Detail != "" {
						fmt.Printf(" (%s)", e.Detail)
					}
					fmt.Println()
				}
			}

			return nil
		},
	}
}

func depCmd() *cobra.Command {
	var after []string

	cmd := &cobra.Command{
		Use:     "dep <id>",
		Short:   "Set stack prerequisites (dependency edges)",
		GroupID: "operations",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(after) == 0 {
				return fmt.Errorf("at least one --after flag required")
			}

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

			for _, depIDPrefix := range after {
				depID, err := store.ResolveID(depIDPrefix)
				if err != nil {
					return fmt.Errorf("dependency %s: %w", depIDPrefix, err)
				}
				if depID == id {
					return fmt.Errorf("task cannot depend on itself")
				}
				found := false
				for _, existing := range task.DependsOn {
					if existing == depID {
						found = true
						break
					}
				}
				if !found {
					task.DependsOn = append(task.DependsOn, depID)
				}
			}

			task.UpdatedAt = time.Now()
			if err := store.SaveTask(task); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Task %s is now blocked by: %s\n", id, strings.Join(task.DependsOn, ", "))
			return nil
		},
	}

	cmd.Flags().StringArrayVar(&after, "after", nil, "Task ID that must complete first in the stack (repeatable)")
	return cmd
}
