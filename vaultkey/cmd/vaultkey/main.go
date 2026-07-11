package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/bang9/ai-tools/shared/upgrade"
	"github.com/bang9/ai-tools/vaultkey/internal/vaultkey"
	"github.com/spf13/cobra"
)

var (
	passwordFlag string
	ciFlag       bool
	vaultFlag    string

	// Set via -ldflags at build time
	version = "dev"
)

func main() {
	root := &cobra.Command{
		Use:          "vaultkey",
		Short:        "Encrypted secrets manager backed by a private Git repo",
		Version:      version,
		SilenceUsage: true,
	}

	root.PersistentFlags().StringVar(&passwordFlag, "password", "", "vault password (or use VAULTKEY_PASSWORD env)")
	root.PersistentFlags().BoolVar(&ciFlag, "ci", false, "CI mode: skip interactive prompts")
	root.PersistentFlags().StringVar(&vaultFlag, "vault", "", "vault to operate on (or use VAULTKEY_VAULT env; defaults to the vault set via 'vaultkey use')")

	root.AddCommand(initCmd(), setCmd(), getCmd(), listCmd(), deleteCmd(), pushCmd(), pullCmd(), useCmd(), vaultsCmd(), repairCmd(), upgradeCmd(), migrateCmd())

	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}

// selectedVaultName returns the vault explicitly requested via --vault or
// VAULTKEY_VAULT, or "" when the config's default vault should be used.
func selectedVaultName() string {
	if vaultFlag != "" {
		return vaultFlag
	}
	return os.Getenv("VAULTKEY_VAULT")
}

// resolveVault loads the config and picks the vault to operate on.
func resolveVault() (string, vaultkey.VaultEntry, error) {
	cfg, err := vaultkey.LoadConfig()
	if err != nil {
		return "", vaultkey.VaultEntry{}, err
	}
	return cfg.Resolve(selectedVaultName())
}

func initCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "init <git-repo-url>",
		Short: "Clone repo and create a new vault (name it with --vault, default: \"default\")",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			repoURL := args[0]

			name := selectedVaultName()
			if name == "" {
				name = vaultkey.DefaultVaultName
			}
			if err := vaultkey.ValidateVaultName(name); err != nil {
				return err
			}

			cfg, err := vaultkey.LoadConfigIfExists()
			if err != nil {
				return err
			}
			if _, exists := cfg.Vaults[name]; exists {
				return fmt.Errorf("vault %q already exists (pick another name with --vault, or remove it from %s first)", name, vaultkey.ConfigPath())
			}

			var pw string
			if ciFlag {
				pw, err = vaultkey.GetPassword(passwordFlag, name)
			} else {
				pw, err = vaultkey.GetPasswordWithConfirm(passwordFlag, name)
			}
			if err != nil {
				return err
			}

			configDir := vaultkey.ConfigDir()
			if err := vaultkey.EnsurePathNotSymlink(configDir); err != nil {
				return fmt.Errorf("checking config dir: %w", err)
			}

			reposDir := vaultkey.ReposDir()
			if err := vaultkey.EnsurePathNotSymlink(reposDir); err != nil {
				return fmt.Errorf("checking repos dir: %w", err)
			}

			repoPath := filepath.Join(reposDir, name)
			if err := vaultkey.EnsurePathNotSymlink(repoPath); err != nil {
				return fmt.Errorf("checking repo path: %w", err)
			}

			if _, err := os.Lstat(repoPath); err == nil {
				return fmt.Errorf("repo already exists at %s (delete it first to reinit)", repoPath)
			} else if !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("checking repo path: %w", err)
			}

			fmt.Fprintf(os.Stderr, "Cloning %s...\n", vaultkey.RedactURLCredentials(repoURL))
			if err := vaultkey.GitClone(repoURL, repoPath); err != nil {
				return err
			}

			vaultPath := filepath.Join(repoPath, "vault.json")
			if err := vaultkey.EnsurePathNotSymlink(vaultPath); err != nil {
				return fmt.Errorf("checking vault path: %w", err)
			}
			if _, err := os.Lstat(vaultPath); err == nil {
				// vault.json already exists in repo — just save config
				fmt.Fprintln(os.Stderr, "Found existing vault.json in repo.")
			} else if !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("checking vault path: %w", err)
			} else {
				// Create new vault
				if _, err := vaultkey.CreateVault(repoPath, pw); err != nil {
					return err
				}
				fmt.Fprintln(os.Stderr, "Created new vault.")
			}

			cfg.Vaults[name] = vaultkey.VaultEntry{RepoPath: repoPath}
			if cfg.DefaultVault == "" {
				cfg.DefaultVault = name
			}
			if err := vaultkey.SaveConfig(cfg); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Initialized vault %q successfully.\n", name)
			if cfg.DefaultVault != name {
				fmt.Fprintf(os.Stderr, "Default vault is still %q. Run 'vaultkey use %s' to switch.\n", cfg.DefaultVault, name)
			}
			return nil
		},
	}
}

func setCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set <scope> <key> <value>",
		Short: "Store an encrypted secret",
		Args:  cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			scope, key, value := args[0], args[1], args[2]

			name, entry, err := resolveVault()
			if err != nil {
				return err
			}

			pw, err := vaultkey.GetPassword(passwordFlag, name)
			if err != nil {
				return err
			}

			err = vaultkey.SyncMutation(entry.RepoPath, pw, func(v *vaultkey.Vault) error {
				if v.IsLegacy() {
					fmt.Fprintln(os.Stderr, "Warning: vault uses legacy v1 format. Run 'vaultkey migrate' to upgrade to Argon2id.")
				}
				return v.Set(scope, key, value)
			})
			if err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Set %s/%s (vault: %s)\n", scope, key, name)
			fmt.Fprintln(os.Stderr, "Synced.")
			return nil
		},
	}
}

func getCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <scope> <key>",
		Short: "Retrieve and decrypt a secret",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			scope, key := args[0], args[1]

			v, err := openVault()
			if err != nil {
				return err
			}

			value, err := v.Get(scope, key)
			if err != nil {
				return err
			}

			fmt.Print(value)
			return nil
		},
	}
}

func listCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list [scope-prefix]",
		Short: "List scopes and keys (values are not shown)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			v, err := openVault()
			if err != nil {
				return err
			}

			prefix := ""
			if len(args) > 0 {
				prefix = args[0]
			}

			entries := v.List(prefix)
			if len(entries) == 0 {
				fmt.Fprintln(os.Stderr, "No entries found.")
				return nil
			}

			for _, e := range entries {
				fmt.Println(e)
			}
			return nil
		},
	}
}

func deleteCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "delete <scope> <key>",
		Short: "Delete a secret",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			scope, key := args[0], args[1]

			name, entry, err := resolveVault()
			if err != nil {
				return err
			}

			pw, err := vaultkey.GetPassword(passwordFlag, name)
			if err != nil {
				return err
			}

			err = vaultkey.SyncMutation(entry.RepoPath, pw, func(v *vaultkey.Vault) error {
				return v.Delete(scope, key)
			})
			if err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Deleted %s/%s (vault: %s)\n", scope, key, name)
			fmt.Fprintln(os.Stderr, "Synced.")
			return nil
		},
	}
}

func pushCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "push",
		Short: "Commit and push vault changes to remote",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			_, entry, err := resolveVault()
			if err != nil {
				return err
			}

			if err := vaultkey.GitPush(entry.RepoPath); err != nil {
				return err
			}

			fmt.Fprintln(os.Stderr, "Pushed successfully.")
			return nil
		},
	}
}

func pullCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "pull",
		Short: "Pull latest vault changes from remote",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			_, entry, err := resolveVault()
			if err != nil {
				return err
			}

			if err := vaultkey.GitPull(entry.RepoPath); err != nil {
				return err
			}

			fmt.Fprintln(os.Stderr, "Pulled successfully.")
			return nil
		},
	}
}

func useCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "use <vault-name>",
		Short: "Set the default vault",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]

			cfg, err := vaultkey.LoadConfig()
			if err != nil {
				return err
			}

			if _, _, err := cfg.Resolve(name); err != nil {
				return err
			}

			cfg.DefaultVault = name
			if err := vaultkey.SaveConfig(cfg); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Default vault set to %q.\n", name)
			return nil
		},
	}
}

func vaultsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "vaults",
		Short: "List configured vaults (* marks the default)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := vaultkey.LoadConfig()
			if err != nil {
				return err
			}

			for _, name := range cfg.VaultNames() {
				marker := " "
				if name == cfg.DefaultVault {
					marker = "*"
				}
				fmt.Printf("%s %s\t%s\n", marker, name, cfg.Vaults[name].RepoPath)
			}
			return nil
		},
	}
}

func repairCmd() *cobra.Command {
	var takeRemote, keepLocal bool
	cmd := &cobra.Command{
		Use:   "repair",
		Short: "Recover a vault repo from a conflicted git state",
		Long: `Recover a vault repo from a conflicted git state.

Without flags, aborts any stuck rebase, restores a conflicted vault.json,
and tries to sync. If local unpushed commits conflict with the remote,
pick a side:

  --take-remote   discard local unpushed changes, keep the remote state
  --keep-local    overwrite the remote with the local state`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if takeRemote && keepLocal {
				return fmt.Errorf("--take-remote and --keep-local are mutually exclusive")
			}

			name, entry, err := resolveVault()
			if err != nil {
				return err
			}
			repoPath := entry.RepoPath

			if vaultkey.RebaseInProgress(repoPath) {
				vaultkey.AbortRebase(repoPath)
				fmt.Fprintln(os.Stderr, "Aborted in-progress rebase.")
			}
			if vaultkey.VaultFileHasConflictMarkers(repoPath) {
				if err := vaultkey.RestoreVaultFile(repoPath); err != nil {
					return err
				}
				fmt.Fprintln(os.Stderr, "Restored vault.json from the last committed version.")
			}

			switch {
			case takeRemote:
				if err := vaultkey.ResetToUpstream(repoPath); err != nil {
					return err
				}
				fmt.Fprintln(os.Stderr, "Discarded local unpushed changes; vault now matches remote.")
			case keepLocal:
				if err := vaultkey.ForcePushLocal(repoPath); err != nil {
					return err
				}
				fmt.Fprintln(os.Stderr, "Overwrote remote with local state.")
			}

			if err := vaultkey.GitSync(repoPath); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Vault %q is healthy and synced.\n", name)
			return nil
		},
	}
	cmd.Flags().BoolVar(&takeRemote, "take-remote", false, "discard local unpushed changes and reset to the remote state")
	cmd.Flags().BoolVar(&keepLocal, "keep-local", false, "overwrite the remote with the local state (force push)")
	return cmd
}

func upgradeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "upgrade",
		Short: "Upgrade vaultkey to the latest version",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return upgrade.Run(upgrade.Config{
				Repo:       "bang9/ai-tools",
				BinaryName: "vaultkey",
				Version:    version,
			})
		},
	}
}

func migrateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "migrate",
		Short: "Migrate vault from v1 (PBKDF2) to v2 (Argon2id + AAD)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			name, entry, err := resolveVault()
			if err != nil {
				return err
			}

			pw, err := vaultkey.GetPassword(passwordFlag, name)
			if err != nil {
				return err
			}

			// Pull latest before mutation; a conflict must be repaired first
			if perr := vaultkey.GitPull(entry.RepoPath); perr != nil {
				var conflict *vaultkey.SyncConflictError
				if errors.As(perr, &conflict) {
					return perr
				}
			}

			v, err := vaultkey.LoadVault(entry.RepoPath, pw)
			if err != nil {
				return err
			}

			count, err := v.Migrate(pw)
			if err != nil {
				return err
			}

			if count == 0 {
				fmt.Fprintln(os.Stderr, "Vault is already v2, nothing to migrate.")
				return nil
			}

			fmt.Fprintf(os.Stderr, "Migrated %d secret(s) to v2 (Argon2id + AAD).\n", count)

			if err := vaultkey.GitSync(entry.RepoPath); err != nil {
				return fmt.Errorf("sync failed: %w", err)
			}
			fmt.Fprintln(os.Stderr, "Synced.")
			return nil
		},
	}
}

func openVault() (*vaultkey.Vault, error) {
	name, entry, err := resolveVault()
	if err != nil {
		return nil, err
	}

	pw, err := vaultkey.GetPassword(passwordFlag, name)
	if err != nil {
		return nil, err
	}

	return vaultkey.LoadVault(entry.RepoPath, pw)
}
