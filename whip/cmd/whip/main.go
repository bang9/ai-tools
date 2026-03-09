package main

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/bang9/ai-tools/shared/upgrade"
	"github.com/bang9/ai-tools/whip/internal/whip"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var version = "dev"

func main() {
	root := newRootCmd()
	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}

func newRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:     "whip",
		Short:   "Task orchestrator for AI coding sessions",
		Version: version,
	}

	root.AddCommand(
		createCmd(),
		listCmd(),
		showCmd(),
		assignCmd(),
		attachCmd(),
		unassignCmd(),
		statusCmd(),
		approveCmd(),
		retryCmd(),
		resumeCmd(),
		broadcastCmd(),
		heartbeatCmd(),
		killCmd(),
		deleteCmd(),
		cleanCmd(),
		dashboardCmd(),
		depCmd(),
		remoteCmd(),
		helloCmd(),
		upgradeCmd(),
		versionCmd(),
	)

	return root
}

func createCmd() *cobra.Command {
	var desc, file, cwd, difficulty, backend string
	var review bool

	cmd := &cobra.Command{
		Use:   "create <title>",
		Short: "Create a new task",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			title := args[0]

			// Validate difficulty
			if difficulty != "" && difficulty != "hard" && difficulty != "medium" && difficulty != "easy" {
				return fmt.Errorf("invalid difficulty %q: must be hard, medium, or easy", difficulty)
			}

			// Validate --review: only allowed for medium/hard
			if review && difficulty != "medium" && difficulty != "hard" {
				return fmt.Errorf("--review requires --difficulty medium or hard")
			}

			// Validate backend
			if backend != "" {
				if _, err := whip.GetBackend(backend); err != nil {
					return err
				}
			}

			// Resolve description from --desc, --file, or stdin
			description, err := resolveDescription(desc, file)
			if err != nil {
				return err
			}

			// Default cwd to current directory
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

			task := whip.NewTask(title, description, cwd)
			task.Difficulty = difficulty
			task.Review = review
			task.Backend = backend
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
	cmd.Flags().StringVar(&difficulty, "difficulty", "", "Task difficulty (hard, medium, easy)")
	cmd.Flags().Lookup("difficulty").Shorthand = "d"
	cmd.Flags().BoolVar(&review, "review", false, "Require review before completion (medium/hard only)")
	cmd.Flags().StringVar(&backend, "backend", "", "AI backend (default: claude)")

	return cmd
}

func listCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Short:   "List all tasks",
		Aliases: []string{"ls"},
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
			fmt.Fprintln(w, "ID\tTITLE\tSTATUS\tIRC\tPID\tUPDATED")
			for _, t := range tasks {
				pid := formatShellPID(t)
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n",
					t.ID,
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

func showCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <id>",
		Short: "Show task details",
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

			task, err := store.LoadTask(id)
			if err != nil {
				return err
			}

			fmt.Printf("ID:          %s\n", task.ID)
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
				fmt.Printf("Depends on:  %s\n", strings.Join(task.DependsOn, ", "))
			}
			fmt.Printf("Created:     %s\n", task.CreatedAt.Format(time.RFC3339))
			fmt.Printf("Updated:     %s\n", task.UpdatedAt.Format(time.RFC3339))
			if task.AssignedAt != nil {
				fmt.Printf("Assigned:    %s\n", task.AssignedAt.Format(time.RFC3339))
			}
			if task.CompletedAt != nil {
				fmt.Printf("Completed:   %s\n", task.CompletedAt.Format(time.RFC3339))
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

			return nil
		},
	}
}

