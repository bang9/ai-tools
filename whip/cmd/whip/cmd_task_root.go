package main

import "github.com/spf13/cobra"

func taskCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "task",
		Short: "Manage tasks",
	}

	cmd.AddCommand(
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
		depCmd(),
	)
	return cmd
}
