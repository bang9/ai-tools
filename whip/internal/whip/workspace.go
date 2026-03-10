package whip

import (
	"fmt"
	"regexp"
	"strings"
)

const (
	GlobalWorkspaceName   = "global"
	workspacesDir         = "workspaces"
	workspaceFile         = "workspace.json"
	DefaultGlobalMasterIRCName = "wp-master"
)

var workspaceNamePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`)

func NormalizeWorkspaceName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" || name == GlobalWorkspaceName {
		return GlobalWorkspaceName
	}
	return name
}

func ValidateWorkspaceName(name string) error {
	normalized := NormalizeWorkspaceName(name)
	if normalized == GlobalWorkspaceName {
		return nil
	}
	if !workspaceNamePattern.MatchString(normalized) {
		return fmt.Errorf("invalid workspace %q: use lowercase letters, numbers, dots, dashes, or underscores", name)
	}
	return nil
}

func WorkspaceMasterIRCName(workspace string) string {
	workspace = NormalizeWorkspaceName(workspace)
	if workspace == GlobalWorkspaceName {
		return DefaultGlobalMasterIRCName
	}
	return DefaultGlobalMasterIRCName + "-" + workspace
}

func WorkspaceLeadIRCName(workspace string) string {
	workspace = NormalizeWorkspaceName(workspace)
	if workspace == GlobalWorkspaceName {
		return ""
	}
	return "wp-lead-" + workspace
}

func WorkspaceMasterSessionName(workspace string) string {
	return WorkspaceMasterIRCName(workspace)
}
