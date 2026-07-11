import { forwardRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";

interface Props {
  icon: ReactNode;
  label: ReactNode;
  title: string;
  isSelected: boolean;
  disabled?: boolean;
  onActivate: () => void;
  status?: ReactNode;
  action?: ReactNode;
  forceShowAction?: boolean;
}

const SidebarLeafItem = forwardRef<HTMLDivElement, Props & React.HTMLAttributes<HTMLDivElement>>(
  function SidebarLeafItem(
    {
      icon,
      label,
      title,
      isSelected,
      disabled = false,
      onActivate,
      status,
      action,
      forceShowAction = false,
      ...rest
    },
    ref,
  ) {
    return (
      <div
        ref={ref}
        {...rest}
        className={cn(
          "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-[13px] transition-all duration-150 cursor-pointer select-none",
          {
            "pointer-events-none opacity-50": disabled,
            "bg-selected text-foreground": isSelected && !disabled,
            "text-muted-foreground hover:bg-secondary/50 hover:text-foreground":
              !isSelected && !disabled,
          },
        )}
        onClick={onActivate}
        title={title}
      >
        {icon}
        <span className={cn("min-w-0 flex-1 truncate")}>{label}</span>
        {status}
        <span
          className={cn(
            "flex shrink-0 items-center justify-end overflow-hidden transition-all duration-150",
            {
              "max-w-0 opacity-0": !isSelected && !forceShowAction,
              "max-w-[72px] opacity-100": isSelected || forceShowAction,
              "group-hover:max-w-[72px] group-hover:opacity-100": true,
            },
          )}
        >
          {action}
        </span>
      </div>
    );
  },
);

export default SidebarLeafItem;
