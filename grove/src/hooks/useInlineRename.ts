import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

interface InlineRenameOptions {
  maxLength?: number;
  /** Receives the trimmed draft; an empty string means "reset to default". */
  onCommit: (value: string) => void;
  onCancel?: () => void;
}

/**
 * Shared inline-rename state machine: begin(initial) opens the editor,
 * Enter/blur commit, Escape cancels without the blur handler double-firing,
 * and an Enter that only confirms an IME candidate never commits. Spread
 * inputProps onto the editor's <input>.
 */
export function useInlineRename({ maxLength, onCommit, onCancel }: InlineRenameOptions) {
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurSaveRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!editing) return;
    skipBlurSaveRef.current = false;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [editing]);

  const begin = useCallback((initial: string) => {
    setDraft(initial);
    setEditing(true);
  }, []);

  const commit = useCallback(() => {
    onCommit(draft.trim());
    setEditing(false);
  }, [draft, onCommit]);

  const cancel = useCallback(() => {
    skipBlurSaveRef.current = true;
    setEditing(false);
    onCancel?.();
  }, [onCancel]);

  const inputProps = {
    ref: inputRef,
    type: "text" as const,
    value: draft,
    maxLength,
    onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    onBlur: () => {
      if (skipBlurSaveRef.current) {
        skipBlurSaveRef.current = false;
        return;
      }
      commit();
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    },
  };

  return { editing, begin, inputProps };
}
