import { cn } from "../../lib/cn";

interface Props {
  changeCount: number;
  isSelected: boolean;
  onClick: () => void;
}

export default function WorkingChanges({ changeCount, isSelected, onClick }: Props) {
  return (
    <div
      className={cn("px-4 py-2 cursor-pointer select-none transition-colors", {
        "bg-selected": isSelected,
        "hover:bg-secondary/30": !isSelected,
      })}
      onClick={onClick}
    >
      <span className={cn("text-sm font-medium text-foreground")}>Working Changes</span>
      {changeCount > 0 && (
        <span className={cn("ml-1.5 text-sm text-muted-foreground")}>({changeCount})</span>
      )}
    </div>
  );
}
