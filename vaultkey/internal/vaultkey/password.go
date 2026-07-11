package vaultkey

import (
	"fmt"
	"os"
	"strings"

	"golang.org/x/term"
)

// vaultPasswordEnv maps a vault name to its dedicated password env var,
// e.g. "work" -> VAULTKEY_PASSWORD_WORK, "my-team" -> VAULTKEY_PASSWORD_MY_TEAM.
func vaultPasswordEnv(vaultName string) string {
	if vaultName == "" {
		return ""
	}
	sanitized := strings.NewReplacer("-", "_").Replace(strings.ToUpper(vaultName))
	return "VAULTKEY_PASSWORD_" + sanitized
}

// resolvePassword applies the non-interactive sources in priority order:
// explicit --password flag, per-vault env, then global env.
func resolvePassword(flagValue, vaultName string) string {
	if flagValue != "" {
		return flagValue
	}
	if key := vaultPasswordEnv(vaultName); key != "" {
		if env := os.Getenv(key); env != "" {
			return env
		}
	}
	return os.Getenv("VAULTKEY_PASSWORD")
}

func GetPassword(flagValue, vaultName string) (string, error) {
	if pw := resolvePassword(flagValue, vaultName); pw != "" {
		return pw, nil
	}
	return promptPassword("Password: ")
}

func GetPasswordWithConfirm(flagValue, vaultName string) (string, error) {
	if pw := resolvePassword(flagValue, vaultName); pw != "" {
		return pw, nil
	}

	// Interactive prompt with confirmation
	pw, err := promptPassword("New password: ")
	if err != nil {
		return "", err
	}

	confirm, err := promptPassword("Confirm password: ")
	if err != nil {
		return "", err
	}

	if pw != confirm {
		return "", fmt.Errorf("passwords do not match")
	}

	return pw, nil
}

func promptPassword(prompt string) (string, error) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		return "", fmt.Errorf("no password provided (use VAULTKEY_PASSWORD env or --password flag)")
	}

	fmt.Fprint(os.Stderr, prompt)
	raw, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", fmt.Errorf("reading password: %w", err)
	}

	pw := strings.TrimSpace(string(raw))
	if pw == "" {
		return "", fmt.Errorf("password cannot be empty")
	}
	return pw, nil
}
