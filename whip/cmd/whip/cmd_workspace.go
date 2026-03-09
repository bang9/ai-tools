package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"text/tabwriter"

	"github.com/bang9/ai-tools/whip/internal/whip"
	"github.com/spf13/cobra"
)

func workspaceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "workspace",
		Short: "Manage named workspaces",
	}

	cmd.AddCommand(
		workspaceListCmd(),
		workspaceShowCmd(),
		workspaceDropCmd(),
	)
	return cmd
}

func workspaceListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List named workspaces",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			workspaces, err := store.ListWorkspaces()
			if err != nil {
				return err
			}
			if len(workspaces) == 0 {
				fmt.Println("No workspaces.")
				return nil
			}

			tasks, err := store.ListTasks()
			if err != nil {
				return err
			}
			taskCounts := map[string]int{}
			for _, task := range tasks {
				if task.WorkspaceName() == whip.GlobalWorkspaceName {
					continue
				}
				taskCounts[task.WorkspaceName()]++
			}

			w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "NAME\tMODEL\tTASKS\tREPO\tWORKTREE")
			for _, workspace := range workspaces {
				fmt.Fprintf(w, "%s\t%s\t%d\t%s\t%s\n",
					workspace.WorkspaceName(),
					workspace.ExecutionModelLabel(),
					taskCounts[workspace.WorkspaceName()],
					workspace.OriginalRepoPath,
					workspace.WorktreePath,
				)
			}
			return w.Flush()
		},
	}
}

func workspaceShowCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <name>",
		Short: "Show workspace details",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := whip.NormalizeWorkspaceName(args[0])
			if name == whip.GlobalWorkspaceName {
				return fmt.Errorf("global is not a named workspace")
			}

			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			workspace, err := store.LoadWorkspace(name)
			if err != nil && !strings.Contains(err.Error(), "not found") {
				return err
			}
			if workspace == nil {
				workspace = &whip.Workspace{Name: name}
			}

			tasks, err := store.ListTasks()
			if err != nil {
				return err
			}

			fmt.Printf("Name:             %s\n", name)
			fmt.Printf("Execution model:  %s\n", workspace.ExecutionModelLabel())
			fmt.Printf("Original repo:    %s\n", workspace.OriginalRepoPath)
			fmt.Printf("Original cwd:     %s\n", workspace.OriginalCWD)
			fmt.Printf("Worktree path:    %s\n", workspace.WorktreePath)

			count := 0
			for _, task := range tasks {
				if task.WorkspaceName() != name {
					continue
				}
				if count == 0 {
					fmt.Printf("\nTasks:\n")
				}
				count++
				fmt.Printf("- %s  %s  %s\n", task.ID, task.Status, task.Title)
			}
			if count == 0 {
				fmt.Printf("\nTasks:            none\n")
			}
			return nil
		},
	}
}

func workspaceDropCmd() *cobra.Command {
	var force bool

	cmd := &cobra.Command{
		Use:   "drop <name>",
		Short: "Delete a workspace, its tasks, and its worktree",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := whip.NormalizeWorkspaceName(args[0])
			if name == whip.GlobalWorkspaceName {
				return fmt.Errorf("global is not a named workspace")
			}

			store, err := whip.NewStore()
			if err != nil {
				return err
			}

			tasks, err := store.ListTasks()
			if err != nil {
				return err
			}

			var workspaceTasks []*whip.Task
			for _, task := range tasks {
				if task.WorkspaceName() == name {
					workspaceTasks = append(workspaceTasks, task)
				}
			}

			if !force {
				for _, task := range workspaceTasks {
					if task.Status.IsActive() {
						return fmt.Errorf("workspace %s has active task %s (%s); rerun with --force", name, task.ID, task.Title)
					}
				}
			}

			for _, task := range workspaceTasks {
				if task.Runner == "tmux" && whip.IsTmuxSession(task.ID) {
					_ = whip.KillTmuxSession(task.ID)
				}
				if task.ShellPID > 0 && whip.IsProcessAlive(task.ShellPID) {
					_ = whip.KillProcess(task.ShellPID)
				}
				if err := store.DeleteTask(task.ID); err != nil {
					return err
				}
			}

			workspace, err := store.LoadWorkspace(name)
			if err != nil && !strings.Contains(err.Error(), "not found") {
				return err
			}
			if workspace != nil {
				if err := whip.RemoveWorkspaceWorktree(workspace); err != nil {
					return err
				}
			}

			if err := store.DeleteWorkspace(name); err != nil {
				return err
			}

			_ = exec.Command("claude-irc", "clean").Run()
			fmt.Fprintf(os.Stderr, "Dropped workspace %s (%d task(s))\n", name, len(workspaceTasks))
			return nil
		},
	}
	cmd.Flags().BoolVarP(&force, "force", "f", false, "Kill active sessions before dropping the workspace")
	return cmd
}
