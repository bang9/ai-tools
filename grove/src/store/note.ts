import { create } from "zustand";
import * as platform from "../lib/platform";
import { runCommandSafely } from "../lib/command";

interface NoteState {
  notes: Record<string, string>;

  init: () => Promise<void>;
  saveNote: (key: string, content: string) => void;
  deleteNote: (key: string) => void;
  getNote: (key: string) => string | undefined;
  hasNote: (key: string) => boolean;
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

function debouncedSaveToBackend(key: string, content: string) {
  const existing = saveTimers.get(key);
  if (existing) clearTimeout(existing);
  saveTimers.set(
    key,
    setTimeout(() => {
      saveTimers.delete(key);
      platform.saveNote(key, content).catch(() => {});
    }, 500),
  );
}

export const useNoteStore = create<NoteState>((set, get) => ({
  notes: {},

  init: async () => {
    const notes = await runCommandSafely(() => platform.listNotes(), {
      errorToast: "Failed to load notes",
    });
    if (notes) {
      set({ notes });
    }
  },

  saveNote: (key: string, content: string) => {
    const trimmed = content.trim();
    set((state) => {
      const next = { ...state.notes };
      if (trimmed.length === 0) {
        delete next[key];
      } else {
        next[key] = content;
      }
      return { notes: next };
    });
    debouncedSaveToBackend(key, content);
  },

  deleteNote: (key: string) => {
    set((state) => {
      const next = { ...state.notes };
      delete next[key];
      return { notes: next };
    });
    platform.deleteNote(key).catch(() => {});
  },

  getNote: (key: string) => get().notes[key],
  hasNote: (key: string) => {
    const note = get().notes[key];
    return note !== undefined && note.trim().length > 0;
  },
}));
