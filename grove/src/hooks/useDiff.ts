import { useEffect } from "react";
import { useDiffStore } from "../store/diff";

export function useDiff(worktreePath: string | null) {
  const store = useDiffStore();

  // Polling + focus refresh are registered once at app level; see lib/diff-sync.ts.
  useEffect(() => {
    store.setWorktreePath(worktreePath);
    if (worktreePath) {
      store.loadStatus();
      store.loadCommits();
      store.loadBehindCount();
    }
  }, [worktreePath]);

  return store;
}
