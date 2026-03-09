package whip

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type Workspace struct {
	Name             string                  `json:"name"`
	ExecutionModel   WorkspaceExecutionModel `json:"execution_model,omitempty"`
	OriginalRepoPath string                  `json:"original_repo_path,omitempty"`
	OriginalCWD      string                  `json:"original_cwd,omitempty"`
	WorktreePath     string                  `json:"worktree_path,omitempty"`
	CreatedAt        time.Time               `json:"created_at,omitempty"`
	UpdatedAt        time.Time               `json:"updated_at,omitempty"`
}

type gitContext struct {
	RepoRoot   string
	RepoSubdir string
}

type WorkspaceExecutionModel string

const (
	WorkspaceExecutionModelGitWorktree WorkspaceExecutionModel = "git-worktree"
	WorkspaceExecutionModelDirectCWD   WorkspaceExecutionModel = "direct-cwd"
)

func (w *Workspace) WorkspaceName() string {
	return NormalizeWorkspaceName(w.Name)
}

func (w *Workspace) EffectiveExecutionModel() WorkspaceExecutionModel {
	if w == nil {
		return ""
	}
	if w.ExecutionModel != "" {
		return w.ExecutionModel
	}
	if strings.TrimSpace(w.OriginalRepoPath) != "" || strings.TrimSpace(w.WorktreePath) != "" {
		return WorkspaceExecutionModelGitWorktree
	}
	if strings.TrimSpace(w.OriginalCWD) != "" {
		return WorkspaceExecutionModelDirectCWD
	}
	return ""
}

func (w *Workspace) normalizeExecutionModel() error {
	if w == nil {
		return fmt.Errorf("workspace is nil")
	}
	model := w.EffectiveExecutionModel()
	switch model {
	case "", WorkspaceExecutionModelGitWorktree, WorkspaceExecutionModelDirectCWD:
		w.ExecutionModel = model
		return nil
	default:
		return fmt.Errorf("invalid workspace execution model %q", model)
	}
}

func (w *Workspace) ExecutionModelLabel() string {
	model := w.EffectiveExecutionModel()
	if model == "" {
		return "unspecified"
	}
	return string(model)
}

func (s *Store) workspaceMetaPath(name string) string {
	return filepath.Join(s.workspaceDir(name), workspaceFile)
}

func (s *Store) workspaceWorktreePath(name string) string {
	return filepath.Join(s.workspaceDir(name), "worktree")
}

func (s *Store) LoadWorkspace(name string) (*Workspace, error) {
	name = NormalizeWorkspaceName(name)
	if name == GlobalWorkspaceName {
		return nil, fmt.Errorf("global does not use workspace metadata")
	}

	data, err := os.ReadFile(s.workspaceMetaPath(name))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("workspace %s not found", name)
		}
		return nil, err
	}

	var workspace Workspace
	if err := json.Unmarshal(data, &workspace); err != nil {
		return nil, fmt.Errorf("corrupt workspace %s: %w", name, err)
	}
	workspace.Name = name
	return &workspace, nil
}

