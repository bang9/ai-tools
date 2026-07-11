import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ThemedToken } from "shiki";
import { cn } from "../../lib/cn";
import { detectLanguage } from "../../lib/language-detect";
import { formatFileSize } from "../../lib/format-size";
import { highlightLines } from "../../lib/shiki-highlighter";
import { useIsDarkTheme } from "../../hooks/useIsDarkTheme";

const LINE_HEIGHT = 20;
// Approximate advance width of one text-xs (12px) monospace glyph. Only used to
// give the horizontal scroll a stable width when wrapping is off.
const CHAR_WIDTH = 7.23;

interface CodeViewProps {
  content: string;
  fileName: string;
  size: number;
  wrap: boolean;
}

function CodeView({ content, fileName, size, wrap }: CodeViewProps) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const language = useMemo(() => detectLanguage(fileName), [fileName]);
  const isDark = useIsDarkTheme();

  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  const [highlightSkipped, setHighlightSkipped] = useState(false);

  useEffect(() => {
    setTokens(null);
    setHighlightSkipped(false);
    if (!language) return;
    let cancelled = false;
    highlightLines(content, language, isDark)
      .then((result) => {
        if (cancelled) return;
        if (result) {
          setTokens(result);
        } else {
          // A known language that returned null means the size caps kicked in.
          setHighlightSkipped(true);
        }
      })
      .catch(() => {
        if (!cancelled) setTokens(null);
      });
    return () => {
      cancelled = true;
    };
  }, [content, language, isDark]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 20,
  });

  // Row heights change when wrapping toggles (and when the file changes), so
  // drop the cached measurements and let them recompute.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [wrap, content, rowVirtualizer]);

  const gutterDigits = Math.max(2, String(lines.length).length);
  const gutterWidth = gutterDigits * CHAR_WIDTH + 20;

  const maxLineLength = useMemo(() => {
    let max = 0;
    for (const line of lines) {
      if (line.length > max) max = line.length;
    }
    return max;
  }, [lines]);
  const contentWidth = gutterWidth + maxLineLength * CHAR_WIDTH + 16;

  const virtualRows = rowVirtualizer.getVirtualItems();

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col")}>
      <div
        ref={scrollRef}
        className={cn("relative min-h-0 flex-1", {
          "overflow-auto": !wrap,
          "overflow-x-hidden overflow-y-auto": wrap,
        })}
      >
        <div
          className={cn("relative")}
          style={{
            height: rowVirtualizer.getTotalSize(),
            width: wrap ? "100%" : contentWidth,
            minWidth: "100%",
          }}
        >
          {virtualRows.map((virtualRow) => {
            const index = virtualRow.index;
            const lineTokens = tokens?.[index] ?? null;
            return (
              <div
                key={index}
                data-index={index}
                ref={wrap ? rowVirtualizer.measureElement : undefined}
                className={cn("absolute left-0 top-0 flex w-full font-mono text-xs leading-5")}
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                  minHeight: wrap ? LINE_HEIGHT : undefined,
                  height: wrap ? undefined : LINE_HEIGHT,
                }}
              >
                <span
                  className={cn(
                    "sticky left-0 z-10 shrink-0 select-none bg-background pr-3 text-right text-muted-foreground/60",
                  )}
                  style={{ width: gutterWidth }}
                >
                  {index + 1}
                </span>
                <code
                  className={cn("text-foreground", {
                    "whitespace-pre": !wrap,
                    "min-w-0 flex-1 whitespace-pre-wrap break-words": wrap,
                  })}
                >
                  {lineTokens
                    ? lineTokens.map((token, tokenIndex) => (
                        <span key={tokenIndex} style={{ color: token.color }}>
                          {token.content}
                        </span>
                      ))
                    : lines[index] || " "}
                </code>
              </div>
            );
          })}
        </div>
      </div>

      <div
        className={cn(
          "flex h-6 shrink-0 items-center gap-1.5 border-t border-border px-3 text-xs text-muted-foreground",
        )}
      >
        <span>
          {lines.length} {lines.length === 1 ? "line" : "lines"}
        </span>
        <span>·</span>
        <span>{formatFileSize(size)}</span>
        <span>·</span>
        <span>{language ?? "Plain text"}</span>
        {highlightSkipped && (
          <>
            <span>·</span>
            <span>highlight skipped (large file)</span>
          </>
        )}
      </div>
    </div>
  );
}

export default CodeView;
