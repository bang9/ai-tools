package vaultkey

import (
	"errors"
)

// SyncMutation pulls the latest vault state, applies op, and syncs the
// result to the remote.
//
// If the repo already has local commits conflicting with the remote (e.g.
// from offline work), it refuses to pile on top and returns the
// SyncConflictError with recovery instructions. If the sync itself races
// with a concurrent push and conflicts, it recovers automatically: the
// just-created commit is dropped, the remote state is taken, and op is
// re-applied on top (per-key last-writer-wins).
func SyncMutation(repoPath, password string, op func(*Vault) error) error {
	// Other pull failures (e.g. offline) keep the old best-effort behavior:
	// the mutation proceeds locally and the sync step reports the error.
	if err := GitPull(repoPath); err != nil {
		var conflict *SyncConflictError
		if errors.As(err, &conflict) {
			return err
		}
	}

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		v, err := LoadVault(repoPath, password)
		if err != nil {
			return err
		}
		if err := op(v); err != nil {
			return err
		}

		err = GitSync(repoPath)
		if err == nil {
			return nil
		}
		var conflict *SyncConflictError
		if !errors.As(err, &conflict) {
			return err
		}
		lastErr = err

		if AheadCount(repoPath) != 1 {
			// More than the commit we just created is unpushed — recovering
			// would drop offline work, so hand over to 'vaultkey repair'.
			return err
		}
		if rerr := ResetToUpstream(repoPath); rerr != nil {
			return rerr
		}
	}
	return lastErr
}