func (s *Store) SaveWorkspace(workspace *Workspace) error {
	if workspace == nil {
		return fmt.Errorf("workspace is nil")
	}

	workspace.Name = NormalizeWorkspaceName(workspace.Name)
	if workspace.Name == GlobalWorkspaceName {
		return fmt.Errorf("global does not use workspace metadata")
	}
	if err := workspace.normalizeExecutionModel(); err != nil {
		return err
	}
	if err := ensurePrivateDir(s.workspaceDir(workspace.Name)); err != nil {
		return err
	}
	data, err := json.MarshalIndent(workspace, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return atomicWriteFile(s.workspaceMetaPath(workspace.Name), data, privateFilePerm)
}

func (s *Store) ListWorkspaces() ([]*Workspace, error) {
	var workspaces []*Workspace
	entries, err := os.ReadDir(filepath.Join(s.BaseDir, workspacesDir))
	if err != nil {
		if os.IsNotExist(err) {
			return []*Workspace{}, nil
		}
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := NormalizeWorkspaceName(entry.Name())
		workspace, err := s.LoadWorkspace(name)
		if err != nil {
			if strings.Contains(err.Error(), "not found") {
				workspace = &Workspace{Name: name}
			} else {
				return nil, err
			}
		}
		workspaces = append(workspaces, workspace)
	}
	sort.Slice(workspaces, func(i, j int) bool {
		return workspaces[i].WorkspaceName() < workspaces[j].WorkspaceName()
	})
	return workspaces, nil
}

func (s *Store) EnsureWorkspace(name string, cwd string) (*Workspace, string, error) {
	name = NormalizeWorkspaceName(name)
	if name == GlobalWorkspaceName {
		return nil, cwd, nil
	}
	if cwd == "" {
		return nil, "", fmt.Errorf("cwd is required")
	}

	resolvedCWD, err := canonicalizeStorePath(cwd)
	if err != nil {
		return nil, "", err
	}

	workspace, err := s.loadOrInitWorkspace(name, resolvedCWD)
	if err != nil {
		return nil, "", err
	}
	if workspace.WorktreePath != "" {
		if canonicalWorktreePath, err := canonicalizeStorePath(workspace.WorktreePath); err == nil {
			workspace.WorktreePath = canonicalWorktreePath
		}
	}

	if workspace.WorktreePath != "" && isPathWithinRoot(workspace.WorktreePath, resolvedCWD) {
		workspace.ExecutionModel = WorkspaceExecutionModelGitWorktree
		workspace.UpdatedAt = time.Now().UTC()
		if err := s.SaveWorkspace(workspace); err != nil {
			return nil, "", err
		}
		return workspace, resolvedCWD, nil
	}

	gitCtx, err := detectGitContext(resolvedCWD)
	if err != nil {
		return nil, "", err
	}
	if gitCtx == nil {
		switch workspace.EffectiveExecutionModel() {
		case "", WorkspaceExecutionModelDirectCWD:
			workspace.ExecutionModel = WorkspaceExecutionModelDirectCWD
		case WorkspaceExecutionModelGitWorktree:
			return nil, "", fmt.Errorf("workspace %s uses execution model %s and is bound to repo %s; cwd %s is outside that repo", name, WorkspaceExecutionModelGitWorktree, workspace.OriginalRepoPath, resolvedCWD)
		default:
			return nil, "", fmt.Errorf("workspace %s has unsupported execution model %q", name, workspace.ExecutionModel)
		}
		if workspace.OriginalCWD == "" {
			workspace.OriginalCWD = resolvedCWD
		}
		workspace.UpdatedAt = time.Now().UTC()
		if err := s.SaveWorkspace(workspace); err != nil {
			return nil, "", err
		}
		return workspace, resolvedCWD, nil
	}

	switch workspace.EffectiveExecutionModel() {
	case "", WorkspaceExecutionModelGitWorktree:
		workspace.ExecutionModel = WorkspaceExecutionModelGitWorktree
	case WorkspaceExecutionModelDirectCWD:
		return nil, "", fmt.Errorf("workspace %s uses execution model %s and cannot be rebound to git repo %s", name, WorkspaceExecutionModelDirectCWD, gitCtx.RepoRoot)
	default:
		return nil, "", fmt.Errorf("workspace %s has unsupported execution model %q", name, workspace.ExecutionModel)
	}

	if workspace.OriginalRepoPath != "" && workspace.OriginalRepoPath != gitCtx.RepoRoot {
		return nil, "", fmt.Errorf("workspace %s belongs to repo %s, not %s", name, workspace.OriginalRepoPath, gitCtx.RepoRoot)
	}

	if workspace.OriginalRepoPath == "" {
		workspace.OriginalRepoPath = gitCtx.RepoRoot
	}
	if workspace.OriginalCWD == "" {
		workspace.OriginalCWD = resolvedCWD
	}
	if workspace.WorktreePath == "" {
		workspace.WorktreePath = s.workspaceWorktreePath(name)
	}
	if err := ensureGitWorktree(workspace.OriginalRepoPath, workspace.WorktreePath); err != nil {
		return nil, "", err
	}
	canonicalWorktreePath, err := canonicalizeStorePath(workspace.WorktreePath)
	if err != nil {
		return nil, "", err
	}
	workspace.WorktreePath = canonicalWorktreePath

	workspace.UpdatedAt = time.Now().UTC()
	if err := s.SaveWorkspace(workspace); err != nil {
		return nil, "", err
	}

	if gitCtx.RepoSubdir == "" {
		return workspace, workspace.WorktreePath, nil
	}
	return workspace, filepath.Join(workspace.WorktreePath, gitCtx.RepoSubdir), nil
}

func (s *Store) DeleteWorkspace(name string) error {
	name = NormalizeWorkspaceName(name)
	if name == GlobalWorkspaceName {
		return fmt.Errorf("cannot delete global workspace")
	}
	return os.RemoveAll(s.workspaceDir(name))
}

func (s *Store) loadOrInitWorkspace(name string, cwd string) (*Workspace, error) {
	workspace, err := s.LoadWorkspace(name)
	if err == nil {
		return workspace, nil
	}
	if !strings.Contains(err.Error(), "not found") {
		return nil, err
	}
	now := time.Now().UTC()
	return &Workspace{
		Name:      name,
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

func detectGitContext(cwd string) (*gitContext, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return nil, nil
	}

	cmd := exec.Command("git", "-C", cwd, "rev-parse", "--show-toplevel")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, nil
	}

	repoRoot, err := canonicalizeStorePath(strings.TrimSpace(string(output)))
	if err != nil {
		return nil, err
	}
	repoSubdir, err := filepath.Rel(repoRoot, cwd)
	if err != nil {
		return nil, err
	}
	if repoSubdir == "." {
		repoSubdir = ""
	}
	return &gitContext{RepoRoot: repoRoot, RepoSubdir: repoSubdir}, nil
}

func ensureGitWorktree(repoRoot string, worktreePath string) error {
	if strings.TrimSpace(repoRoot) == "" || strings.TrimSpace(worktreePath) == "" {
		return fmt.Errorf("repo root and worktree path are required")
	}
	if _, err := os.Stat(worktreePath); err == nil {
		return nil
	}

	if err := ensurePrivateDir(filepath.Dir(worktreePath)); err != nil {
		return err
	}

	pruneCmd := exec.Command("git", "-C", repoRoot, "worktree", "prune")
	_ = pruneCmd.Run()

	cmd := exec.Command("git", "-C", repoRoot, "worktree", "add", "--detach", worktreePath, "HEAD")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("git worktree add %s: %s", worktreePath, strings.TrimSpace(string(output)))
	}
	return nil
}

func RemoveWorkspaceWorktree(workspace *Workspace) error {
	if workspace == nil || strings.TrimSpace(workspace.WorktreePath) == "" {
		return nil
	}

	if strings.TrimSpace(workspace.OriginalRepoPath) != "" {
		cmd := exec.Command("git", "-C", workspace.OriginalRepoPath, "worktree", "remove", "--force", workspace.WorktreePath)
		output, err := cmd.CombinedOutput()
		if err == nil {
			return nil
		}
		if strings.TrimSpace(string(output)) != "" {
			return fmt.Errorf("git worktree remove %s: %s", workspace.WorktreePath, strings.TrimSpace(string(output)))
		}
	}

	if err := os.RemoveAll(workspace.WorktreePath); err != nil {
		return err
	}
	return nil
}
