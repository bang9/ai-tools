package main

import (
	"fmt"

	"github.com/bang9/ai-tools/shared/upgrade"
	"github.com/spf13/cobra"
)

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