func assignCmd() *cobra.Command {
	var masterIRC string

	cmd := &cobra.Command{
		Use:   "assign <id>",
		Short: "Assign task to a new terminal session",
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

			task, err := store.LoadTask(id)
			if err != nil {
				return err
			}

			if task.Status != whip.StatusCreated {
				return fmt.Errorf("task %s is %s, must be 'created' to assign", id, task.Status)
			}

			// Check dependencies
			met, unmet, err := store.AreDependenciesMet(task)
			if err != nil {
				return err
			}
			if !met {
				return fmt.Errorf("unmet dependencies: %s", strings.Join(unmet, ", "))
			}

			// Resolve master IRC name
			cfg, err := store.LoadConfig()
			if err != nil {
				return err
			}
			if masterIRC != "" {
				cfg.MasterIRCName = masterIRC
				if err := store.SaveConfig(cfg); err != nil {
					return err
				}
			}
			if cfg.MasterIRCName == "" {
				cfg.MasterIRCName = "whip-master"
				store.SaveConfig(cfg)
			}

			// Set task IRC names
			task.IRCName = "whip-" + task.ID
			task.MasterIRCName = cfg.MasterIRCName

			// Ensure backend is persisted so retry/resume use the same backend
			if task.Backend == "" {
				task.Backend = whip.DefaultBackendName
			}

			// Generate prompt
			prompt := whip.GeneratePrompt(task)
			if err := store.SavePrompt(task.ID, prompt); err != nil {
				return err
			}

			// Spawn session (tmux preferred, Terminal.app fallback)
			runner, err := whip.Spawn(task, store.PromptPath(task.ID))
			if err != nil {
				return fmt.Errorf("failed to spawn session: %w", err)
			}
			task.Runner = runner

			// Update task status
			task.Status = whip.StatusAssigned
			now := time.Now()
			task.AssignedAt = &now
			task.UpdatedAt = now
			if err := store.SaveTask(task); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Assigned task %s → IRC: %s (runner: %s)\n", task.ID, task.IRCName, task.Runner)
			return nil
		},
	}

	cmd.Flags().StringVar(&masterIRC, "master-irc", "", "Master session IRC name (saved for future use)")
	return cmd
}

func attachCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "attach <id>",
		Short: "Attach to a tmux task session",
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

			task, err := store.LoadTask(id)
			if err != nil {
				return err
			}

			if task.Runner != "tmux" {
				return fmt.Errorf("attach is only supported for tmux sessions (task %s uses %q)", id, task.Runner)
			}

			if !whip.IsTmuxSession(id) {
				return fmt.Errorf("tmux session for task %s not found", id)
			}

			return whip.AttachTmuxSession(id)
		},
	}
}

func unassignCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "unassign <id>",
		Short: "Kill task session and reset to created",
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

			task, err := store.LoadTask(id)
			if err != nil {
				return err
			}

			if !task.Status.IsActive() {
				return fmt.Errorf("task %s is %s, not active", id, task.Status)
			}

			// Kill process / tmux session
			if task.Runner == "tmux" && whip.IsTmuxSession(id) {
				whip.KillTmuxSession(id)
			}
			if task.ShellPID > 0 {
				whip.KillProcess(task.ShellPID)
			}

			// Reset
			task.Status = whip.StatusCreated
			task.Runner = ""
			task.ShellPID = 0
			task.IRCName = ""
			task.AssignedAt = nil
			task.UpdatedAt = time.Now()
			if err := store.SaveTask(task); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Unassigned task %s\n", id)
			return nil
		},
	}
}

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

			// Just display if no new status
			if len(args) == 1 && !cmd.Flags().Changed("note") {
				fmt.Printf("%s (%s): %s\n", task.ID, task.Title, task.Status)
				if task.Note != "" {
					fmt.Printf("Note: %s\n", task.Note)
				}
				return nil
			}

			// Update status
			if len(args) == 2 {
				newStatus := whip.TaskStatus(args[1])
				if err := task.ValidateTransition(newStatus); err != nil {
					return err
				}
				task.Status = newStatus

				if newStatus == whip.StatusCompleted || newStatus == whip.StatusFailed {
					now := time.Now()
					task.CompletedAt = &now
				}
			}

			if cmd.Flags().Changed("note") {
				task.AddNote(note)
			}
			task.UpdatedAt = time.Now()

			if err := store.SaveTask(task); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Task %s → %s\n", id, task.Status)

			// Auto-assign dependents on completion
			if task.Status == whip.StatusCompleted {
				assigned, err := whip.AutoAssignDependents(store, task.ID)
				if err != nil {
					fmt.Fprintf(os.Stderr, "Warning: auto-assign error: %v\n", err)
				}
				for _, aid := range assigned {
					fmt.Fprintf(os.Stderr, "Auto-assigned dependent: %s\n", aid)
				}
			}

			// Auto-terminate task session when status becomes terminal.
			// This must not depend on the caller's current shell environment:
			// the lead session may mark a task terminal, and some backends spawn
			// child processes that keep the shell alive unless the whole runner is
			// explicitly terminated.
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
		Short: "Approve a task in review status (notifies agent to commit and complete)",
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

			task, err := store.LoadTask(id)
			if err != nil {
				return err
			}

			if task.Status != whip.StatusReview {
				return fmt.Errorf("task %s is %s, must be 'review' to approve", id, task.Status)
			}

			// Notify agent via IRC to commit and complete
			if task.IRCName != "" {
				commitMsg := fmt.Sprintf("Task %s approved. Please commit your changes and run `whip status %s completed --note \"...\"` to finalize.", id, id)
				ircCmd := exec.Command("claude-irc", "msg", task.IRCName, commitMsg)
				ircCmd.Stderr = os.Stderr
				if err := ircCmd.Run(); err != nil {
					return fmt.Errorf("failed to notify agent via IRC: %w", err)
				}
			}

			fmt.Fprintf(os.Stderr, "Approved task %s — agent notified to commit and complete\n", id)
			return nil
		},
	}
}

func retryCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "retry <id>",
		Short: "Retry a failed task (resumes previous session context if available)",
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

			task, err := store.LoadTask(id)
			if err != nil {
				return err
			}

			// Retry resets status to created but preserves SessionID
			if err := task.Retry(); err != nil {
				return err
			}

			// Resolve master IRC name
			cfg, err := store.LoadConfig()
			if err != nil {
				return err
			}
			if cfg.MasterIRCName == "" {
				cfg.MasterIRCName = "whip-master"
			}

			// Set task IRC names
			task.IRCName = "whip-" + task.ID
			task.MasterIRCName = cfg.MasterIRCName

			// Ensure backend is persisted (normalize legacy empty-backend tasks)
			if task.Backend == "" {
				task.Backend = whip.DefaultBackendName
			}

			// Generate prompt and spawn (will use --resume if SessionID exists)
			prompt := whip.GeneratePrompt(task)
			if err := store.SavePrompt(task.ID, prompt); err != nil {
				return err
			}

			runner, err := whip.Spawn(task, store.PromptPath(task.ID))
			if err != nil {
				return fmt.Errorf("failed to spawn session: %w", err)
			}
			task.Runner = runner

			// Update task status to assigned
			task.Status = whip.StatusAssigned
			now := time.Now()
			task.AssignedAt = &now
			task.UpdatedAt = now
			if err := store.SaveTask(task); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Retried task %s → IRC: %s (runner: %s, session resumed: %v)\n",
				task.ID, task.IRCName, task.Runner, task.SessionID != "")
			return nil
		},
	}
}

func resumeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "resume <id>",
		Short: "Resume a task session interactively in the current terminal",
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

			task, err := store.LoadTask(id)
			if err != nil {
				return err
			}

			if task.SessionID == "" {
				return fmt.Errorf("task %s has no session ID (was it assigned before session tracking was added?)", id)
			}

			backend, err := whip.GetBackend(task.Backend)
			if err != nil {
				return err
			}

			path, execArgs, err := backend.ResumeExec(task)
			if err != nil {
				return err
			}

			if task.CWD != "" {
				if err := os.Chdir(task.CWD); err != nil {
					return fmt.Errorf("change directory to %s: %w", task.CWD, err)
				}
			}

			task.ShellPID = os.Getpid()
			if task.Status == whip.StatusAssigned {
				task.Status = whip.StatusInProgress
			}
			task.UpdatedAt = time.Now()
			if err := store.SaveTask(task); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Resuming session %s for task %s (%s)...\n", task.SessionID, task.ID, task.Title)
			return syscall.Exec(path, execArgs, os.Environ())
		},
	}
}

func broadcastCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "broadcast <message>",
		Short: "Send message to all active sessions",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			tasks, err := store.ListTasks()
			if err != nil {
				return err
			}

			sent, err := whip.BroadcastMessage(tasks, args[0])
			fmt.Fprintf(os.Stderr, "Broadcast sent to %d session(s)\n", sent)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Warning: %v\n", err)
			}
			return nil
		},
	}
}

func heartbeatCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "heartbeat [id]",
		Short: "Register shell PID for a task session",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			var taskID string
			var shellPID int

			if len(args) == 1 {
				taskID = args[0]
				// Try env for PID
				_, pid, envErr := whip.HeartbeatFromEnv()
				if envErr == nil {
					shellPID = pid
				}
			} else {
				// Both from env
				tid, pid, envErr := whip.HeartbeatFromEnv()
				if envErr != nil {
					return envErr
				}
				taskID = tid
				shellPID = pid
			}

			id, err := store.ResolveID(taskID)
			if err != nil {
				return err
			}

			task, err := store.LoadTask(id)
			if err != nil {
				return err
			}

			task.ShellPID = shellPID
			if task.Status == whip.StatusAssigned {
				task.Status = whip.StatusInProgress
			}
			task.UpdatedAt = time.Now()

			if err := store.SaveTask(task); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Heartbeat: task %s, PID %d → in_progress\n", id, shellPID)
			return nil
		},
	}
}

func killCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "kill <id>",
		Short: "Force kill a task session",
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

			task, err := store.LoadTask(id)
			if err != nil {
				return err
			}

			if task.Runner == "tmux" && whip.IsTmuxSession(id) {
				if err := whip.KillTmuxSession(id); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: kill tmux session: %v\n", err)
				}
			}
			if task.ShellPID > 0 {
				if err := whip.KillProcess(task.ShellPID); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: kill PID %d: %v\n", task.ShellPID, err)
				}
			}

			task.Status = whip.StatusFailed
			task.AddNote("killed")
			now := time.Now()
			task.CompletedAt = &now
			task.UpdatedAt = now
			if err := store.SaveTask(task); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Killed task %s (PID: %d)\n", id, task.ShellPID)
			return nil
		},
	}
}

func deleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <id> [id...]",
		Short: "Delete tasks and their sessions",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			for _, arg := range args {
				id, err := store.ResolveID(arg)
				if err != nil {
					fmt.Fprintf(os.Stderr, "Warning: %v\n", err)
					continue
				}

				task, err := store.LoadTask(id)
				if err != nil {
					fmt.Fprintf(os.Stderr, "Warning: %v\n", err)
					continue
				}

				// Kill running session if any
				if task.Runner == "tmux" && whip.IsTmuxSession(id) {
					_ = whip.KillTmuxSession(id)
				}
				if task.ShellPID > 0 && whip.IsProcessAlive(task.ShellPID) {
					_ = whip.KillProcess(task.ShellPID)
				}

				if err := store.DeleteTask(id); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: delete %s: %v\n", id, err)
					continue
				}
				fmt.Fprintf(os.Stderr, "Deleted task %s (%s)\n", id, task.Title)
			}
			return nil
		},
	}
}

func cleanCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "clean",
		Short: "Remove completed and failed tasks",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			count, err := store.CleanTerminal()
			if err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Cleaned %d task(s)\n", count)
			return nil
		},
	}
}

func dashboardCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "dashboard",
		Short:   "Live task dashboard (TUI)",
		Aliases: []string{"dash"},
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			p := tea.NewProgram(
				whip.NewDashboardModel(store, version),
				tea.WithAltScreen(),
			)
			for {
				m, err := p.Run()
				if err != nil {
					return err
				}
				dm, ok := m.(whip.DashboardModel)
				if !ok {
					return nil
				}
				sessionName := dm.PendingAttach()
				if sessionName == "" {
					dm.Cleanup()
					return nil
				}
				if whip.IsTmuxSessionName(sessionName) {
					_ = whip.AttachTmuxSessionName(sessionName)
				} else {
					fmt.Fprintf(os.Stderr, "tmux session %s no longer exists\n", sessionName)
				}
				// Restart dashboard after detach
				p = tea.NewProgram(
					whip.NewDashboardModel(store, version),
					tea.WithAltScreen(),
				)
			}
		},
	}
}

