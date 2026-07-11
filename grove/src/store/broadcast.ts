import { create } from "zustand";

export type BroadcastTarget = "mirror" | "pip";

export interface BroadcastSession {
  ptyId: string;
  paneId: string;
  target: BroadcastTarget;
  originalCols: number;
  originalRows: number;
  snapshot: string | null;
}

interface BroadcastState {
  mirrors: Record<string, BroadcastSession>;
  pips: Record<string, BroadcastSession>;
  pipOwnerByPtyId: Record<string, string>;

  /**
   * Start or replace a mirror broadcast for a specific PTY.
   */
  startMirror: (
    ptyId: string,
    paneId: string,
    originalCols: number,
    originalRows: number,
    snapshot?: string | null,
  ) => void;

  /**
   * Stop a mirror broadcast for a specific PTY.
   * Returns the ended session (for size restoration) or null if idle.
   */
  stopMirror: (ptyId: string) => BroadcastSession | null;

  /**
   * Start or replace the single PiP broadcast slot.
   */
  startPip: (
    worktreePath: string,
    ptyId: string,
    paneId: string,
    originalCols: number,
    originalRows: number,
    snapshot?: string | null,
  ) => void;

  /**
   * Stop the active PiP broadcast.
   * Returns the ended session (for size restoration) or null if idle.
   */
  stopPip: (worktreePath: string) => BroadcastSession | null;

  /** Stop the PiP broadcast that owns this PTY, regardless of worktree. */
  stopPipByPty: (ptyId: string) => { worktreePath: string; session: BroadcastSession } | null;

  /** Get the PiP session for a worktree, or null if none is active. */
  getPip: (worktreePath: string | null | undefined) => BroadcastSession | null;

  /** Get the PiP session that owns this PTY, or null if none is active. */
  getPipByPty: (ptyId: string) => BroadcastSession | null;

  /** Check if a specific ptyId is currently broadcasting. */
  isBroadcasting: (ptyId: string) => boolean;

  /** Check if a specific ptyId currently has a mirror broadcast. */
  isMirroring: (ptyId: string) => boolean;

  /** Get the mirror session for a ptyId, or null if not mirroring. */
  getMirror: (ptyId: string) => BroadcastSession | null;
}

export const useBroadcastStore = create<BroadcastState>((set, get) => ({
  mirrors: {},
  pips: {},
  pipOwnerByPtyId: {},

  startMirror: (ptyId, paneId, originalCols, originalRows, snapshot = null) => {
    set((state) => ({
      mirrors: {
        ...state.mirrors,
        [ptyId]: {
          ptyId,
          paneId,
          target: "mirror",
          originalCols,
          originalRows,
          snapshot,
        },
      },
    }));
  },

  stopMirror: (ptyId) => {
    const session = get().mirrors[ptyId];
    if (!session) return null;

    set((state) => {
      const nextMirrors = { ...state.mirrors };
      delete nextMirrors[ptyId];
      return { mirrors: nextMirrors };
    });

    return session;
  },

  startPip: (worktreePath, ptyId, paneId, originalCols, originalRows, snapshot = null) => {
    set((state) => {
      const previous = state.pips[worktreePath];
      const nextPipOwnerByPtyId = { ...state.pipOwnerByPtyId };
      if (previous && previous.ptyId !== ptyId) {
        delete nextPipOwnerByPtyId[previous.ptyId];
      }
      nextPipOwnerByPtyId[ptyId] = worktreePath;

      return {
        pips: {
          ...state.pips,
          [worktreePath]: {
            ptyId,
            paneId,
            target: "pip",
            originalCols,
            originalRows,
            snapshot,
          },
        },
        pipOwnerByPtyId: nextPipOwnerByPtyId,
      };
    });
  },

  stopPip: (worktreePath) => {
    const session = get().pips[worktreePath];
    if (!session) return null;

    set((state) => {
      const nextPips = { ...state.pips };
      const nextPipOwnerByPtyId = { ...state.pipOwnerByPtyId };
      delete nextPips[worktreePath];
      delete nextPipOwnerByPtyId[session.ptyId];
      return {
        pips: nextPips,
        pipOwnerByPtyId: nextPipOwnerByPtyId,
      };
    });

    return session;
  },

  stopPipByPty: (ptyId) => {
    const worktreePath = get().pipOwnerByPtyId[ptyId];
    if (!worktreePath) return null;

    const session = get().pips[worktreePath];
    if (!session) {
      set((state) => {
        const nextPipOwnerByPtyId = { ...state.pipOwnerByPtyId };
        delete nextPipOwnerByPtyId[ptyId];
        return { pipOwnerByPtyId: nextPipOwnerByPtyId };
      });
      return null;
    }

    set((state) => {
      const nextPips = { ...state.pips };
      const nextPipOwnerByPtyId = { ...state.pipOwnerByPtyId };
      delete nextPips[worktreePath];
      delete nextPipOwnerByPtyId[ptyId];
      return {
        pips: nextPips,
        pipOwnerByPtyId: nextPipOwnerByPtyId,
      };
    });

    return { worktreePath, session };
  },

  getPip: (worktreePath) => {
    if (!worktreePath) {
      return null;
    }
    return get().pips[worktreePath] ?? null;
  },

  getPipByPty: (ptyId) => {
    const state = get();
    const worktreePath = state.pipOwnerByPtyId[ptyId];
    if (!worktreePath) {
      return null;
    }

    return state.pips[worktreePath] ?? null;
  },

  isBroadcasting: (ptyId) => {
    const { mirrors, pipOwnerByPtyId } = get();
    return Boolean(mirrors[ptyId] || pipOwnerByPtyId[ptyId]);
  },

  isMirroring: (ptyId) => {
    return Boolean(get().mirrors[ptyId]);
  },

  getMirror: (ptyId) => {
    return get().mirrors[ptyId] ?? null;
  },
}));
