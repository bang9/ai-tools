import { create } from "zustand";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { cn } from "./cn";

export type OverlayControlProps<T = unknown> = {
  resolve: (value: T) => void;
  close: () => void;
};

type OverlayEntry = {
  id: string;
  render: (control: OverlayControlProps<any>) => React.ReactNode;
  resolve: (value: any) => void;
};

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  className?: string;
}

interface OverlayStore {
  entries: OverlayEntry[];
  push: (entry: OverlayEntry) => void;
  remove: (id: string) => void;
}

const useOverlayStore = create<OverlayStore>((set) => ({
  entries: [],
  push: (entry) => set((s) => ({ entries: [...s.entries, entry] })),
  remove: (id) => set((s) => ({ entries: s.entries.filter((e) => e.id !== id) })),
}));

let counter = 0;

export const overlay = {
  /**
   * Open an overlay with a render function and await its result.
   *
   * ```tsx
   * const ok = await overlay.open<boolean>(({ resolve, close }) => (
   *   <Dialog open onClose={close} title="Confirm?">
   *     <Button onClick={close}>Cancel</Button>
   *     <Button onClick={() => resolve(true)}>OK</Button>
   *   </Dialog>
   * ));
   * ```
   */
  open<T = void>(
    render: (control: OverlayControlProps<T>) => React.ReactNode,
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((promiseResolve) => {
      const id = `overlay-${++counter}`;

      const resolve = (value: T) => {
        useOverlayStore.getState().remove(id);
        promiseResolve(value);
      };

      const close = () => {
        useOverlayStore.getState().remove(id);
        promiseResolve(undefined);
      };

      useOverlayStore.getState().push({ id, render, resolve: close });
      // Store actual control for rendering
      controlMap.set(id, { resolve, close });
    });
  },

  async confirm({
    title,
    description,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    variant = "default",
    className,
  }: ConfirmOptions): Promise<boolean> {
    const result = await this.open<boolean>(({ resolve, close }) => (
      <Dialog open onClose={close} title={title} className={cn("max-w-sm", className)}>
        <div className={cn("space-y-4")}>
          {description ? (
            <div
              className={cn("text-sm leading-relaxed text-muted-foreground whitespace-pre-line")}
            >
              {description}
            </div>
          ) : null}
          <div className={cn("flex justify-end gap-2")}>
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              {cancelLabel}
            </Button>
            <Button type="button" variant={variant} size="sm" onClick={() => resolve(true)}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </Dialog>
    ));

    return Boolean(result);
  },
};

// Internal map to hold typed controls per overlay
const controlMap = new Map<string, OverlayControlProps<any>>();

/** Render all active overlays. Place once at app root. */
export function OverlayContainer() {
  const entries = useOverlayStore((s) => s.entries);

  return (
    <>
      {entries.map((entry) => {
        const control = controlMap.get(entry.id);
        if (!control) return null;
        return <div key={entry.id}>{entry.render(control)}</div>;
      })}
    </>
  );
}