func depCmd() *cobra.Command {
	var after []string

	cmd := &cobra.Command{
		Use:   "dep <id>",
		Short: "Set task dependencies",
		Args:  cobra.ExactArgs(1),
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

			// Resolve all dependency IDs
			for _, depIDPrefix := range after {
				depID, err := store.ResolveID(depIDPrefix)
				if err != nil {
					return fmt.Errorf("dependency %s: %w", depIDPrefix, err)
				}
				if depID == id {
					return fmt.Errorf("task cannot depend on itself")
				}
				// Avoid duplicates
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

			fmt.Fprintf(os.Stderr, "Task %s depends on: %s\n", id, strings.Join(task.DependsOn, ", "))
			return nil
		},
	}

	cmd.Flags().StringArrayVar(&after, "after", nil, "Task ID that must complete first (repeatable)")
	return cmd
}

func remoteCmd() *cobra.Command {
	var backend, difficulty, tunnel string
	var port int

	cmd := &cobra.Command{
		Use:   "remote",
		Short: "Start master session with IRC serve",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			// Check tmux installed
			if _, err := exec.LookPath("tmux"); err != nil {
				return fmt.Errorf("tmux is required but not installed\n\nInstall with:\n  brew install tmux    (macOS)\n  apt install tmux     (Ubuntu/Debian)\n  pacman -S tmux       (Arch)")
			}

			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			// Load config and merge CLI flags
			cfg, err := store.LoadConfig()
			if err != nil {
				return err
			}

			if !cmd.Flags().Changed("tunnel") && cfg.Tunnel != "" {
				tunnel = cfg.Tunnel
			}
			if !cmd.Flags().Changed("port") && cfg.RemotePort > 0 {
				port = cfg.RemotePort
			}

			// Resolve CWD
			cwd, err := os.Getwd()
			if err != nil {
				return fmt.Errorf("cannot determine working directory: %w", err)
			}

			remoteCfg := whip.RemoteConfig{
				Backend:    backend,
				Difficulty: difficulty,
				Tunnel:     tunnel,
				Port:       port,
				CWD:        cwd,
			}

			// Check if master session already exists
			if whip.IsMasterSessionAlive() {
				fmt.Fprintln(os.Stderr, "Master session already running (whip-master)")
				fmt.Fprintln(os.Stderr, "Attach with: tmux attach -t whip-master")
			} else {
				// Spawn master session
				fmt.Fprintln(os.Stderr, "Spawning master session...")
				if err := whip.SpawnMasterSession(remoteCfg); err != nil {
					return fmt.Errorf("failed to spawn master session: %w", err)
				}
				fmt.Fprintln(os.Stderr, "Master session started (whip-master)")
			}

			// Start serve subprocess
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			// Load or generate token
			serveToken := cfg.ServeToken
			if cmd.Flags().Changed("new-token") {
				serveToken = "" // force new token
			}

			fmt.Fprintln(os.Stderr, "Starting claude-irc serve...")
			serveCmd, serveResult, err := whip.StartServe(ctx, remoteCfg, serveToken, true)
			if err != nil {
				return fmt.Errorf("failed to start serve: %w", err)
			}

			connectURL := serveResult.ConnectURL
			shortURL := serveResult.ShortURL

			// Print connect info
			fmt.Fprintln(os.Stderr, "")
			if shortURL != "" {
				fmt.Fprintf(os.Stderr, "  URL: %s\n", shortURL)
			} else if connectURL != "" {
				fmt.Fprintf(os.Stderr, "  URL: %s\n", connectURL)
			}
			fmt.Fprintf(os.Stderr, "  Master tmux:   tmux attach -t whip-master\n")
			fmt.Fprintln(os.Stderr, "")
			fmt.Fprintln(os.Stderr, "  Shortcuts: [o] open in browser  [c] copy URL  [q] quit")

			// Extract token from connect URL and save config
			if t := connectURLToken(connectURL); t != "" {
				cfg.ServeToken = t
			}
			configChanged := false
			if tunnel != cfg.Tunnel {
				cfg.Tunnel = tunnel
				configChanged = true
			}
			if port != cfg.RemotePort {
				cfg.RemotePort = port
				configChanged = true
			}
			if cfg.ServeToken != "" {
				configChanged = true
			}
			if configChanged {
				if err := store.SaveConfig(cfg); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: save config: %v\n", err)
				}
			}

			// Keyboard loop + signal handling
			sigCh := make(chan os.Signal, 1)
			signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

			quitCh := make(chan struct{})
			primaryURL := shortURL
			if primaryURL == "" {
				primaryURL = connectURL
			}
			go remoteKeyboardLoop(primaryURL, quitCh)

			select {
			case <-sigCh:
			case <-quitCh:
			}

			// Cleanup: stop serve process
			fmt.Fprintln(os.Stderr, "\nStopping serve...")
			cancel()
			if serveCmd.Process != nil {
				_ = serveCmd.Process.Signal(syscall.SIGTERM)
				_ = serveCmd.Wait()
			}

			fmt.Fprintln(os.Stderr, "Serve stopped. Master session persists — reattach with: tmux attach -t whip-master")
			return nil
		},
	}

	cmd.Flags().StringVar(&backend, "backend", "claude", "AI backend (claude or codex)")
	cmd.Flags().StringVar(&difficulty, "difficulty", "hard", "Task difficulty (hard, medium, easy)")
	cmd.Flags().StringVar(&tunnel, "tunnel", "", "Cloudflare tunnel hostname")
	cmd.Flags().IntVar(&port, "port", 8585, "Serve port")
	cmd.Flags().Bool("new-token", false, "Generate a new auth token (discard saved token)")

	return cmd
}

