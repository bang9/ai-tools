package whip

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	whipDir         = ".whip"
	configFile      = "config.json"
	configLock      = "config.lock"
	tasksDir        = "tasks"
	taskFile        = "task.json"
	taskLockFile    = "task.lock"
	promptFile      = "prompt.txt"
	storeMetaFile   = ".store-meta.json"
	whipStoreKind   = "whip"
	privateDirPerm  = 0o700
	privateFilePerm = 0o600
)

type Config struct {
	MasterIRCName string `json:"master_irc_name"`
	Tunnel        string `json:"tunnel,omitempty"`
	RemotePort    int    `json:"remote_port,omitempty"`
	ServeToken    string `json:"serve_token,omitempty"`
}

type Store struct {
	BaseDir string
}

type storeMetadata struct {
	StoreKind     string    `json:"store_kind"`
	OwnerUID      int       `json:"owner_uid"`
	CanonicalRoot string    `json:"canonical_root"`
	CreatedAt     time.Time `json:"created_at"`
	InstallID     string    `json:"install_id"`
}

func NewStore() (*Store, error) {
	baseDir, err := ResolveWhipBaseDir()
	if err != nil {
		return nil, fmt.Errorf("cannot determine home directory: %w", err)
	}
	if err := ensurePrivateDir(filepath.Join(baseDir, tasksDir)); err != nil {
		return nil, fmt.Errorf("cannot create whip directory: %w", err)
	}
	if err := ensurePrivateDir(filepath.Join(baseDir, workspacesDir)); err != nil {
		return nil, fmt.Errorf("cannot create workspaces directory: %w", err)
	}
	return &Store{BaseDir: baseDir}, nil
}

func ResolveWhipBaseDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	defaultRoot, err := resolveDefaultStoreRoot(home, whipDir)
	if err != nil {
		return "", fmt.Errorf("resolve default whip home: %w", err)
	}

	target := defaultRoot
	if override := strings.TrimSpace(os.Getenv("WHIP_HOME")); override != "" {
		target, err = canonicalizeStorePath(override)
		if err != nil {
			return "", fmt.Errorf("resolve WHIP_HOME: %w", err)
		}
	}

	if err := validateStorePath(defaultRoot, target); err != nil {
		return "", fmt.Errorf("invalid WHIP_HOME: %w", err)
	}
	if err := ensureStoreRoot(target, whipStoreKind); err != nil {
		return "", fmt.Errorf("prepare WHIP_HOME: %w", err)
	}
	return target, nil
}

func ensureStoreRoot(dir string, kind string) error {
	if err := ensurePrivateDir(dir); err != nil {
		return err
	}
	return ensureStoreMetadata(dir, kind)
}

func ensurePrivateDir(dir string) error {
	if err := os.MkdirAll(dir, privateDirPerm); err != nil {
		return err
	}
	return os.Chmod(dir, privateDirPerm)
}

func ensureStoreMetadata(dir string, kind string) error {
	metaPath := filepath.Join(dir, storeMetaFile)
	currentUID := os.Geteuid()

	data, err := os.ReadFile(metaPath)
	if err == nil {
		var meta storeMetadata
		if err := json.Unmarshal(data, &meta); err != nil {
			return fmt.Errorf("parse %s: %w", storeMetaFile, err)
		}
		switch {
		case meta.StoreKind != kind:
			return fmt.Errorf("%s store kind mismatch: got %q want %q", storeMetaFile, meta.StoreKind, kind)
		case meta.OwnerUID != currentUID:
			return fmt.Errorf("%s owner uid mismatch: got %d want %d", storeMetaFile, meta.OwnerUID, currentUID)
		case meta.CanonicalRoot != dir:
			return fmt.Errorf("%s canonical root mismatch: got %q want %q", storeMetaFile, meta.CanonicalRoot, dir)
		case strings.TrimSpace(meta.InstallID) == "":
			return fmt.Errorf("%s install id is empty", storeMetaFile)
		case meta.CreatedAt.IsZero():
			return fmt.Errorf("%s created_at is empty", storeMetaFile)
		}
		return os.Chmod(metaPath, privateFilePerm)
	}
	if !os.IsNotExist(err) {
		return err
	}

	installID, err := generateStoreInstallID()
	if err != nil {
		return err
	}
	meta := storeMetadata{
		StoreKind:     kind,
		OwnerUID:      currentUID,
		CanonicalRoot: dir,
		CreatedAt:     time.Now().UTC(),
		InstallID:     installID,
	}
	encoded, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	return atomicWriteFile(metaPath, encoded, privateFilePerm)
}

