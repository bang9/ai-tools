package main

import (
	"os"

	"github.com/spf13/cobra"
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
		taskCmd(),
		workspaceCmd(),
		dashboardCmd(),
		remoteCmd(),
		upgradeCmd(),
		versionCmd(),
	)

	return root
}
