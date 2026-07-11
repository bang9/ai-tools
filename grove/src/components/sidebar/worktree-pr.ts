import { useCallback, useEffect } from "react";
import type { WorktreePullRequest } from "../../types";
import { create } from "zustand";
import { runCommandSafely } from "../../lib/command";
import { getWorktreePrUrl } from "../../lib/platform";

const WORKTREE_PR_RESULT_CACHE_VERSION = 1;
const WORKTREE_PR_FOUND_CACHE_TTL_MS = 120_000;
const WORKTREE_PR_MISSING_CACHE_TTL_MS = 180_000;

export interface WorktreePrLookupInput {
  projectOrg: string;
  projectRepo: string;
  worktreeBranch: string;
  worktreePath: string;
}

interface WorktreePrEntry {
  version: number;
  loading: boolean;
  pullRequest: WorktreePullRequest | null;
  fetchedAt: number | null;
}

interface WorktreePrState {
  entries: Record<string, WorktreePrEntry>;
  ensureWorktreePrUrl: (key: string, worktreePath: string) => Promise<void>;
}

const EMPTY_ENTRY: WorktreePrEntry = {
  version: WORKTREE_PR_RESULT_CACHE_VERSION,
  loading: false,
  pullRequest: null,
  fetchedAt: null,
};

const inflightRequests = new Map<string, Promise<void>>();

function entryTtlMs(entry: WorktreePrEntry): number | null {
  if (entry.pullRequest == null) {
    return WORKTREE_PR_MISSING_CACHE_TTL_MS;
  }
  if (entry.pullRequest.status === "merged") {
    return null;
  }
  return WORKTREE_PR_FOUND_CACHE_TTL_MS;
}

function isEntryFresh(entry: WorktreePrEntry | undefined): boolean {
  if (entry == null || entry.fetchedAt == null) {
    return false;
  }
  if (entry.version !== WORKTREE_PR_RESULT_CACHE_VERSION) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(entry, "pullRequest")) {
    return false;
  }

  const ttl = entryTtlMs(entry);
  if (ttl == null) {
    return true;
  }

  return Date.now() - entry.fetchedAt < ttl;
}

export function createWorktreePrLookupKey(
  projectOrg: string,
  projectRepo: string,
  worktreeBranch: string,
): string | null {
  const org = projectOrg.trim();
  const repo = projectRepo.trim();
  const branch = worktreeBranch.trim();

  if (!org || !repo || !branch) {
    return null;
  }

  return `${org}/${repo}:${branch}`;
}

export function selectWorktreePrEntry(state: WorktreePrState, key: string | null): WorktreePrEntry {
  if (!key) {
    return EMPTY_ENTRY;
  }

  return state.entries[key] ?? EMPTY_ENTRY;
}

export const useWorktreePrStore = create<WorktreePrState>((set, get) => ({
  entries: {},
  ensureWorktreePrUrl: async (key, worktreePath) => {
    const cachedEntry = get().entries[key];
    if (isEntryFresh(cachedEntry)) {
      return;
    }

    const existingRequest = inflightRequests.get(key);
    if (existingRequest) {
      return existingRequest;
    }

    set((state) => ({
      entries: {
        ...state.entries,
        [key]: {
          version: WORKTREE_PR_RESULT_CACHE_VERSION,
          loading: true,
          pullRequest: cachedEntry?.pullRequest ?? null,
          fetchedAt: cachedEntry?.fetchedAt ?? null,
        },
      },
    }));

    const request = (async () => {
      const pullRequest = await runCommandSafely(() => getWorktreePrUrl(worktreePath), {
        errorToast: false,
      });

      set((state) => ({
        entries: {
          ...state.entries,
          [key]: {
            version: WORKTREE_PR_RESULT_CACHE_VERSION,
            loading: false,
            pullRequest,
            fetchedAt: Date.now(),
          },
        },
      }));
    })().finally(() => {
      inflightRequests.delete(key);
    });

    inflightRequests.set(key, request);
    return request;
  },
}));

export function invalidateWorktreePr(key: string): void {
  const entry = useWorktreePrStore.getState().entries[key];
  if (!entry) {
    return;
  }

  useWorktreePrStore.setState((state) => ({
    entries: {
      ...state.entries,
      [key]: { ...entry, fetchedAt: null },
    },
  }));
}

export function resetWorktreePrLookupState(): void {
  inflightRequests.clear();
  useWorktreePrStore.setState({ entries: {} });
}

export function useWorktreePrUrl(input: WorktreePrLookupInput) {
  const key = createWorktreePrLookupKey(input.projectOrg, input.projectRepo, input.worktreeBranch);
  const entry = useWorktreePrStore((state) => selectWorktreePrEntry(state, key));

  useEffect(() => {
    if (!key) {
      return;
    }
    if (entry.loading || isEntryFresh(entry)) {
      return;
    }

    void useWorktreePrStore.getState().ensureWorktreePrUrl(key, input.worktreePath);
  }, [entry.fetchedAt, entry.loading, entry.pullRequest, input.worktreePath, key]);

  useEffect(() => {
    if (!key || entry.fetchedAt == null) {
      return;
    }

    const ttl = entryTtlMs(entry);
    if (ttl == null) {
      return;
    }

    const refreshInMs = Math.max(0, entry.fetchedAt + ttl - Date.now());
    const timeout = globalThis.setTimeout(() => {
      void useWorktreePrStore.getState().ensureWorktreePrUrl(key, input.worktreePath);
    }, refreshInMs + 1);

    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, [entry.fetchedAt, input.worktreePath, key]);

  const refresh = useCallback(() => {
    if (!key || entry.loading) {
      return;
    }
    invalidateWorktreePr(key);
  }, [key, entry.loading]);

  return {
    isLoading: entry.loading,
    hasFetchedBefore: entry.fetchedAt != null,
    pullRequest: entry.pullRequest,
    url: entry.pullRequest?.url ?? null,
    status: entry.pullRequest?.status ?? null,
    refresh,
  };
}