func validateStorePath(defaultRoot, target string) error {
	if !isPathWithinRoot(defaultRoot, target) {
		return fmt.Errorf("%q is outside canonical root %q", target, defaultRoot)
	}

	currentUID := os.Geteuid()
	for current := target; ; current = filepath.Dir(current) {
		info, err := os.Stat(current)
		if err != nil {
			if !os.IsNotExist(err) {
				return err
			}
		} else {
			if !info.IsDir() {
				return fmt.Errorf("%q is not a directory", current)
			}
			if err := validateOwnedByCurrentUser(current, info, currentUID); err != nil {
				return err
			}
			if info.Mode().Perm()&0o022 != 0 {
				return fmt.Errorf("%q must not be group/world writable", current)
			}
		}
		if current == defaultRoot {
			return nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return fmt.Errorf("cannot walk parent chain for %q", target)
		}
	}
}

func validateOwnedByCurrentUser(path string, info os.FileInfo, currentUID int) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("cannot determine owner for %q", path)
	}
	if int(stat.Uid) != currentUID {
		return fmt.Errorf("%q is owned by uid %d, want %d", path, stat.Uid, currentUID)
	}
	return nil
}

func isPathWithinRoot(root, target string) bool {
	if root == target {
		return true
	}
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

func resolveDefaultStoreRoot(home, leaf string) (string, error) {
	literalRoot, err := filepath.Abs(filepath.Clean(filepath.Join(home, leaf)))
	if err != nil {
		return "", err
	}
	if err := rejectSymlinkedDefaultRoot(literalRoot); err != nil {
		return "", err
	}

	canonicalParent, err := canonicalizeStorePath(filepath.Dir(literalRoot))
	if err != nil {
		return "", err
	}
	return filepath.Clean(filepath.Join(canonicalParent, filepath.Base(literalRoot))), nil
}

func rejectSymlinkedDefaultRoot(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%q must not be a symlink", path)
	}
	if !info.IsDir() {
		return fmt.Errorf("%q is not a directory", path)
	}
	return nil
}

func canonicalizeStorePath(path string) (string, error) {
	absPath, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", err
	}

	missing := make([]string, 0, 4)
	current := absPath
	for {
		info, err := os.Lstat(current)
		if err == nil {
			isSymlink := info.Mode()&os.ModeSymlink != 0
			if !info.IsDir() && !isSymlink && len(missing) > 0 {
				return "", fmt.Errorf("%q is not a directory", current)
			}
			resolved, err := filepath.EvalSymlinks(current)
			if err != nil {
				return "", err
			}
			if len(missing) > 0 {
				resolvedInfo, err := os.Stat(resolved)
				if err != nil {
					return "", err
				}
				if !resolvedInfo.IsDir() {
					return "", fmt.Errorf("%q is not a directory", current)
				}
			}
			if len(missing) == 0 {
				return filepath.Clean(resolved), nil
			}
			parts := append([]string{resolved}, missing...)
			return filepath.Clean(filepath.Join(parts...)), nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}

		parent := filepath.Dir(current)
		if parent == current {
			return "", fmt.Errorf("cannot resolve %q", path)
		}
		missing = append([]string{filepath.Base(current)}, missing...)
		current = parent
	}
}

func generateStoreInstallID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
