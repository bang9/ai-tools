import type { DiffLine as DiffLineType } from "../../types";
import { cn } from "../../lib/cn";

interface Props {
  line: DiffLineType;
}

export default function DiffLine({ line }: Props) {
  const isAdd = line.type === "add";
  const isRemove = line.type === "remove";

  let rowBg = "";
  let gutterBg = "";
  let prefixColor = "text-transparent";

  if (isAdd) {
    rowBg = "bg-[var(--diff-add-bg)]";
    gutterBg = "bg-[var(--diff-add-gutter-bg)]";
    prefixColor = "text-[var(--color-success)]";
  } else if (isRemove) {
    rowBg = "bg-[var(--diff-remove-bg)]";
    gutterBg = "bg-[var(--diff-remove-gutter-bg)]";
    prefixColor = "text-[var(--color-danger)]";
  }

  let prefix = " ";
  if (isAdd) {
    prefix = "+";
  } else if (isRemove) {
    prefix = "-";
  }

  return (
    <div
      className={cn("flex items-stretch min-h-[20px] leading-[20px] font-mono text-[12px]", rowBg)}
    >
      {/* Old line number gutter */}
      <span
        className={cn(
          "w-[40px] text-right pr-2 text-[11px] text-[var(--color-text-tertiary)] shrink-0 select-none",
          gutterBg,
        )}
      >
        {line.oldLineNumber ?? ""}
      </span>

      {/* New line number gutter */}
      <span
        className={cn(
          "w-[40px] text-right pr-2 text-[11px] text-[var(--color-text-tertiary)] shrink-0 select-none",
          gutterBg,
        )}
      >
        {line.newLineNumber ?? ""}
      </span>

      {/* Prefix (+/-/space) */}
      <span
        className={cn(
          "w-[18px] text-center shrink-0 select-none font-medium",
          prefixColor,
          gutterBg,
        )}
      >
        {prefix}
      </span>

      {/* Content */}
      <span className={cn("diff-line-content flex-1 pr-3 whitespace-pre overflow-x-auto")}>
        {line.content}
      </span>
    </div>
  );
}
