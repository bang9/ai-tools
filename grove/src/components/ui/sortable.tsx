import type { CSSProperties, ReactNode } from "react";
import { PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "../../lib/cn";

/**
 * Shared pointer sensor for sortable lists: distance 5 keeps plain clicks
 * selecting the item; a real drag kicks in only after the pointer moves.
 */
export function usePointerDragSensors() {
  return useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
}

/**
 * Standard dnd-kit sortable wrapper: siblings slide aside during a drag and
 * the dragged item dims. translateOnly drops the sorting strategy's scale
 * component — required when list items have different sizes, where the scale
 * would stretch the dragged item to each neighbor's size as it passes over.
 */
export function SortableItem({
  id,
  translateOnly = false,
  className,
  children,
}: {
  id: string;
  translateOnly?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style: CSSProperties = {
    transform: translateOnly
      ? CSS.Translate.toString(transform)
      : CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    touchAction: "none",
  };
  return (
    <div ref={setNodeRef} style={style} className={cn(className)} {...attributes} {...listeners}>
      {children}
    </div>
  );
}