func remoteKeyboardLoop(primaryURL string, quit chan struct{}) {
	fd := int(os.Stdin.Fd())
	old, err := term.MakeRaw(fd)
	if err != nil {
		// Not a terminal, just block
		select {}
	}
	defer term.Restore(fd, old)

	buf := make([]byte, 1)
	for {
		n, err := os.Stdin.Read(buf)
		if err != nil || n == 0 {
			return
		}
		switch buf[0] {
		case 'q', 'Q':
			close(quit)
			return
		case 'o', 'O':
			if primaryURL != "" {
				exec.Command("open", primaryURL).Start()
			}
		case 'c', 'C':
			if primaryURL != "" {
				c := exec.Command("pbcopy")
				c.Stdin = strings.NewReader(primaryURL)
				c.Run()
				fmt.Fprintln(os.Stderr, "  URL copied to clipboard")
			}
		}
	}
}

func upgradeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "upgrade",
		Short: "Upgrade whip to the latest version",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return upgrade.Run(upgrade.Config{
				Repo:           "bang9/ai-tools",
				BinaryName:     "whip",
				Version:        version,
				CompanionTools: []string{"claude-irc", "webform"},
			})
		},
	}
}

func helloCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "hello",
		Short: "Print hello world",
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Fprintln(cmd.OutOrStdout(), "hello world")
		},
	}
}

func versionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print version",
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Println(version)
		},
	}
}

// resolveDescription reads description from --desc, --file, or stdin.
func resolveDescription(desc, file string) (string, error) {
	if desc != "" {
		return desc, nil
	}
	if file != "" {
		data, err := os.ReadFile(file)
		if err != nil {
			return "", fmt.Errorf("cannot read description file: %w", err)
		}
		return strings.TrimSpace(string(data)), nil
	}

	// Try stdin
	stat, _ := os.Stdin.Stat()
	if (stat.Mode() & os.ModeCharDevice) == 0 {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return "", fmt.Errorf("cannot read stdin: %w", err)
		}
		content := strings.TrimSpace(string(data))
		if content != "" {
			return content, nil
		}
	}

	return "", nil
}

func formatShellPID(task *whip.Task) string {
	if task == nil || task.ShellPID <= 0 {
		return ""
	}
	state := whip.TaskProcessState(task)
	if state == whip.ProcessStateNone {
		return ""
	}
	return fmt.Sprintf("%d (%s)", task.ShellPID, state)
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	if max <= 3 {
		return s[:max]
	}
	return s[:max-2] + ".."
}

func timeAgo(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

func connectURLToken(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	if t := u.Query().Get("token"); t != "" {
		return t
	}
	fragment, err := url.ParseQuery(u.Fragment)
	if err != nil {
		return ""
	}
	return fragment.Get("token")
}
